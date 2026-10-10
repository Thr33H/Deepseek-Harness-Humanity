/**
 * 摘要层：把语义事件文档压成**一次模型调用能吃得下**的紧凑对话摘要。
 *
 * 三条纪律：
 * 1. **只取对话正文**：`user/message` 与 `assistant/message` 之外的类型（工具调用/结果、
 *    todo、回合边界）对"用户是谁、说了什么、定了什么"没有增量，只会撑爆预算——
 *    过滤发生在**代码里**（工程裁剪），不是提示词里（G-003 禁的是运行时单点示例引导，不是数据过滤）。
 * 2. **字节预算硬上限**：单事件先截，再按总字节截；截断处留显式标记，
 *    让模型知道"这里不完整"而不是把半句话当整句解析。
 * 3. **纯函数**：不碰服务、不写存储——输入事件数组，输出文本；可整层单测。
 *
 * 事件文本来自 sessionQuery 的第一方语义提取（`extraction.ts` 按事件类型提取正文），
 * 我们只做角色标注与截断，不再猜内容结构。
 * @module humanity/evolution/digest
 */
import type { EventDocLike } from './types.js'

/** 进摘要的事件类型（对话正文两类；其余是噪声或机械内容）。 */
export const DIGEST_EVENT_TYPES = ['user/message', 'assistant/message'] as const

/** 单事件正文的字符上限（超长发言留头留尾不如留头：整理管线要的是"说了什么"的开头主干）。 */
export const PER_EVENT_CHAR_LIMIT = 2000

/** 角色标注（抽象标签，不是提示词示例）。 */
const ROLE_LABELS: Readonly<Record<string, string>> = {
  'user/message': 'user',
  'assistant/message': 'assistant',
}

/** 截断标记（预留进预算，保证输出总字节永不超 maxBytes）。 */
const TRUNCATION_MARKER = '[…earlier-or-longer content truncated by budget…]'

/** 摘要结果。 */
export interface DigestResult {
  /** 摘要正文；没有任何可消化事件时为空串（调用方据此跳过模型调用）。 */
  text: string
  /** 实际进入摘要的事件数。 */
  eventCount: number
  /** 是否因预算截断（投影与运行记录里如实标注）。 */
  truncated: boolean
  /**
   * **可以安全推进到的 seq**：真正"看过"的最后一条事件（含被当作噪声跳过的那类）。
   *
   * ⚠️ 为什么必须有它（2026-09-26 审计抓到的真缺陷）：预算不够时循环 break，而调用方原来
   * 把游标直接推到**整批末尾** —— 没进摘要的事件就此永久跳过，与"宁可下轮重看，不可永久丢"
   * 完全相反。截断时这里停在"最后一条被考虑过的"，下一轮从它之后接着读。
   */
  lastSeq: number
}

/** 压平空白：对话里的多段空行对解析没有信息量，只会浪费字节预算。 */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 构造摘要。
 *
 * 字节计数用 `TextEncoder`（标准 API，跨平台，G-006）；预算是**软进硬出**：
 * 一行装不下剩余预算就停（不把一行截一半），已截断的事实由 `truncated` 带回。
 * @param events - 语义事件（seq 升序）。
 * @param maxBytes - 总字节预算（配置 `budget.maxInputBytesPerCall`，留出提示词与系统段的余量由调用方决定）。
 */
export function buildDigest(events: readonly EventDocLike[], maxBytes: number): DigestResult {
  const encoder = new TextEncoder()
  const markerBytes = encoder.encode(TRUNCATION_MARKER).byteLength + 1
  const lines: string[] = []
  let bytes = 0
  let count = 0
  let truncated = false

  /** 安全推进点：每"考虑过"一条就前移（噪声事件也算看过，不必再读一遍）。 */
  let lastSeq = 0
  for (const event of events) {
    const label = ROLE_LABELS[event.type]
    if (label === undefined) {
      lastSeq = event.seq
      continue
    }
    const body = collapse(event.text ?? '')
    if (body === '') {
      lastSeq = event.seq
      continue
    }
    const clipped = body.length > PER_EVENT_CHAR_LIMIT ? `${body.slice(0, PER_EVENT_CHAR_LIMIT)}…` : body
    const line = `[${label}] ${clipped}`
    const cost = encoder.encode(line).byteLength + 1
    // 预算里先扣下截断标记的位置：一旦这里放不下，标记必然要出现，总字节才不会超。
    if (bytes + cost + markerBytes > maxBytes) {
      truncated = true
      break
    }
    lines.push(line)
    bytes += cost
    count += 1
    lastSeq = event.seq
  }

  if (truncated) lines.push(TRUNCATION_MARKER)
  return { text: lines.join('\n'), eventCount: count, truncated, lastSeq }
}
