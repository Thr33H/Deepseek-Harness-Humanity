/**
 * 自进化数据层测试：四表包装（`createEvolutionState`）与存储契约（`model.ts`）。
 *
 * 钉的是语义：排序方向、裁剪保留谁、状态兜底、payload 上限、解析合同的逐字段校验。
 * 落盘与旧文件兼容不在这（`host-store-migration.test.mjs` 用真实后端覆盖）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_CURSOR_RECORDS, MAX_RUN_RECORDS } from '../lib/evolution/constants.js'
import { AnalysisOutputSchema, createProposal, createRunRecord, RunRecordSchema, STATE_INITIAL } from '../lib/evolution/model.js'
import { createFakeTable, fakeEvolutionState } from './helpers/evolution-fake.mjs'
import { createEvolutionState } from '../lib/evolution/state.js'

/** 造一条运行记录（startedAt 可控，用于排序与裁剪断言）。 */
function run(startedAt, overrides = {}) {
  return { ...createRunRecord('incremental', 'manual', startedAt), ...overrides }
}

/** 造一条提案（createdAt 可覆盖：排序断言需要确定性时间戳）。 */
function proposal(kind, title, overrides = {}) {
  return createProposal({ kind, title, reason: '测试', payload: { note: title }, ...overrides }, 65536)
}

test('运行记录：最新在前（startedAt 降序）', async () => {
  const { state } = fakeEvolutionState()
  await state.putRun(run('2026-09-01T00:00:00.000Z'))
  await state.putRun(run('2026-09-03T00:00:00.000Z'))
  await state.putRun(run('2026-09-02T00:00:00.000Z'))

  assert.deepEqual(
    state.listRuns().map((record) => record.startedAt),
    ['2026-09-03T00:00:00.000Z', '2026-09-02T00:00:00.000Z', '2026-09-01T00:00:00.000Z'],
  )
})

test(`运行记录：超过 ${MAX_RUN_RECORDS} 条裁掉最旧`, async () => {
  const { state } = fakeEvolutionState()
  for (let index = 0; index < MAX_RUN_RECORDS + 5; index += 1) {
    const day = String(index + 1).padStart(2, '0')
    await state.putRun(run(`2026-08-${day}T00:00:00.000Z`))
  }

  const runs = state.listRuns()
  assert.equal(runs.length, MAX_RUN_RECORDS)
  // 最旧的 5 条（08-01…08-05）被裁掉，最新的还在。
  assert.ok(!runs.some((record) => record.startedAt === '2026-08-01T00:00:00.000Z'))
  assert.equal(runs[0].startedAt, `2026-08-${String(MAX_RUN_RECORDS + 5).padStart(2, '0')}T00:00:00.000Z`)
})

test('提案：按状态过滤、分类计数只算 pending', async () => {
  const { state } = fakeEvolutionState()
  const persona = proposal('persona', '固定层补自定义字段A', { createdAt: '2026-09-02T00:00:00.000Z' })
  const skill = proposal('skill', '周报技能', { createdAt: '2026-09-03T00:00:00.000Z' })
  const route = proposal('route', '夜间便宜模型', { createdAt: '2026-09-01T00:00:00.000Z' })
  await state.putProposal(persona)
  await state.putProposal(skill)
  await state.putProposal({ ...route, status: 'applied' })

  assert.equal(state.listProposals().length, 3)
  assert.deepEqual(
    state.listProposals('pending').map((record) => record.title),
    ['周报技能', '固定层补自定义字段A'],
  )
  assert.deepEqual(state.countPending(), { persona: 1, skill: 1, route: 0, total: 2 })
})

test('提案：payload 超字节上限即抛（一条失控提案不进表）', () => {
  const huge = 'x'.repeat(70000)
  assert.throws(
    () => createProposal({ kind: 'skill', title: '超大', payload: { content: huge } }, 65536),
    /超过 65536 字节上限/,
  )
})

test('游标：写入后按会话读回；保留期外的先清', async () => {
  const { state } = fakeEvolutionState()
  await state.putCursor({ sessionId: 'fresh', lastSeq: 42, lastRunAt: '2026-09-20T00:00:00.000Z' })
  await state.putCursor({ sessionId: 'stale', lastSeq: 7, lastRunAt: '2026-01-01T00:00:00.000Z' })

  const removed = await state.pruneCursors('2026-09-25T00:00:00.000Z')
  assert.equal(removed, 1)
  assert.equal(state.getCursor('fresh')?.lastSeq, 42)
  assert.equal(state.getCursor('stale'), undefined)
})

