/**
 * 归拢与阶段的测试（2026-11-22）。
 *
 * 这一层是"回忆"和"流水账"的分界：没有它，记忆永远是一件一件排着。
 * 这里钉六件事：
 * 1. **挑谁**：只挑放了半天、还没被吸收的经历；本月的归拢不进"一段时期"（那段日子还没过完）；
 * 2. **什么时候跑**：素材不够不跑，跑过一天之内不再跑；
 * 3. **模型给的怎么收窄**：不存在的编号、条数不够、同一条进两组的，一律丢掉；
 * 4. **合成时取哪个**：代价取最贵、感受取最强 —— 概括不能成为绕过秘密的后门；
 * 5. **写完之后**：原来那几条不再单独出现在回忆里，但记录还在；
 * 6. **模型坏了**：什么都不写，而不是写一条编出来的概括。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  chapterBuckets,
  chapterCandidates,
  consolidate,
  consolidationDue,
  mergeSources,
  periodCandidates,
  pickGroups,
} from '../lib/memory/consolidate.js'
import { createMemoryRecord } from '../lib/memory/model.js'
import { recall, strongest } from '../lib/memory/search.js'

/** 现在：固定一个时刻，所有相对时间都相对它算。 */
const NOW = new Date('2026-11-22T12:00:00.000Z')

/** 一条放了一天的经历（默认 11-01 发生、11-01 写入）。 */
function episode(what, overrides = {}) {
  return {
    ...createMemoryRecord({ what, about: 'us', certain: 'witnessed' }),
    when: '2026-11-01T00:00:00.000Z',
    createdAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  }
}

/** 一条归拢（默认发生在 10 月，已经是过完的月份）。 */
function period(what, overrides = {}) {
  return episode(what, {
    tier: 'period',
    when: '2026-10-05T00:00:00.000Z',
    createdAt: '2026-10-05T00:00:00.000Z',
    ...overrides,
  })
}

/** 假表 + 真 store。 */
function storeOf(records = []) {
  const table = new Map(records.map((record) => [record.id, record]))
  return {
    table,
    store: {
      put: async (record) => {
        table.set(record.id, record)
        return record
      },
      get: (id) => table.get(id),
      all: () => [...table.values()],
      remove: async (id) => table.delete(id),
      touch: async () => undefined,
    },
  }
}

/** 假模型：按顺序回放准备好的文本，并记下每次调用的输入。 */
function llmOf(replies) {
  const calls = []
  const queue = [...replies]
  return {
    calls,
    llm: {
      route: () => ({ provider: 'test', model: 'test' }),
      streamText: async (input) => {
        calls.push(input)
        return { text: queue.shift() ?? '[]', inputTokens: 0, outputTokens: 0, finishReason: 'stop' }
      },
    },
  }
}

/** 静音日志。 */
const log = { info: () => {}, warn: () => {}, error: () => {} }

/* ───────────────────────── 挑谁 ───────────────────────── */

test('候选：只挑放了半天以上、还没被吸收的经历', () => {
  const fresh = episode('刚发生的事', { createdAt: '2026-11-22T11:00:00.000Z' })
  const folded = episode('已经被归拢的事', { covers: [] })
  const merged = period('那阵子的事', { covers: [folded.id] })
  const ready = episode('放了一天的事')

  const candidates = periodCandidates([fresh, folded, merged, ready], NOW)
  assert.deepEqual(candidates.map((record) => record.id), [ready.id])
})

test('候选：按发生时间从早到晚排（模型读时间顺序更容易看出"那阵子"）', () => {
  const later = episode('后来的事', { when: '2026-11-03T00:00:00.000Z' })
  const earlier = episode('早先的事', { when: '2026-11-02T00:00:00.000Z' })
  const candidates = periodCandidates([later, earlier], NOW)
  assert.deepEqual(candidates.map((record) => record.what), ['早先的事', '后来的事'])
})

