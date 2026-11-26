/**
 * 写入 / 渲染 / 工具的测试（记忆重构第二批）。
 *
 * 钉的是"准入"这一环，因为它才是整套记忆最容易烂的地方：
 * - 整合失败时**一条都不写**（写进垃圾比没记住更糟）；
 * - 模型给错枚举值时**跳过那一条**，不让脏数据落库；
 * - 一次整合有硬上限（防一次抽爆）；
 * - 检索不到时说的是"没有"，不是"没找到" —— 前者是事实，后者会诱导模型继续编。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createMemoryStore } from '../lib/memory/store.js'
import { MEMORY_GUIDANCE, renderRecalled, whenText } from '../lib/memory/render.js'
import { integrate, normalizePerspective, remember } from '../lib/memory/write.js'
import { isGreetingTurn, isMemoryNotice, parseScheduleReminders } from '../lib/memory/inject.js'
import { splitByDisclosure } from '../lib/memory/disclosure.js'
import { hitsToValue } from '../lib/memory/tools.js'
import { createMemoryRecord } from '../lib/memory/model.js'

/** 假表。 */
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

/** 一个总是返回给定文本的模型。 */
function fakeLlm(text) {
  return {
    route: () => ({ provider: 'fake', model: 'fake' }),
    streamText: async () => ({ text, inputTokens: 0, outputTokens: 0, finishReason: 'stop' }),
  }
}

/** 一个调不通的模型。 */
const brokenLlm = {
  route: () => ({ provider: 'fake', model: 'fake' }),
  streamText: async () => {
    throw new Error('超时')
  },
}

/** 静默日志。 */
const quietLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }

const events = [
  { role: 'user', text: '我下周三要去医院复查', at: '2026-11-20T10:00:00.000Z' },
  { role: 'assistant', text: '那我记着，别忘了', at: '2026-11-20T10:00:05.000Z' },
]

/* ───────────────────────── 整合 ───────────────────────── */

test('整合：模型给什么就写什么，形状照契约补齐', async () => {
  const store = createMemoryStore(fakeTable())
  const written = await integrate(store, events, {
    llm: fakeLlm('[{"what":"对方下周三要去医院复查","about":"user","certain":"told","cost":0.2}]'),
    log: quietLog,
  })
  assert.equal(written.length, 1)
  assert.equal(written[0].what, '对方下周三要去医院复查')
  assert.equal(written[0].about, 'user')
  assert.equal(written[0].certain, 'told')
  assert.equal(store.all().length, 1)
})

test('整合：模型输出解析不了时一条都不写（写进垃圾比没记住更糟）', async () => {
  const store = createMemoryStore(fakeTable())
  const written = await integrate(store, events, { llm: fakeLlm('抱歉，我无法完成'), log: quietLog })
  assert.deepEqual(written, [])
  assert.equal(store.all().length, 0)
})

test('整合：模型调用失败时安静跳过，不影响对话', async () => {
  const store = createMemoryStore(fakeTable())
  const written = await integrate(store, events, { llm: brokenLlm, log: quietLog })
  assert.deepEqual(written, [])
})

test('整合：枚举写错的那一条被跳过，其余正常写入', async () => {
  const store = createMemoryStore(fakeTable())
  const written = await integrate(store, events, {
    llm: fakeLlm(
      JSON.stringify([
        { what: '一条好记录', about: 'user', certain: 'told' },
        { what: '一条坏记录', about: '关于用户', certain: 'told' },
        { what: '', about: 'user', certain: 'told' },
      ]),
    ),
    log: quietLog,
  })
  assert.equal(written.length, 1, '只有形状对的那条进来了')
  assert.equal(written[0].what, '一条好记录')
})

test('整合：一次最多写几条是硬上限（防一次抽爆）', async () => {
  const store = createMemoryStore(fakeTable())
  const many = Array.from({ length: 20 }, (_, index) => ({ what: `第 ${index} 件`, about: 'self', certain: 'witnessed' }))
  const written = await integrate(store, events, { llm: fakeLlm(JSON.stringify(many)), log: quietLog })
  assert.ok(written.length <= 3, `一次最多 3 条，实际 ${written.length}`)
})

