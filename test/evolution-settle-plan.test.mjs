/**
 * 收账判定的回归钉。
 *
 * 这段逻辑之所以值得单独钉：真机上"日记是空的"连续发生了好几天，而原因
 * 要么没有、要么说得不准（把"材料被重启冲掉"写成"她那天没留下话"）。
 * 这里钉五件事：
 *
 * 1. **材料跟着它自己的那一天走**（跨午夜收昨天，不是丢掉）；
 * 2. **一天只有一篇**（写过就不是错误）；
 * 3. **清点里记过、手上却是空的** ⇒ 原因必须直说"被重启冲掉了"；
 * 4. **进程覆盖了那一整天** ⇒ 才可以说"她那天没开口"；
 * 5. **其余情况** ⇒ 只能说"看不出来"，不许冒充前两种。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { decideSettle, momentText } from '../lib/evolution/settle-plan.js'

/** 一份基准事实（各用例只改自己关心的字段）。 */
function facts(overrides = {}) {
  return {
    today: '2026-11-25',
    notesDay: '',
    notesCount: 0,
    recordedDay: '',
    recordedCount: 0,
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

test('收账判定：清点里记过、手上却是空的 ⇒ 必须直说材料被重启冲掉了', () => {
  const plan = decideSettle(facts({ recordedDay: '2026-11-25', recordedCount: 7 }))
  assert.equal(plan.kind, 'cannot')
  assert.match(plan.reason, /记过 7 行/)
  assert.match(plan.reason, /重启/)
  // 这一条最要紧：不许把它说成"她那天没开口"。
  assert.doesNotMatch(plan.reason, /没在房间里说过话/)
})

test('收账判定：进程那天之前就活着、清点里也没有 ⇒ 才能说她那天没开口', () => {
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

test('收账判定：材料属于今天、今天也没写过 ⇒ 永远优先写，不受清点影响', () => {
  const plan = decideSettle(facts({
    notesDay: '2026-11-25',
    notesCount: 1,
    recordedDay: '2026-11-25',
    recordedCount: 1,
  }))
  assert.deepEqual(plan, { kind: 'write', date: '2026-11-25' })
})

test('收账判定：时刻按她的时区写成"几号几点"', () => {
  // 2026-11-25T01:30:00Z 在东八区是 09:30。
  assert.equal(momentText('2026-11-25T01:30:00.000Z', 'Asia/Shanghai'), '11-25 09:30')
  // 时区名坏了不该炸：退回进程时区，至少给出一个能看的时间。
  assert.match(momentText('2026-11-25T01:30:00.000Z', 'Not/AZone'), /^\d{2}-\d{2} \d{2}:\d{2}$/)
})
