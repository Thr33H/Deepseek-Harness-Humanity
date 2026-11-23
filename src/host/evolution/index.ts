/**
 * 自进化模块（她自己的时间）——**唯一入口**。
 *
 * 与人格/记忆同一条约定：宿主只调 `installEvolution(...)` 一行。
 *
 * ### 这一版做了什么（第 0 期）
 *
 * 1. 她的房间：一个只属于她的会话（第一次投递时由调度服务自动创建）；
 * 2. 一次一约：每次醒来结束时，把**下一次**排到未来某个随机时刻；
 * 3. 醒来的那一轮，她自己决定做什么（提示词只说清"没有人在等你"）。
 *
 * 还没做：精力（按 token 算累不累）、线索账、睡前收账（日记/记忆/性格）。见设计方案的分期。
 *
 * ### 时序纪律（这一条以前踩过三次）
 *
 * 存储是**异步打开**的，状态文档在打开之前读不到。所以：
 * - 装配期什么都不排（读了也是空文档）；
 * - `notifyStoreReady()` 才第一次排程；
 * - 开关/配置变化只调 `reconfigure()`（内部重排），不缓存任何"就绪"快照。
 * @module humanity/evolution
 */
import type { Context } from '@deepseek-ai/cordis'

import type { DocumentStore } from '../documents.js'
import type { Log } from '../log.js'
import { afterWake, nextGapSeconds, readState, writeState, type WakeRhythm } from './state.js'
import { ensureTask, reschedule, setActive, type RoomDeps, type ScheduleServiceLike } from './room.js'
import { WAKE_MARKER } from './constants.js'
import { buildWakePrompt } from './wake.js'

/** 宿主交给自进化模块的外部事实（全部现读，不缓存句柄）。 */
export interface EvolutionDeps {
  /** 文档表（存储未就绪时 `undefined`）。 */
  documents(): DocumentStore | undefined
  /** 模块开关：总开关 × 自进化开关 × 人格已封存。 */
  enabled(): boolean
  /** 醒来的节奏参数（现读配置）。 */
  wake(): WakeRhythm
  /** 生效时区（`undefined` = 跟随进程时区）。 */
  timeZone(): string | undefined
  /** `$DSH_HOME`（房间目录要用）。 */
  homeDir(): string | undefined
}

/** 模块句柄。 */
export interface EvolutionModule {
  /** 开关变化（宿主 `syncModulesEnabled` 调）。 */
  setEnabled(enabled: boolean): void
  /** 配置变化：重排下一次（宿主 `onChanged` 调）。 */
  reconfigure(): void
  /** 时间基准变化后重排一次（宿主 `clock.onChanged` 调）。 */
  refresh(): Promise<void>
  /** 存储就绪：第一次排程。 */
  notifyStoreReady(): void
  /** 卸载。 */
  dispose(): void
}

/** 一条消息里模型能看到的所有文本（只取 text 块）。 */
function textOf(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      const candidate = block as { type?: unknown; text?: unknown }
      return candidate?.type === 'text' && typeof candidate.text === 'string' ? candidate.text : ''
    })
    .join('\n')
}

/** 这条消息是不是"她自己的时间"那一条（导出给测试：醒来判据写错会让你的提醒也算她醒来）。 */
export function isWakeMessage(message: unknown): boolean {
  const source = (message as { source?: { kind?: unknown } } | undefined)?.source
  if (source?.kind !== 'schedule') return false
  return textOf(message).includes(WAKE_MARKER)
}

/**
 * 装配自进化模块。
 * @param ctx - 宿主上下文。
 * @param log - 日志门面。
 * @param deps - 外部事实。
 * @returns 模块句柄。
 */
