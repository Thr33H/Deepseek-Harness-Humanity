/**
 * 从运行期对象里读**记忆需要的身份**（会话 id、工作区 id、当前用户消息文本）。
 *
 * 为什么用结构性读取而不是 import 那些包的类型：`dsh-agent` / `dsh-session` / `dsh-llm`
 * 都不是本插件的依赖（G-002 零硬依赖），引进来只为拿三个字段的类型，会把这个插件绑死在
 * 它们的版本上。这里的读取都很窄，缺字段就是空串，由调用方决定"没有身份就不写"。
 *
 * 读到的字段（已在 DSH 0.1.5-rc.2 的实现里核实）：
 * - `agent.id` = 会话 id（`dsh-agent` 的 `Agent` 接口）；
 * - `agent.session.header.cwd` = 会话的工作目录（DSH 的"工作区"就是它）。
 *   ⚠️ 依据是官方先例：`dsh-tool-fs/lib/index.js:241` 的 `sessionCwd` 读的正是
 *   `exec.agent?.session.header.cwd`。**2026-09-26 真机实证**：此前读 `session.meta.cwd`
 *   恒为空，后果是「区域记忆」两头都坏——写入侧存空归属、检索侧 workspaceId 恒空
 *   （⇒ 全部 0 分被阈值刷掉、从来不注入）。`meta.cwd` 只作为最后的回退。
 * - 用户消息的正文在 `message.content` 的 `text` 块里（`dsh-llm` 的 `ContentBlock`）。
 * @module humanity/memory/identity
 */

/** 记忆需要的调用方身份。 */
import type { MemoryScope } from './constants.js'

export interface MemoryIdentity {
  /** 会话 id；空串 = 读不到。 */
  sessionId: string
  /** 工作区 id（会话 cwd）；空串 = 读不到。 */
  workspaceId: string
}

/**
 * 读一条消息里的**可见正文**。
 *
 * 只取 `text` 块：图片/工具结果/推理块都不是"用户说的话"，拿来检索只会引入噪音。
 * @param message - 用户消息（结构性读取）。
 * @returns 正文；没有文本块时为空串。
 */
export function userTextOf(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    const typed = block as { type?: unknown; text?: unknown }
    if (typed?.type === 'text' && typeof typed.text === 'string') parts.push(typed.text)
  }
  return parts.join('\n')
}

/**
 * 从一个 agent（或它的替身）里读身份。
 * @param subject - agent 对象（`exec.agent` 或系统提示词装配主体）。
 * @returns 会话 id 与工作区 id；读不到的部分是空串。
 */
export function memoryIdentityOf(subject: unknown): MemoryIdentity {
  const agent = subject as
    | { id?: unknown; session?: { header?: { cwd?: unknown }; meta?: { cwd?: unknown } } }
    | undefined
  const id = agent?.id
  const cwd = agent?.session?.header?.cwd ?? agent?.session?.meta?.cwd
  return {
    sessionId: typeof id === 'string' ? id : '',
    workspaceId: typeof cwd === 'string' ? cwd : '',
  }
}

/**
 * 区域记忆的归属检查：读不到工作目录时给一句话原因（写入侧据此**拒写**）。
 *
 * 为什么必须拒：写了就是一条永远匹配不上的死记录（2026-09-26 真机实证：库里 2 条这样的记忆
 * 从写下那天起就没生效过）；也**不降级为长期**——那会把只在某个区域成立的内容泄露到别的工作区。
 * @param scope - 记忆作用域。
 * @param workspaceId - 当前会话的工作目录（读不到为空串）。
 * @returns 拒绝原因；可以写时为 `undefined`。
 */
export function attributionIssue(scope: MemoryScope, workspaceId: string): string | undefined {
  if (scope !== 'workspace' || workspaceId !== '') return undefined
  return '这条被判为「区域记忆」，但此刻读不到会话的工作目录，本次没有写入（避免留下一条永远不会生效的记录）。下次在会话里再说一次即可。'
}
