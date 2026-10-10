/**
 * 懒装件的**构建工厂**（从 `index.ts` 拆出）：runner 与 scheduler 的依赖装配各自一个函数。
 *
 * 放一起的理由：两者共享同一组"部件"（配置读取、门禁、LLM、技能桥、活动追踪），
 * 拆到两个文件只会把同一份参数表抄两遍。存储就绪后由 `index.ts` 的 `ensureInstalled` 调用；
 * 存储服务摘除再挂回时用**新的表**重建（旧表句柄已死）。
 * @module humanity/evolution/runtime
 */
import type { Context } from '@deepseek-ai/cordis'

import type { Log } from '../log.js'
import { applyConsolidation } from '../persona/consolidate-apply.js'
import { personaPromptReport } from '../persona/render.js'
import type { PersonaDocument } from '../persona/types.js'
import type { ActivityTracker } from './activity.js'
import type { LlmAccess } from './llm.js'
import type { Runner } from './run.js'
import { createRunner } from './run.js'
import type { SchedulerHandle } from './scheduler.js'
import { installScheduler } from './scheduler.js'
import type { SkillBridge } from './skills.js'
import type { EvolutionState } from './state.js'
import type { SessionQueryLike } from './types.js'
import type { EvolutionDeps } from './index.js'

/** 构建懒装件需要的全部部件（都是现读闭包或无状态服务）。 */
export interface RuntimeParts {
  deps: EvolutionDeps
  moduleEnabled(): boolean
  sessionQuery(): SessionQueryLike | undefined
  llm: LlmAccess
  skills: SkillBridge
  activity: ActivityTracker
  log: Log
  /** 投影刷新（调度重排/运行结束后让工作台看到新值）。 */
  refresh(): void
}

/** 用一份已就绪的存储面构建运行入口。 */
export function buildRunner(parts: RuntimeParts, state: EvolutionState): Runner {
  const { deps, log } = parts
  // A1 / A-预演（0.1.11）：注入预算的读数**只有一处算得对**
  // （与提示词拼装共用 `persona/render.ts` 的同一套拟合）。`independentJudgment` 必传：
  // 独立判断段与人格内容共用同一份预算，漏了它读数就会偏大。
  // 同一个函数喂给两处：轮首读数（`personaFit()`）与写回层预演（`classify().personaFit(doc)`）——
  // 预演与真实注入因此不可能分叉。
  const budgetOf = (doc: PersonaDocument): ReturnType<typeof personaPromptReport> =>
    personaPromptReport(doc, { independentJudgment: deps.config().independentJudgment })
  return createRunner({
    state,
    config: () => ({ evolution: deps.config().modules.evolution, dream: deps.config().modules.dream }),
    enabled: parts.moduleEnabled,
    sessionQuery: parts.sessionQuery,
    llm: parts.llm,
    classify: () => ({
      memoryStore: deps.memoryStore,
      memoryPolicy: deps.memoryPolicy,
      persona: deps.personaSection,
      skills: () => (parts.skills.available() ? parts.skills : undefined),
      state,
      log,
      personaFit: budgetOf,
    }),
    personaCard: () =>
      deps
        .personaSection()
        ?.read()
        .mutableLayer.sections.map((section) => ({ title: section.title, items: section.items })) ?? [],
    personaFit: () => {
      const persona = deps.personaSection()
      if (persona === undefined) return undefined
      return budgetOf(persona.read())
    },
    consolidatePersona: async () => {
      const persona = deps.personaSection()
      return persona === undefined ? 0 : applyConsolidation(persona, log)
    },
    log,
  })
}

/** 用同一份存储面与 runner 构建调度器（定时/空闲触发都从这里出发）。 */
export function buildScheduler(ctx: Context, parts: RuntimeParts, state: EvolutionState, runner: Runner): SchedulerHandle {
  const { deps } = parts
  return installScheduler(ctx, {
    schedule: () => deps.config().modules.evolution.schedule,
    enabled: parts.moduleEnabled,
    dreamEnabled: () => parts.moduleEnabled() && deps.config().modules.dream.enabled,
    state,
    activity: parts.activity,
    runner,
    log: parts.log,
    refresh: parts.refresh,
  })
}
