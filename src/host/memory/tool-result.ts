/**
 * 记忆写入工具的**返回值**：结果形状、输出 schema、构造与渲染。
 *
 * 为什么单独一个文件：这份契约的读者是**模型**（"为什么没写下来"必须和成功结果走同一条渲染通道），
 * 与工具的参数说明是两份会长长的文本；挤在一起改一处要读三处（人格工具同样分了 `tool-result.ts`）。
 * @module humanity/memory/tool-result
 */
import type { MemoryScope } from './constants.js'
import type { RememberResult } from './write.js'
import { SCOPE_LABELS } from './write-text.js'

/** 工具返回的规范值（字段与 `RESULT_SCHEMA` 一一对应）。 */
export interface RememberToolValue {
  ok: boolean
  /** 面向 Agent 的一句话结论；失败时说明为什么没写入。 */
  message: string
  fingerprint: string
  scope: string
  status: string
  sensitive: boolean
  /**
   * 正文是否被截断保存（0.1.9）。
   *
   * 给机器读的位；给人/模型读的说法在 `message` 里（"原 N 字 → 存 M 字" + 怎么办）。
   * 两者都要：只给位不给话，模型不知道该怎么办；只给话不给位，调用方无法程序化判断。
   */
  truncated: boolean
  /** 可能与它矛盾的已有记忆（只标记，未解决）。 */
  conflicts: Array<{ fingerprint: string; content: string }>
}

/** 工具输出契约（宽类型：成败由 `ok` 表达，枚举用字符串，见人格工具的同一条理由）。 */
export const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true, description: '是否真的写入了' },
    message: { type: 'string', required: true, description: '面向 Agent/用户的一句话结论' },
    fingerprint: { type: 'string', required: true, description: '条目指纹；空串表示没有写入' },
    scope: { type: 'string', required: true, description: '落盘的作用域' },
    status: { type: 'string', required: true, description: 'active 生效 / pending 待确认 / 空串=没写入' },
    sensitive: { type: 'boolean', required: true, description: '是否标记为敏感' },
    truncated: {
      type: 'boolean',
      required: true,
      description: '正文是否因超上限被截断保存（true 时 message 里写明原始字数与处置建议）',
    },
    conflicts: {
      type: 'array',
      required: true,
      description: '可能与它矛盾的已有记忆（已标记冲突，未自动改动）',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          fingerprint: { type: 'string', required: true },
          content: { type: 'string', required: true },
        },
      },
    },
  },
} as const

/** 没写成时的返回值（指纹/作用域留空，避免模型把"没写"误读成"写了一条空的"）。 */
function refused(message: string): RememberToolValue {
  return { ok: false, message, fingerprint: '', scope: '', status: '', sensitive: false, truncated: false, conflicts: [] }
}

/** 写入结果 → 工具返回值。 */
function toValue(result: RememberResult): RememberToolValue {
  if (!result.ok || result.entry === undefined) return refused(result.message)
  const entry = result.entry
  return {
    ok: true,
    message: result.message,
    fingerprint: entry.dedupeKey,
    scope: entry.scope,
    status: entry.status,
    sensitive: entry.sensitive,
    // 0.1.9：截断要能在回执里被读出来（说法在 message 里，位在这里）。
    truncated: result.truncated === true,
    conflicts: result.conflicts.map((item) => ({ fingerprint: item.dedupeKey, content: item.content })),
  }
}

/** 工具结果 → 给模型看的文本。 */
function renderValue(value: RememberToolValue): string {
  const lines = [value.ok ? value.message : `没有写入：${value.message}`]
  if (value.ok) {
    lines.push(`指纹：${value.fingerprint}｜作用域：${SCOPE_LABELS[value.scope as MemoryScope]}｜状态：${value.status}`)
    for (const item of value.conflicts) lines.push(`- 可能矛盾：${item.content}`)
  }
  return lines.join('\n')
}

/** 纯文本内容块。 */
function text(content: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: content }]
}

export { refused, renderValue, text, toValue }
