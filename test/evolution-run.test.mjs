/**
 * 运行编排测试：门禁降级、零成本收工、游标推进语义、每日预算、互斥、梦境收集与用量记账。
 *
 * LLM 是假的（按次回放输出），记忆管线是真的（`remember()` 落进假表）——
 * 这里钉的是 run/run-loop 的**编排语义**，解析合同与写回权限分别有自己的测试文件。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createRunner } from '../lib/evolution/run.js'
import { dayKeyOf } from '../lib/evolution/schedule-time.js'
import { createLog } from '../lib/log.js'
import { createMemoryStore } from '../lib/memory/store.js'
import { resolveMemoryPolicy } from '../lib/memory/policy.js'
import { createFakeTable, fakeEvent, fakeEvolutionState, fakeSession, fakeSessionQuery } from './helpers/evolution-fake.mjs'

const log = createLog(new Context(), 'test')
const NOW = '2026-09-25T12:00:00.000Z'
const BASELINE = '2026-09-20T00:00:00.000Z'
const CREATED = Date.parse(BASELINE) + 60000

/** 最小合法解析输出。 */
const EMPTY_OUTPUT = { memories: [], personaSections: [], personaFixed: [], skills: [], insights: [], narrative: '' }

/** 造运行环境：假 LLM 按调用次序回放；记忆表真管线。 */
function harness(options = {}) {
  const { state } = fakeEvolutionState()
  const memoryTable = createFakeTable()
  const responses = options.responses ?? []
  const llmCalls = []
  const sessions = options.sessions ?? []
  const events = options.events ?? {}
  const config = {
    evolution: {
      enabled: true,
      schedule: { mode: 'idle', idleMinutes: 30, timeOfDay: '03:00', weekday: 1, monthDay: 1, timezone: options.timezone ?? '' },
      scan: { includeSubSessions: false },
      budget: {
        maxSessionsPerRun: 5,
        maxEventsPerSession: 200,
        maxInputBytesPerCall: 32768,
        maxOutputTokensPerCall: 2000,
        dailyCallCap: options.dailyCallCap ?? 20,
      },
    },
    dream: { enabled: options.dreamEnabled ?? true },
  }
  const deps = {
    state,
    config: () => config,
    enabled: () => options.enabled ?? true,
    sessionQuery: () => (options.noQuery === true ? undefined : fakeSessionQuery(sessions, events)),
    llm: {
      route: () => (options.noRoute === true ? undefined : { provider: 'deepseek', model: 'test' }),
      streamText: async (input) => {
        llmCalls.push(input)
        const next = responses[llmCalls.length - 1] ?? { text: JSON.stringify(EMPTY_OUTPUT), inputTokens: 10, outputTokens: 5, finishReason: 'stop' }
        if (next instanceof Error) throw next
        return next
      },
    },
    classify: () => ({
      memoryStore: () => createMemoryStore(memoryTable),
      memoryPolicy: () => resolveMemoryPolicy('balanced'),
      persona: () => undefined,
      skills: () => undefined,
      state,
      log,
    }),
    sectionTitles: () => ['说话风格'],
    log,
    now: () => options.now ?? NOW,
  }
  return { runner: createRunner(deps), state, memoryTable, llmCalls, config }
}

/** 预置基线（避免首轮建基线不扫的语义干扰被测场景）。 */
async function seedBaseline(state) {
  await state.mutateState({ baselineAt: BASELINE })
}

const ok = (output, usage = {}) => ({
  text: JSON.stringify(output),
  inputTokens: usage.input ?? 100,
  outputTokens: usage.output ?? 40,
  finishReason: 'stop',
})

test('sessionQuery 缺席：运行记 failed，原因写明，不碰模型（G-002 降级说清楚）', async () => {
  const { runner, state, llmCalls } = harness({ noQuery: true })
  await seedBaseline(state)
  const record = await runner.start({ mode: 'incremental', trigger: 'manual' })

  assert.equal(record.status, 'failed')
  assert.ok(record.error.includes('sessionQuery'))
  assert.equal(llmCalls.length, 0)
})

test('没有待消化内容：completed 收工，一次模型调用都不发生（零成本）', async () => {
  const { runner, state, llmCalls } = harness({ noRoute: true })
  await seedBaseline(state)
  const record = await runner.start({ mode: 'incremental', trigger: 'manual' })

  assert.equal(record.status, 'completed')
  assert.equal(record.scannedSessions, 0)
  assert.equal(llmCalls.length, 0, '路由都没有也能收工：因为根本不需要模型')
})

