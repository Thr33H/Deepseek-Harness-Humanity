/**
 * 记忆工作台投影的测试（2026-11-21）。
 *
 * 投影是"给定记录 + 时刻 ⇒ 确定的文档"，所以它能在单元测试里完全钉死。
 * 这里钉四件事：
 * 1. **最近的排在前**（工作台是时间线，不是数据库页面）；
 * 2. **强度在读的时候算**（库里那份是"上次想起时"的值，直接显示会显得她一直没忘）；
 * 3. **统计不受截断影响**（界面要能说"这是最近 200 条，你一共有 2871 条"）；
 * 4. **存储没就绪时说"读不到"而不是"没有记忆"**（两件事必须分得开）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createMemoryRecord } from '../lib/memory/model.js'
import { peekReaction } from '../lib/memory/reaction.js'
import { projectMemoryDocument, recallViewOf, removeMemory, reveal } from '../lib/memory/section-runtime.js'
import { VIEW_LIMIT } from '../lib/memory/section-doc.js'

/** 造一条记忆，可指定发生时间。 */
function recordOf(what, when, overrides = {}) {
  return createMemoryRecord({ what, about: 'user', certain: 'told', when, ...overrides })
}

test('投影：最近发生的排在最前', () => {
  const now = new Date('2026-11-21T12:00:00.000Z')
  const records = [
    recordOf('上周的事', '2026-11-14T00:00:00.000Z'),
    recordOf('昨天的事', '2026-11-20T00:00:00.000Z'),
    recordOf('前天的事', '2026-11-19T00:00:00.000Z'),
  ]
  const doc = projectMemoryDocument(records, now, true)
  assert.deepEqual(
    doc.entries.map((entry) => entry.what),
    ['昨天的事', '前天的事', '上周的事'],
  )
})

test('投影：强度按"现在"算，而不是库里那一刻的值', () => {
  const created = '2026-09-01T00:00:00.000Z'
  // 到期衰减的基准是"写入时刻"（`createdAt`），所以要连它一起往前挪 —— 只改 `when` 不算数。
  const record = { ...recordOf('很久以前的事', created), createdAt: created }
  const fresh = projectMemoryDocument([record], new Date(created), true)
  const agedDoc = projectMemoryDocument([record], new Date('2026-11-01T00:00:00.000Z'), true)
  assert.ok(agedDoc.entries[0].strength < fresh.entries[0].strength, '两个月后应当更淡')
})

test('投影：统计算全库，条目只带最近 200 条', () => {
  const records = Array.from({ length: VIEW_LIMIT + 25 }, (_, index) =>
    recordOf(`第 ${index} 件`, new Date(Date.UTC(2026, 0, 1) + index * 3600_000).toISOString()),
  )
  const doc = projectMemoryDocument(records, new Date('2026-11-21T12:00:00.000Z'), true)
  assert.equal(doc.entries.length, VIEW_LIMIT, `只带 ${VIEW_LIMIT} 条`)
  assert.equal(doc.stats.total, VIEW_LIMIT + 25, '但总数如实')
})

test('投影：统计按档位分开数，被想起过的也单独数', () => {
  const records = [
    recordOf('A', '2026-11-20T00:00:00.000Z', { tier: 'episode' }),
    recordOf('B', '2026-11-19T00:00:00.000Z', { tier: 'episode' }),
    recordOf('C', '2026-11-18T00:00:00.000Z', { tier: 'period' }),
    { ...recordOf('D', '2026-11-17T00:00:00.000Z'), recalled: 3 },
  ]
  const doc = projectMemoryDocument(records, new Date('2026-11-21T12:00:00.000Z'), true)
  assert.equal(doc.stats.total, 4)
  assert.equal(doc.stats.episode, 3)
  assert.equal(doc.stats.period, 1)
  assert.equal(doc.stats.chapter, 0)
  assert.equal(doc.stats.recalled, 1)
})

test('投影：存储没就绪时 storeReady 为假，条目为空', () => {
  const doc = projectMemoryDocument([], new Date(), false)
  assert.equal(doc.storeReady, false)
  assert.deepEqual(doc.entries, [])
  assert.equal(doc.stats.total, 0)
})

/* ───────────────────────── 被窥探 ───────────────────────── */

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

