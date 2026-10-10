/**
 * 自建调度器：定时（每日/每周/每月）+ 空闲自动 + 错过补跑（P-035）。
 *
 * ### 为什么不是 dsh-schedule / ctx.jobs（交接 §5.3 的"二选一实证"结论）
 * - `dsh-schedule` 是**会话级**提醒器：交付即向 agent 发 prompt（触发计费轮次、打进对话），
 *   且会话不活就不跑——凌晨定时无法保证（编译 `dsh-schedule/lib/types/runtime.d.ts:5-8`）；
 * - `ctx.jobs.start` 要求有已挂载的 job controller（由 agent 组合的 `dsh-tool-jobs` 提供，
 *   编译 `dsh-jobs-local/lib/index.js:131-132`）——宿主后台任务恰在无活跃会话时触发，必被拒；
 * - `DEVELOPMENT.md` §3.2 明文允许「插件自有调度器」；DSH 第一方 `dsh-schedule` 自己就用
 *   全局 `setTimeout` 分段重臂（`lib/index.js:852`、`MAX_TIMER_DELAY_MS`）。本文件是同款做法。
 *
 * ### 语义要点（全部对应 P-035 的冻结文字）
 * - 选定时模式后空闲触发**关闭**；手动触发不走这里（命令槽直接调 runner）。
 * - 错过的定时**只补一次**：停机跨过触发点，启动后若在宽限窗内立即补跑；超窗记 `skipped`。
 * - 触发时有 agent 在跑 ⇒ 推迟（DEFER_RETRY_MS × DEFER_RETRY_MAX 次后放弃记 `skipped`）。
 * - 空闲触发要"有新内容才跑"：上次空闲触发之后没有新活动就不再重复（防空转刷运行记录）。
 * - 定时器全部经 `ctx.effect` 挂卸载清理；分段重臂躲开 setTimeout 的 32 位毫秒上限。
 * @module humanity/evolution/scheduler
 */
import type { Context } from '@deepseek-ai/cordis'

import type { Log } from '../log.js'
import type { ActivityTracker } from './activity.js'
import { DEFER_RETRY_MAX, DEFER_RETRY_MS, IDLE_TICK_MS, MAX_TIMER_SEGMENT_MS, SCHEDULE_GRACE_MS } from './constants.js'
import type { RunOptions, Runner } from './run.js'
import { computeNextRunAt, type ScheduleConfig } from './schedule-time.js'
import { launch, recordSkipped, type LaunchDeps } from './scheduler-actions.js'
import type { EvolutionState } from './state.js'

/** 调度依赖（配置现读：改了设置，下一次重算立即生效）。 */
export interface SchedulerDeps {
  schedule(): ScheduleConfig
  enabled(): boolean
  dreamEnabled(): boolean
  state: EvolutionState
  activity: ActivityTracker
  runner: Runner
  log: Log
  /** 重排/运行结束后的投影刷新（工作台读投影，不刷就停旧值）。 */
  refresh?(): void
  /** 时钟与定时器注入点（测试替身；缺省用真实实现）。 */
  now?(): number
  setTimer?(handler: () => void, ms: number): unknown
  clearTimer?(handle: unknown): void
}

/** 调度器句柄。 */
export interface SchedulerHandle {
  /** 设置变更后重算（宿主 onChanged 调）。 */
  reconfigure(): void
  /** 下一次定时触发的 epoch 毫秒；0 = 未排程（空闲模式或未启用）。 */
  nextRunAt(): number
  dispose(): void
}

/** 调度器的可变内部状态。 */
interface SchedulerState {
  timer: unknown | undefined
  idleTimer: unknown | undefined
  deferCount: number
  lastIdleRunAt: number
  disposed: boolean
}

/** 停机对账：错过的触发点在宽限窗内补跑一次，超窗记 skipped（P-035）。 */
function catchUpMissed(deps: LaunchDeps, stored: number, current: number): void {
  if (stored <= 0 || stored > current) return
  const overdue = current - stored
  if (overdue <= SCHEDULE_GRACE_MS) {
    deps.log.info(`定时整理错过触发点 ${Math.round(overdue / 60000)} 分钟（宽限窗内），补跑一次`)
    launch(deps, 'scheduled')
    return
  }
  void recordSkipped(deps, `停机错过触发点且超出 ${SCHEDULE_GRACE_MS / 3600000} 小时宽限窗，按跳过处理（P-035：只补一次）`, current)
}