export function installEvolution(ctx: Context, log: Log, deps: EvolutionDeps): EvolutionModule {
  let enabled = true
  /** 排程进行中的标记：防止启动、配置变更、存储就绪三件事同时排程。 */
  let arming = false
  /** "调度服务不在"只提醒一次：它每个配置变更都会被重试，逐次告警会刷屏。 */
  let warnedNoSchedule = false
  const moduleEnabled = (): boolean => enabled && deps.enabled()
  const schedule = (): ScheduleServiceLike | undefined => {
    const service = ctx.get('schedule') as ScheduleServiceLike | undefined
    if (service === undefined || typeof service.create !== 'function') {
      if (!warnedNoSchedule) {
        warnedNoSchedule = true
        log.warn('没有调度服务（DSH 的 schedule 未启用）：她不会有自己的时间；其余功能不受影响')
      }
      return undefined
    }
    return service
  }
  const roomDeps: RoomDeps = { schedule, homeDir: deps.homeDir, log }

  /**
   * 把下一次醒来排好。
   *
   * 三种情况：
   * 1. 没有任务 ⇒ 建一个（第一次投递时顺带开出她的房间）；
   * 2. 有任务、但下一次已经过期/没排 ⇒ 重新排；
   * 3. 有任务、下一次还在未来 ⇒ **不动它**（重启不该把已定的时刻推翻）。
   * @param reason - 日志里说明是谁触发的。
   */
  const arm = async (reason: string): Promise<void> => {
    if (arming) return
    if (!moduleEnabled()) return
    const documents = deps.documents()
    if (documents === undefined) return
    arming = true
    try {
      const state = readState(documents)
      const now = new Date().toISOString()
      const timeZone = deps.timeZone()
      const hasFuture =
        state.taskId !== ''
        && state.nextAt !== ''
        && Number.isFinite(Date.parse(state.nextAt))
        && Date.parse(state.nextAt) > Date.parse(now)
      if (hasFuture) {
        await setActive(roomDeps, state.taskId, true)
        return
      }
      const gap = nextGapSeconds(state, deps.wake(), now, timeZone)
      if (gap === undefined) {
        await setActive(roomDeps, state.taskId, false)
        return
      }
      const outcome = state.taskId === ''
        ? await ensureTask(roomDeps, state.taskId, gap, buildWakePrompt(now, timeZone))
        : await reschedule(roomDeps, state.taskId, gap)
      if (!outcome.ok) {
        log.warn(`${reason}：没有排上——${outcome.reason}`)
        return
      }
      await writeState(documents, {
        taskId: outcome.room.taskId,
        roomSessionId: outcome.room.sessionId,
        nextAt: outcome.room.nextAt,
      })
      log.info(`${reason}：她下一次醒来 ${outcome.room.nextAt === '' ? '（时间未回报）' : outcome.room.nextAt}`)
    } finally {
      arming = false
    }
  }

  /**
   * 一次醒来之后：记账 + 排下一次。
   *
   * 为什么触发了就立刻排，而不是等她这一轮跑完：我们拿不到"这一轮结束"这个时刻，
   * 而"下一次该来"是必须成立的承诺 —— 宁可早排（多一次醒来），不可漏排（她从此不再醒）。
   * @param at - 醒来的时刻。
   */
  const settleWake = async (at: string): Promise<void> => {
    const documents = deps.documents()
    if (documents === undefined) return
    const timeZone = deps.timeZone()
    const before = readState(documents)
    const patch = afterWake(before, at, timeZone)
    await writeState(documents, patch)
    const after = { ...before, ...patch }
    const gap = nextGapSeconds(after, deps.wake(), at, timeZone)
    if (gap === undefined) {
      await setActive(roomDeps, after.taskId, false)
      log.info('她醒了一次；今天的次数到了上限，不再排下一次')
      return
    }
    const outcome = await reschedule(roomDeps, after.taskId, gap)
    if (outcome.ok) {
      await writeState(documents, { nextAt: outcome.room.nextAt, roomSessionId: outcome.room.sessionId })
    }
    log.info(`她醒了一次（今天第 ${after.dayCount} 次）；下一次 ${outcome.ok ? outcome.room.nextAt : '没排上'}`)
  }

  const on = ctx.on as unknown as (
    name: string,
    listener: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>,
  ) => () => void

  const disposeStep = on('agent/pre-step', async (payload, next) => {
    const decision = (await next()) as { kind?: string; messages?: unknown[] } | null
    if (decision === null || decision.kind !== 'enter') return decision
    const { step } = (payload ?? {}) as { step?: number }
    // 只看每一步的第一步：一次醒来是一轮对话，不是每一步都要记一次。
    if (step !== 1) return decision
    if (!moduleEnabled()) return decision
    const messages = Array.isArray(decision.messages) ? decision.messages : []
    if (!messages.some(isWakeMessage)) return decision
    // 落账放在异步尾巴上：她这一轮不必等一次调度写入。
    void settleWake(new Date().toISOString()).catch((error: unknown) => {
      log.warn('醒来之后没能排下一次（这一次不影响对话）', error)
    })
    return decision
  })

  ctx.effect(
    () => () => {
      disposeStep()
      log.info('自进化模块已卸载')
    },
    'humanity: 自进化卸载',
  )

  log.info('自进化模块已装配（等存储就绪后第一次排程）')

  return {
    setEnabled(next) {
      enabled = next
      if (next && moduleEnabled()) {
        void arm('开关打开').catch((error: unknown) => log.warn('开关打开后没能排程', error))
        return
      }
      const documents = deps.documents()
      if (documents !== undefined) {
        const state = readState(documents)
        void setActive(roomDeps, state.taskId, false)
      }
    },
    reconfigure() {
      void arm('配置变更').catch((error: unknown) => log.warn('配置变更后没能重排', error))
    },
    refresh: () => arm('时间基准变化'),
    notifyStoreReady() {
      void arm('存储就绪').catch((error: unknown) => log.warn('存储就绪后没能排程', error))
    },
    dispose() {
      enabled = false
    },
  }
}
