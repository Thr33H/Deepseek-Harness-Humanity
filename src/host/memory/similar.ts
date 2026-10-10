/**
 * 近似去重：识别"同一条事实的另一种说法"。
 *
 * **为什么需要它**（真机实证，不是防御性编程）：精确指纹 `buildDedupeKey` 只在
 * **归一化后逐字相同**时命中，而模型复述同一件事时几乎从不逐字相同。TEST 生产库里
 * 同一条"不区分戏内/戏外"的规矩已经躺了 **4 个平行条目**（两两 Dice 0.697 / 0.756 / 0.944）。
 *
 * **判据**：本地记号相似度（Dice，基于 `tokenize` 的汉字二元组），**不调模型**——
 * 与 P-029「默认不调用模型做改写/判断」同一口径，也让写入路径保持零外部成本。
 *
 * **为什么不在这里做决定**：本模块只回答"像不像同一条"。并进去、还是新增，
 * 由 `write.ts` 按安全规则决定（安全标记只能收紧那条防线不许绕过）。
 * @module humanity/memory/similar
 */
import { NEAR_DUPLICATE_DICE } from './constants.js'
import { conflictsWith } from './conflict.js'
import { overlapCount, tokenize } from './tokenize.js'
import type { MemoryEntry } from './types.js'

/**
 * 两条正文的 Dice 相似度（0–1）。
 *
 * 用 Dice 而不是 Jaccard：短文本上 Dice 更宽容一点点，而我们要比的是
 * "同一件事的两种说法"——它们长度接近、共同记号多，Dice 的读数更直观。
 * @param left - 正文 A。
 * @param right - 正文 B。
 * @returns 相似度；任一侧没有记号时返回 0（空文本不该与任何东西"像"）。
 */
export function similarity(left: string, right: string): number {
  const a = tokenize(left)
  const b = tokenize(right)
  const total = a.size + b.size
  if (total === 0) return 0
  return (2 * overlapCount(a, b)) / total
}

/**
 * 候选条目是否是**已存某条**的另一种说法。
 *
 * 只比同作用域 + 同归属的条目：跨层各说各的（长期 vs 会话），跨归属各管各的
 * （两个会话的记忆不该互相并掉）。已归档的不参与——它默认不检索，被它并掉
 * 等于把新内容丢进归档里。精确命中那一档由调用方先处理，这里跳过。
 * @param candidate - 待写入的条目。
 * @param existing - 已存条目。
 * @returns 最像的那条；都不够像时返回 undefined。
 */
export function findNearDuplicate(
  candidate: MemoryEntry,
  existing: readonly MemoryEntry[],
): MemoryEntry | undefined {
  let best: MemoryEntry | undefined
  let bestScore = 0
  for (const item of existing) {
    if (item.scope !== candidate.scope) continue
    if (item.ownerId !== candidate.ownerId) continue
    if (item.status === 'archived') continue
    if (item.dedupeKey === candidate.dedupeKey) continue
    const score = similarity(candidate.content, item.content)
    if (score >= NEAR_DUPLICATE_DICE && score > bestScore) {
      best = item
      bestScore = score
    }
  }
  return best
}

/**
 * 把候选条目并进已有条目：**身份沿用已有的，信息只增不减**。
 *
 * 为什么和判据放在同一个模块：并进去要动的字段（指纹、id、首次来源）正是身份本身，
 * 让调用方自己拼一遍，拼错一次就是"身份漂移"——`conflictWith` 里记的是旧指纹、
 * `put` 靠指纹保留创建时间与使用统计，换了指纹等于凭空新增一条，两个都会坏。
 *
 * 具体规则：
 * - `id` / `dedupeKey` / `createdAt` / 首次来源（`origin`/`sourceSessionId`/`sourceMessageId`）
 *   沿用已有的 —— 身份与"什么时候进来的"都不改；
 * - **使用统计（`useCount`/`lastUsedAt`）也沿用已有的**：重写不等于被用过（与 `store.put`
 *   同一条理由；这里显式保留是为了让本函数**脱离 `put` 也自洽**）；
 * - 正文取**更长**的那条（信息量不倒退；等长时保留已有的）；
 * - `importance` / `confidence` 取较大值：合并只该让一条事实更硬，不该更软；
 * - `tags` 取并集（检索信号只会更全）；`pinned` 沿用已有的（用户钉过就一直钉着）。
 *
 * 2026-09-25 真机教训：`createdAt` 原先没列进来 —— 在线写入路径被 `store.put` 兜住了看不出问题，
 * 但**数据级清理**（`mergeDuplicates` 直接改存档、不经过 `put`）会让幸存者的创建时间漂成后来那条的。
 * 时间是新鲜度打分的输入，漂了就是错的。身份字段必须由本函数自己保全，不指望调用方补。
 *
 * 安全标记（`sensitive`/`status`）**不在这里动**：那条防线由 `mergeSafety` 单独负责。
 * @param target - 已存条目。
 * @param candidate - 待写入的条目。
 * @returns 合并后的条目（尚未落盘）。
 */