test('阶段候选：本月的归拢不算（那段日子还没过完）', () => {
  const thisMonth = period('这个月的一类事', { when: '2026-11-10T00:00:00.000Z' })
  const lastMonth = period('上个月的一类事')
  const candidates = chapterCandidates([thisMonth, lastMonth], NOW)
  assert.deepEqual(candidates.map((record) => record.id), [lastMonth.id])
})

test('阶段分组：同一个月不足 3 条不成堆', () => {
  const two = [period('A'), period('B')]
  assert.equal(chapterBuckets(two, NOW).size, 0)
  const three = [period('A'), period('B'), period('C')]
  assert.equal(chapterBuckets(three, NOW).size, 1)
})

/* ───────────────────────── 什么时候跑 ───────────────────────── */

test('该不该跑：素材不够不跑', () => {
  assert.equal(consolidationDue([episode('只有一条')], NOW), false)
  assert.equal(consolidationDue([episode('A'), episode('B')], NOW), false)
})

test('该不该跑：素材够了就跑到（第一次没有冷却）', () => {
  assert.equal(consolidationDue([episode('A'), episode('B'), episode('C')], NOW), true)
})

test('该不该跑：一天之内跑过就不再跑（冷却看库里最新那条概括）', () => {
  const recent = period('刚归拢的', { when: '2026-11-21T00:00:00.000Z', createdAt: '2026-11-22T06:00:00.000Z' })
  const records = [episode('A'), episode('B'), episode('C'), recent]
  assert.equal(consolidationDue(records, NOW), false)
})

/* ───────────────────────── 模型输出 ───────────────────────── */

test('收窄：编号不存在、条数不够都丢掉；about 写坏不算致命（按来源补）', () => {
  const a = episode('A')
  const b = episode('B')
  const c = episode('C')
  const known = new Map([
    ['1', a],
    ['2', b],
    ['3', c],
  ])
  const groups = pickGroups(
    [
      { ids: ['1', '7', '2'], what: '只有两条有效', about: 'us' },
      { ids: ['#1', ' 2 ', '3'], what: '这条成立', about: '瞎写' },
    ],
    known,
    3,
  )
  assert.equal(groups.length, 1)
  assert.equal(groups[0].what, '这条成立', '编号上的 # 与空格要剥掉')
  assert.equal(groups[0].about, 'us', '模型写坏 about 时按来源投票补上，而不是丢掉这条')
})

test('收窄：字段名写成 summary 也认（免得因为一个别名白丢一次归拢）', () => {
  const a = episode('A')
  const b = episode('B')
  const c = episode('C')
  const known = new Map([
    ['1', a],
    ['2', b],
    ['3', c],
  ])
  const groups = pickGroups([{ ids: ['1', '2', '3'], summary: '那阵子的事', about: 'us' }], known, 3)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].what, '那阵子的事')
})

test('收窄：同一条经历不能进两条概括（否则同一件事会被说两遍）', () => {
  const a = episode('A')
  const b = episode('B')
  const c = episode('C')
  const d = episode('D')
  const known = new Map([
    ['1', a],
    ['2', b],
    ['3', c],
    ['4', d],
  ])
  const groups = pickGroups(
    [
      { ids: ['1', '2', '3'], what: '第一组', about: 'us' },
      { ids: ['3', '4', '1'], what: '第二组', about: 'us' },
    ],
    known,
    3,
  )
  assert.deepEqual(groups.map((group) => group.what), ['第一组'], '第二组和第一组抢了同两条')
})

/* ───────────────────────── 合成一条 ───────────────────────── */

