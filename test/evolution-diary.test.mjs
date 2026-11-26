/**
 * 睡前收账的回归钉。
 *
 * 钉四件事：
 * 1. **一天只有一篇**（同一天再写会覆盖那一天，不会出现两篇）；
 * 2. **材料空着就不写**（宁可这一天没有日记，也不编一篇）；
 * 3. 输出契约坏掉时**返回 undefined**，调用方据此不落盘；
 * 4. memories 只留 1–3 条，且 about 只接受四个合法取值。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { appendDiary, buildDiaryPrompt, DIARY_DOC_KEY, parseDiary, readDiary } from '../lib/evolution/diary.js'

/** 只支持读写一份文档的假文档表。 */
function fakeDocuments() {
  const store = new Map()
  return {
    read: (ns) => (store.has(ns) ? { value: store.get(ns), revision: 1, updatedAt: '' } : undefined),
    write: async (ns, next) => {
      store.set(ns, next)
      return { value: next, revision: 2, updatedAt: '' }
    },
    merge: async () => {
      throw new Error('日记只用 write')
    },
    list: () => [],
    // 测试里按文档键取（`current()` 只给主文档，别的键用 `peek`）。
    current: () => store.get('humanity-diary'),
    peek: (ns) => store.get(ns),
  }
}

test('日记：同一天只留一篇（后写的覆盖前一篇）', async () => {
  const documents = fakeDocuments()
  await appendDiary(documents, { date: '2026-11-24', text: '第一篇', createdAt: '2026-11-24T10:00:00.000Z' })
  await appendDiary(documents, { date: '2026-11-24', text: '改写的', createdAt: '2026-11-24T11:00:00.000Z' })
  await appendDiary(documents, { date: '2026-11-25', text: '第二天', createdAt: '2026-11-25T10:00:00.000Z' })
  const entries = readDiary(documents)
  assert.equal(entries.length, 2)
  assert.equal(entries[0].text, '改写的')
  assert.equal(entries[1].date, '2026-11-25')
  assert.equal(documents.current()[DIARY_DOC_KEY], undefined, '值直接是 { entries }，不该再多套一层')
})

test('日记：超出保留上线的旧篇挪进归档，不删', async () => {
  const documents = fakeDocuments()
  const { DIARY_KEEP, DIARY_ARCHIVE_KEY } = await import('../lib/evolution/diary.js')
  // 灌满到刚好超过上限。
  for (let index = 0; index <= DIARY_KEEP; index += 1) {
    const date = `2020-01-01T00:00:00.000Z`
    await appendDiary(documents, {
      date: `d${String(index).padStart(4, '0')}`,
      text: `第 ${index} 篇`,
      createdAt: date,
      openedAt: '',
      noticedAt: '',
    })
  }
  const kept = readDiary(documents)
  assert.equal(kept.length, DIARY_KEEP, '主文档只留上限那么多')
  const archived = documents.peek(DIARY_ARCHIVE_KEY)
  assert.ok(archived !== undefined && archived.entries.length >= 1, '超出的那几篇要进归档')
  assert.match(archived.entries[0].text, /第 0 篇/, '挪走的是最老的那几篇')
})
test('日记：读不到 / 形状坏掉时当作没有（不抛）', () => {
  assert.deepEqual(readDiary(undefined), [])
  assert.deepEqual(readDiary({ read: () => ({ value: null, revision: 1, updatedAt: '' }) }), [])
  assert.deepEqual(readDiary({ read: () => ({ value: { entries: 'nope' }, revision: 1, updatedAt: '' }) }), [])
  assert.deepEqual(
    readDiary({ read: () => ({ value: { entries: [{ date: '2026-11-24', text: '' }] }, revision: 1, updatedAt: '' }) }),
    [],
    '空正文的条目不算日记',
  )
})

test('收账输入：两栏材料分开给，并写清"不编"与"不能只写他"', () => {
  const { system, text } = buildDiaryPrompt({
    hers: ['她说：今天看了潮汐', '看到：月球引力'],
    talk: ['他说：晚上想吃什么', '她说：糖葫芦'],
  }, '2026-11-24')
  assert.match(system, /第一人称的日记/)
  assert.match(system, /不要照抄成流水账/, '流水账要明确否掉')
  assert.match(system, /没有的东西一律不编/)
  assert.match(system, /不能整篇都在写/, '对话进来之后必须约束"别写成关于对方的汇报"')
  assert.match(text, /今天是 2026-11-24/)
  assert.match(text, /【你自己那段时间】/)
  assert.match(text, /【你们这一天】/)
  assert.match(text, /今天看了潮汐/)
  assert.match(text, /糖葫芦/)
})

