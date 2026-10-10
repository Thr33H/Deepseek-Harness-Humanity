/**
 * 写入路径的**文案**：作用域标签与"这次写入了什么"的结论句。
 *
 * 为什么从 `write.ts` 拆出来：那份文件贴着 200 行行数门，而"怎么判断/怎么落盘"与
 * "结论怎么说给模型听"是两件事 —— 后者几乎每次用户反馈都要改措辞，前者不该跟着动。
 * 三个消费方（工具结果、检索渲染、写入本身）都从这里取标签，措辞只有一个真源。
 * @module humanity/memory/write-text
 */
import type { MemoryEntry } from './types.js'
import type { MemoryScope } from './constants.js'

/** 作用域的中文标签（工具结果、注入文本与写入结论共用一份）。 */
export const SCOPE_LABELS: Readonly<Record<MemoryScope, string>> = {
  'long-term': '长期记忆',
  workspace: '区域记忆',
  session: '会话记忆',
}

/**
 * 写入结论（成功路径）：新增/更新/并入 + 待确认 + 冲突，各说清一句。
 * @param entry - 落盘后的条目。
 * @param updated - 是否是"同一条事实的更新"。
 * @param hasConflict - 是否标记了冲突。
 * @param mergedTwin - 是否是"并入已有的另一种说法"。
 * @returns 给模型看的一句话。
 */
export function describeEntry(
  entry: MemoryEntry,
  updated: boolean,
  hasConflict: boolean,
  mergedTwin = false,
): string {
  const head = mergedTwin
    ? `已并入已有的${SCOPE_LABELS[entry.scope]}（识别为同一条事实的另一种说法，未新增平行条目）。`
    : updated
      ? `已更新${SCOPE_LABELS[entry.scope]}（同一条事实，未重复新增）。`
      : `已写入${SCOPE_LABELS[entry.scope]}。`
  const parts = [head]
  if (entry.status === 'pending') parts.push('这是敏感内容，已进入待确认：用户确认前不参与检索与注入。')
  if (hasConflict) parts.push('与已有记忆可能矛盾，已标记冲突（不改动任何一方，等用户在工作台处理）。')
  return parts.join('')
}
