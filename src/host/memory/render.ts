/**
 * 记忆块的渲染：把检索结果变成**一小段**进系统提示词的文本（纯函数）。
 *
 * 格式（P-028 的"滚动摘要块"）：
 *
 * ```
 * # 相关记忆（Humanity 自动注入）
 * - [长期记忆] 用户喜欢喝咖啡，尤其是手冲（重要度 4/5，3天前）
 * ```
 *
 * 三条约束：
 * 1. **只放摘要/事实**：正文本身就是摘要（写入时已截断），这里不再追加原文；
 * 2. **硬上限按字符算**：{@link renderMemoryBlock} 收下一个 `budget`，**超出就整条丢弃**
 *    （不截半句话 —— 半句话比没有更危险：模型会照着一个残缺的约束行事）；
 * 3. **没有内容就不产出**：一条都塞不进时返回空串，宁可不注入（P-028）。
 *
 * 为什么按字符而不是 token：本插件不带 tokenizer（引一个分词/编码器只为估算长度不划算）。
 * 字符数是**保守**读法：中日韩 1 字 ≈ 1 token，英文 1 token ≈ 4 字符，所以"字符数 ≤ 预算"
 * 一定满足"token 数 ≤ 预算"。
 * @module humanity/memory/render
 */
import { IMPORTANCE_MAX } from './constants.js'
import { SCOPE_LABELS } from './write-text.js'
import type { MemoryEntry } from './types.js'

/** 块标题。它同时是"这一轮注入了记忆"的可读标记，工作日志与提示词里靠它辨认。 */
export const BLOCK_TITLE = '# 相关记忆（Humanity 自动注入）'

/**
 * 相对时间（`今天` / `昨天` / `3天前` / `2个月前`）。
 *
 * 为什么给模型看相对时间而不是时间戳：模型据此判断"这条还新鲜吗"，
 * ISO 时间戳要它自己换算，换算错了就是一次错误判断。
 * @param stamp - 目标时刻（ISO 8601）。
 * @param now - 当前时刻（ISO 8601）。
 * @returns 中文相对时间。
 */
export function relativeTimeOf(stamp: string, now: string): string {
  const ageMs = Date.parse(now) - Date.parse(stamp)
  if (!Number.isFinite(ageMs) || ageMs < 0) return '刚刚'
  const days = Math.floor(ageMs / 86_400_000)
  if (days === 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 30) return `${days}天前`
  if (days < 365) return `${Math.floor(days / 30)}个月前`
  return `${Math.floor(days / 365)}年前`
}

/** 一条记忆渲染成一行。 */
function lineOf(entry: MemoryEntry, now: string): string {
  const stamp = entry.lastUsedAt === '' ? entry.updatedAt : entry.lastUsedAt
  return `- [${SCOPE_LABELS[entry.scope]}] ${entry.content}（重要度 ${entry.importance}/${IMPORTANCE_MAX}，${relativeTimeOf(stamp, now)}）`
}

/**
 * 渲染记忆块。
 * @param entries - 已按相关度排好序的条目（顺序即优先级）。
 * @param budget - 硬上限（字符）；≤0 表示不注入。
 * @param now - 当前时刻（ISO 8601），用于相对时间；显式传入以保证纯函数可复现。
 * @returns 块文本；没有任何条目放得下时返回空串。
 */
export function renderMemoryBlock(entries: readonly MemoryEntry[], budget: number, now: string): string {
  if (budget <= 0) return ''
  const lines: string[] = [BLOCK_TITLE]
  for (const entry of entries) {
    const line = lineOf(entry, now)
    if ([...lines, line].join('\n').length > budget) break
    lines.push(line)
  }
  // 只剩标题说明一条都没放下 —— 那就什么都不注入（P-028：空着比塞错安全）。
  return lines.length > 1 ? lines.join('\n') : ''
}
