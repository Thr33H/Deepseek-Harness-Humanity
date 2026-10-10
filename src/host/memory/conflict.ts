/**
 * 冲突检测：**标记**两条记忆可能互相矛盾，绝不自动解决（P-025 要求"冲突检测"，
 * 但没给任何人自动改用户话的权力）。
 *
 * 判据是**本地关键词启发式**，理由与 P-029 一致：默认不调用模型做改写/判断。
 * 规则两步：
 * 1. 两条内容去掉否定词后**说的是同一件事**（归一化后相等或互相包含）；
 * 2. 但一条带否定、另一条不带 —— 那就是「喜欢咖啡」对上「不喜欢咖啡」。
 *
 * 启发式的边界写在代码里，好过藏在注释里：它**只处理最典型的一类矛盾**（同句加否定），
 * 像「早上喝咖啡」对上「晚上喝咖啡」这种时间/条件矛盾它认不出来。认不出来只是不标记，
 * 不会做出任何错误动作 —— 这是这个设计能接受漏检的原因。
 * @module humanity/memory/conflict
 */
import { hasNegation, withoutNegations } from '../text.js'
import { normalizeMemoryText } from './model.js'
import type { MemoryStore } from './store.js'
import type { MemoryEntry } from './types.js'

/**
 * 两条记忆是否**可能**矛盾。
 *
 * 同指纹不算冲突（那是去重），跨作用域不算冲突（各层各说各的），已归档的不参与
 * （它默认不参与检索，把它翻出来只会制造噪音）。
 * @param candidate - 待写入的条目。
 * @param existing - 已存条目。
 * @returns 可能矛盾时为 true。
 */
export function conflictsWith(candidate: MemoryEntry, existing: MemoryEntry): boolean {
  if (existing.dedupeKey === candidate.dedupeKey) return false
  if (existing.scope !== candidate.scope) return false
  // 归属不同 = 两条各管各的（会话 A 与会话 B、工作区甲与工作区乙），谈不上互相矛盾。
  // 缺这一条时，工作台会在一条记忆上标出"与另一条矛盾"，而那条在当前区域里根本看不到（2026-09-26 审计）。
  if (existing.ownerId !== candidate.ownerId) return false
  if (existing.status === 'archived') return false
  if (normalizeMemoryText(candidate.content) === normalizeMemoryText(existing.content)) return false
  if (hasNegation(candidate.content) === hasNegation(existing.content)) return false

  const candidateBase = normalizeMemoryText(withoutNegations(candidate.content))
  const existingBase = normalizeMemoryText(withoutNegations(existing.content))
  if (candidateBase === '' || existingBase === '') return false
  return (
    candidateBase === existingBase ||
    candidateBase.includes(existingBase) ||
    existingBase.includes(candidateBase)
  )
}

/**
 * 找出与候选条目可能矛盾的全部已存条目。
 * @param candidate - 待写入的条目。
 * @param existing - 已存条目（通常来自 `store.list()`）。
 * @returns 冲突条目的指纹列表。
 */
export function findConflicts(candidate: MemoryEntry, existing: readonly MemoryEntry[]): string[] {
  return existing.filter((item) => conflictsWith(candidate, item)).map((item) => item.dedupeKey)
}

/**
 * 同步双方的冲突标记。
 *
 * 冲突是**双向**的（A 与 B 矛盾，两边都该显示），并且必须能**撤销**：
 * 内容改成不再矛盾时，旧标记要拆掉，否则工作台会永远挂着一堆幽灵冲突。
 *
 * 放在本模块而不是写入路径：它是冲突记账，不是写入流程；`remember` 只该讲流程。
 * @param store - 记忆读写入口。
 * @param candidateKey - 本次写入的指纹。
 * @param conflicts - 本次检测到的冲突指纹。
 * @param existing - 本次写入前的全部条目。
 */
export async function syncConflictMarks(
  store: MemoryStore,
  candidateKey: string,
  conflicts: readonly string[],
  existing: readonly MemoryEntry[],
): Promise<void> {
  const wanted = new Set(conflicts)
  for (const item of existing) {
    const marked = item.conflictWith.includes(candidateKey)
    const shouldMark = wanted.has(item.dedupeKey)
    if (marked === shouldMark) continue
    const conflictWith = shouldMark
      ? [...item.conflictWith, candidateKey]
      : item.conflictWith.filter((key) => key !== candidateKey)
    await store.put({ ...item, conflictWith })
  }
}
