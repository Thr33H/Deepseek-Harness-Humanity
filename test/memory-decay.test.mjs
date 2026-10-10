/**
 * 衰减与归档的行为测试（P-026）。
 *
 * 时间全部显式传入（`runDecayCycle(store, policy, now)`），所以这些用例是**确定**的：
 * 不依赖真实时钟，也不会在某个下午突然变红。每条用例都同时断言"该动的动了"与"不该动的没动"——
 * 衰减最危险的错误方向是**误伤**（把重要的、稳定的、用户标记过的记忆降权或归档）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ARCHIVE_IMPORTANCE } from '../lib/memory/constants.js'
import { maybeRunDecay, resetDecaySweepForTest, runDecayCycle } from '../lib/memory/decay.js'
import { createMemoryEntry } from '../lib/memory/model.js'
import { resolveMemoryPolicy } from '../lib/memory/policy.js'
import { searchMemory } from '../lib/memory/search.js'
import { applyMemoryRequest } from '../lib/memory/ops.js'
import { createMemoryStore } from '../lib/memory/store.js'
import { createFakeTable } from './helpers/memory-fake.mjs'

/** 基准时刻：所有用例都用它算"多少天前"。 */
const NOW = '2026-09-24T00:00:00.000Z'
const balanced = resolveMemoryPolicy('balanced')

/** `days` 天前的 ISO 时刻。 */
function daysAgo(days) {
  return new Date(Date.parse(NOW) - days * 86_400_000).toISOString()
}

/** 写入一条记忆：默认是"很早写下、从没用过"的低重要度条目。 */
async function seed(store, content, overrides = {}) {
  const entry = createMemoryEntry({
    scope: 'long-term',
    content,
    origin: 'agent-derived',
    sourceSessionId: 's1',
    status: 'active',
    confidence: 0.6,
    importance: 3,
    createdAt: daysAgo(200),
    updatedAt: daysAgo(200),
    ...overrides,
  })
  await store.put(entry)
  return entry
}

/** 起一个空存储。 */
function boot() {
  return createMemoryStore(createFakeTable())
}

test('30 天未用：还在窗口内，完全不衰减（"长期未用"要 90 天）', async () => {
  const store = boot()
  await seed(store, '用户偏好简短回复', { updatedAt: daysAgo(30) })

  const report = await runDecayCycle(store, balanced, NOW)

  assert.deepEqual(report, { scanned: 1, decayed: 0, archived: 0, protectedCount: 0, skippedFresh: 1 })
  assert.equal(store.list()[0].importance, 3)
  assert.equal(store.list()[0].status, 'active')
})

test('95 天未用 + 低重要度：先降权（3 → 2），还没到归档线', async () => {
  const store = boot()
  await seed(store, '用户偏好简短回复', { importance: 3, updatedAt: daysAgo(95) })

  const report = await runDecayCycle(store, balanced, NOW)

  assert.equal(report.decayed, 1)
  assert.equal(report.archived, 0)
  assert.equal(store.list()[0].importance, 2, '降了一档，但仍在生效')
  assert.equal(store.list()[0].status, 'active')
})

test('120 天未用：降到归档线以下 ⇒ 归档（数据仍在，默认检索不到）', async () => {
  const store = boot()
  await seed(store, '用户偏好简短回复', { importance: 3, updatedAt: daysAgo(120), tags: ['偏好'] })

  const report = await runDecayCycle(store, balanced, NOW)

  assert.equal(report.archived, 1)
  const archived = store.list(undefined, 'archived')[0]
  assert.ok(archived.importance < ARCHIVE_IMPORTANCE, '归档记录带的是**降权后**的分值')
  assert.ok(archived.archivedAt.length > 0)

  const hits = await searchMemory(store, balanced, {
    message: '偏好',
    sessionId: 's1',
    workspaceId: '',
  })
  assert.deepEqual(hits, [], '归档后检索不到（P-026：默认检索不命中归档）')
})

test('归档可调回：restore 之后重新可检索（数据没被删）', async () => {
  const store = boot()
  await seed(store, '用户偏好简短回复', { importance: 2, updatedAt: daysAgo(200), tags: ['偏好'] })
  await runDecayCycle(store, balanced, NOW)
  const key = store.list(undefined, 'archived')[0].dedupeKey

  const restored = await store.restore(key)
  assert.equal(restored?.status, 'active')

  const hits = await searchMemory(store, balanced, { message: '偏好', sessionId: 's1', workspaceId: '' })
  assert.equal(hits.length, 1, '调回后立刻能检索到')
})