test('整合：没有原始片段时不调模型（空批次不该花钱）', async () => {
  const store = createMemoryStore(fakeTable())
  let called = 0
  const llm = {
    route: () => ({ provider: 'fake', model: 'fake' }),
    streamText: async () => {
      called += 1
      return { text: '[]', inputTokens: 0, outputTokens: 0, finishReason: 'stop' }
    },
  }
  assert.deepEqual(await integrate(store, [], { llm, log: quietLog }), [])
  assert.equal(called, 0)
})

test('直接记住：带上当时的感觉，强度按它算', async () => {
  const store = createMemoryStore(fakeTable())
  const { record, duplicate } = await remember(store, {
    what: '他说他不会走',
    about: 'us',
    certain: 'told',
    felt: { kind: 'trust', intensity: 80 },
  })
  assert.equal(duplicate, false)
  assert.ok(record.strength > 0.5, '情绪很强的记忆初始应当更牢')
})

test('直接记住：同一件事再记一次不新增，只把旧的那条加固', async () => {
  // 真机（2026-11-22）："想有人陪"三天里被记了三遍 —— 模型每次觉得重要就记一次，
  // 而工具这条路原来没有去重。人的做法是"再提一遍就记得更牢"，不是在本子上抄三行。
  const store = createMemoryStore(fakeTable())
  const first = await remember(store, { what: '小明说找我主要是想有人陪，以后可能也会要我帮忙', about: 'user', certain: 'told' })
  const again = await remember(store, { what: '小明说找我主要是想有人陪，以后可能也会要我帮忙。', about: 'user', certain: 'told' })

  assert.equal(again.duplicate, true, '必须告诉调用方"这次没有新增"')
  assert.equal(store.all().length, 1, '库里还是只有一条')
  assert.equal(again.record.id, first.record.id, '加固的是原来那条')
  assert.equal(again.record.recalled, 1, '又提了一遍 = 想起过一次')
  assert.ok(again.record.strength > first.record.strength, '再提一遍应当更牢')
})

test('直接记住：极性相反的两句不是重复（不能替对方改意思）', async () => {
  // "喜欢下雨" vs "不喜欢下雨"：只差一个字，Dice 很高，但这是两件事 ——
  // 合并等于把对方的偏好反过来说。人格去重早就守着这条，记忆这里也要守。
  const store = createMemoryStore(fakeTable())
  const like = await remember(store, { what: '小明喜欢下雨天', about: 'user', certain: 'told' })
  const dislike = await remember(store, { what: '小明不喜欢下雨天', about: 'user', certain: 'told' })

  assert.equal(like.duplicate, false)
  assert.equal(dislike.duplicate, false)
  assert.equal(store.all().length, 2)
})

test('整合：极性相反也不算重复（去重判据两边共用一套）', async () => {
  const store = createMemoryStore(fakeTable())
  await integrate(store, events, {
    llm: fakeLlm('[{"what":"小明喜欢下雨天","about":"user","certain":"told"}]'),
    log: quietLog,
  })
  const changed = await integrate(store, events, {
    llm: fakeLlm('[{"what":"小明不喜欢下雨天","about":"user","certain":"told"}]'),
    log: quietLog,
  })
  assert.equal(changed.length, 1, '偏好反过来了，这是新的一条')
  assert.equal(store.all().length, 2)
})

