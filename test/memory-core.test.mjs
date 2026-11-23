/**
 * 记忆数据层与遗忘形状的测试（2026-11-20 重写后的第一批）。
 *
 * 钉的是"这套东西凭什么像人"的四条：
 * 1. **初始强度只由两件事决定** —— 当时情绪多强、这事跟我多大关系；
 * 2. **忘的形状是先快后慢**（幂律），不是到点跳崖；
 * 3. **坏情绪褪得比好情绪快**（同一件事，几年后提起来不疼了，但还是会笑）；
 * 4. **淡了不等于没了** —— 淡掉的只是退出日常检索，记录还在。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createMemoryRecord, initialStrength } from '../lib/memory/model.js'
import { detailExpired, isDormant, isFaded, strengthAt } from '../lib/memory/decay.js'
import { recall, strongest } from '../lib/memory/search.js'
import { createMemoryStore } from '../lib/memory/store.js'

/** 一个假的领域表（只实现记忆用到的四个方法）。 */
function fakeTable() {
  const records = new Map()
  return {
    records,
    get: (key) => records.get(key),
    entries: () => records.entries(),
    put: async (key, value) => {
      records.set(key, value)
    },
    delete: async (key) => records.delete(key),
  }
}

/** 造一条"刚刚发生"的记忆。 */
function fresh(overrides = {}) {
  return createMemoryRecord({
    what: '看到一段讲深海鱼的视频',
    about: 'self',
    certain: 'witnessed',
    felt: { kind: 'fear', intensity: 60 },
    ...overrides,
  })
}

/** 把一条记忆的写入时刻挪到 N 天前（模拟"这么久以前发生的事"）。 */
function aged(record, days) {
  const at = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
  return { ...record, createdAt: at, when: at }
}

const near = (actual, expected, tolerance = 0.02) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `期望约 ${expected}，实际 ${actual}`)

/* ───────────────────────── 初始强度 ───────────────────────── */

test('初始强度：情绪越强越牢，越"关于我"越牢（只有这两项加权）', () => {
  const calm = initialStrength({ kind: 'joy', intensity: 0 }, 'world')
  const strong = initialStrength({ kind: 'fear', intensity: 90 }, 'world')
  const aboutSelf = initialStrength({ kind: 'fear', intensity: 90 }, 'self')

  assert.ok(calm < strong, '同样关于世界，情绪更强的更牢')
  assert.ok(strong < aboutSelf, '同样的情绪，关于我自己的更牢')
  // 再平淡的事也不是零：一写入就等于"没有"，那条记忆根本不存在。
  assert.ok(calm > 0)
  assert.ok(aboutSelf <= 1)
})

test('初始强度不问"重要不重要"：没有 1–10 分这种绝对值', () => {
  const record = fresh()
  assert.equal('importance' in record, false, '旧版的 importance 字段不该再出现')
  assert.ok(record.strength > 0 && record.strength <= 1)
})

/* ───────────────────────── 遗忘形状 ───────────────────────── */

test('遗忘是先快后慢：头一天掉掉的部分远多于第 7–8 天', () => {
  // 用正面情绪来验形状：负性的那条指数更陡（见下一条测试），会把这个数字搅浑。
  const record = createMemoryRecord({
    what: '那天下午在店里坐了很久',
    about: 'self',
    certain: 'witnessed',
    felt: { kind: 'joy', intensity: 60 },
  })
  const at = (days) => new Date(Date.parse(record.createdAt) + days * 86400000)
  const day1 = strengthAt(record, at(1))
  const day7 = strengthAt(record, at(7))
  const day8 = strengthAt(record, at(8))

  const firstDayDrop = record.strength - day1
  const eighthDayDrop = day7 - day8
  assert.ok(firstDayDrop > eighthDayDrop * 3, '第一天掉的必须明显多于第八天（幂律，不是直线）')
  // T0=3、d=0.5：(1 + 7/3)^(-0.5) ≈ 0.548
  near(day7 / record.strength, 0.548, 0.02)
})

