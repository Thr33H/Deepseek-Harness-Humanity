/**
 * 调度器的两个副作用动作（从 `scheduler.ts` 拆出，保持函数与文件都在门限内）：
 * 发起运行、补记 skipped。放一起的理由：它们都是"调度决定之后对外的唯一出口"，
 * 失败语义相同——记日志、不抛（调度器路径上抛错等于整个模块停摆）。
 * @module humanity/evolution/scheduler-actions
 */
import { createRunRecord } from './model.js'
import type { RunOptions } from './run.js'
import { modeForSchedule, type ScheduleConfig } from './schedule-time.js'
import type { RunRecord } from './types.js'
import type { EvolutionState } from './state.js'
import type { Log } from '../log.js'

/** 发起动作需要的最小依赖面。 */
export interface LaunchDeps {
  state: EvolutionState
  schedule(): ScheduleConfig
  dreamEnabled(): boolean
  log: Log
  start(options: RunOptions): Promise<RunRecord>
  /**
   * 运行结束后的投影刷新（可选）：定时运行是"发射后不管"的，没有这一步，
   * 工作台时间线会停在运行前的旧投影，直到下一次无关事件碰巧刷新它
   * （2026-09-25 真机：恢复默认态后投影里的 nextRunAt 停旧值，同源）。
   */
  refresh?(): void
}

/** 定时触发的运行形态：每周/每月是梦境；梦境开关关了退回增量（不空转、不静默取消）。 */
export function scheduledMode(deps: LaunchDeps): 'incremental' | 'dream' {
  const mode = modeForSchedule(deps.schedule())
  return mode === 'dream' && !deps.dreamEnabled() ? 'incremental' : mode
}

/** 发起一次运行（火后不管：结局在 RunRecord 里；结局落盘后刷一次投影让时间线可见）。 */
export function launch(deps: LaunchDeps, trigger: RunOptions['trigger']): void {
  void deps
    .start({ mode: scheduledMode(deps), trigger })
    .then((record: RunRecord) => {
      deps.log.info(`整理运行结束：${record.mode}/${record.trigger} → ${record.status}`)
      deps.refresh?.()
    })
    .catch((error: unknown) => deps.log.warn('整理运行未能启动（互斥被占或模块已关）', error))
}

/** 记一条"没有跑成"的 skipped 运行（原因如实进时间线，不静默）。 */
export async function recordSkipped(deps: LaunchDeps, reason: string, at: number): Promise<void> {
  const now = new Date(at).toISOString()
  const record = createRunRecord(modeForSchedule(deps.schedule()), 'scheduled', now)
  record.status = 'skipped'
  record.finishedAt = now
  record.error = reason
  await deps.state.putRun(record).catch((error: unknown) => deps.log.warn('skipped 运行记录落盘失败', error))
}