test('视角：模型写下"对方/用户"时换成人名（只换这两个词）', () => {
  // 真机库里真有一条写成「我和对方在园子里散步」——提示词管不住的那部分，用一行确定的替换兜住。
  assert.equal(normalizePerspective('我和对方在园子里散步', '小明'), '我和小明在园子里散步')
  assert.equal(normalizePerspective('用户说他喜欢下雨', '小明'), '小明说他喜欢下雨')
  // "你"不能换：换成"小明记得…"语气就变了，那是另一句话。
  assert.equal(normalizePerspective('你还记得那天吗', '小明'), '你还记得那天吗')
  // "他"可能是第三个人，换了就是篡改。
  assert.equal(normalizePerspective('他说他会来', '小明'), '他说他会来')
  // 没有名字时一个字都不动。
  assert.equal(normalizePerspective('对方来了', ''), '对方来了')
})

test('直接记住：写入时把"对方"换成人名', async () => {
  const store = createMemoryStore(fakeTable())
  const { record } = await remember(
    store,
    { what: '我和对方在园子里散步', about: 'us', certain: 'witnessed' },
    { userName: '小明' },
  )
  assert.equal(record.what, '我和小明在园子里散步')
})

test('整合：带上当时的感觉，并把"对方"换成人名（这条线原来两样都缺）', async () => {
  // 真机发现：inject 那条线调 integrate 时既没传 feeling、也没有 userName，
  // 于是整合写下的记忆强度一律按零情绪算，还会留下"对方"这种指代。
  const store = createMemoryStore(fakeTable())
  const written = await integrate(store, events, {
    llm: fakeLlm('[{"what":"对方说他下周三要去医院复查","about":"user","certain":"told"}]'),
    feeling: () => ({ kind: 'trust', intensity: 60 }),
    userName: () => '小明',
    log: quietLog,
  })
  assert.equal(written[0].what, '小明说他下周三要去医院复查')
  assert.deepEqual(written[0].felt, { kind: 'trust', intensity: 60 })
})

test('整合：同一件事被相邻两个窗口各抽一遍时，只留一条', async () => {
  // 真机实测（2026-11-21）：这两句话在库里躺成了两条。它们 Dice 相似度 0.654 ——
  // 同一件事的两种说法，但整合每次只看最近几条消息，跨窗口就抽了两遍。
  const store = createMemoryStore(fakeTable())
  const first = await integrate(store, events, {
    llm: fakeLlm('[{"what":"小明告诉我他叫小明、是男生，希望我是女生，其余让我自己决定。","about":"user","certain":"told"}]'),
    log: quietLog,
  })
  assert.equal(first.length, 1)

  const second = await integrate(store, events, {
    llm: fakeLlm('[{"what":"我认识了小明，他告诉我他是男生，并希望我是女生，其余由我自己决定。","about":"user","certain":"told"}]'),
    log: quietLog,
  })
  assert.equal(second.length, 0, '同一件事不该再留一条')
  assert.equal(store.all().length, 1)
})

test('整合：不同的事照常写入（去重不能误杀）', async () => {
  const store = createMemoryStore(fakeTable())
  await integrate(store, events, {
    llm: fakeLlm('[{"what":"小明告诉我他叫小明、是男生，希望我是女生。","about":"user","certain":"told"}]'),
    log: quietLog,
  })
  const another = await integrate(store, events, {
    llm: fakeLlm('[{"what":"小明说找我主要是想有人陪，以后可能也会要我帮忙。","about":"user","certain":"told"}]'),
    log: quietLog,
  })
  assert.equal(another.length, 1, '两件不同的事，相似度只有 0.044')
  assert.equal(store.all().length, 2)
})

test('记忆注入：只有本会话第一轮才打招呼（重启不会重新自我介绍）', () => {
  // 2026-11-22 真机：一晚上部署三次，同一个会话里她"醒来"了三次。
  // 试过查历史（payload.messages 只有这一条新消息）和 source.kind，都不行；
  // `payload.turn` 是会话内的轮次号、跨重启连续，才是可靠依据。
  assert.equal(isGreetingTurn(1), true)
  assert.equal(isGreetingTurn(2), false)
  assert.equal(isGreetingTurn(6), false)
  assert.equal(isGreetingTurn(undefined), false)
})