test('坏情绪褪得比好情绪快（同一件事，过几年不疼了，但还是会笑）', () => {
  const base = { what: '那天发生了一件事', about: 'us', certain: 'witnessed', felt: { kind: 'joy', intensity: 70 } }
  const happy = createMemoryRecord(base)
  const sad = createMemoryRecord({ ...base, felt: { kind: 'sadness', intensity: 70 } })
  const later = new Date(Date.now() + 30 * 86400000)

  assert.ok(strengthAt(sad, later) < strengthAt(happy, later), '负性情绪的记忆应当褪得更快')
})

test('被想起一次就从那一刻重新算 —— 想起会把时间线重置', () => {
  const table = fakeTable()
  const store = createMemoryStore(table)
  const record = aged(fresh(), 20)
  const decayed = strengthAt(record, new Date())
  assert.ok(decayed < record.strength, '前提：20 天后已经淡了一些')

  return store.put(record).then(async () => {
    const at = new Date().toISOString()
    const touched = await store.touch(record.id, at, 0.12)
    assert.equal(touched.recalled, 1)
    assert.equal(touched.recalledAt, at)
    assert.ok(touched.strength > decayed, '想起来的这一刻应当比刚淡掉时更牢')

    // 同一份记录在"刚想起"之后立刻读，强度就是它自己（没有时间可掉）。
    near(strengthAt(touched, new Date(at)), touched.strength, 0.001)
  })
})

test('细节比要点先死：60 天后只剩"发生过什么"', () => {
  const record = aged(
    createMemoryRecord({ what: '我们吵架了', detail: '他说"你根本不懂"', about: 'us', certain: 'witnessed' }),
    61,
  )
  assert.equal(detailExpired(record, new Date()), true, '细节该丢了')
  assert.notEqual(record.what, '', '但事情还在')
  assert.equal(detailExpired(aged(record, 10), new Date()), false, '十天前的还不该丢')
})

test('写入：情绪强度取整并夹到 0–100（不让 5.9888 这种小数位进库）', () => {
  const rounded = createMemoryRecord({
    what: '一件小事',
    about: 'us',
    certain: 'witnessed',
    felt: { kind: 'joy', intensity: 5.9888371532538835 },
  })
  assert.equal(rounded.felt.intensity, 6, '落库就是整数')
  const clamped = createMemoryRecord({
    what: '另一件小事',
    about: 'us',
    certain: 'witnessed',
    felt: { kind: 'joy', intensity: 130 },
  })
  assert.equal(clamped.felt.intensity, 100)
})

test('淡与没淡是两条线：淡了只是退出日常检索', () => {
  assert.equal(isDormant(0.05), true)
  assert.equal(isDormant(0.5), false)
  assert.equal(isFaded(0.01), true)
  assert.equal(isFaded(0.2), false)
})

/* ───────────────────────── 检索 ───────────────────────── */

test('检索：不相关的不给 —— 再牢、再对味也不带进对话', () => {
  const record = createMemoryRecord({ what: '深海鱼住在几千米以下', about: 'self', certain: 'witnessed' })
  const hits = recall([record], '今天晚饭吃什么')
  assert.deepEqual(hits, [], '完全不相关时宁可不注入')
})

test('检索：淡到几乎没了的也不参与（要靠线索唤醒，不是日常检索）', () => {
  const record = aged(createMemoryRecord({ what: '深海鱼住在几千米以下', about: 'self', certain: 'witnessed', strength: 0.05 }), 400)
  assert.deepEqual(recall([record], '深海鱼'), [])
})