test('合成：代价取最贵、感受取最强、时间取最新、确定度记 inferred', () => {
  const cheap = episode('轻的事', { cost: 0.1, felt: { kind: 'joy', intensity: 20 }, when: '2026-11-01T00:00:00.000Z' })
  const costly = episode('重的事', { cost: 0.8, costWhy: '说出来就没法收场', when: '2026-11-02T00:00:00.000Z' })
  const strong = episode('扎人的事', { cost: 0.2, felt: { kind: 'sadness', intensity: 90 }, when: '2026-11-03T00:00:00.000Z' })

  const merged = mergeSources([cheap, costly, strong], 'us', '那阵子的事', 'period', NOW)
  assert.equal(merged.cost, 0.8, '概括不能比它收进来的任何一条更容易说出口')
  assert.equal(merged.costWhy, '说出来就没法收场')
  assert.deepEqual(merged.felt, { kind: 'sadness', intensity: 90 }, '那阵子里最扎人的一下就是这段的味道')
  assert.equal(merged.when, '2026-11-03T00:00:00.000Z', '时间取最新的那一件')
  assert.equal(merged.certain, 'inferred', '这是从小事里推出来的，不是亲眼看见的一件具体事')
  assert.equal(merged.tier, 'period')
  assert.deepEqual(merged.covers, [cheap.id, costly.id, strong.id])
})

/* ───────────────────────── 整条路 ───────────────────────── */

test('归拢：三条同类 → 一条概括，原来那几条不再单独出现在回忆里', async () => {
  const a = episode('我和小明在园子里散步')
  const b = episode('我和小明又去园子里散步')
  const c = episode('我和小明还是在园子里散步')
  const { store, table } = storeOf([a, b, c])
  const { llm, calls } = llmOf([JSON.stringify([{ ids: ['1', '2', '3'], what: '那阵子我们常在园子里散步', about: 'us' }])])

  const written = await consolidate(store, { llm, log, now: () => NOW })
  assert.equal(calls.length, 1, '只调一次模型')
  assert.equal(written.length, 1)
  assert.equal(written[0].tier, 'period')
  assert.equal(table.size, 4, '原来的三条还在（不删），多了一条概括')

  // 回忆只给概括：那三条已经被它代表了。
  const hits = recall(store.all(), '小明 散步', { now: NOW })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].record.id, written[0].id)

  // "最牢的几条"也不该再翻出明细。
  const top = strongest(store.all(), 10, NOW)
  assert.equal(top.some((hit) => [a.id, b.id, c.id].includes(hit.record.id)), false)
})

test('归拢：模型吐了不是 JSON 的东西 → 一条都不写（宁可没有，不要编）', async () => {
  const records = [episode('A'), episode('B'), episode('C')]
  const { store, table } = storeOf(records)
  const { llm } = llmOf(['我今天心情不错，不想干活'])

  const written = await consolidate(store, { llm, log, now: () => NOW })
  assert.deepEqual(written, [])
  assert.equal(table.size, 3, '库里一条没多')
})

test('阶段：上个月三条归拢 → 一条"那阵子"，那三条不再单独出现', async () => {
  const p1 = period('我们那阵子总在夜里聊天')
  const p2 = period('我们那阵子总在夜里聊天（二）')
  const p3 = period('我们那阵子总在夜里聊天（三）')
  const { store, table } = storeOf([p1, p2, p3])
  const { llm, calls } = llmOf([JSON.stringify([{ ids: ['1', '2', '3'], what: '十月那阵子我们不太顺', about: 'us' }])])

  const written = await consolidate(store, { llm, log, now: () => NOW })
  assert.equal(calls.length, 1, '没有经历可归拢，只跑阶段这一次')
  assert.equal(written.length, 1)
  assert.equal(written[0].tier, 'chapter')
  assert.equal(table.size, 4)

  const hits = recall(store.all(), '夜里聊天', { now: NOW })
  assert.deepEqual(hits.map((hit) => hit.record.tier), ['chapter'], '只剩那一段时期')
})

test('冷却：刚归拢过就再调，不再花钱调模型', async () => {
  const recent = period('刚归拢的', { when: '2026-11-21T00:00:00.000Z', createdAt: '2026-11-22T06:00:00.000Z' })
  const records = [episode('A'), episode('B'), episode('C'), recent]
  const { store } = storeOf(records)
  const { llm, calls } = llmOf([])

  const written = await consolidate(store, { llm, log, now: () => NOW })
  assert.deepEqual(written, [])
  assert.equal(calls.length, 0, '冷却期内一次模型调用都不该有')
})