test('记忆注入：注入消息能从 source.kind 上认出来（排查用）', () => {
  assert.equal(isMemoryNotice({ role: 'user', content: [], source: { kind: 'humanity-memory' } }), true)
  assert.equal(isMemoryNotice({ role: 'user', content: [], source: { kind: 'humanity-emotion' } }), false)
  assert.equal(isMemoryNotice({ role: 'user', content: [] }), false)
  assert.equal(isMemoryNotice(null), false)
})

/* ───────────────────────── 秘密 ───────────────────────── */

test('秘密：代价高的那条不进"能说"的一堆，只留一句"不想说"', () => {
  const now = new Date()
  const open = createMemoryRecord({ what: '他喜欢先看结论', about: 'user', certain: 'told', cost: 0.1 })
  const secret = createMemoryRecord({ what: '那件我一直没敢说的事', about: 'self', certain: 'witnessed', cost: 0.9 })
  const hits = [open, secret].map((record) => ({ record, score: 0.5, parts: { relevance: 1, strength: 0.5, mood: 0 } }))

  const { speakable, withheld } = splitByDisclosure(hits)
  assert.deepEqual(speakable.map((hit) => hit.record.what), ['他喜欢先看结论'])
  assert.deepEqual(withheld.map((hit) => hit.record.what), ['那件我一直没敢说的事'])

  // 能说的那句照常渲染；说不出口的那条**内容一个字都不出现**。
  const text = renderRecalled(speakable, now)
  assert.match(text, /他喜欢先看结论/)
})

test('秘密：代价刚好在门槛上的算"能说"（门槛是"超过才藏"）', () => {
  const record = createMemoryRecord({ what: '边界上的事', about: 'self', certain: 'witnessed', cost: 0.5 })
  const hits = [{ record, score: 0.5, parts: { relevance: 1, strength: 0.5, mood: 0 } }]
  assert.equal(splitByDisclosure(hits).withheld.length, 0)
})

/* ───────────────────────── 定时提醒的留痕 ───────────────────────── */

/** 单条格式（那一轮只有这一条提醒时）。 */
const REMINDER_TEXT = [
  '[SCHEDULE REMINDER]',
  'This is a scheduled reminder you set earlier.',
  'schedule_id_json: "a3f1"',
  'occurrence_at: 2026-11-21T07:00:00.000Z',
  'reminder_prompt_json: "提醒小明吃药"',
].join('\n')

/**
 * 批量格式 —— **真机实际发的是这个**，哪怕只有一条（2026-11-21）。
 *
 * 我第一版只认单条格式，结果真机一条都没记上；这条用例就是那次事故的护栏。
 */
const BATCH_TEXT = [
  '[SCHEDULE REMINDER BATCH]',
  'This is a scheduled message from the user',
  'reminders_json: [{"schedule_id":"schedule-bd4c","occurrence_at":"2026-11-21T14:35:20.000Z","reminder_prompt":"提醒小明喝水"}]',
].join('\n')

test('定时提醒：单条格式能读出来', () => {
  const fired = parseScheduleReminders(REMINDER_TEXT)
  assert.equal(fired.length, 1)
  assert.equal(fired[0].prompt, '提醒小明吃药')
  assert.equal(fired[0].at, '2026-11-21T07:00:00.000Z')
})

test('定时提醒：批量格式也能读出来（真机发的是这个）', () => {
  const fired = parseScheduleReminders(BATCH_TEXT)
  assert.equal(fired.length, 1)
  assert.equal(fired[0].prompt, '提醒小明喝水')
  assert.equal(fired[0].at, '2026-11-21T14:35:20.000Z')
})

test('定时提醒：普通消息不会被误认（认不出来就当没有，绝不猜）', () => {
  assert.deepEqual(parseScheduleReminders('今天有点累，回来了'), [])
  assert.deepEqual(parseScheduleReminders('[SCHEDULE REMINDER]\nschedule_id_json: "x"'), [], '缺 prompt 就放弃')
})

