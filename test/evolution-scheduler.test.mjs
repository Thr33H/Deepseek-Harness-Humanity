/**
 * 调度层测试：定时计算（纯函数）+ 调度器行为（假时钟）。
 *
 * 假时钟**手动推进**：定时器语义（重臂、分段、推迟、tick）全在毫秒算术里，
 * 真实 `setTimeout` 会让测试要么等 30 分钟要么 flaky——注入点是 scheduler 自己开的
 * （`now`/`setTimer`/`clearTimer`），不是为测试挖的洞。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createLog } from '../lib/log.js'
import { installScheduler } from '../lib/evolution/scheduler.js'
import { computeNextRunAt, dayKeyOf, modeForSchedule, utcDateOf } from '../lib/evolution/schedule-time.js'
import { fakeEvolutionState } from './helpers/evolution-fake.mjs'

const log = createLog(new Context(), 'test')

/** 基准时刻：2026-09-25T10:00:00Z（周五）。 */
const T0 = Date.parse('2026-09-25T10:00:00.000Z')

/** 造调度配置（默认每日 03:00 UTC）。 */
function schedule(overrides = {}) {
  return { mode: 'daily', idleMinutes: 30, timeOfDay: '03:00', weekday: 1, monthDay: 1, timezone: 'UTC', ...overrides }
}

// ---------- 纯函数：computeNextRunAt ----------

test('每日：当前时刻晚于今天触发点 → 明天同一时刻', () => {
  assert.equal(computeNextRunAt(schedule(), T0), Date.parse('2026-09-26T03:00:00.000Z'))
})

test('每日：当前时刻早于今天触发点 → 今天', () => {
  const early = Date.parse('2026-09-25T01:00:00.000Z')
  assert.equal(computeNextRunAt(schedule(), early), Date.parse('2026-09-25T03:00:00.000Z'))
})

test('每周（周一）：从周五算 → 下周一 03:00', () => {
  const next = computeNextRunAt(schedule({ mode: 'weekly', weekday: 1 }), T0)
  assert.equal(next, Date.parse('2026-09-28T03:00:00.000Z'))
})

test('每周：触发点就是今天但已过 → 下周日再加七天', () => {
  const friday = Date.parse('2026-09-25T01:00:00.000Z')
  const next = computeNextRunAt(schedule({ mode: 'weekly', weekday: 5 }), friday)
  assert.equal(next, Date.parse('2026-09-25T03:00:00.000Z'), '当天未过触发点 → 就是今天')
  const afterFriday = computeNextRunAt(schedule({ mode: 'weekly', weekday: 5 }), T0)
  assert.equal(afterFriday, Date.parse('2026-10-02T03:00:00.000Z'), '已过 → 下周五')
})

test('每月（1 日）：从 9 月 25 日算 → 10 月 1 日', () => {
  const next = computeNextRunAt(schedule({ mode: 'monthly', monthDay: 1 }), T0)
  assert.equal(next, Date.parse('2026-10-01T03:00:00.000Z'))
})

test('时区：Asia/Shanghai 的 03:00 = UTC 前一日 19:00', () => {
  const next = computeNextRunAt(schedule({ timezone: 'Asia/Shanghai' }), T0)
  assert.equal(next, Date.parse('2026-09-25T19:00:00.000Z'))
})

test('时刻非法：回退 03:00 并警告一次（调度路径不抛，G-002）', () => {
  const warnings = []
  const next = computeNextRunAt(schedule({ timeOfDay: '25:99' }), T0, (message) => warnings.push(message))
  assert.equal(next, Date.parse('2026-09-26T03:00:00.000Z'))
  assert.equal(warnings.length, 1)
  assert.ok(warnings[0].includes('25:99'))
})

test('时区非法：回退并警告（不抛）', () => {
  const warnings = []
  const next = computeNextRunAt(schedule({ timezone: 'Mars/Olympus' }), T0, (message) => warnings.push(message))
  assert.ok(next > T0)
  assert.ok(warnings.some((message) => message.includes('Mars/Olympus')))
})