test('检索：相关的那条会被带回，分数拆成三块便于解释', () => {
  const record = createMemoryRecord({ what: '那天下雨，我在地铁口看见有人在吹口琴', about: 'self', certain: 'witnessed', felt: { kind: 'joy', intensity: 40 } })
  const hits = recall([record], '你还记得地铁口吹口琴那个人吗', { mood: { tone: 1 } })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].record.id, record.id)
  assert.ok(hits[0].parts.relevance > 0)
  assert.ok(hits[0].parts.strength > 0)
  assert.equal(hits[0].parts.mood, 1, '心情好的时候，同向的旧事有加成')
})

test('检索：心情加成只影响排序，不让不相关的混进来', () => {
  const relevant = createMemoryRecord({ what: '地铁口那个吹口琴的人', about: 'self', certain: 'witnessed', felt: { kind: 'sadness', intensity: 80 } })
  const hits = recall([relevant], '地铁口吹口琴', { mood: { tone: 1 } })
  assert.equal(hits.length, 1, '相关就进，与心情同不同向无关')
  assert.equal(hits[0].parts.mood, 0, '但心情不同向时没有加成')
})

test('检索：长句子里接住够多的词就该想起 —— 不被句子的长度稀释', () => {
  // 真机（2026-11-22）：这句切出十几个词，接住了"园子/子里/散步/念树/树牌"五个，
  // 比值只有 0.28，被 0.3 挡在门外 —— 明明就是同一件事。错在算法，不在用户。
  const record = createMemoryRecord({
    what: '我和火火在冬天的园子里一起散步，踩着脆脆的落叶，一路念树牌上的名字',
    about: 'us',
    certain: 'witnessed',
  })
  const hits = recall([record], '我们那天在园子里散步，你还念树牌给我听')
  assert.equal(hits.length, 1, '接住三个以上实词就该想起来')
  assert.ok(hits[0].parts.relevance < 0.3, '它的比值确实低于旧阈值（证明走的是新那条线）')
})

test('检索：长句子只接住一两个泛词时仍然不给（新那条线不能变成后门）', () => {
  const record = createMemoryRecord({ what: '我和火火在冬天的园子里一起散步', about: 'us', certain: 'witnessed' })
  const hits = recall([record], '我们那天在小区吃饭，你还记得那家店后来关门了吗')
  assert.deepEqual(hits, [], '只有"我们/那天"这种泛词对得上，不算相关')
})

/* ───────────────────────── 「最牢的几条」 ───────────────────────── */

test('最牢的几条：不看当前话题也拿得出来（新会话第一句靠它）', () => {
  const weak = createMemoryRecord({ what: '一件很淡的事', about: 'world', certain: 'witnessed', strength: 0.2 })
  const strong = createMemoryRecord({ what: '他第一次告诉我他叫什么', about: 'user', certain: 'told', strength: 0.9 })
  const hits = strongest([weak, strong], 1)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].record.what, '他第一次告诉我他叫什么', '按强度取，不看话题')
})

test('最牢的几条：淡到快没了的不要（她已经想不起来了）', () => {
  const faded = createMemoryRecord({ what: '很久以前的一件小事', about: 'world', certain: 'witnessed', strength: 0.01 })
  assert.deepEqual(strongest([faded], 3), [])
})

/* ───────────────────────── 存储 ───────────────────────── */

test('存储：写入、读取、按发生时间倒序列出、删除', async () => {
  const store = createMemoryStore(fakeTable())
  const older = aged(createMemoryRecord({ what: '旧事', about: 'user', certain: 'told' }), 10)
  const newer = createMemoryRecord({ what: '新事', about: 'user', certain: 'told' })
  await store.put(older)
  await store.put(newer)

  assert.equal(store.get(older.id)?.what, '旧事')
  assert.deepEqual(store.all().map((item) => item.what), ['新事', '旧事'])
  assert.equal(await store.remove(older.id), true)
  assert.equal(store.get(older.id), undefined)
})

test('存储：想起一条不存在的记忆不会造出一条', async () => {
  const store = createMemoryStore(fakeTable())
  assert.equal(await store.touch('nope', new Date().toISOString(), 0.1), undefined)
  assert.equal(store.all().length, 0)
})
