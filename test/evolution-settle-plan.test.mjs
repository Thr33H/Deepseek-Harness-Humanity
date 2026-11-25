/**
 * 收账判定 + 材料本子的回归钉。
 *
 * 这段逻辑之所以值得单独钉：真机上"日记是空的"连续发生了好几天，而原因
 * 要么没有、要么说得不准（把"材料没了"写成"她那天没留下话"）。
 *
 * 钉六件事：
 *
 * 1. **材料跟着它自己的那一天走**（跨午夜收昨天，不是丢掉）；
 * 2. **一天只有一篇**（写过就不是错误）；
 * 3. **没有材料时只许说两种话**：她那天没开口 / 这份记录之前看不出来；
 * 4. 本子**连正文一起落盘**（重启还在，条数上限 40）；
 * 5. 老版本那种"只有条数、没有正文"的文档**当成空本子**，不冒充材料；
 * 6. 时刻按她的时区写。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { NOTES_DOC_KEY, NOTES_MAX_LINES } from '../lib/evolution/constants.js'
import { readNotes, saveNotes } from '../lib/evolution/state.js'
import { decideSettle, momentText } from '../lib/evolution/settle-plan.js'

/** 只支持读写文档的假文档表。 */
function fakeDocuments(initial = {}) {
  const store = new Map(Object.entries(initial))
  return {
    read: (ns) => (store.has(ns) ? { value: store.get(ns), revision: 1, updatedAt: '' } : undefined),
    write: async (ns, next) => {
      store.set(ns, next)
      return { value: next, revision: 2, updatedAt: '' }
    },
    merge: async () => {
      throw new Error('材料本子只用 write')
    },
    list: () => [],
    peek: (ns) => store.get(ns),
  }
}

/** 一份基准事实（各用例只改自己关心的字段）。 */
function facts(overrides = {}) {
  return {
    today: '2026-11-25',
    notesDay: '',
    notesCount: 0,
    writtenDates: [],
    startedAt: '2026-11-20T01:00:00.000Z',
    startedDay: '2026-11-20',
    timeZone: 'Asia/Shanghai',
    ...overrides,
  }
}

test('收账判定：材料是今天的，就收今天', () => {
  const plan = decideSettle(facts({ notesDay: '2026-11-25', notesCount: 12 }))
  assert.deepEqual(plan, { kind: 'write', date: '2026-11-25' })
})

test('收账判定：材料是昨天的，就收昨天（跨午夜不能丢那一天）', () => {
  const plan = decideSettle(facts({ notesDay: '2026-11-24', notesCount: 3 }))
  assert.deepEqual(plan, { kind: 'write', date: '2026-11-24' })
})

test('收账判定：今天的已写过、手上却是昨天的 ⇒ 先把昨天补上', () => {
  const plan = decideSettle(facts({
    notesDay: '2026-11-24',
    notesCount: 3,
    writtenDates: ['2026-11-25'],
  }))
  assert.deepEqual(plan, { kind: 'write', date: '2026-11-24' })
})

test('收账判定：昨天已经写过，就不再重复收', () => {
  const plan = decideSettle(facts({
    notesDay: '2026-11-24',
    notesCount: 3,
    writtenDates: ['2026-11-24'],
  }))
  assert.equal(plan.kind, 'cannot')
  assert.match(plan.reason, /已经写过/)
})

test('收账判定：今天已经写过，安静跳过（不算错误）', () => {
  const plan = decideSettle(facts({ writtenDates: ['2026-11-25'] }))
  assert.deepEqual(plan, { kind: 'done' })
})

test('收账判定：本子空的、进程那天之前就活着 ⇒ 才能说她那天没开口', () => {
  const plan = decideSettle(facts({ startedDay: '2026-11-20' }))
  assert.equal(plan.kind, 'cannot')
  assert.match(plan.reason, /没在房间里说过话/)
})

test('收账判定：进程是当天才起来的 ⇒ 只能说看不出来，不许冒充结论', () => {
  const plan = decideSettle(facts({
    startedAt: '2026-11-25T03:00:00.000Z',
    startedDay: '2026-11-25',
  }))
  assert.equal(plan.kind, 'cannot')
  assert.match(plan.reason, /看不出来/)
  assert.doesNotMatch(plan.reason, /没在房间里说过话/)
})

test('收账判定：进程比那一天还晚（隔天重启后才来收昨天）⇒ 也是看不出来', () => {
  const plan = decideSettle(facts({ startedDay: '2026-11-26' }))
  assert.equal(plan.kind, 'cannot')
  assert.match(plan.reason, /看不出来/)
})

test('收账判定：算不出今天是哪天 ⇒ 明说时间基准坏了', () => {
  const plan = decideSettle(facts({ today: '' }))
  assert.equal(plan.kind, 'cannot')
  assert.match(plan.reason, /时间基准/)
})

test('收账判定：时刻按她的时区写成"几号几点"', () => {
  // 2026-11-25T03:49:55Z 在东八区是 11:49。
  assert.equal(momentText('2026-11-25T03:49:55.000Z', 'Asia/Shanghai'), '11-25 11:49')
  // 时区名坏了不该炸：退回进程时区，至少给出一个能看的时间。
  assert.match(momentText('2026-11-25T01:30:00.000Z', 'Not/AZone'), /^\d{2}-\d{2} \d{2}:\d{2}$/)
})

test('材料本子：存进去的正文能原样读回来（重启也不丢）', async () => {
  const documents = fakeDocuments()
  await saveNotes(documents, {
    day: '2026-11-25',
    lines: ['她说：今天去查了潮汐', '看到：月球引力一天两次'],
    lastAt: '2026-11-25T03:00:00.000Z',
  })
  const book = readNotes(documents)
  assert.equal(book.day, '2026-11-25')
  assert.deepEqual(book.lines, ['她说：今天去查了潮汐', '看到：月球引力一天两次'])
})

test('材料本子：只留最近 40 行，旧的不再参与这一天的日记', async () => {
  const documents = fakeDocuments()
  const many = Array.from({ length: NOTES_MAX_LINES + 7 }, (_, index) => `第 ${index} 行`)
  await saveNotes(documents, { day: '2026-11-25', lines: many, lastAt: '' })
  const book = readNotes(documents)
  assert.equal(book.lines.length, NOTES_MAX_LINES)
  assert.equal(book.lines[book.lines.length - 1], `第 ${NOTES_MAX_LINES + 6} 行`)
})

test('材料本子：老版本"只有条数、没有正文"的文档当成空本子', () => {
  const documents = fakeDocuments({
    [NOTES_DOC_KEY]: { day: '2026-11-25', count: 7, lastAt: '2026-11-25T03:00:00.000Z' },
  })
  const book = readNotes(documents)
  assert.equal(book.day, '')
  assert.deepEqual(book.lines, [])
})

test('材料本子：空白与非字符串的行不进来（别拿噪声写她的日记）', () => {
  const documents = fakeDocuments({
    [NOTES_DOC_KEY]: { day: '2026-11-25', lines: ['真的', '   ', 42, '', '也算真的'], lastAt: '' },
  })
  assert.deepEqual(readNotes(documents).lines, ['真的', '也算真的'])
})

test('材料本子：什么都没存过时读成空本子（不炸）', () => {
  assert.deepEqual(readNotes(fakeDocuments()), { day: '', lines: [], lastAt: '' })
  assert.deepEqual(readNotes(undefined), { day: '', lines: [], lastAt: '' })
})
