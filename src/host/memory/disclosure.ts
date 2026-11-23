/**
 * 「这件事她说得出来吗」的判定（**纯函数**，不碰存储）。
 *
 * 秘密不是"不能想起来"，而是"想起来了也不说"。所以两条通道必须分开：
 * - **影响心情**（隐式）：所有够牢的记忆都参与，包括秘密；
 * - **进入对话 / 进入工具结果**（显式）：只放"她愿意说"的。
 *
 * 这条判定现在被两个地方共用：自动注入（`inject.ts`）与主动回忆工具（`tools.ts`）。
 * 分开写两份的代价是真机踩过的：注入那条路一直守着，工具那条路**原来一个都没守** ——
 * 模型只要主动查一次，秘密就整段看到了，"她不想说"形同虚设（2026-11-22 发现）。
 * @module humanity/memory/disclosure
 */
import { DISCLOSURE_THRESHOLD } from './constants.js'
import type { MemoryHit } from './types.js'

/**
 * 把命中按"说不说得出来"分成两堆。
 *
 * 判据是 `cost`（说出来要付多大代价）与 `DISCLOSURE_THRESHOLD` 的比较。抽成纯函数是为了能直接测 ——
 * 这一条是整套设计里**唯一"她主动隐瞒"的落点**，必须能单独验。
 * @param hits - 这一轮想起的（已排序）。
 * @returns `speakable` 能说的、`withheld` 说不出口的。
 */
export function splitByDisclosure(hits: readonly MemoryHit[]): {
  speakable: MemoryHit[]
  withheld: MemoryHit[]
} {
  const speakable: MemoryHit[] = []
  const withheld: MemoryHit[] = []
  for (const hit of hits) {
    if (hit.record.cost > DISCLOSURE_THRESHOLD) withheld.push(hit)
    else speakable.push(hit)
  }
  return { speakable, withheld }
}