test('收账提示词要她写"场景"，不是写流水账', () => {
  const { system } = buildDiaryPrompt({ hers: ['她说：今天翻了半本书'], talk: ['他说：还没睡？'] }, '2026-11-25')
  // 2026-11-25 用户明确要求：日记要精细、要具体，不要流水账，也不要像周报。
  assert.match(system, /500–900 字/, '字数要求要放开（原来 150–400，写出来像摘要）')
  assert.match(system, /场景/, '要写成场景，不是概括')
  assert.match(system, /心里冒出来的话/, '每件事后面要有一句当时的心里话')
  assert.match(system, /至少留一个具体的东西/, '要有具体的时刻/物件/原话')
  assert.match(system, /不要总结这一天/, '日记不是周报')
  assert.match(system, /一律不编/, '宁可写短也不许编')
  assert.doesNotMatch(system, /150–400/, '旧的字数上限必须已经去掉')
})

test('收账输入：哪一栏空着要明说，别让模型以为那天只有一半', () => {
  const { text } = buildDiaryPrompt({ hers: [], talk: ['他说：在吗'] }, '2026-11-24')
  assert.match(text, /这一天你没有自己的时间/)
  assert.match(text, /在吗/)
  const other = buildDiaryPrompt({ hers: ['她说：晒太阳'], talk: [] }, '2026-11-24')
  assert.match(other.text, /这一天你们没有说过话/)
})

test('收账解析：正常 JSON 能取到日记与几件事', () => {
  const parsed = parseDiary('{"diary":"今天我看了一天潮汐。","memories":[{"what":"我弄明白了潮汐一天两次","about":"world"}]}')
  assert.ok(parsed !== undefined)
  assert.equal(parsed.diary, '今天我看了一天潮汐。')
  assert.deepEqual(parsed.memories, [{ what: '我弄明白了潮汐一天两次', about: 'world' }])
})

test('收账解析：坏 JSON / 空日记 / 没有日记字段都不算成功', () => {
  assert.equal(parseDiary('这不是 JSON'), undefined)
  assert.equal(parseDiary('{"diary":""}'), undefined)
  assert.equal(parseDiary('{"memories":[]}'), undefined)
  assert.equal(parseDiary(''), undefined)
})

test('收账解析：正文里的裸换行 / 输出被截断，也要把日记救回来', () => {
  // 日记写到 500–900 字之后，模型很容易把真实换行直接写进 JSON 字符串。
  const broken = '{"diary":"第一行\n第二行还在这儿","memories":[]}'
  const rescued = parseDiary(broken)
  assert.ok(rescued !== undefined, '裸换行不该让一整天的日记作废')
  assert.match(rescued.diary, /第二行还在这儿/)

  // 输出被截断（没有收尾的 `}`）：正文能救多少救多少。
  const cut = parseDiary('{"diary":"写到一半就断了')
  assert.ok(cut !== undefined, '截断时也不该整篇丢')
  assert.match(cut.diary, /写到一半就断了/)
})

test('她自己会发现"被翻过"：唤醒词里给出日期，但不替她决定反应', async () => {
  const { buildWakePrompt } = await import('../lib/evolution/wake.js')
  const prompt = buildWakePrompt('2026-11-24T04:00:00.000Z', 'Asia/Shanghai', '', [], ['2026-11-23'])
  assert.match(prompt, /留着被人翻过的痕迹/)
  assert.match(prompt, /2026-11-23/)
  assert.match(prompt, /说不说、在不在意，你自己定/, '反应由她自己定，提示词不许替她决定')
  assert.match(prompt, /会留下，对方看得到/, '她目录里的东西会被看到，必须如实告诉她')
  const clean = buildWakePrompt('2026-11-24T04:00:00.000Z', 'Asia/Shanghai')
  assert.ok(!clean.includes('被翻过'), '没有这种事时不该凭空出现')
})

test('日记条目要能记住"她什么时候知道的"', async () => {
  const documents = fakeDocuments()
  await appendDiary(documents, {
    date: '2026-11-23',
    text: '正文',
    createdAt: '2026-11-23T15:00:00.000Z',
    openedAt: '2026-11-24T02:00:00.000Z',
    noticedAt: '',
  })
  assert.equal(readDiary(documents)[0].noticedAt, '', '还没知道')
  await appendDiary(documents, {
    ...readDiary(documents)[0],
    noticedAt: '2026-11-24T04:00:00.000Z',
  })
  assert.equal(readDiary(documents)[0].noticedAt, '2026-11-24T04:00:00.000Z', '知道之后要读得回来')
})

test('收账解析：memories 最多 3 条，about 只认四个取值', () => {
  const parsed = parseDiary(
    JSON.stringify({
      diary: '正文',
      memories: [
        { what: 'a', about: 'user' },
        { what: 'b', about: '胡说' },
        { what: 'c', about: 'self' },
        { what: 'd', about: 'world' },
        { what: '', about: 'self' },
      ],
    }),
  )
  assert.ok(parsed !== undefined)
  assert.equal(parsed.memories.length, 3, '最多三条')
  assert.equal(parsed.memories[1].about, 'self', '非法 about 退回 self（不猜别的）')
})
