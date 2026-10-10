/**
 * "这次系统提示词装配的主体是不是**主 Agent**" 的共用判定（裁决 2：人格等套件内容只注入主 Agent）。
 *
 * 为什么单独一个文件：人格注入与记忆注入都要同一个判定，而这条判定踩过真机事故 ——
 * 同一份逻辑写两遍，早晚有一边会把 `agents` 加回 `ctx.inject` 的依赖里，
 * 那会让**每个会话都创建失败**（见 {@link createMainAgentJudge} 的说明）。
 *
 * @module humanity/agent-scope
 */
import type { Context } from '@deepseek-ai/cordis'

import type { Log } from './log.js'

/**
 * 运行时父子标记的候选字段名。
 *
 * ⚠️ **DSH 0.1.5-rc.2 的 `Agent` 接口上没有这些字段**（父子关系由注册表的
 * `enter(agent, owner)` / `isOwnedBy()` 记录，不挂在 agent 对象上）。所以这一层是**前瞻性防御**：
 * 将来若在 agent 上暴露了归属字段，这里立刻就能用上。现在它实际不生效——不生效的后果由
 * 下面的二级判定兜住。
 */
const PARENT_MARKERS = ['parent', 'parentAgent', 'owner', 'ownerAgent'] as const

/** 主体是否自带"我是子代理"的运行时标记。 */
function hasRuntimeParent(subject: object): boolean {
  for (const key of PARENT_MARKERS) {
    const value = (subject as Record<string, unknown>)[key]
    if (value !== undefined && value !== null) return true
  }
  return false
}

/**
 * 造一个"是否主 Agent"的判定函数。
 *
 * ### 三级判定（从强到弱，每级都能安全降级）
 *
 * 1. 主体自带运行时归属标记 ⇒ 子代理，不注入；
 * 2. `ctx.get('agents')` 读得到注册表 ⇒ 用 `roots()` **精确**判定（这是裁决 2 的正解）；
 * 3. 两级都拿不到（服务未挂载 / 未激活）⇒ **退化为"有 agent 就注入"**，并只警告一次。
 *    取舍：这一支会让子代理也拿到内容（多一点 token），但绝不会像"声明 agents 依赖"那样
 *    把会话创建弄坏 —— **可用性优先于省 token**。
 *
 * ### ⛔ 绝不把 `agents` 声明成依赖
 *
 * 真机事故（2026-09-23）：`ctx.inject(['agents', 'systemPrompt'], …)` 会把 `agents` 写进本插件
 * fiber 的依赖声明，而会话创建走另一个尚未激活的组合上下文，报
 * `cannot get required service "agents" in inactive context` ⇒ **每个会话都创建失败**。
 * 需要看注册表时一律用不声明依赖的 `ctx.get('agents')`（读不到就是 undefined，不抛）。
 *
 * @param ctx - 本插件的上下文。
 * @param log - 日志门面。
 * @returns 判定函数；同一个判定函数里的退化警告只记一次。
 */
export function createMainAgentJudge(ctx: Context, log: Log): (subject: object) => boolean {
  let warnedDegraded = false

  return (subject: object): boolean => {
    if (hasRuntimeParent(subject)) return false

    // 只读查找：不声明依赖（读不到就是 undefined，不抛）。
    const agents = ctx.get('agents') as { roots?: () => unknown[] } | undefined
    if (agents !== undefined && typeof agents.roots === 'function') {
      return agents.roots().includes(subject)
    }

    if (!warnedDegraded) {
      warnedDegraded = true
      log.warn('读不到 agents 注册表：本插件退化为"对每个 agent 都注入"（子代理也会拿到内容）')
    }
    return true
  }
}

/** 从系统提示词的装配上下文里取出主体（`assembleContextFor` 会同时给 `agent` 与 `scope`）。 */
export function subjectOf(context: unknown): object | undefined {
  if (context === undefined || context === null) return undefined
  const subject = (context as { agent?: unknown }).agent ?? (context as { scope?: unknown }).scope
  return subject !== null && typeof subject === 'object' ? (subject as object) : undefined
}
