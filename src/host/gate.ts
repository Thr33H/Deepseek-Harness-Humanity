/**
 * 工具闸：把**宿主平面的全局工具**收窄成一份白名单。
 *
 * ### 它解决什么
 * 预设只能决定"我自己装哪些插件"，决定不了"别人装的插件对我可不可见" ——
 * 宿主平面注册的工具对所有预设一律可见。于是装一个新插件，它的工具就会直接出现在
 * 陪伴人格面前。`dsh-tools` 为此提供了正式的 `ctx.tools.restrict({ allow })`：
 * 名单之外的全局工具在该作用域里不可见（预设自己的作用域工具不受影响，也不需要受影响）。
 *
 * ### 为什么必须住在预设里
 * `restrict()` 只接受**有作用域的上下文**（`scopeOf(ctx) !== undefined`），
 * 宿主平面调用会直接抛错（"a context-global restriction would mask every agent"）。
 * 所以这个模块被写进预设的插件清单里，由 loader 在预设作用域内挂载。
 *
 * ### 为什么用 `ctx.tools` 而不是 `ctx.get('tools')`
 * 前者的 `this` 绑定到**当前访问者**的上下文（与 `dsh-subagent` 的
 * `childCtx.tools.restrict(...)` 同一写法）；后者拿到的是服务原型上的实例，
 * 作用域判定会落空，`restrict()` 必然抛错。
 * @module deepseek-harness-humanity/gate
 */
import type { Context } from '@deepseek-ai/cordis'

/** Cordis 插件名（诊断用）。 */
export const name = 'humanity-gate'

/** 闸只依赖工具表，不声明硬依赖：缺席就静默不生效。 */
export const inject: string[] = []

/** 配置：与 `dsh-tools` 的 `ToolRestriction` 同形。 */
export interface GateConfig {
  /** 保留可见的全局工具名；其余一律不可见。 */
  allow?: readonly string[]
  /** 移除可见的全局工具名（与 `allow` 二选一，通常只用 `allow`）。 */
  deny?: readonly string[]
}

/** 我们用到的那一小片工具服务。 */
interface ToolGate {
  restrict?(filter: { allow?: readonly string[]; deny?: readonly string[] }): () => void
}

/**
 * 装上闸。
 * @param ctx - 预设作用域内的上下文。
 * @param config - 白名单/黑名单。
 */
export function apply(ctx: Context, config: GateConfig = {}): void {
  const allow = config.allow ?? []
  const deny = config.deny
  if (allow.length === 0 && deny === undefined) return

  const filter: { allow?: readonly string[]; deny?: readonly string[] } = {
    ...(allow.length > 0 ? { allow } : {}),
    ...(deny === undefined ? {} : { deny }),
  }

  /**
   * 试一次；名字还没注册齐时 `restrict()` 会抛（官方要求名单里的名字必须已知），
   * 那就等下一次工具表变化再试 —— 只在**没有超时器**的情况下重试，避免常驻轮询。
   */
  const attempt = (tools: ToolGate): boolean => {
    if (typeof tools.restrict !== 'function') return false
    try {
      const dispose = tools.restrict(filter)
      ctx.effect(() => dispose, 'humanity: 工具闸')
      return true
    } catch {
      return false
    }
  }

  const tools = (ctx as Context & { tools?: ToolGate }).tools
  if (tools === undefined) return
  if (attempt(tools)) return

  // 工具还没注册完（预设挂在宿主工具之前）：挂一个一次性重试。
  const on = ctx.on as unknown as (event: string, listener: () => void) => () => void
  let pending = true
  const disposeListener = on('tools/change', () => {
    if (!pending) return
    if (attempt(tools)) {
      pending = false
      disposeListener()
    }
  })
  ctx.effect(() => disposeListener, 'humanity: 工具闸重试')
}
