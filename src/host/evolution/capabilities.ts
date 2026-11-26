/**
 * 她能做什么：**从她当前真正可见的工具里长出来**，不是写死在提示词里。
 *
 * ### 为什么必须这样
 *
 * 这是个通用插件：装到谁那儿、配了哪套预设，工具都可能不一样。
 * 提示词里写死 `web_search`，而部署里没有 tool-web，就是让她去调一个不存在的工具。
 * 所以：工具名从运行时取；我们只负责"把工具名翻成人话"，翻不出来就照抄工具名。
 *
 * ### 名字从哪来
 *
 * 对方叫什么**从数据来**（人格里"对TA的称呼"）；没设过就用"对方" —— 通用插件不能假定
 * 对方是谁，也不能假定性别。标签里的 `{who}` 在渲染时替换。
 * @module humanity/evolution/capabilities
 */

/** 一条能力：工具名 + 一句人话。 */
export interface CapabilityHint {
  /** 工具名（原样来自运行时的工具表）。 */
  name: string
  /** 人话标签（已替换 `{who}`）；翻不出来时就是工具名。 */
  label: string
}

/**
 * 工具名 → 人话标签。
 *
 * 这张表**不是权限清单**：它只影响"怎么说"，不影响"能不能用"。
 * 表里没有的工具照样会被列出来（只写工具名），所以新增插件不会被漏掉。
 */
const LABELS: Readonly<Record<string, string>> = {
  web_search: '查东西',
  web_fetch: '打开网页读',
  read: '看文件',
  read_image: '看图片',
  glob: '在文件里找（按名字）',
  grep: '在文件里找（按内容）',
  write: '写东西',
  edit: '改文件',
  apply_patch: '改文件',
  schedule_create: '定下次醒来的时间',
  schedule_edit: '改醒来的时间',
  schedule_list: '看自己定过的提醒',
  schedule_view: '看一条提醒的细节',
  present: '让{who}看到某样东西',
  humanity_tell_him: '留话给{who}',
  humanity_remember: '记住一件事',
  humanity_recall: '想起某件事',
}

/**
 * 从工具定义里挑出名字。
 * @param definitions - 运行时的工具定义（只用到 `name`）。
 * @returns 工具名列表（去重、保序、丢掉空名）。
 */
export function toolNamesOf(definitions: readonly unknown[]): string[] {
  const seen = new Set<string>()
  const names: string[] = []
  for (const definition of definitions) {
    const name = (definition as { name?: unknown } | undefined)?.name
    if (typeof name !== 'string' || name.trim() === '' || seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  return names
}

/**
 * 把工具名翻成能读的清单。
 * @param names - 工具名列表。
 * @param who - 对方的称呼（空串按"对方"）。
 * @returns 清单一项一条；没有工具时给空数组（调用方据此决定那一段写不写）。
 */
export function describeCapabilities(names: readonly string[], who = ''): CapabilityHint[] {
  const peer = who.trim() === '' ? '对方' : who.trim()
  const hints: CapabilityHint[] = []
  for (const name of names) {
    const label = LABELS[name]
    hints.push({ name, label: label === undefined ? name : label.replace(/\{who\}/g, peer) })
  }
  return hints
}

/**
 * 从工具服务里取出**某一个 agent 此刻可见的工具定义**。
 *
 * ⚠️ 探针必须是那个 agent，不能省。`definitions(scope)` 的注释写明"scope = 调用的 agent；
 * 省略 = 全局视图"。省了就会拿到整个部署的工具（真机 2026-11-26 实测：她的清单里冒出
 * `univer_*`、`team_task_*`、`bili_watch` —— 那些是别的会话的工具，她根本调不到）。
 * @param tools - 工具服务（`ctx.get('tools')`）。
 * @param agent - 她的 agent。
 * @returns 工具定义列表；拿不到时给空数组。
 */
export function visibleToolDefinitions(tools: unknown, agent: unknown): readonly unknown[] {
  const service = tools as { definitions?: (scope?: unknown) => readonly unknown[] } | undefined
  if (service === undefined || typeof service.definitions !== 'function') return []
  if (agent === undefined || agent === null) return []
  try {
    return service.definitions(agent)
  } catch {
    return []
  }
}

/**
 * 从一个 agent 身上取下**它此刻真正可见的工具名**。
 * @param tools - 工具服务（`ctx.get('tools')`）。
 * @param agent - 她的 agent（可能拿不到）。
 * @returns 工具名列表。
 */
export function visibleToolNames(tools: unknown, agent: unknown): string[] {
  return toolNamesOf(visibleToolDefinitions(tools, agent))
}

/**
 * 把清单渲染成提示词里的几行。
 *
 * 一个工具一行：不按用途合并 —— 合并就要维护"哪几个算一类"，那又是一种写死。
 * @param hints - 能力清单。
 * @returns 每行形如 `- 查东西：\`web_search\``；空清单给空数组。
 */
export function capabilityLines(hints: readonly CapabilityHint[]): string[] {
  return hints.map((hint) => (hint.label === hint.name ? `- \`${hint.name}\`` : `- ${hint.label}：\`${hint.name}\``))
}
