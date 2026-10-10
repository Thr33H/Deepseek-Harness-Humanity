/**
 * 检索引擎测试：分词 / 评分 / 检索三层各钉一件事。
 *
 * 为什么必须有"无关记忆不得命中"这一组：检索的错误方向不是"漏掉一条"，
 * 而是"塞进一条不相关的记忆"—— 后者会污染提示词、让模型把别的话题的偏好当成本轮的约束。
 * 所以每个命中用例都配一条无关对照。
 */
import assert from 'node:assert/strict'
import { after, mock, test } from 'node:test'
import { RELEVANCE_THRESHOLD } from '../lib/memory/constants.js'
import { createMemoryEntry } from '../lib/memory/model.js'
import { resolveMemoryPolicy } from '../lib/memory/policy.js'
import { breakdownOf, scoreEntry, WEIGHTS } from '../lib/memory/scoring.js'
import { searchMemory } from '../lib/memory/search.js'
import { createMemoryStore } from '../lib/memory/store.js'
import { tokenize } from '../lib/memory/tokenize.js'
import { createFakeTable } from './helpers/memory-fake.mjs'

const NOW = '2026-09-24T05:00:00.000Z'

/**
 * 时间夹具：把本文件的 `Date` 冻结在 `NOW`（同 `memory-inject.test.mjs`，这里也曾经是时间炸弹）。
 *
 * 本文件的多条用例把夹具记忆的写入时刻固定为 `NOW`，却走真实检索路径 —— 而 `rankMemories`
 * 取的是**墙钟**（`src/host/memory/search.ts`）。新鲜度信号（权重 0.1）于是随运行日期线性衰减：
 * 实测 `关键词命中` 一例在 2026-11-11 还绿、2026-11-13 已红；`limit 生效` 一例在
 * 2026-12-17~12-24 之间转红。把"现在"钉死在 `NOW`，检索时刻与写入时刻永远同刻，新鲜度恒为 1。
 * 只冻 `Date`，不碰 `setTimeout`/`setImmediate`。
 */
mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) })
after(() => mock.timers.reset())
const balanced = resolveMemoryPolicy('balanced')

/** 造一条记忆并写进存储；返回它的指纹。 */
async function seed(store, content, overrides = {}) {
  const entry = createMemoryEntry({
    scope: 'long-term',
    content,
    origin: 'agent-derived',
    sourceSessionId: 's1',
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  })
  await store.put(entry)
  return entry.dedupeKey
}

/** 起一个带内容的存储。 */
async function boot(seedRows = []) {
  const store = createMemoryStore(createFakeTable())
  for (const [content, overrides] of seedRows) await seed(store, content, overrides)
  return store
}

test('分词：中文出二元组、英文出单词、停用词与标点丢掉', () => {
  const tokens = tokenize('我喜欢喝咖啡，and the Coffee!')
  assert.ok(tokens.has('咖啡'), '「咖啡」必须是一个可匹配的单元')
  assert.ok(tokens.has('喜欢'))
  assert.ok(tokens.has('coffee'), '英文按单词（已小写）')
  assert.equal(tokens.has('and'), false, '停用词不参与匹配')
  assert.equal(tokens.has('the'), false)
  assert.deepEqual([...tokenize('   ')], [], '空转空白得到空集')
})

test('关键词命中 → 返回；无关记忆 → 被阈值挡住（空着比塞错安全）', async () => {
  const store = await boot([
    ['用户喜欢喝咖啡', { tags: ['饮品'] }],
    ['用户住在示例城市', {}],
  ])

  const hits = await searchMemory(store, balanced, {
    message: '今天想喝咖啡',
    sessionId: 's1',
    workspaceId: '',
  })

  assert.equal(hits.length, 1)
  assert.equal(hits[0].content, '用户喜欢喝咖啡')
})

test('标签命中 → 返回（标签是强信号）', async () => {
  const store = await boot([['用户的口味偏好', { tags: ['咖啡'] }]])

  const hits = await searchMemory(store, balanced, {
    message: '咖啡',
    sessionId: 's1',
    workspaceId: '',
  })

  assert.equal(hits.length, 1)
  assert.equal(hits[0].content, '用户的口味偏好')
})

test('作用域：内容相同、只有作用域不同时，当前工作区的记忆排前面', async () => {
  // 两条**内容一模一样**的记忆，只有作用域与归属不同：这样比较的才是 scope 信号本身，
  // 而不是"谁的关键词碰巧多"。
  const content = '构建工具用 pnpm'
  const store = await boot([
    [content, { scope: 'workspace', ownerId: '/work/shop' }],
    [content, {}],
  ])
  const message = '构建工具用 pnpm 装依赖'

  const inWorkspace = await searchMemory(store, balanced, { message, sessionId: 's1', workspaceId: '/work/shop' })
  assert.equal(inWorkspace.length, 2, '两条都过阈值（内容命中足够多）')
  assert.equal(inWorkspace[0].scope, 'workspace', '同一工作区的记忆优先于长期记忆')

  const another = await searchMemory(store, balanced, { message, sessionId: 's1', workspaceId: '/work/other' })
  assert.equal(another.length, 1, '别的工作区的记忆**根本不参与**（不是"排后面"）')
  assert.equal(another[0].scope, 'long-term', '换了工作区，工作记忆不再优先')

  const noWorkspace = await searchMemory(store, balanced, { message, sessionId: 's1', workspaceId: '' })
  assert.equal(noWorkspace.length, 1, '没有工作区上下文时也不带别处的区域记忆')
  assert.equal(noWorkspace[0].scope, 'long-term', '没有工作区上下文时长期记忆优先（§4.2.1）')
})

