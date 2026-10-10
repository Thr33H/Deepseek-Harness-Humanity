/**
 * `humanity_recall` 的**返回值**：结果形状、输出 schema、构造与渲染。
 *
 * 与写入工具（`tool-result.ts`）刻意同形：`ok` + `message` + 结构化数据 ——
 * 模型在两种工具上只学一套读法。分开文件是因为两边各有自己的字段与文案，
 * 挤在一起会让"改召回文案"要翻过写入契约。
 * @module humanity/memory/tool-result-recall
 */
import { IMPORTANCE_MAX } from './constants.js'
import type { MemoryScope } from './constants.js'
import { relativeTimeOf } from './render.js'
import { SCOPE_LABELS } from './write-text.js'
import type { MemoryEntry } from './types.js'

/** recall 返回文本的字符预算（10 条摘要量级；同样按字符保守折算 token）。 */
export const RECALL_TEXT_BUDGET = 1200

/** 返回的一条记忆（只给模型需要的叶子字段，不带内部记录）。 */
export interface RecallItem {
  fingerprint: string
  scope: string
  content: string
  tags: string[]
  importance: number
  /** 相对时间（今天 / 3天前），渲染层算好，省得模型自己换算时间戳。 */
  age: string
}

/** 召回工具的返回值。 */
export interface RecallToolValue {
  ok: boolean
  /** 面向 Agent 的一句话结论（含"没找到"时的下一步提示）。 */
  message: string
  count: number
  entries: RecallItem[]
}

/** 召回工具的输出契约（宽类型，理由同写入工具）。 */
export const RECALL_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true, description: '这次检索是否正常执行（没找到也是 true）' },
    message: { type: 'string', required: true, description: '面向 Agent 的一句话结论' },
    count: { type: 'number', required: true, description: '返回条数' },
    entries: {
      type: 'array',
      required: true,
      description: '命中的记忆（已按相关度排序）',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          fingerprint: { type: 'string', required: true },
          scope: { type: 'string', required: true, description: 'long-term / workspace / session' },
          content: { type: 'string', required: true },
          tags: { type: 'array', required: true, items: { type: 'string' } },
          importance: { type: 'number', required: true },
          age: { type: 'string', required: true, description: '相对时间，例如 3天前' },
        },
      },
    },
  },
} as const

/**
 * 截到字符预算内：超出的条目**整条丢弃**（半句话比没有更危险）。
 *
 * 召回最多 10 条、每条正文上限 200 字，理论上能到 2500 字符 —— 一次调用就把上下文塞满，
 * 与 P-028"硬上限"的精神相反。这里按"正文 + 一行固定开销"估算。
 * @param entries - 已排序的命中条目。
 * @returns 能装下的条目。
 */
function withinBudget(entries: readonly MemoryEntry[]): MemoryEntry[] {
  const kept: MemoryEntry[] = []
  let used = 0
  for (const entry of entries) {
    const cost = entry.content.length + 32
    if (used + cost > RECALL_TEXT_BUDGET) break
    used += cost
    kept.push(entry)
  }
  return kept
}

/**
 * 命中条目 → 召回返回值。
 * @param entries - 已排序的命中条目。
 * @param now - 当前时刻（ISO 8601）。
 * @param note - 覆盖默认结论（例如"该层已关闭"）；缺省按条数给话术。
 * @param ok - 是否算执行成功；存储未就绪、作用域被关掉这类拒绝用 false。
 */
export function toRecallValue(
  entries: readonly MemoryEntry[],
  now: string,
  note?: string,
  ok = true,
): RecallToolValue {
  const kept = withinBudget(entries)
  const dropped = entries.length - kept.length
  const extra = dropped > 0 ? `（另有 ${dropped} 条超出长度限制未展开）` : ''
  const message =
    note ??
    (kept.length === 0
      ? '没有找到相关记忆。可以换个说法再试，或先和用户确认要记的内容。'
      : `找到 ${kept.length} 条相关记忆${extra}`)
  return {
    ok,
    message,
    count: kept.length,
    entries: kept.map((entry) => ({
      fingerprint: entry.dedupeKey,
      scope: entry.scope,
      content: entry.content,
      tags: [...entry.tags],
      importance: entry.importance,
      age: relativeTimeOf(entry.lastUsedAt === '' ? entry.updatedAt : entry.lastUsedAt, now),
    })),
  }
}

/** 召回结果 → 给模型看的文本：先结论，再逐条摘要（含标签与重要度，便于 Agent 自行取舍）。 */
export function renderRecallValue(value: RecallToolValue): string {
  const lines = [value.message]
  for (const entry of value.entries) {
    const label = SCOPE_LABELS[entry.scope as MemoryScope]
    const tags = entry.tags.length > 0 ? `｜标签：${entry.tags.join('、')}` : ''
    const meta = `重要度 ${entry.importance}/${IMPORTANCE_MAX}，${entry.age}${tags}`
    lines.push(`- [${label}] ${entry.content}（${meta}）`)
  }
  return lines.join('\n')
}
