/**
 * 存量重复的**工作台动作**：清理与撤销（`ops.ts` 里两条命令的实现，拆出来是为了守住 200 行上限）。
 *
 * 判据与安全规则**完全复用**写入路径（`similar.ts` 的 `mergeDuplicates`）：本模块只负责
 * "读全库 → 应用 → 记账 → 报告"，绝不新造第二套判据——两套判据迟早会漂成两个答案。
 *
 * 撤销是**内存态**：快照随进程消失，重启后撤不回来（文案如实说明，不假装持久）。
 * 这条快照存在的理由：合并的代价不对称——漏合只是库里多一条，误合是**丢信息**，
 * 撤销把它从"不可逆"降成"点一下能回来"。
 * @module humanity/memory/dedupe-ops
 */
import { mergeDuplicates } from './similar.js'
import type { MemoryStore } from './store.js'
import type { MemoryEntry } from './types.js'

/** 上一次合并的撤销快照；`entries` 为空表示没有可撤销的合并。 */
export interface MergeUndoSlot {
  entries?: readonly MemoryEntry[]
}

/** 报告里给用户看的是正文开头，不是指纹。 */
function brief(entry: MemoryEntry | undefined): string {
  if (entry === undefined) return '（已不存在）'
  const text = entry.content.replace(/\s+/g, ' ').trim()
  return text.length <= 18 ? text : `${text.slice(0, 18)}…`
}

/** 配对清单：最多列 3 对，其余只报数量（通知区不是日志）。 */
function summarizePairs(
  absorbed: readonly { from: string; into: string }[],
  byKey: Map<string, MemoryEntry>,
): string {
  const shown = absorbed
    .slice(0, 3)
    .map((item) => `「${brief(byKey.get(item.from))}」并入「${brief(byKey.get(item.into))}」`)
  const rest = absorbed.length - shown.length
  return `${shown.join('；')}${rest > 0 ? `；另有 ${rest} 对` : ''}。`
}

/**
 * 清理全库的近似重复。
 * @param store - 记忆读写入口。
 * @param slot - 撤销槽（本次动过的条目写进这里）。
 * @returns 面向用户的结论。
 */
export async function dedupeOnce(store: MemoryStore, slot: MergeUndoSlot): Promise<string> {
  const all = store.list()
  const { kept, absorbed } = mergeDuplicates(all)
  if (absorbed.length === 0) return '检查完毕：没有发现可以安全合并的重复条目。'

  const byKey = new Map(all.map((entry) => [entry.dedupeKey, entry]))
  const survivors = new Set(absorbed.map((item) => item.into))
  for (const entry of kept) {
    if (survivors.has(entry.dedupeKey)) await store.put(entry)
  }
  for (const item of absorbed) await store.remove(item.from)

  // 快照在写完之后才存：中途抛错时不会留下"撤销一个没发生的合并"的假状态。
  slot.entries = [...absorbed.map((item) => item.from), ...survivors]
    .map((key) => byKey.get(key))
    .filter((entry): entry is MemoryEntry => entry !== undefined)

  return (
    `已合并 ${absorbed.length} 对重复条目（正文保留更长的那条，创建时间与使用次数沿用最早那条）：` +
    `${summarizePairs(absorbed, byKey)}可以撤销。`
  )
}

/**
 * 撤销上一次合并：把动过的条目原样写回（不做整库覆盖）。
 * @param store - 记忆读写入口。
 * @param slot - 撤销槽。
 * @returns 面向用户的结论。
 */
export async function undoDedupe(store: MemoryStore, slot: MergeUndoSlot): Promise<string> {
  const before = slot.entries
  if (before === undefined || before.length === 0) {
    return '没有可撤销的合并（撤销只在本次启动后有效）。'
  }
  for (const entry of before) await store.put(entry)
  slot.entries = undefined
  return `已撤销上一次合并：${before.length} 条记忆已恢复到合并前的内容。`
}