test('idle 模式没有定时触发这回事（返回 0）；形态映射与 UTC 日期', () => {
  assert.equal(computeNextRunAt(schedule({ mode: 'idle' }), T0), 0)
  assert.equal(modeForSchedule(schedule({ mode: 'daily' })), 'incremental')
  assert.equal(modeForSchedule(schedule({ mode: 'weekly' })), 'dream')
  assert.equal(modeForSchedule(schedule({ mode: 'monthly' })), 'dream')
  assert.equal(utcDateOf(T0), '2026-09-25')
})

test('记账用的「今天」按**调度时区**算，不是 UTC（2026-09-26 审计 E5）', () => {
  // 容器在 CST（UTC+8）时，UTC 日期要到北京时间 08:00 才翻页 —— 旧实现用 toISOString()，
  // 于是工作台的「今日用量」在早上 8 点突然归零，而 03:00 那次定时运行被算进前一个 UTC 日。
  const shanghai = schedule({ timezone: 'Asia/Shanghai' })
  // 2026-09-25T20:00Z = 北京时间 09-26 04:00 ⇒ 调度日已经是 26 号，UTC 日还是 25 号。
  assert.equal(dayKeyOf(Date.parse('2026-09-25T20:00:00.000Z'), shanghai), '2026-09-26')
  assert.equal(utcDateOf(Date.parse('2026-09-25T20:00:00.000Z')), '2026-09-25', '这正是错的那一个')
  // 同一条时刻在 UTC 时区里就是 25 号：时区说了算，不是机器时区说了算。
  assert.equal(dayKeyOf(Date.parse('2026-09-25T20:00:00.000Z'), schedule({ timezone: 'UTC' })), '2026-09-25')
  // 时区为空串 ⇒ 系统时区（只要求它是一个合法的 YYYY-MM-DD，不猜机器时区）。
  assert.match(dayKeyOf(Date.parse('2026-09-25T20:00:00.000Z'), schedule({ timezone: '' })), /^\d{4}-\d{2}-\d{2}$/)
})

test('时区名非法时 dayKey 回退系统时区并警告，绝不抛（调度路径同一条纪律）', () => {
  const warnings = []
  const key = dayKeyOf(T0, schedule({ timezone: 'Mars/Olympus' }), (message) => warnings.push(message))
  assert.match(key, /^\d{4}-\d{2}-\d{2}$/)
  assert.ok(warnings.some((message) => message.includes('Mars/Olympus')))
  assert.match(dayKeyOf(T0, undefined), /^\d{4}-\d{2}-\d{2}$/, '配置形状不全也不抛')
})

// ---------- 行为：installScheduler（假时钟） ----------

/** 造可手动推进的假时钟（定时器按到期顺序触发，触发后等待微任务收敛）。 */
function fakeClock(startMs) {
  let nowMs = startMs
  const timers = new Map()
  let nextId = 1
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  const api = {
    now: () => nowMs,
    setTimer: (fn, ms) => {
      const id = nextId++
      timers.set(id, { fn, at: nowMs + ms })
      return id
    },
    clearTimer: (id) => {
      timers.delete(id)
    },
    async advance(ms) {
      const target = nowMs + ms
      for (;;) {
        let due = null
        for (const [id, timer] of timers) {
          if (timer.at <= target && (due === null || timer.at < due.timer.at)) due = { id, timer }
        }
        if (due === null) break
        nowMs = due.timer.at
        timers.delete(due.id)
        due.timer.fn()
        await settle()
      }
      nowMs = target
      await settle()
    },
    settle,
    pending: () => timers.size,
  }
  return api
}

