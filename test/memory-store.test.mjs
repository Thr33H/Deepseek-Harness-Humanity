/**
 * 记忆存储面（`createMemoryStore` / `installMemory`）的行为测试。
 *
 * 用 **Map 假表**而不是真后端：这一层要钉的是 CRUD 语义（去重时保留什么、归档与恢复怎么改状态、
 * 列表顺序与过滤），与"数据怎么落盘"无关；落盘与旧文件兼容由 `host-store-migration.test.mjs`
 * 用**真实后端**覆盖。两层各测各的，不互相冒充。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createLog } from '../lib/log.js'
import { installMemory } from '../lib/memory/index.js'
import { createMemoryEntry } from '../lib/memory/model.js'
import { createMemoryStore } from '../lib/memory/store.js'
import { createFakeTable } from './helpers/memory-fake.mjs'

/** 造一条记忆；`overrides` 用来固定状态/作用域/时间等被断言字段。 */
function entry(content, overrides = {}) {
  return { ...createMemoryEntry({ scope: 'long-term', content, origin: 'agent-derived', sourceSessionId: 's1' }), ...overrides }
}

test('写入后能按指纹读回，并按作用域/状态列出', async () => {
  const store = createMemoryStore(createFakeTable())
  const longTerm = entry('用户偏好简短回复')
  const session = entry('这次讨论用中文', { scope: 'session', ownerId: 's1', status: 'active' })

  await store.put(longTerm)
  await store.put(session)

  assert.equal(store.get(longTerm.dedupeKey)?.content, '用户偏好简短回复')
  assert.equal(store.list().length, 2)
  assert.deepEqual(
    store.list('session').map((item) => item.content),
    ['这次讨论用中文'],
  )
  // 新条目默认待确认；待确认的东西不在 active 列表里。
  assert.deepEqual(
    store.list(undefined, 'active').map((item) => item.content),
    ['这次讨论用中文'],
  )
  assert.deepEqual(
    store.list('long-term', 'pending').map((item) => item.content),
    ['用户偏好简短回复'],
  )
})

test('同一指纹再次写入是更新而不是新增，且不重置创建时间与使用统计', async () => {
  const table = createFakeTable()
  const store = createMemoryStore(table)
  const first = await store.put(entry('用户偏好简短回复'))

  // 手工把使用统计改掉，模拟"这条已经被用过 5 次"。
  const used = { ...first, useCount: 5, lastUsedAt: '2026-09-24T00:00:00.000Z' }
  await table.put(used.dedupeKey, used)

  const again = await store.put(entry('用户偏好简短回复。'))
  assert.equal(store.list().length, 1, '同一条事实只能有一行')
  assert.equal(again.content, '用户偏好简短回复。', '内容以新写入为准')
  assert.equal(again.createdAt, first.createdAt, '创建时间沿用已存记录')
  assert.equal(again.useCount, 5, '重新写一遍不等于被使用过')
  assert.equal(again.lastUsedAt, '2026-09-24T00:00:00.000Z')
})

test('列表顺序固定为最近更新在前', async () => {
  const store = createMemoryStore(createFakeTable())
  await store.put(entry('早的', { id: 'a', updatedAt: '2026-09-01T00:00:00.000Z' }))
  await store.put(entry('晚的', { id: 'b', updatedAt: '2026-09-20T00:00:00.000Z' }))

  assert.deepEqual(
    store.list().map((item) => item.content),
    ['晚的', '早的'],
  )
})

test('删除返回是否真的删掉了', async () => {
  const store = createMemoryStore(createFakeTable())
  const item = await store.put(entry('会被删掉'))

  assert.equal(await store.remove(item.dedupeKey), true)
  assert.equal(await store.remove(item.dedupeKey), false, '再删一次是"本来就没有"')
  assert.equal(store.get(item.dedupeKey), undefined)
})

test('归档只改状态不删数据、不动内容时间；恢复回 active', async () => {
  const store = createMemoryStore(createFakeTable())
  const item = await store.put(entry('旧偏好', { status: 'active' }))

  const archived = await store.archive(item.dedupeKey)
  assert.equal(archived?.status, 'archived')
  assert.ok((archived?.archivedAt ?? '').length > 0, '归档要盖时刻')
  assert.equal(archived?.updatedAt, item.updatedAt, '归档不是内容变更，不刷新 updatedAt')
  assert.equal(store.get(item.dedupeKey)?.content, '旧偏好', '归档不删数据（P-026）')
  assert.deepEqual(store.list(undefined, 'active'), [])

  const restored = await store.restore(item.dedupeKey)
  assert.equal(restored?.status, 'active')
  assert.equal(restored?.archivedAt, '')
  assert.equal(store.list(undefined, 'active').length, 1)
})

test('归档/恢复对不存在的指纹（或未归档的条目）返回 undefined，不抛错', async () => {
  const store = createMemoryStore(createFakeTable())
  const item = await store.put(entry('还在用', { status: 'active' }))

  assert.equal(await store.archive('long-term:不存在'), undefined)
  assert.equal(await store.restore(item.dedupeKey), undefined, '没归档就无所谓"恢复"')
})

test('installMemory：存储没就绪时 store() 为 undefined；就绪后即可读写，句柄现读现用', async () => {
  const ctx = new Context()
  const log = createLog(ctx, 'test')
  let opened
  const module = installMemory(ctx, log, {
    mode: () => 'balanced',
    store: () => opened,
  })

  assert.equal(module.policy().injectLimit, 3)
  assert.equal(module.store(), undefined, '存储未就绪必须降级为 undefined，而不是抛错（G-002）')

  opened = {
    installedAt: '2026-01-01T00:00:00.000Z',
    memory: createFakeTable(),
    recordHistory: async () => {},
    historyCount: () => 0,
    close: async () => {},
  }
  const store = module.store()
  assert.ok(store !== undefined, '存储就绪后同一个模块句柄应当立刻可用')

  const item = await store.put(entry('存储后挂载也能写'))
  assert.equal(store.get(item.dedupeKey)?.content, '存储后挂载也能写')

  await ctx.fiber.dispose()
})