test('成功运行：写回计数、token 记账、游标推进到已消化的最后 seq', async () => {
  const { runner, state, memoryTable, llmCalls } = harness({
    sessions: [fakeSession('s1', CREATED, { cwd: '/ws' })],
    events: { s1: [fakeEvent('s1', 1, 'user/message', '我喜欢简短回复'), fakeEvent('s1', 2, 'assistant/message', '好')] },
    responses: [ok({ ...EMPTY_OUTPUT, memories: [{ content: '用户偏好简短回复', scope: 'long-term', tags: [], sensitive: false }] })],
  })
  await seedBaseline(state)
  const record = await runner.start({ mode: 'incremental', trigger: 'manual' })

  assert.equal(record.status, 'completed')
  assert.equal(record.scannedSessions, 1)
  assert.equal(record.parsedEvents, 2)
  assert.equal(record.memoriesWritten, 1)
  assert.equal(record.calls, 1)
  assert.equal(record.inputTokens, 100)
  assert.equal(record.outputTokens, 40)
  assert.equal(state.getCursor('s1')?.lastSeq, 2, '游标推到已消化的最后 seq')
  assert.equal(memoryTable.records.size, 1)
  // 每日账目同步落进单值状态（P-051 花费可见）。
  const stateRecord = state.readState()
  assert.equal(stateRecord.dailyCalls, 1)
  assert.equal(stateRecord.dailyInputTokens, 100)
  assert.equal(llmCalls.length, 1)
})

test('首轮建基线：不扫旧会话，基线写进状态（P-037）', async () => {
  const { runner, state } = harness({ sessions: [fakeSession('old', Date.parse(BASELINE) - 1000)] })
  const record = await runner.start({ mode: 'incremental', trigger: 'manual' })

  assert.equal(record.status, 'completed')
  assert.equal(state.readState().baselineAt, NOW)
  assert.ok(record.error.includes('已建立扫描基线'))
})

test('解析失败的会话不推游标；全部失败整轮判 failed', async () => {
  const { runner, state } = harness({
    sessions: [fakeSession('s1', CREATED)],
    events: { s1: [fakeEvent('s1', 7)] },
    responses: [ok(null), ok(null)].map(() => ({ text: '散文不是 JSON', inputTokens: 10, outputTokens: 5, finishReason: 'stop' })),
  })
  await seedBaseline(state)
  const record = await runner.start({ mode: 'incremental', trigger: 'manual' })

  assert.equal(record.status, 'failed')
  const cursor = state.getCursor('s1')
  assert.equal(cursor.lastSeq, 0, '失败会话的水位必须留在原地（下轮重看）')
  assert.equal(cursor.failures, 1, '失败计数落盘（跨运行累计，熔断的依据）')
  assert.ok(record.error.includes('解析失败'))
  assert.equal(record.calls, 2, '重试的钱也要记进账（两次尝试）')
  assert.equal(record.inputTokens, 20, '失败尝试的 token 一样花了，必须可见（P-051）')
  assert.equal(record.outputTokens, 10)
})

test('每日预算到顶：skipped + 警告注记，不再调用（P-051 不偷偷烧钱）', async () => {
  const { runner, state, llmCalls } = harness({
    dailyCallCap: 2,
    sessions: [fakeSession('s1', CREATED)],
    events: { s1: [fakeEvent('s1', 1)] },
  })
  await seedBaseline(state)
  await state.mutateState({ dailyDate: NOW.slice(0, 10), dailyCalls: 2, dailyInputTokens: 0, dailyOutputTokens: 0 })

  const record = await runner.start({ mode: 'incremental', trigger: 'manual' })
  assert.equal(record.status, 'skipped')
  assert.ok(record.error.includes('每日调用上限'))
  assert.equal(llmCalls.length, 0)
})

test('先失败、再撞上每日上限 ⇒ failed（不是 skipped）：那一轮真失败了、也真花了钱', async () => {
  // 2026-09-26 审计 E6：旧顺序先判 capStopped，于是"失败一个会话 + 随后预算停摆"被记成 `skipped`
  // （语义是"没干活"）—— 而 record.calls > 0、错误注记也在，等于把失败藏起来。
  const { runner, state, config } = harness({
    dailyCallCap: 2,
    sessions: [fakeSession('s1', CREATED), fakeSession('s2', CREATED)],
    events: { s1: [fakeEvent('s1', 1)], s2: [fakeEvent('s2', 1)] },
    responses: [
      { text: '散文不是 JSON', inputTokens: 10, outputTokens: 5, finishReason: 'stop' },
      { text: '散文不是 JSON', inputTokens: 10, outputTokens: 5, finishReason: 'stop' },
    ],
  })
  await seedBaseline(state)
  // 预算只剩 2 次调用，而一次会话要试两遍 ⇒ 第一个会话失败后，第二个会话必然被预算挡住。
  await state.mutateState({
    dailyDate: dayKeyOf(Date.parse(NOW), config.evolution.schedule),
    dailyCalls: 0,
    dailyInputTokens: 0,
    dailyOutputTokens: 0,
  })

  const record = await runner.start({ mode: 'incremental', trigger: 'manual' })
  assert.equal(record.status, 'failed', '失败优先于预算停摆')
  assert.ok(record.calls > 0, '这一轮确实花了钱')
  assert.ok(record.error.includes('解析失败'))
})

