/**
 * 精力模型的回归钉。
 *
 * 钉的是**性质**，不是几个算出来的小数（小数会随参数一起变，性质不会）：
 * 1. 醒着时精力不随时间变（累只来自 token，不来自"过了多久"）；
 * 2. 睡一觉一定回血；睡够一定醒；醒来的那一下要扣起床迷糊；
 * 3. "排到几点醒"和"真到点结算"必须一致 —— 否则她会排一个醒不来的时刻；
 * 4. 夜里睡比白天睡值；缺得越多补得越快；
 * 5. token 记账：缓存读只算一成，且越到后面每一份越贵。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  BLOCK_MINUTES,
  drainPoints,
  ENERGY_MAX,
  minutesToWake,
  settleEnergy,
  shouldSleep,
  SLEEP_AT,
  startsSleeping,
  SLEEP_CAP_MINUTES,
  SLEEP_INERTIA,
  SLEEP_MIN_MINUTES,
  tokensTodayOf,
  WAKE_AT,
  weightedTokens,
} from '../lib/evolution/energy.js'

/** 造一份睡眠状态。 */
function sleeping(energy, sinceIso) {
  return { energy, energyAt: sinceIso, sleepingSince: sinceIso }
}

test('醒着时精力不随时间变（累只来自 token）', () => {
  const state = { energy: 55, energyAt: '2026-11-23T02:00:00.000Z', sleepingSince: '' }
  const settled = settleEnergy(state, '2026-11-23T12:00:00.000Z', 'UTC')
  assert.equal(settled.energy, 55, '干坐着十小时不该变累，也不该回血')
  assert.equal(settled.energyAt, '2026-11-23T12:00:00.000Z')
})

test('睡一觉一定回血，而且缺得越多回得越快', () => {
  const low = settleEnergy(sleeping(20, '2026-11-23T23:00:00.000Z'), '2026-11-24T01:00:00.000Z', 'UTC')
  const high = settleEnergy(sleeping(60, '2026-11-23T23:00:00.000Z'), '2026-11-24T01:00:00.000Z', 'UTC')
  assert.ok(low.energy > 20, '两小时睡眠必须回血')
  assert.ok(low.energy - 20 > high.energy - 60, '精力越低，这两小时恢复得越多')
})

test('睡够了会自己醒，且醒来要扣起床迷糊', () => {
  const sleepless = settleEnergy(sleeping(20, '2026-11-23T23:00:00.000Z'), '2026-11-24T09:00:00.000Z', 'UTC')
  assert.equal(sleepless.sleepingSince, '', '十小时之后必须已经醒了')
  assert.ok(sleepless.energy <= ENERGY_MAX - SLEEP_INERTIA, '醒来那一下要扣起床迷糊')
  assert.ok(sleepless.energy >= WAKE_AT - SLEEP_INERTIA, '睡够了精力要在醒来线附近以上')
})

test('睡不满最短时长不会醒（精力够也不醒）', () => {
  const early = settleEnergy(sleeping(68, '2026-11-23T23:00:00.000Z'), '2026-11-23T23:30:00.000Z', 'UTC')
  assert.notEqual(early.sleepingSince, '', '半小时就叫醒的觉不算睡')
  assert.ok(early.energy > 68, '但这半小时仍然要回血')
})

test('排到几点醒 == 真到点结算（否则她会排一个醒不来的时刻）', () => {
  for (const start of [0, 10, 20, 40]) {
    const at = '2026-11-23T15:00:00.000Z' // UTC 15 点：白天，效率最低的时段
    const minutes = minutesToWake(start, at, 'UTC')
    assert.ok(minutes >= SLEEP_MIN_MINUTES, `至少睡到最短时长（实际 ${minutes}）`)
    assert.ok(minutes <= SLEEP_CAP_MINUTES, '不超过睡眠上限')
    const wakeAt = new Date(Date.parse(at) + minutes * 60_000).toISOString()
    const settled = settleEnergy(sleeping(start, at), wakeAt, 'UTC')
    assert.equal(settled.sleepingSince, '', `按 ${minutes} 分钟排，到点应当已醒`)
  }
})

