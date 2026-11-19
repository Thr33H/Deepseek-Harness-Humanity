/**
 * 懒装件的**构建工厂**（从 `index.ts` 拆出）：runner 与 scheduler 的依赖装配各自一个函数。
 *
 * 放一起的理由：两者共享同一组"部件"（配置读取、门禁、LLM、活动追踪），
 * 拆到两个文件只会把同一份参数表抄两遍。存储就绪后由 `index.ts` 的 `ensureInstalled` 调用；
 * 存储服务摘除再挂回时用**新的表**重建（旧表句柄已死）。
 * @module humanity/evolution/runtime
 */
import type { Context } from '@deepseek-ai/cordis'

import type { Log } from '../log.js'
import { applyConsolidation } from '../persona/consolidate-apply.js'
import type { PersonaDocument } from '../persona/types.js'
import type { ActivityTracker } from './activity.js'
import type { LlmAccess } from '../llm.js'
import type { Runner } from './run.js'
import { createRunner } from './run.js'
import { effectiveSchedule } from './schedule-time.js'
import type { SchedulerHandle } from './scheduler.js'
import { installScheduler } from './scheduler.js'
import type { EvolutionState } from './state.js'
import type { SessionQueryLike } from './types.js'
import type { EvolutionDeps } from './index.js'

/** 构建懒装件需要的全部部件（都是现读闭包或无状态服务）。 */
export interface RuntimeParts {
  deps: EvolutionDeps
  moduleEnabled(): boolean
  sessionQuery(): SessionQueryLike | undefined
  llm: LlmAccess
  activity: ActivityTracker
  log: Log
  /** 投影刷新（调度重排/运行结束后让工作台看到新值）。 */
  refresh(): void
}

/** 用一份已就绪的存储面构建运行入口。 */
export function buildRunner(parts: RuntimeParts, state: EvolutionState): Runner {
  const { deps, log } = parts
  /**
   * 生效时区（时间基准校准出来的那个）。
   *
   * 显式传给调度与记账：进程的本地时间未必跟着它走（2026-11-19 实机：`Intl` 变了 `Date` 没变），
   * 所以两处都必须拿到这个字符串自己换算，不能靠"系统时区"这四个字。
   */
  const zone = (): string | undefined => deps.clock?.()?.effective
  return createRunner({
    state,
    config: () => {
      const config = deps.config()
      return {
        // 调度段先换算成"实际参与计算"的（自动模式 = 生效时区）。
        evolution: { ...config.modules.evolution, schedule: effectiveSchedule(config.modules.evolution.schedule, zone()) },
        dream: config.modules.dream,
      }
    },
    enabled: parts.moduleEnabled,
    sessionQuery: parts.sessionQuery,
    llm: parts.llm,
    classify: () => ({
      memoryStore: deps.memoryStore,
      memoryPolicy: deps.memoryPolicy,
      persona: deps.personaSection,
      state,
      log,
    }),
    personaCard: () =>
      deps
        .personaSection()
        ?.read()
        .mutableLayer.sections.map((section) => ({ title: section.title, items: section.items })) ?? [],
    consolidatePersona: async () => {
      const persona = deps.personaSection()
      if (persona === undefined) return { count: 0, merges: [] }
      const result = await applyConsolidation(persona, log)
      // ②（2026-11-17）：合并会删掉被并的那条，不能只在后台账本里说一声 ——
      // 记进状态，下一次装配时让模型在对话里提一句（`notify.ts` 负责渲染、只提一次）。
      if (result.count > 0) {
        void state
          .mutateState({ mergeNotice: result.merges })
          .catch((error: unknown) => log.warn('合并提醒落盘失败（这次合并没有告诉对方）', error))
      }
      return result
    },
    log,
  })
}

/** 用同一份存储面与 runner 构建调度器（定时/空闲触发都从这里出发）。 */
export function buildScheduler(ctx: Context, parts: RuntimeParts, state: EvolutionState, runner: Runner): SchedulerHandle {
  const { deps } = parts
  return installScheduler(ctx, {
    schedule: () => effectiveSchedule(deps.config().modules.evolution.schedule, deps.clock?.()?.effective),
    enabled: parts.moduleEnabled,
    dreamEnabled: () => parts.moduleEnabled() && deps.config().modules.dream.enabled,
    state,
    activity: parts.activity,
    runner,
    log: parts.log,
    refresh: parts.refresh,
  })
}