/* ───────────────────────── 时间说法 ───────────────────────── */

test('时间说法：今天 / 昨天 / N 天 / N 周 / N 个月 / N 年', () => {
  const now = new Date('2026-11-20T12:00:00.000Z')
  const at = (days) => new Date(now.getTime() - days * 86400000).toISOString()
  assert.equal(whenText(at(0), now), '今天')
  assert.equal(whenText(at(1), now), '昨天')
  assert.equal(whenText(at(3), now), '3 天前')
  assert.equal(whenText(at(14), now), '2 周前')
  assert.equal(whenText(at(90), now), '3 个月前')
  assert.equal(whenText(at(400), now), '1 年前')
})

test('时间说法：读不出时间时返回空串（宁可不提，也不要瞎说"很久以前"）', () => {
  assert.equal(whenText('不是时间', new Date()), '')
  assert.equal(whenText('', new Date()), '')
})

test('时间说法：给时区就按日历日算"昨天"，不给就还是 24 小时', () => {
  // 上海 11-22 00:30（= 11-21T16:30Z）回忆 11-21 23:30（= 11-21T15:30Z）的事：
  // 毫秒差只有 1 小时，旧口径会说"今天"；可对过日子的她来说，那是昨晚。
  const now = new Date('2026-11-21T16:30:00.000Z')
  const lastNight = '2026-11-21T15:30:00.000Z'
  assert.equal(whenText(lastNight, now), '今天', '不传时区时保持旧口径（不静默改变别的调用方）')
  assert.equal(whenText(lastNight, now, 'Asia/Shanghai'), '昨天')
})

test('时间说法：时区名写错时不炸，退回 24 小时口径', () => {
  const now = new Date('2026-11-20T12:00:00.000Z')
  const at = new Date(now.getTime() - 3 * 86400000).toISOString()
  assert.equal(whenText(at, now, 'Mars/Olympus'), '3 天前')
})

/* ───────────────────────── 注入文本 ───────────────────────── */

test('注入文本：没有想起来的就不占一个 token', () => {
  assert.equal(renderRecalled([], new Date()), '')
})

test('注入文本：带时间感，且不显示任何分数', () => {
  const now = new Date('2026-11-20T12:00:00.000Z')
  const record = createMemoryRecord({
    what: '我们那天吵了一架',
    about: 'us',
    certain: 'witnessed',
    when: '2026-11-17T12:00:00.000Z',
  })
  const text = renderRecalled([{ record, score: 0.63, parts: { relevance: 0.8, strength: 0.5, mood: 0 } }], now)
  assert.match(text, /想起来的几件事/)
  assert.match(text, /3 天前/)
  assert.match(text, /我们那天吵了一架/)
  assert.equal(/0\.63/.test(text), false, '分数不该出现在给她看的文本里')
})

test('注入文本：刚发生的事带上当时的原话，久了就不再带（细节会褪）', () => {
  const now = new Date('2026-11-22T12:00:00.000Z')
  const fresh = createMemoryRecord({
    what: '他慢慢亲了我一下',
    detail: '「这风声，微微的，挺惬意的」',
    about: 'us',
    certain: 'witnessed',
    when: now.toISOString(),
  })
  const hit = (record) => [{ record, score: 0.9, parts: { relevance: 0.8, strength: 0.6, mood: 0 } }]

  assert.match(renderRecalled(hit(fresh), now), /这风声，微微的，挺惬意的/, '刚发生的事要带原话')

  // 同一个把月前（超过细节寿命 60 天）：事还在，原话已经想不起来了。
  const stale = { ...fresh, createdAt: '2026-08-01T00:00:00.000Z' }
  const staleText = renderRecalled(hit(stale), now)
  assert.match(staleText, /他慢慢亲了我一下/, '事还在')
  assert.equal(staleText.includes('这风声'), false, '原话不该再出现')
})