test('夜里睡比白天睡值', () => {
  const night = settleEnergy(sleeping(20, '2026-11-23T23:00:00.000Z'), '2026-11-24T01:00:00.000Z', 'UTC')
  const day = settleEnergy(sleeping(20, '2026-11-23T13:00:00.000Z'), '2026-11-23T15:00:00.000Z', 'UTC')
  assert.ok(night.energy > day.energy, '同样是两小时，夜里恢复得更多')
})

test('睡太久不再有用（有时间上限）', () => {
  const long = settleEnergy(sleeping(20, '2026-11-23T22:00:00.000Z'), '2026-11-24T14:00:00.000Z', 'UTC')
  assert.equal(long.sleepingSince, '', '早该醒了')
  assert.ok(long.energy <= ENERGY_MAX)
})

test('该不该睡：只有醒着且掉到底线以下才睡', () => {
  assert.equal(shouldSleep({ energy: SLEEP_AT, energyAt: '', sleepingSince: '' }), true)
  assert.equal(shouldSleep({ energy: SLEEP_AT + 1, energyAt: '', sleepingSince: '' }), false)
  assert.equal(shouldSleep({ energy: 5, energyAt: '', sleepingSince: '2026-11-23T23:00:00.000Z' }), false, '已经睡着就别再记一次')
})

test('token 记账：缓存读只算一成', () => {
  assert.equal(weightedTokens({ inputTokens: 1000, outputTokens: 500 }), 1500)
  assert.equal(weightedTokens({ inputTokens: 1000, outputTokens: 500, cacheReadTokens: 40000 }), 1500 + 4000)
  assert.equal(weightedTokens({ inputTokens: 1000, cacheReadTokens: 0 }), 1000)
  assert.equal(weightedTokens({}), 0)
  assert.equal(weightedTokens(undefined), 0)
  assert.equal(weightedTokens({ inputTokens: -5, outputTokens: 'x' }), 0, '坏字段按 0 算，不许变成负数')
})

test('越到后面每一份越贵（疲劳），但花得少时几乎一样', () => {
  const early = drainPoints(50_000, 0)
  const late = drainPoints(50_000, 1_000_000)
  assert.ok(early > 0)
  assert.ok(late > early, '同样五万 token，晚上比早上更累')
  assert.ok(late / early < 2, '但最多贵一倍上下，不该失控')
  assert.equal(drainPoints(0, 100), 0)
})

test('"今天花了多少"跨天归零', () => {
  assert.equal(tokensTodayOf('2026-11-23', '2026-11-23', 1234), 1234)
  assert.equal(tokensTodayOf('2026-11-22', '2026-11-23', 1234), 0)
  assert.equal(tokensTodayOf('', '2026-11-23', 1234), 0)
  assert.equal(tokensTodayOf('2026-11-23', '2026-11-23', -3), 0)
})

test('时间口径：睡眠分格是 15 分钟，最短睡 90 分钟', () => {
  assert.equal(BLOCK_MINUTES, 15)
  assert.equal(SLEEP_MIN_MINUTES, 90)
})

test('什么时候算"一天到头"：精力见底，或者今天的次数到顶', () => {
  const base = { wasSleeping: false, energy: 80, dayCount: 1, maxPerDay: 8 }
  assert.equal(startsSleeping(base), false, '还有力气、次数没到顶 ⇒ 不睡')
  assert.equal(startsSleeping({ ...base, energy: SLEEP_AT }), true, '掉到底线就睡')
  assert.equal(startsSleeping({ ...base, energy: SLEEP_AT - 0.1 }), true, '低于底线也睡')
  assert.equal(startsSleeping({ ...base, dayCount: 8 }), true, '次数到顶也算一天结束')
  assert.equal(startsSleeping({ ...base, dayCount: 9 }), true, '超过上限同样算（不该出现，但不能因此不睡）')
  assert.equal(startsSleeping({ ...base, dayCount: 8, maxPerDay: 0 }), false, '上限关掉（0）时不因次数睡')
  assert.equal(startsSleeping({ ...base, energy: 10, wasSleeping: true }), false, '已经在睡时不重复记睡点')
})