test('每日上限按**调度时区**算那一天（审计 E5）：UTC 日期对不上时不该误清零', async () => {
  // 时刻取 20:00Z = 北京时间次日 04:00：调度日（Asia/Shanghai）已经是 09-26，UTC 日还是 09-25。
  // 账本记在 09-26 上、上限 0 次 —— 只有用同一个日期键才会判定"今天已用满"。
  const lateNow = '2026-09-25T20:00:00.000Z'
  const { runner, state, llmCalls } = harness({
    dailyCallCap: 2,
    now: lateNow,
    timezone: 'Asia/Shanghai',
    sessions: [fakeSession('s1', CREATED)],
    events: { s1: [fakeEvent('s1', 1)] },
  })
  await seedBaseline(state)
  await state.mutateState({ dailyDate: '2026-09-26', dailyCalls: 2, dailyInputTokens: 0, dailyOutputTokens: 0 })

  const record = await runner.start({ mode: 'incremental', trigger: 'manual' })
  assert.equal(record.status, 'skipped', '调度日已经用满 ⇒ 不许再烧钱')
  assert.equal(llmCalls.length, 0)
})

test('噪声事件（无对话正文）：游标照推、不调模型（否则噪声会永远堵住新事件）', async () => {
  const { runner, state, llmCalls } = harness({
    sessions: [fakeSession('s1', CREATED)],
    events: { s1: [fakeEvent('s1', 1, 'tool/call', '{}'), fakeEvent('s1', 2, 'tool/result', 'ok')] },
  })
  await seedBaseline(state)
  const record = await runner.start({ mode: 'incremental', trigger: 'manual' })

  assert.equal(record.status, 'completed')
  assert.equal(llmCalls.length, 0)
  assert.equal(state.getCursor('s1')?.lastSeq, 2)
})

test('梦境运行：叙事与洞察收进运行记录（P-034 时间线的数据源）', async () => {
  const { runner, state, memoryTable } = harness({
    sessions: [fakeSession('s1', CREATED)],
    events: { s1: [fakeEvent('s1', 1, 'user/message', '今天部署又炸了')] },
    responses: [ok({ ...EMPTY_OUTPUT, insights: ['部署焦虑反复出现'], narrative: '今晚梦见 boot 清单在闪烁。' })],
  })
  await seedBaseline(state)
  const record = await runner.start({ mode: 'dream', trigger: 'manual' })

  assert.equal(record.mode, 'dream')
  assert.deepEqual(record.insights, ['部署焦虑反复出现'])
  assert.equal(record.narrative, '今晚梦见 boot 清单在闪烁。')
  assert.equal(memoryTable.records.size, 0, '洞察不自动入库')
})

test('梦境开关关闭：dream 运行直接拒绝（不静默降级成增量——手动命令要如实报错）', async () => {
  const { runner, state } = harness({ dreamEnabled: false })
  await seedBaseline(state)
  await assert.rejects(runner.start({ mode: 'dream', trigger: 'manual' }), /梦境模式未启用/)
})

test('互斥：运行中再触发被拒；模块关闭时拒绝', async () => {
  const { runner, state } = harness({
    sessions: [fakeSession('s1', CREATED)],
    events: { s1: [fakeEvent('s1', 1)] },
  })
  await seedBaseline(state)
  const first = runner.start({ mode: 'incremental', trigger: 'manual' })
  await assert.rejects(runner.start({ mode: 'incremental', trigger: 'idle' }), /已有一次整理在运行/)
  await first

  const disabled = harness({ enabled: false })
  await assert.rejects(disabled.runner.start({ mode: 'incremental', trigger: 'manual' }), /未启用/)
})

test('熔断：同一会话连败到上限（3 次）后强制推进游标跳过该批（防无限重试烧钱，P-051）', async () => {
  const { runner, state } = harness({
    sessions: [fakeSession('s1', CREATED)],
    events: { s1: [fakeEvent('s1', 7)] },
    responses: [
      { text: '散文不是 JSON', inputTokens: 10, outputTokens: 5, finishReason: 'stop' },
      { text: '还是散文', inputTokens: 10, outputTokens: 5, finishReason: 'stop' },
    ],
  })
  await seedBaseline(state)
  // 预置两次历史失败（第三击触发熔断）。
  await state.putCursor({ sessionId: 's1', lastSeq: 0, lastRunAt: '', failures: 2 })

  const record = await runner.start({ mode: 'incremental', trigger: 'manual' })
  assert.equal(record.status, 'failed')
  const cursor = state.getCursor('s1')
  assert.equal(cursor.lastSeq, 7, '熔断：游标被推过这批永远消化不动的内容')
  assert.equal(cursor.failures, 0, '熔断后计数清零（下一批重新计）')
  assert.ok(record.error.includes('熔断'), '运行注记必须如实说明跳过了内容（不静默丢）')
})