test('受保护的三类不衰减：用户标记、稳定事实、重要记忆（P-026）', async () => {
  const store = boot()
  await seed(store, '用户标记保留的', { pinned: true, updatedAt: daysAgo(300) })
  await seed(store, '用户明确说过的', { confidence: 1, updatedAt: daysAgo(300) })
  await seed(store, '重要偏好', { importance: 5, updatedAt: daysAgo(300) })
  await seed(store, '应该被归档的', { importance: 2, updatedAt: daysAgo(300) })

  const report = await runDecayCycle(store, balanced, NOW)

  assert.equal(report.protectedCount, 3)
  assert.equal(report.archived, 1)
  for (const entry of store.list(undefined, 'active')) {
    assert.ok(entry.importance >= 2, `${entry.content} 不该被降权`)
  }
  assert.deepEqual(
    store.list(undefined, 'active').map((entry) => entry.content).sort(),
    ['用户标记保留的', '用户明确说过的', '重要偏好'].sort(),
  )
})

test('最近用过的：不衰减（用 lastUsedAt 判定，与写入时间无关）', async () => {
  const store = boot()
  // 很久以前写下的，但昨天刚被检索命中过 ⇒ 不算"长期未用"。
  await seed(store, '老但常用', { importance: 3, updatedAt: daysAgo(300), lastUsedAt: daysAgo(1) })
  // 对照组：同样老，但从未用过。
  await seed(store, '老且没用过', { importance: 3, updatedAt: daysAgo(300) })

  const report = await runDecayCycle(store, balanced, NOW)

  const byContent = new Map(store.list().map((entry) => [entry.content, entry]))
  assert.equal(byContent.get('老但常用').importance, 3, '用过就重新计时')
  assert.equal(byContent.get('老且没用过').importance, 0, '没用过的照常降权')
  assert.equal(report.archived, 1)
})

test('衰减关掉时什么都不动：模式 off 与显式的 decay=false 都算', async () => {
  const store = boot()
  await seed(store, '用户偏好简短回复', { importance: 2, updatedAt: daysAgo(300) })

  const off = await runDecayCycle(store, resolveMemoryPolicy('off'), NOW)
  const disabled = await runDecayCycle(store, resolveMemoryPolicy('balanced', { decay: false }), NOW)

  assert.deepEqual(off, { scanned: 0, decayed: 0, archived: 0, protectedCount: 0, skippedFresh: 0 })
  assert.deepEqual(disabled, { scanned: 0, decayed: 0, archived: 0, protectedCount: 0, skippedFresh: 0 })
  assert.equal(store.list()[0].importance, 2)
  assert.equal(store.list()[0].status, 'active')
})

test('空库：零报告，不报错；重复跑是幂等的', async () => {
  const store = boot()
  assert.deepEqual(await runDecayCycle(store, balanced, NOW), {
    scanned: 0,
    decayed: 0,
    archived: 0,
    protectedCount: 0,
    skippedFresh: 0,
  })

  await seed(store, '用户偏好简短回复', { importance: 2, updatedAt: daysAgo(200) })
  const first = await runDecayCycle(store, balanced, NOW)
  const second = await runDecayCycle(store, balanced, NOW)
  assert.equal(first.archived, 1)
  assert.deepEqual(second, { scanned: 0, decayed: 0, archived: 0, protectedCount: 0, skippedFresh: 0 }, '归档过的不再参与')
})

test('窗口与半衰期可调：把窗口调到 10 天，30 天未用的条目就开始衰减', async () => {
  const store = boot()
  await seed(store, '用户偏好简短回复', { importance: 3, updatedAt: daysAgo(30) })

  const impatient = resolveMemoryPolicy('balanced', { decayUnusedDays: 10, decayHalfLifeDays: 10 })
  const report = await runDecayCycle(store, impatient, NOW)

  assert.equal(report.decayed + report.archived, 1, '窗口调小后不再受保护于 90 天')
})

test('检索时顺带核算：到期跑一次，24 小时内不重复（免得每轮对话都全表维护）', async () => {
  resetDecaySweepForTest()
  const store = boot()
  await seed(store, '用户偏好简短回复', { importance: 2, updatedAt: daysAgo(300), content: '用户喜欢喝咖啡' })

  const ran = await maybeRunDecay(store, balanced, NOW)
  assert.equal(ran, true)
  assert.equal(store.list(undefined, 'archived').length, 1, '顺带那次真的归档了')

  const second = await maybeRunDecay(store, balanced, new Date(Date.parse(NOW) + 3_600_000).toISOString())
  assert.equal(second, false, '一小时后再调不会重复跑')
})

test('工作台手动触发「整理记忆」：跑一次并把结果说清楚', async () => {
  const store = boot()
  await seed(store, '用户偏好简短回复', { importance: 3, updatedAt: daysAgo(120), content: '用户喜欢喝咖啡' })

  const message = await applyMemoryRequest(store, balanced, { op: 'decay', fingerprint: '' })

  assert.match(message, /记忆维护完成/)
  assert.match(message, /归档 1 条/)
  const empty = await applyMemoryRequest(store, balanced, { op: 'decay', fingerprint: '' })
  assert.match(empty, /没有需要衰减的条目/)
})
