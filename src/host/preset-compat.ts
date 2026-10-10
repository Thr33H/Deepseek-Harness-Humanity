/**
 * **Agent preset 兼容性探测**：这次组合是不是"极简模式"（会丢弃插件注入）。
 *
 * ### 为什么要探测而不是查配置
 *
 * 极简模式的特征是 preset 里给 persona 注册了 `complete: true` 的 section
 * （`includeRuntimeContext: false`），而 `complete` 的语义是"这一条就是全部系统提示词" ——
 * DSH 的 `systemPrompt.assemble()` 会把其余 sections 替换掉。我们的 section 因此静默消失。
 * 这件事**没有现成的 API 可查**（本插件也不该去读别人的 preset 文件），
 * 但可以**看行为**：装配一次，看自己刚注册的那个 section 还在不在。
 *
 * ### ⚠️ 探测必须带 **agent 作用域**（本节是 round 45 的漏洞修正）
 *
 * preset 的 complete 段注册在 **agent 作用域**里（preset 组合在 agent 的 scoped ctx 下 apply；
 * 作用域 key 就是 agent 本身 —— `packages/core/agent-loop/src/agent.ts:129`
 * `this.scope = createScope(loopCtx, this)`）。而 `assemble()` **不带 scope 时只看全局层**
 * （`ScopedLayers.chainLayers(undefined)` 返回空；`packages/core/scope/src/store.ts:192-199`）。
 * 所以"注册后立刻全局装配一次"永远看不到 agent 作用域里的 complete 段 ——
 * 真机极简模式下警告条因此**从来不会出现**。探测必须问对作用域。
 *
 * 又因为"哪个 agent 在装配"只有在装配发生时才知道，真正的触发点在 `persona/prompt.ts`
 * 的 `text` 回调里（那里的 `context` 带着 agent）；本模块只提供"给定作用域探一次"的能力。
 *
 * @module humanity/preset-compat
 */

/** 探测结果（宿主内共享：人格注入写、记忆投影读）。 */
export interface CompatState {
  /** true = 本组合会丢弃插件注入（极简模式）。 */
  blocked: boolean
  /** 探测是否已经跑过（没跑过时不要显示"一切正常"，也不要显示警告）。 */
  probed: boolean
}

/** 建一个未探测的状态。 */
export function createCompatState(): CompatState {
  return { blocked: false, probed: false }
}

/** `systemPrompt` 的窄视图：只用到 `assemble`。 */
interface AssembleProbe {
  assemble?: (context?: unknown) => Promise<{ sections?: readonly { name: string }[] }>
}

/**
 * 探测自己的 section 在**给定作用域**下是否被 `complete` 替换掉。
 *
 * 失败（服务形状不对、装配抛错）一律当"没探测到"：**宁可少提示，也不要误报**
 * —— 误报会让用户去改一个本来正常的配置。
 * @param systemPrompt - 系统提示词服务（结构读取）。
 * @param name - 自己刚注册的 section 名。
 * @param state - 写入探测结果的共享状态。
 * @param scope - 要探测的 agent 作用域；省略时退化为全局装配（只对全局 complete 段有效，
 *   真实 preset 的段在 agent 作用域，必须传）。
 */
export async function probeInjectionSurvived(
  systemPrompt: unknown,
  name: string,
  state: CompatState,
  scope?: object,
): Promise<void> {
  const probe = systemPrompt as AssembleProbe | undefined
  if (probe === undefined || typeof probe.assemble !== 'function') return
  try {
    const assembly = scope === undefined ? await probe.assemble() : await probe.assemble({ scope })
    const sections = assembly.sections ?? []
    state.blocked = sections.length > 0 && !sections.some((section) => section.name === name)
    state.probed = true
  } catch {
    // 装配失败不是"被吞掉"：保持未探测状态。
  }
}