test('注入文本：细节受字数预算约束（宁可少一句原话，也不塞满上下文）', () => {
  const now = new Date('2026-11-22T12:00:00.000Z')
  const hits = Array.from({ length: 5 }, (_, index) => ({
    record: createMemoryRecord({
      what: `第 ${index} 件事` + '啊'.repeat(180),
      detail: '细节'.repeat(60),
      about: 'us',
      certain: 'witnessed',
      when: now.toISOString(),
    }),
    score: 1,
    parts: { relevance: 1, strength: 1, mood: 0 },
  }))
  const detailLines = renderRecalled(hits, now)
    .split('\n')
    .filter((line) => line.startsWith('  '))
  assert.ok(detailLines.length >= 1, '第一条的细节应当带上')
  assert.ok(detailLines.length < 5, '五条都带就超预算了')
})


/* ───────────────────────── 工具：回忆工具也要守秘密 ───────────────────────── */

/** 造一条带 cost 的记忆。 */
function memoryOf(what, cost, overrides = {}) {
  return createMemoryRecord({ what, about: 'user', certain: 'told', cost, ...overrides })
}

test('回忆工具：秘密只报"有这么一条"，正文一个字都不给模型', () => {
  // 2026-11-22 发现：注入那条路一直守着披露门槛，**工具这条路一个都没守** ——
  // 模型只要主动查一次，秘密就整段看到了，"她不想说"当场形同虚设。
  const open = memoryOf('一件普通的事', 0.1)
  const secret = memoryOf('那件我一直没说的事', 0.9)
  const value = hitsToValue(
    [
      { record: open, score: 0.9, parts: { relevance: 0.8, strength: 0.5, mood: 0 } },
      { record: secret, score: 0.8, parts: { relevance: 0.7, strength: 0.5, mood: 0 } },
    ],
    new Date(),
  )

  assert.equal(value.entries.length, 1)
  assert.equal(value.entries[0].what, '一件普通的事')
  assert.match(value.message, /不想说/)
  assert.equal(JSON.stringify(value).includes('那件我一直没说的事'), false, '秘密的正文不能出现在工具结果里')
})

test('回忆工具：只命中了秘密时，不退回"最牢的几条"（否则等于从后门漏）', () => {
  const secret = memoryOf('那件我一直没说的事', 0.9)
  const value = hitsToValue([{ record: secret, score: 0.8, parts: { relevance: 0.8, strength: 0.8, mood: 0 } }], new Date())
  assert.deepEqual(value.entries, [])
  assert.match(value.message, /不想说/)
})

test('整合：两段并发整合不会写出两条一模一样的记忆（先查后写不是原子动作）', async () => {
  // 真机 2026-11-22：同一分钟出现两条一字不差的记忆。整合是后台 void 出去的，
  // 上一段没写完、下一段就开始查重 —— 谁也看不见对方刚写的那条。现在排队串行。
  const store = createMemoryStore(fakeTable())
  const reply = '[{"what":"小明说找我主要是想有人陪","about":"user","certain":"told"}]'
  await Promise.all([
    integrate(store, events, { llm: fakeLlm(reply), log: quietLog }),
    integrate(store, events, { llm: fakeLlm(reply), log: quietLog }),
  ])
  assert.equal(store.all().length, 1, '后一段应当看得到前一段写下的东西')
})

test('记忆的说明自己讲边界：记忆的事与人格的事分开（系统提示词不再代管）', () => {
  // 2026-11-22：人格的系统提示词里原本写着"稳定事实用 humanity_remember 记"，那是记忆
  // 还在系统提示词里当兄弟段落的年代留下的。拆开后两边各守一侧：记忆这边也要说清"什么不归我"。
  assert.match(MEMORY_GUIDANCE, /人格/, '记忆的说明里要指一下另一个人格那边')
  assert.equal(MEMORY_GUIDANCE.includes('humanity_persona'), false, '记忆的说明不教人格工具')
  assert.equal(MEMORY_GUIDANCE.includes('humanity_remember'), true, '记忆自己的工具由它自己说')
})
