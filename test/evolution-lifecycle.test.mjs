/**
 * 一次醒来的结算（纯函数）——她"一天怎么转"的核心。
 *
 * 钉五件事：
 * 1. 醒着的醒来：次数 +1、精力扣起动成本、睡眠区间保持空；
 * 2. 睡着醒来：`sleepingSince` 被清空、先扣起床迷糊、再扣起动成本（顺序不能反）；
 * 3. 次数到顶：记为"睡下"，要收账，下一次排到第二天早上；
 * 4. 上限关掉（0）：不排下一次；
 * 5. 同一天里次数一直累加，跨天从 1 重新数。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { MIN_GAP_SECONDS } from '../lib/evolution/constants.js'
import { SLEEP_INERTIA, WAKE_COST } from '../lib/evolution/energy.js'
import { settleWakeState, sleepGapSeconds } from '../lib/evolution/lifecycle.js'

const TZ = 'Asia/Shanghai'

/** 造一份醒着时的状态。 */
function awake(overrides = {}) {
  return {
    taskId: 'task-1',
    roomSessionId: 'session-room',
    lastWakeAt: '',
    nextAt: '',
    dayKey: '2026-11-24',
    dayCount: 0,
    energy: 80,
    energyAt: '2026-11-24T04:00:00.000Z',
    sleepingSince: '',
    tokensToday: 0,
    tokensDayKey: '2026-11-24',
    lastError: '',
    lastSettleError: '',
    lastAttemptAt: '',
    ...overrides,
  }
}

const rhythm = { minGapMinutes: 40, maxGapMinutes: 150, maxPerDay: 8 }

test('醒着的醒来：次数 +1，精力只扣一次起动成本', () => {
  const result = settleWakeState({
    state: awake({ energy: 80 }),
    at: '2026-11-24T04:30:00.000Z',
    timeZone: TZ,
    rhythm,
    random: () => 0.5,
  })
  assert.equal(result.state.dayCount, 1)
  assert.equal(result.state.energy, 80 - WAKE_COST, '醒着时精力不随时间变，只扣起动成本')
  assert.equal(result.state.sleepingSince, '')
  assert.equal(result.fellAsleep, false)
  assert.ok(typeof result.gapSeconds === 'number' && result.gapSeconds >= MIN_GAP_SECONDS)
})

test('睡着醒来：清空睡点、先扣起床迷糊再扣起动成本', () => {
  // 睡了 10 小时，从 30 点起（足够它睡到自然醒）。
  const result = settleWakeState({
    state: awake({ energy: 30, sleepingSince: '2026-11-24T00:00:00.000Z', energyAt: '2026-11-24T00:00:00.000Z' }),
    at: '2026-11-24T10:00:00.000Z',
    timeZone: TZ,
    rhythm,
    random: () => 0.5,
  })
  assert.equal(result.state.sleepingSince, '', '醒来之后不该还标着在睡')
  assert.ok(result.state.energy > 30, '睡一觉一定要回血')
  assert.equal(result.fellAsleep, false, '睡醒不等于刚睡下，不该收账')
  assert.ok(
    result.state.energy <= 100 - SLEEP_INERTIA - WAKE_COST,
    '起床迷糊与起动成本都要扣（顺序反了会只扣一次）',
  )
})

test('次数到顶：记为睡下、要收账、排到第二天早上', () => {
  const result = settleWakeState({
    state: awake({ energy: 70, dayCount: 7 }),
    at: '2026-11-24T06:00:00.000Z',
    timeZone: TZ,
    rhythm: { ...rhythm, maxPerDay: 8 },
    random: () => 0.5,
  })
  assert.equal(result.state.dayCount, 8, '这一次是今天的第 8 次')
  assert.notEqual(result.state.sleepingSince, '', '到顶就算这一天过完了')
  assert.equal(result.fellAsleep, true, '刚睡下 ⇒ 要收账')
  assert.ok(typeof result.gapSeconds === 'number')
  // 06:00Z = 14:00 东八区，排到明早 8 点 ⇒ 18 小时左右。
  assert.ok(result.gapSeconds >= 17 * 3600 && result.gapSeconds <= 19 * 3600, `实际 ${result.gapSeconds}`)
})

test('上限关掉（0）：不排下一次，也不因为次数睡', () => {
  const result = settleWakeState({
    state: awake({ energy: 70, dayCount: 3 }),
    at: '2026-11-24T06:00:00.000Z',
    timeZone: TZ,
    rhythm: { ...rhythm, maxPerDay: 0 },
    random: () => 0.5,
  })
  assert.equal(result.gapSeconds, undefined, '上限为 0 就不该再排')
  assert.equal(result.state.sleepingSince, '', '上限关掉不等于该睡')
  assert.equal(result.fellAsleep, false)
})

test('同一天次数累加，跨天从 1 重新数', () => {
  const same = settleWakeState({
    state: awake({ dayKey: '2026-11-24', dayCount: 3 }),
    at: '2026-11-24T06:00:00.000Z',
    timeZone: TZ,
    rhythm,
    random: () => 0.5,
  })
  assert.equal(same.state.dayCount, 4, '同一天要继续数')

  const nextDay = settleWakeState({
    state: awake({ dayKey: '2026-11-24', dayCount: 3 }),
    at: '2026-11-25T00:30:00.000Z', // 东八区 08:30，已经换天
    timeZone: TZ,
    rhythm,
    random: () => 0.5,
  })
  assert.equal(nextDay.state.dayCount, 1, '新的一天从 1 开始')
  assert.equal(nextDay.state.dayKey, '2026-11-25')
})

test('睡着的间隔只有一份规矩：到顶等明早，累了按曲线（重启重排也用它）', () => {
  const sleepingState = awake({ energy: 40, sleepingSince: '2026-11-24T06:00:00.000Z', dayCount: 3 })
  // 14:00 东八区、次数没到顶 ⇒ 按睡眠曲线（几十分钟到几小时，但远不到明早）。
  const tired = sleepGapSeconds(sleepingState, '2026-11-24T06:00:00.000Z', TZ, rhythm)
  assert.ok(tired >= MIN_GAP_SECONDS && tired < 12 * 3600, `累了不该等明早，实际 ${tired}`)
  // 次数到顶 ⇒ 一律到明早（≈18 小时）。
  const capped = sleepGapSeconds({ ...sleepingState, dayCount: 8 }, '2026-11-24T06:00:00.000Z', TZ, rhythm)
  assert.ok(capped >= 17 * 3600, `到顶要等明早，实际 ${capped}`)
})
test('跨天重启：昨天的"到顶"不许拖住今天（否则又多睡一整天）', () => {
  // 昨晚 22:00 到顶睡下；第二天早上 08:30 重启，状态里的 dayCount 还是 8、dayKey 还是昨天。
  const stale = awake({
    energy: 90,
    dayCount: 8,
    dayKey: '2026-11-24',
    sleepingSince: '2026-11-24T14:00:00.000Z',
    energyAt: '2026-11-24T14:00:00.000Z',
  })
  const gap = sleepGapSeconds(stale, '2026-11-25T00:30:00.000Z', TZ, rhythm)
  assert.ok(gap < 12 * 3600, `今天没到顶，不该再排一整天，实际 ${gap}`)
})