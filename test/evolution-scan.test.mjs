/**
 * 扫描层测试：会话过滤、子会话排除、游标推进语义、回扫范围与预算裁剪。
 *
 * 假 sessionQuery **实现了过滤语义**（created-at/cwd/id/seq/surface 的子集）：
 * 这样才能同时钉住两件事——我们**传了什么过滤器**（契约），以及**结果怎么被裁剪**（行为）。
 * 真后端的行为由 TEST 真机验收覆盖（DEV-PLAN §9）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { collectScanTargets } from '../lib/evolution/scan.js'
import { fakeSessionQuery as fakeQuery, fakeSession as session, fakeEvent as event } from './helpers/evolution-fake.mjs'

const BUDGET = { maxSessionsPerRun: 5, maxEventsPerSession: 200 }
const NOW = '2026-09-25T00:00:00.000Z'
const NO_CURSORS = { getCursor: () => undefined }

test('基线未建立：本次建立基线且不扫任何旧会话（P-037 默认不回扫）', async () => {
  const query = fakeQuery([session('old', Date.parse(NOW) - 86400000)], {
    old: [event('old', 1)],
  })
  const result = await collectScanTargets(query, NO_CURSORS, {
    baselineAt: '',
    includeSubSessions: false,
    budget: BUDGET,
    now: NOW,
  })

  assert.equal(result.newBaselineAt, NOW)
  assert.deepEqual(result.targets, [])
})

test('增量：只收基线后创建的会话；事件带 surface=current 过滤', async () => {
  const baseline = '2026-09-20T00:00:00.000Z'
  const query = fakeQuery(
    [session('before', Date.parse(baseline) - 1000), session('after', Date.parse(baseline) + 1000)],
    { after: [event('after', 1), event('after', 2, 'assistant/message', 'ok')] },
  )
  const result = await collectScanTargets(query, NO_CURSORS, {
    baselineAt: baseline,
    includeSubSessions: false,
    budget: BUDGET,
    now: NOW,
  })

  assert.deepEqual(
    result.targets.map((target) => target.sessionId),
    ['after'],
  )
  assert.equal(result.newBaselineAt, '')
  const eventCall = query.calls.find((call) => call.method === 'filterEvents')
  assert.deepEqual(eventCall.filters, [{ kind: 'surface', values: ['current'] }])
})

test('子会话排除：三个标记任一命中即排除；开关打开后纳入（P-036）', async () => {
  const baseline = '2026-09-20T00:00:00.000Z'
  const createdAt = Date.parse(baseline) + 1000
  const sessions = [
    session('main', createdAt),
    session('by-origin', createdAt, { origin: 'subagent' }),
    session('by-depth', createdAt, { delegationDepth: 2 }),
    session('by-parent', createdAt, { parentSession: 'main' }),
  ]
  const events = Object.fromEntries(sessions.map((record) => [record.header.id, [event(record.header.id, 1)]]))

  const strict = await collectScanTargets(fakeQuery(sessions, events), NO_CURSORS, {
    baselineAt: baseline,
    includeSubSessions: false,
    budget: BUDGET,
    now: NOW,
  })
  assert.deepEqual(
    strict.targets.map((target) => target.sessionId),
    ['main'],
  )
  assert.equal(strict.skippedSessions, 3)

  const loose = await collectScanTargets(fakeQuery(sessions, events), NO_CURSORS, {
    baselineAt: baseline,
    includeSubSessions: true,
    budget: BUDGET,
    now: NOW,
  })
  assert.equal(loose.targets.length, 4)
})

test('游标：有水位时从 lastSeq+1 起读；无水位不加 seq 过滤（从头）', async () => {
  const baseline = '2026-09-20T00:00:00.000Z'
  const createdAt = Date.parse(baseline) + 1000
  const query = fakeQuery([session('s1', createdAt), session('s2', createdAt)], {
    s1: [event('s1', 6), event('s1', 7)],
    s2: [event('s2', 1)],
  })
  const cursors = { getCursor: (id) => (id === 's1' ? { sessionId: 's1', lastSeq: 5, lastRunAt: '' } : undefined) }

  const result = await collectScanTargets(query, cursors, {
    baselineAt: baseline,
    includeSubSessions: false,
    budget: BUDGET,
    now: NOW,
  })

  const s1Call = query.calls.find((call) => call.method === 'filterEvents' && call.sessionId === 's1')
  assert.deepEqual(s1Call.filters, [
    { kind: 'surface', values: ['current'] },
    { kind: 'seq', from: 6 },
  ])
  const s2Call = query.calls.find((call) => call.method === 'filterEvents' && call.sessionId === 's2')
  assert.deepEqual(s2Call.filters, [{ kind: 'surface', values: ['current'] }])
  assert.deepEqual(
    result.targets.map((target) => target.fromSeq),
    [5, 0],
  )
})

test('回扫单会话：无视游标从头读，按 id 过滤', async () => {
  const query = fakeQuery([session('s1', 1000)], { s1: [event('s1', 1), event('s1', 2)] })
  const cursors = { getCursor: () => ({ sessionId: 's1', lastSeq: 99, lastRunAt: '' }) }

  const result = await collectScanTargets(query, cursors, {
    baselineAt: '2026-09-20T00:00:00.000Z',
    includeSubSessions: false,
    budget: BUDGET,
    rescan: { kind: 'session', sessionId: 's1' },
    now: NOW,
  })

  const filterCall = query.calls.find((call) => call.method === 'filterSessions')
  assert.deepEqual(filterCall.filters, [{ kind: 'id', values: ['s1'] }])
  assert.equal(result.targets[0].fromSeq, 0)
  assert.equal(result.targets[0].events.length, 2)
})

test('回扫工作区与最近 N 天：过滤器形状正确', async () => {
  const empty = fakeQuery([], {})
  await collectScanTargets(empty, NO_CURSORS, {
    baselineAt: NOW,
    includeSubSessions: false,
    budget: BUDGET,
    rescan: { kind: 'workspace', cwd: '/ws' },
    now: NOW,
  })
  assert.deepEqual(empty.calls[0].filters, [{ kind: 'cwd', values: ['/ws'] }])

  const days = fakeQuery([], {})
  await collectScanTargets(days, NO_CURSORS, {
    baselineAt: NOW,
    includeSubSessions: false,
    budget: BUDGET,
    rescan: { kind: 'days', days: 7 },
    now: NOW,
  })
  assert.deepEqual(days.calls[0].filters, [{ kind: 'created-at', from: Date.parse(NOW) - 7 * 86400000 }])
})

test('预算：会话数超限即停（skipped 如实计数）；单会话事件按 seq 取最早一批', async () => {
  const baseline = '2026-09-20T00:00:00.000Z'
  const createdAt = Date.parse(baseline) + 1000
  const sessions = ['a', 'b', 'c', 'd'].map((id) => session(id, createdAt))
  const events = {
    a: [event('a', 1), event('a', 2), event('a', 3), event('a', 4), event('a', 5)],
    b: [event('b', 1)],
    c: [event('c', 1)],
    d: [event('d', 1)],
  }
  const result = await collectScanTargets(fakeQuery(sessions, events), NO_CURSORS, {
    baselineAt: baseline,
    includeSubSessions: false,
    budget: { maxSessionsPerRun: 2, maxEventsPerSession: 3 },
    now: NOW,
  })

  assert.deepEqual(
    result.targets.map((target) => target.sessionId),
    ['a', 'b'],
  )
  assert.equal(result.skippedSessions, 2)
  // 事件按 seq 升序取最早 3 条：游标语义要求"剩下的下轮接着来"，不是丢尾巴。
  assert.deepEqual(
    result.targets[0].events.map((item) => item.seq),
    [1, 2, 3],
  )
})

test('无新事件的会话：不进 targets 也不算 skipped（游标不动，成本为零）', async () => {
  const baseline = '2026-09-20T00:00:00.000Z'
  const createdAt = Date.parse(baseline) + 1000
  const query = fakeQuery([session('quiet', createdAt)], { quiet: [] })
  const result = await collectScanTargets(query, NO_CURSORS, {
    baselineAt: baseline,
    includeSubSessions: false,
    budget: BUDGET,
    now: NOW,
  })

  assert.deepEqual(result.targets, [])
  assert.equal(result.skippedSessions, 0)
})