test('被窥探：看穿之后，那条秘密的代价归零，而且她记下了这件事', async () => {
  const secret = createMemoryRecord({ what: '我一直没敢说的那件事', about: 'self', certain: 'witnessed', cost: 0.9 })
  const { store, table } = storeOf([secret])
  const notice = await reveal(store, secret.id, '小明', new Date('2026-11-21T12:00:00.000Z'))

  assert.match(notice, /她记得你看了/)

  // ① 秘密不再是秘密：代价降下来了（但她没忘掉那件事本身）。
  const after = table.get(secret.id)
  assert.equal(after.cost, 0, '被看穿之后就不用再瞒了')
  assert.equal(after.what, '我一直没敢说的那件事', '事情本身一个字都没改')
  assert.ok(after.recalled >= 1, '这次"被看"也算想起了一次')

  // ② 她心里多了一笔，但这一笔**不是秘密** —— 它是关系的账（"你翻我东西了"她有权直接提）。
  // 如果它也带秘密标记，界面上就会永远有新 🔒 可点，越点越多（2026-11-21 真机的死循环）。
  const added = [...table.values()].filter((record) => record.id !== secret.id)
  assert.equal(added.length, 1)
  assert.match(added[0].what, /小明.*看了/, '用名字，不用"他/对方"')
  assert.ok(added[0].cost < 0.5, '这条不该再是一个秘密')
})

test('被窥探：本来就说得出的一条，不该被这样看', async () => {
  const open = createMemoryRecord({ what: '一件普通的事', about: 'user', certain: 'told', cost: 0.1 })
  const { store, table } = storeOf([open])
  const notice = await reveal(store, open.id, '小明', new Date())
  assert.match(notice, /本来就说得出/)
  assert.equal(table.size, 1, '不该写任何东西')
})

test('被窥探：那条已经不在了', async () => {
  const { store } = storeOf([])
  const notice = await reveal(store, 'nope', '小明', new Date())
  assert.match(notice, /已经不在了/)
})

/* ──────────────── 被窥探之后：反应由性格定 ────────────────
 *
 * 2026-11-22 补的一条线：之前写死"怕 45"，不管她什么性子反应都一样。
 * 现在强度由情绪稳定性定、种类由宜人性定 —— 下面这几条把这个映射钉死，
 * 免得以后有人顺手又改回一个常数。
 */

test('被窥探：性格读不到时退回基准反应，不替她假设性子', () => {
  assert.deepEqual(peekReaction(undefined), { kind: 'fear', intensity: 45 })
  // 轴坏了（NaN）等同于读不到：不能因为一个脏数字就变成"她完全不介意"。
  assert.deepEqual(peekReaction({ stability: Number.NaN, agreeableness: 0.5 }), {
    kind: 'fear',
    intensity: 45,
  })
})

test('被窥探：越不稳定，这一下越重', () => {
  const calm = peekReaction({ stability: 0.9, agreeableness: 0.8 })
  const shaky = peekReaction({ stability: 0.1, agreeableness: 0.8 })
  assert.equal(calm.intensity, 21, '稳的人 45 − 24')
  assert.equal(shaky.intensity, 69, '易崩的人 45 + 24')
  assert.ok(shaky.intensity > calm.intensity)
  assert.equal(calm.kind, 'fear')
})

test('被窥探：宜人性低的人更可能是恼，不是怕', () => {
  assert.equal(peekReaction({ stability: 0.5, agreeableness: 0.2 }).kind, 'anger')
  assert.equal(peekReaction({ stability: 0.5, agreeableness: 0.9 }).kind, 'fear')
})

test('被窥探：两个端点都在可读的范围里（15 / 75，不贴 0 和 100）', () => {
  assert.equal(peekReaction({ stability: 1, agreeableness: 0.5 }).intensity, 15)
  assert.equal(peekReaction({ stability: 0, agreeableness: 0.5 }).intensity, 75)
})

test('被窥探：她记下的那一笔带着性格算出来的反应', async () => {
  const secret = createMemoryRecord({ what: '我一直没说的事', about: 'self', certain: 'witnessed', cost: 0.9 })
  const { store, table } = storeOf([secret])
  await reveal(store, secret.id, '小明', new Date(), { stability: 0.1, agreeableness: 0.2 })

  const added = [...table.values()].find((record) => record.id !== secret.id)
  assert.equal(added.felt.intensity, 69)
  assert.equal(added.felt.kind, 'anger')
})