/** 造调度环境（活动追踪与 runner 都是可变假件）。 */
function schedulerHarness(overrides = {}) {
  const clock = fakeClock(overrides.startMs ?? T0)
  const { state } = fakeEvolutionState()
  const starts = []
  const activity = { lastActivity: clock.now(), running: false }
  const ctx = new Context()
  const handle = installScheduler(ctx, {
    schedule: () => overrides.schedule ?? schedule(),
    enabled: () => overrides.enabled ?? true,
    dreamEnabled: () => overrides.dreamEnabled ?? true,
    state,
    activity: { lastActivityAt: () => activity.lastActivity, hasRunning: () => activity.running },
    runner: {
      current: () => (overrides.busy === true ? { id: 'x' } : undefined),
      start: async (options) => {
        starts.push(options)
        return { id: 'run', mode: options.mode, trigger: options.trigger, status: 'completed' }
      },
    },
    log,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
  return { clock, state, starts, activity, handle, ctx }
}

test('每日模式：装上即持久化 nextRunAt；到点触发 scheduled 增量并重排下一天', async () => {
  const { clock, state, starts, handle } = schedulerHarness()
  await clock.settle() // nextRunAt 的落盘是异步的，等一拍再断言
  assert.equal(state.readState().nextRunAt, Date.parse('2026-09-26T03:00:00.000Z'))

  await clock.advance(Date.parse('2026-09-26T03:00:00.000Z') - T0)
  assert.deepEqual(starts, [{ mode: 'incremental', trigger: 'scheduled' }])
  assert.equal(state.readState().nextRunAt, Date.parse('2026-09-27T03:00:00.000Z'))
  handle.dispose()
})

test('每周模式触发梦境；梦境开关关闭退回增量（不空转）', async () => {
  const weekly = schedulerHarness({ schedule: schedule({ mode: 'weekly', weekday: 1 }) })
  await weekly.clock.advance(Date.parse('2026-09-28T03:00:00.000Z') - T0)
  assert.deepEqual(weekly.starts, [{ mode: 'dream', trigger: 'scheduled' }])
  weekly.handle.dispose()

  const noDream = schedulerHarness({ schedule: schedule({ mode: 'weekly', weekday: 1 }), dreamEnabled: false })
  await noDream.clock.advance(Date.parse('2026-09-28T03:00:00.000Z') - T0)
  assert.deepEqual(noDream.starts, [{ mode: 'incremental', trigger: 'scheduled' }])
  noDream.handle.dispose()
})

test('停机错过触发点：宽限窗内补跑一次，之后按新时刻重排（P-035 只补一次）', async () => {
  const { clock, state, starts, handle } = schedulerHarness()
  // 模拟停机：nextRunAt 是 10 分钟前（宽限 6 小时内）。
  await state.mutateState({ nextRunAt: T0 - 600000 })
  handle.reconfigure()
  await clock.settle()

  assert.deepEqual(starts, [{ mode: 'incremental', trigger: 'scheduled' }])
  assert.equal(state.readState().nextRunAt, Date.parse('2026-09-26T03:00:00.000Z'))
  handle.dispose()
})

test('停机错过且超宽限窗：不补跑，记 skipped 运行', async () => {
  const { clock, state, starts, handle } = schedulerHarness()
  await state.mutateState({ nextRunAt: T0 - 7 * 3600000 })
  handle.reconfigure()
  await clock.settle()

  assert.deepEqual(starts, [])
  const runs = state.listRuns()
  assert.equal(runs.length, 1)
  assert.equal(runs[0].status, 'skipped')
  assert.ok(runs[0].error.includes('宽限窗'))
  handle.dispose()
})

test('触发时对话活跃：推迟 5 分钟再试；安静后照常触发（P-035 暂停条款）', async () => {
  const { clock, state, starts, activity, handle } = schedulerHarness()
  activity.running = true
  await clock.advance(Date.parse('2026-09-26T03:00:00.000Z') - T0)
  assert.deepEqual(starts, [], '第一次到点：对话在跑，不触发')

  activity.running = false
  await clock.advance(5 * 60000)
  assert.deepEqual(starts, [{ mode: 'incremental', trigger: 'scheduled' }])
  handle.dispose()
})

test('推迟次数用尽：记 skipped 并重排下一次（不是永久停摆）', async () => {
  const { clock, state, starts, activity, handle } = schedulerHarness()
  activity.running = true
  await clock.advance(Date.parse('2026-09-26T03:00:00.000Z') - T0)
  await clock.advance(6 * 5 * 60000)
  assert.deepEqual(starts, [])
  const runs = state.listRuns()
  assert.equal(runs.length, 1)
  assert.equal(runs[0].status, 'skipped')
  assert.ok(runs[0].error.includes('推迟次数用尽'))
  assert.equal(state.readState().nextRunAt, Date.parse('2026-09-27T03:00:00.000Z'))
  handle.dispose()
})

test('空闲模式：安静够久且有新活动才触发；没有新活动不重复跑', async () => {
  const { clock, starts, activity, handle } = schedulerHarness({ schedule: schedule({ mode: 'idle', idleMinutes: 30 }) })
  assert.equal(handle.nextRunAt(), 0)

  // 新活动发生在 T0，随后安静 31 分钟：第一次 tick 满 60s 一次，要到 31 分钟后的 tick 才触发。
  activity.lastActivity = T0
  await clock.advance(31 * 60000)
  assert.deepEqual(starts, [{ mode: 'incremental', trigger: 'idle' }])

  // 再安静 2 小时、无任何新活动：不得重复触发（防空转刷运行记录）。
  await clock.advance(2 * 3600000)
  assert.equal(starts.length, 1)

  // 有了新活动再安静 31 分钟：再触发一次。
  activity.lastActivity = clock.now()
  await clock.advance(31 * 60000)
  assert.equal(starts.length, 2)
  handle.dispose()
})

test('空闲模式：已有运行在跑时 tick 不叠加触发（互斥之外的第二道闸）', async () => {
  const { clock, starts, activity, handle } = schedulerHarness({ schedule: schedule({ mode: 'idle', idleMinutes: 1 }), busy: true })
  activity.lastActivity = T0
  await clock.advance(5 * 60000)
  assert.deepEqual(starts, [])
  handle.dispose()
})

test('dispose：定时器全部清理（卸载后世界安静）', async () => {
  const { clock, starts, handle } = schedulerHarness()
  handle.dispose()
  await clock.advance(48 * 3600000)
  assert.deepEqual(starts, [])
  assert.equal(clock.pending(), 0)
})

test('reconfigure：idle 改每日后立即排程；每日改回 idle 清除定时', async () => {
  const { state, handle } = schedulerHarness({ schedule: schedule({ mode: 'idle' }) })
  assert.equal(state.readState().nextRunAt, 0)

  // 这里通过重建 harness 覆盖配置变更路径（闭包里的 schedule() 是现读的）。
  let current = schedule({ mode: 'idle' })
  const clock = fakeClock(T0)
  const { state: state2 } = fakeEvolutionState()
  const ctx = new Context()
  const handle2 = installScheduler(ctx, {
    schedule: () => current,
    enabled: () => true,
    dreamEnabled: () => true,
    state: state2,
    activity: { lastActivityAt: () => clock.now(), hasRunning: () => false },
    runner: { current: () => undefined, start: async () => ({ status: 'completed' }) },
    log,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
  assert.equal(state2.readState().nextRunAt, 0)

  current = schedule({ mode: 'daily' })
  handle2.reconfigure()
  await clock.settle()
  assert.equal(state2.readState().nextRunAt, Date.parse('2026-09-26T03:00:00.000Z'))

  current = schedule({ mode: 'idle' })
  handle2.reconfigure()
  await clock.settle()
  assert.equal(state2.readState().nextRunAt, 0)
  handle2.dispose()
  handle.dispose()
})

test('重排后回调刷新投影（真机实证：工作台「下次定时」停在旧值直到无关事件碰巧刷新）', async () => {
  const clock = fakeClock(T0)
  const { state } = fakeEvolutionState()
  let refreshes = 0
  const ctx = new Context()
  const handle = installScheduler(ctx, {
    schedule: () => schedule(),
    enabled: () => true,
    dreamEnabled: () => true,
    state,
    activity: { lastActivityAt: () => clock.now(), hasRunning: () => false },
    runner: { current: () => undefined, start: async () => ({ status: 'completed' }) },
    log,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    refresh: () => {
      refreshes += 1
    },
  })
  await clock.settle()
  assert.ok(refreshes >= 1, '重排落盘后必须通知投影刷新')
  handle.dispose()
})
