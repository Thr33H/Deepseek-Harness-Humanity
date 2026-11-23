/**
 * 档位之间的**归属关系**：一条记录是不是已经被更粗的那一档吸收了（纯函数，不碰存储）。
 *
 * ### 为什么需要这个
 *
 * 归拢（`period`）与阶段（`chapter`）不是"另存一份摘要"，而是**更粗的一档接管**：
 * 原来那几条还在库里（不删），但不再单独出现在回忆里 —— 否则同一件事会在这一轮被说两遍
 * （一次是具体的事，一次是概括它的那句），既浪费上下文，也不像人说话。
 *
 * 归属关系只记在一个地方：更粗那条记录的 `covers`（它是由哪几条合成来的）。
 * 所以"哪些条目不再单独出现"是**从数据里反推**的，不需要额外的状态表。
 * @module humanity/memory/tiers
 */
import type { MemoryRecord } from './types.js'

/**
 * 已经被吸收进更粗那一档的条目 id。
 *
 * 一个 id 可能被 `period` 收录、那个 `period` 又被 `chapter` 收录 —— 两种都算。
 * @param records - 全部记忆。
 * @returns id 集合；空库返回空集合。
 */
export function foldedIds(records: readonly MemoryRecord[]): ReadonlySet<string> {
  const folded = new Set<string>()
  for (const record of records) for (const id of record.covers) folded.add(id)
  return folded
}

/**
 * 还**单独出现**的那些记录（没被更粗的档吸收）。
 *
 * 回忆只该从这一堆里挑：概括已经代替了它们。
 * @param records - 全部记忆。
 * @returns 过滤后的新数组（顺序不变）。
 */
export function unfolded(records: readonly MemoryRecord[]): MemoryRecord[] {
  const folded = foldedIds(records)
  return records.filter((record) => !folded.has(record.id))
}