export function adoptExisting(target: MemoryEntry, candidate: MemoryEntry): MemoryEntry {
  // ⚠️ 安全字段**只收紧、不放宽**（P-033 红线，2026-09-26 审计抓到的真缺陷）：
  // 这里原来是 `...candidate` 一路覆盖，于是一条**待确认的敏感记忆**被同义的 active 条目并掉之后，
  // 直接变成"生效 + 不敏感"—— 用户从没点过确认，敏感标记也没了。合并是存量清理，
  // 它没有权力放行任何用户没点头的东西。
  const status = target.status === 'pending' || candidate.status === 'pending' ? 'pending' : candidate.status
  return {
    ...candidate,
    id: target.id,
    dedupeKey: target.dedupeKey,
    createdAt: target.createdAt,
    useCount: target.useCount,
    lastUsedAt: target.lastUsedAt,
    content: target.content.length >= candidate.content.length ? target.content : candidate.content,
    importance: Math.max(target.importance, candidate.importance),
    confidence: Math.max(target.confidence, candidate.confidence),
    tags: [...new Set([...target.tags, ...candidate.tags])],
    origin: target.origin,
    sourceSessionId: target.sourceSessionId,
    sourceMessageId: target.sourceMessageId,
    pinned: target.pinned,
    status,
    sensitive: target.sensitive || candidate.sensitive,
    confirmedVia: status === 'pending' ? '' : target.confirmedVia || candidate.confirmedVia,
    // 冲突标记**取并集**：被并掉那条身上的标记不该无声消失（消失 = 用户看不到那处矛盾）。
    conflictWith: [...new Set([...target.conflictWith, ...candidate.conflictWith])],
  }
}

/**
 * 把一批条目里的近似重复**合并**成一条（存量清理用）。
 *
 * 与写入路径（`remember`）同一套判据、同一条安全规则：**矛盾的两条绝不合并**
 * （"喜欢咖啡" vs "不喜欢咖啡" 的 Dice 高达 0.727，并了就是丢掉一方）。
 *
 * 两条刻意的不对称：
 * - **归档条目不参与合并、也不被合并**：它是历史，默认不检索，动它只是删数据；
 *   而被它并掉等于把新内容埋进归档里（与 {@link findNearDuplicate} 同一条理由）。
 * - **按创建时序**处理：先来的当骨架，后来的并进去 —— 身份落在最早那条上，
 *   与"一次一条地写入"得到的结论完全一致（所以它适合清理老数据，而不只是重放）。
 * @param entries - 全部条目。
 * @returns 清理后的条目表与被并掉的清单（供如实记账）。
 */
export function mergeDuplicates(entries: readonly MemoryEntry[]): {
  kept: MemoryEntry[]
  absorbed: { from: string; into: string }[]
} {
  const ordered = [...entries].sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  const kept: MemoryEntry[] = []
  const absorbed: { from: string; into: string }[] = []
  for (const entry of ordered) {
    if (entry.status === 'archived') {
      kept.push(entry)
      continue
    }
    const near = findNearDuplicate(entry, kept)
    if (near === undefined || conflictsWith(entry, near)) {
      kept.push(entry)
      continue
    }
    const index = kept.findIndex((item) => item.dedupeKey === near.dedupeKey)
    kept[index] = adoptExisting(near, entry)
    absorbed.push({ from: entry.dedupeKey, into: near.dedupeKey })
  }
  return { kept, absorbed }
}