test('区域记忆不跨区泄露：归属对不上就一条都不给（2026-09-26 审计实测的真缺陷）', async () => {
  // 旧实现只对会话层设卡：区域记忆在别的工作区里只是**扣 0.15 分**，照样越过默认阈值被检索、
  // 被注入 ——「只在某个工作目录里被想起」就成了空话。归属读不到时也不猜（宁可不注入）。
  const store = await boot([['这个仓库的构建工具是 pnpm', { scope: 'workspace', ownerId: '/work/shop' }]])
  const message = '这个仓库的构建工具是 pnpm'

  const same = await searchMemory(store, balanced, { message, sessionId: 's1', workspaceId: '/work/shop' })
  assert.equal(same.length, 1, '本工作区照常命中')

  for (const [label, workspaceId] of [['别的工作区', '/work/other'], ['没有工作区', '']]) {
    const hits = await searchMemory(store, balanced, { message, sessionId: 's1', workspaceId })
    assert.deepEqual(hits, [], `${label}里不许出现别处的区域记忆`)
  }
})

test('会话记忆不跨会话：别的会话的记录一律不参与', async () => {
  const store = await boot([['这次讨论用中文', { scope: 'session', ownerId: 'other-session' }]])

  const hits = await searchMemory(store, balanced, {
    message: '这次讨论用中文',
    sessionId: 's1',
    workspaceId: '',
  })

  assert.deepEqual(hits, [])
})

test('排序：同等关键词下重要度高的排前面；分数相同时顺序稳定', async () => {
  const store = await boot([
    ['用户喜欢喝咖啡', { importance: 1 }],
    ['用户喜欢喝咖啡（重要）', { importance: 5 }],
  ])

  const hits = await searchMemory(store, balanced, {
    message: '咖啡',
    sessionId: 's1',
    workspaceId: '',
  })

  assert.equal(hits.length, 2)
  assert.equal(hits[0].importance, 5)
})

test('条数上限与阈值都来自策略：limit 生效、阈值可调严', async () => {
  const store = await boot([
    ['用户喜欢喝咖啡', {}],
    ['用户喜欢喝茶', {}],
  ])

  const limited = await searchMemory(store, balanced, {
    message: '咖啡 茶',
    sessionId: 's1',
    workspaceId: '',
  }, { limit: 1 })
  assert.equal(limited.length, 1)

  const strict = await searchMemory(store, balanced, {
    message: '咖啡 茶',
    sessionId: 's1',
    workspaceId: '',
  }, { threshold: 0.99 })
  assert.deepEqual(strict, [], '阈值调到 1 就什么都不返回')

  const relaxed = await searchMemory(store, resolveMemoryPolicy('balanced', { scopes: { 'long-term': false } }), {
    message: '咖啡',
    sessionId: 's1',
    workspaceId: '',
  })
  assert.deepEqual(relaxed, [], '作用域关掉后该层不参与检索')
})

test('归档记忆不被检索到（P-026：默认只查 active）', async () => {
  const store = await boot([['用户喜欢喝咖啡', {}]])
  const key = store.list()[0].dedupeKey
  await store.archive(key)

  const hits = await searchMemory(store, balanced, {
    message: '咖啡',
    sessionId: 's1',
    workspaceId: '',
  })

  assert.deepEqual(hits, [])
})

test('空库、空消息都返回空数组（不抛）', async () => {
  const store = await boot()
  assert.deepEqual(await searchMemory(store, balanced, { message: '咖啡', sessionId: 's1', workspaceId: '' }), [])
  assert.deepEqual(
    await searchMemory(store, balanced, { message: '   ！ ', sessionId: 's1', workspaceId: '' }),
    [],
  )
})

test('命中的条目会被记一次"被使用"（衰减要靠它）；干跑时可以不记', async () => {
  const store = await boot([['用户喜欢喝咖啡', {}]])
  const key = store.list()[0].dedupeKey

  await searchMemory(store, balanced, { message: '咖啡', sessionId: 's1', workspaceId: '' })
  assert.equal(store.get(key)?.useCount, 1)
  assert.ok((store.get(key)?.lastUsedAt ?? '').length > 0)

  await searchMemory(store, balanced, { message: '咖啡', sessionId: 's1', workspaceId: '' }, { markUsed: false })
  assert.equal(store.get(key)?.useCount, 1, '干跑不该推进统计')
})

test('评分是纯函数：同样的输入给同样的分，且总分等于各分量之和', () => {
  const entry = createMemoryEntry({
    scope: 'long-term',
    content: '用户喜欢喝咖啡',
    origin: 'user-stated',
    sourceSessionId: 's1',
    status: 'active',
    tags: ['咖啡'],
    importance: 4,
    createdAt: NOW,
    updatedAt: NOW,
  })
  const input = {
    entry,
    queryTokens: tokenize('想喝咖啡'),
    context: { sessionId: 's1', workspaceId: '' },
    now: NOW,
  }

  const parts = breakdownOf(input)
  const total = Object.values(parts).reduce((sum, value) => sum + value, 0)
  assert.equal(scoreEntry(input), total)
  assert.ok(total > RELEVANCE_THRESHOLD, '相关命中必须明显高于阈值')
  assert.equal(parts.tag, WEIGHTS.tag, '标签命中拿满该信号权重')

  const unrelated = { ...input, queryTokens: tokenize('明天几点开会') }
  assert.ok(scoreEntry(unrelated) < RELEVANCE_THRESHOLD, `无关话题必须被阈值挡住（实际 ${scoreEntry(unrelated)}）`)
})