/* ───────────────────────── 删除 ─────────────────────────
 *
 * 遗忘不等于删除：淡掉的记录还在，能被线索唤醒；删掉的是"这件事再也不会发生在她身上了"。
 * 所以这条路径只由用户明确要求触发，而且必须把归拢记录里的引用一起摘掉 ——
 * 否则那条概括会声称自己"是从一件已经不存在的事攒出来的"。
 */

test('删除：那条真的没了，归拢记录里的引用也跟着摘掉', async () => {
  const episode = createMemoryRecord({ what: '一件小事', about: 'self', certain: 'witnessed' })
  const period = {
    ...createMemoryRecord({ what: '那阵子的小事', about: 'self', certain: 'inferred', tier: 'period' }),
    covers: [episode.id],
  }
  const { store, table } = storeOf([episode, period])

  const notice = await removeMemory(store, episode.id)
  assert.match(notice, /删掉了/)
  assert.equal(table.has(episode.id), false, '删掉的那条不在了')
  assert.deepEqual(table.get(period.id).covers, [], '概括不再引用它')
  assert.equal(table.get(period.id).what, '那阵子的小事', '概括本身一个字都没改')
})

test('删除：那条已经不在了', async () => {
  const { store } = storeOf([])
  assert.match(await removeMemory(store, 'nope'), /已经不在了/)
})

/* ─────────────────── 为什么想起（工作台唯一的解释窗） ─────────────────── */

test('为什么想起：秘密只留"她不想说"，正文一个字都不进这扇没门槛的窗', () => {
  const open = createMemoryRecord({ what: '一件普通的事', about: 'user', certain: 'told' })
  const secret = createMemoryRecord({ what: '那件我一直没说的事', about: 'self', certain: 'witnessed', cost: 0.9 })
  const hits = [
    { record: open, score: 0.9, parts: { relevance: 0.8, strength: 0.5, mood: 0 } },
    { record: secret, score: 0.8, parts: { relevance: 0.5, strength: 0.6, mood: 0 } },
  ]

  const view = recallViewOf('你还记得那件事吗', hits, new Date('2026-11-22T12:00:00.000Z'))
  assert.equal(view.cue, '你还记得那件事吗')
  assert.equal(view.items[0].what, '一件普通的事')
  assert.equal(view.items[0].match, 'high', '0.8 的相关度是"很相关"')
  assert.equal(view.items[1].withheld, true)
  assert.equal(view.items[1].what, '', '秘密的正文不能从这里出去，要去时间线走「我要看」')
  assert.equal(view.items[1].match, 'mid', '0.5 的相关度是"有点相关"')
})

test('为什么想起：那句触发的话会截断（它可能是一整段）', () => {
  const view = recallViewOf(`  ${'一'.repeat(200)}  `, [], new Date())
  assert.equal(view.cue.length, 61, '留 60 个字加一个省略号')
  assert.ok(view.cue.endsWith('…'))
})

test('投影：带上一次回忆；没有过时是空值而不是缺字段', () => {
  const now = new Date('2026-11-22T12:00:00.000Z')
  assert.deepEqual(projectMemoryDocument([], now, true).lastRecall, { at: '', cue: '', items: [] })

  const doc = projectMemoryDocument([], now, true, { lastRecall: recallViewOf('在吗', [], now) })
  assert.equal(doc.lastRecall.cue, '在吗')
  assert.equal(doc.lastRecall.at, now.toISOString())
})

test('投影：当时的感受用人话（宿主借情绪词表；借不到就退回种类）', () => {
  const now = new Date('2026-11-22T12:00:00.000Z')
  const record = createMemoryRecord({
    what: '那件事',
    about: 'self',
    certain: 'witnessed',
    felt: { kind: 'fear', intensity: 45 },
  })

  const labelled = projectMemoryDocument([record], now, true, { feltLabel: (kind) => (kind === 'fear' ? '害怕' : kind) })
  assert.equal(labelled.entries[0].feltLabel, '害怕')

  const bare = projectMemoryDocument([record], now, true)
  assert.equal(bare.entries[0].feltLabel, 'fear', '借不到词表时至少别空着')
})

test('投影：休眠时带标记（界面要说"还没开始"，而不是"没有记忆"）', () => {
  const now = new Date('2026-11-22T12:00:00.000Z')
  assert.equal(projectMemoryDocument([], now, true).dormant, false, '默认不是休眠')
  assert.equal(projectMemoryDocument([], now, true, { dormant: true }).dormant, true)
})