test(`游标：超过 ${MAX_CURSOR_RECORDS} 条按 lastRunAt 裁最旧`, async () => {
  const { tables } = fakeEvolutionState()
  const state = createEvolutionState(tables)
  for (let index = 0; index < MAX_CURSOR_RECORDS + 10; index += 1) {
    const stamp = new Date(Date.UTC(2026, 8, 1) + index * 60000).toISOString()
    await state.putCursor({ sessionId: `s${index}`, lastSeq: index, lastRunAt: stamp })
  }

  const removed = await state.pruneCursors('2026-09-25T00:00:00.000Z')
  assert.equal(removed, 10)
  assert.equal(tables.cursors.records.size, MAX_CURSOR_RECORDS)
  // 最新触碰的会话必须活着（增量水位丢了会重扫，成本事故）。
  assert.notEqual(state.getCursor(`s${MAX_CURSOR_RECORDS + 9}`), undefined)
  assert.equal(state.getCursor('s0'), undefined)
})

test('单值状态：空表回出厂值；写入后原样读回', async () => {
  const { state } = fakeEvolutionState()
  assert.deepEqual(state.readState(), STATE_INITIAL)

  await state.mutateState({ baselineAt: '2026-09-25T00:00:00.000Z', dailyCalls: 3 })
  assert.equal(state.readState().baselineAt, '2026-09-25T00:00:00.000Z')
  assert.equal(state.readState().dailyCalls, 3)
})

test('单值状态：并发字段写入互不顶掉（真机前科：读改写竞态把 nextRunAt 写回旧值 → 多补跑一次）', async () => {
  const { state } = fakeEvolutionState()
  await Promise.all([
    state.mutateState({ nextRunAt: 12345 }),
    state.mutateState((current) => ({ ...current, dailyCalls: current.dailyCalls + 2 })),
    state.mutateState({ baselineAt: '2026-09-25T00:00:00.000Z' }),
    state.mutateState((current) => ({ ...current, dailyCalls: current.dailyCalls + 3 })),
  ])
  const merged = state.readState()
  assert.equal(merged.nextRunAt, 12345, '调度器写的字段必须活着')
  assert.equal(merged.dailyCalls, 5, '记账的两次累计都在（函数式合并作用于当前值）')
  assert.equal(merged.baselineAt, '2026-09-25T00:00:00.000Z')
})

test('单值状态：坏形状回出厂值而不是抛（调度器读取路径不许炸）', async () => {
  // baselineAt 类型错误 → safeParse 失败 → 出厂值兜底；未知键则按 zod strip 语义丢弃后照常解析。
  const table = createFakeTable([['main', { baselineAt: 42 }]])
  const state = createEvolutionState({
    runs: createFakeTable(),
    proposals: createFakeTable(),
    cursors: createFakeTable(),
    state: table,
  })
  assert.deepEqual(state.readState(), STATE_INITIAL)
})

test('运行记录契约：旧数据缺计数字段按 0 补齐（G-004 零迁移的读取端）', () => {
  const parsed = RunRecordSchema.parse({
    id: 'r1',
    mode: 'dream',
    trigger: 'scheduled',
    status: 'completed',
    startedAt: '2026-09-25T00:00:00.000Z',
  })
  assert.equal(parsed.scannedSessions, 0)
  assert.equal(parsed.inputTokens, 0)
  assert.deepEqual(parsed.insights, [])
  assert.equal(parsed.narrative, '')
})

test('解析合同：默认值补齐 + 每个数组独立上限（超限拒绝整份输出）', () => {
  const minimal = AnalysisOutputSchema.parse({})
  assert.deepEqual(minimal.memories, [])
  assert.equal(minimal.narrative, '')

  const tooMany = { memories: Array.from({ length: 21 }, () => ({ content: 'x', scope: 'long-term' })) }
  assert.throws(() => AnalysisOutputSchema.parse(tooMany))

  // 空正文的记忆候选必须被拒（写入管线拿到空串只会浪费一次拒绝）。
  assert.throws(() => AnalysisOutputSchema.parse({ memories: [{ content: '', scope: 'long-term' }] }))
  // 会话作用域不在解析合同里：跨会话整理天然只产出长期/工作记忆（会话记忆属对话内实时路径）。
  assert.throws(() => AnalysisOutputSchema.parse({ memories: [{ content: 'x', scope: 'session' }] }))
})

test('路由字段已从合同移除：模型若仍输出 routes，按多余键忽略而不报错（M4 裁撤的兼容面）', () => {
  const parsed = AnalysisOutputSchema.parse({
    routes: [{ title: '夜间便宜模型', reason: '成本', scenario: '', provider: '', model: '' }],
  })
  assert.equal('routes' in parsed, false, '裁撤后合同里不再有 routes')
  assert.deepEqual(parsed.memories, [], '多余键不影响其余字段的默认值补齐')
})

test('工厂：新运行记录是 running 态且带 id；新提案是 pending 态', () => {
  const record = createRunRecord('dream', 'idle', '2026-09-25T03:00:00.000Z')
  assert.equal(record.status, 'running')
  assert.equal(record.mode, 'dream')
  assert.ok(record.id.length > 0)

  const created = createProposal({ kind: 'persona', title: 't', sourceRunId: record.id }, 65536)
  assert.equal(created.status, 'pending')
  assert.equal(created.sourceRunId, record.id)
  assert.equal(created.payload, '{}')
})