/**
 * 装上调度器。
 * @param ctx - 插件上下文（清理挂 fiber；dispose 句柄供模块卸载复用）。
 * @param deps - 调度依赖。
 */
export function installScheduler(ctx: Context, deps: SchedulerDeps): SchedulerHandle {
  const state: SchedulerState = { timer: undefined, idleTimer: undefined, deferCount: 0, lastIdleRunAt: 0, disposed: false }
  const now = deps.now ?? Date.now
  const setTimer = deps.setTimer ?? ((handler: () => void, ms: number) => setTimeout(handler, ms))
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const launchDeps: LaunchDeps = {
    state: deps.state,
    schedule: deps.schedule,
    dreamEnabled: deps.dreamEnabled,
    log: deps.log,
    start: (options: RunOptions) => deps.runner.start(options),
    refresh: deps.refresh,
  }

  const clearScheduled = (): void => {
    if (state.timer !== undefined) clearTimer(state.timer)
    state.timer = undefined
  }

  /** 重算并持久化下一次触发时刻，再重臂定时器（分段躲开 32 位毫秒上限）。 */
  const reschedule = (): void => {
    const next = deps.enabled() ? computeNextRunAt(deps.schedule(), now(), (message) => deps.log.warn(message)) : 0
    // 字段级原子合并：绝不整个读改写（真机实证过并发顶掉 nextRunAt，见 state.ts 的警告）。
    // 落盘后刷一次投影：工作台的「下次定时」读的是投影，不刷就停旧值（真机实证）。
    void deps.state
      .mutateState({ nextRunAt: next })
      .then(() => deps.refresh?.())
      .catch((error: unknown) => deps.log.warn('下次触发时刻落盘失败', error))
    clearScheduled()
    if (next <= 0 || state.disposed) return
    const arm = (targetMs: number): void => {
      const delay = targetMs - now()
      state.timer = delay > MAX_TIMER_SEGMENT_MS ? setTimer(() => arm(targetMs), MAX_TIMER_SEGMENT_MS) : setTimer(() => void onFire(), Math.max(0, delay))
    }
    arm(next)
  }

  /** 定时触发：忙碌则推迟，超限则放弃；跑完（或放弃）都重排下一次。 */
  const onFire = async (): Promise<void> => {
    clearScheduled()
    if (state.disposed || !deps.enabled()) return void reschedule()
    if (deps.activity.hasRunning()) {
      state.deferCount += 1
      if (state.deferCount > DEFER_RETRY_MAX) {
        state.deferCount = 0
        await recordSkipped(launchDeps, '触发时对话一直活跃，推迟次数用尽（P-035：有活跃操作时暂停）', now())
        return void reschedule()
      }
      state.timer = setTimer(() => void onFire(), DEFER_RETRY_MS)
      return
    }
    state.deferCount = 0
    launch(launchDeps, 'scheduled')
    reschedule()
  }

  /** 空闲 tick：安静够久、且上次空闲触发之后有过新活动，才跑一次增量。 */
  const idleTick = (): void => {
    if (state.disposed) return
    state.idleTimer = setTimer(idleTick, IDLE_TICK_MS)
    const schedule = deps.schedule()
    if (!deps.enabled() || schedule.mode !== 'idle') return
    if (deps.activity.hasRunning() || deps.runner.current() !== undefined) return
    if (now() - deps.activity.lastActivityAt() < schedule.idleMinutes * 60000) return
    if (deps.activity.lastActivityAt() <= state.lastIdleRunAt) return
    state.lastIdleRunAt = now()
    launch(launchDeps, 'idle')
  }

  /** 启动/改配置对账：先处理停机错过，再重排。 */
  const reconcile = (): void => {
    if (!deps.enabled() || deps.schedule().mode === 'idle') return void reschedule()
    catchUpMissed(launchDeps, deps.state.readState().nextRunAt, now())
    reschedule()
  }

  ctx.effect(() => {
    reconcile()
    state.idleTimer = setTimer(idleTick, IDLE_TICK_MS)
    return () => {
      state.disposed = true
      clearScheduled()
      if (state.idleTimer !== undefined) clearTimer(state.idleTimer)
      state.idleTimer = undefined
    }
  }, 'humanity: 自进化调度器')

  return {
    reconfigure: () => {
      if (state.disposed) return
      state.deferCount = 0
      reconcile()
    },
    nextRunAt: () => deps.state.readState().nextRunAt,
    dispose: () => {
      state.disposed = true
      clearScheduled()
      if (state.idleTimer !== undefined) clearTimer(state.idleTimer)
      state.idleTimer = undefined
    },
  }
}
