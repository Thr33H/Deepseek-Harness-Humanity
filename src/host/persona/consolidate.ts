/**
 * 人格可变层的**整合**：把"同一件事的另一种说法"并成一条。
 *
 * **为什么必须由系统自己做**（用户 2026-09-26 原话：「自进化系统应该也要有整合这些的能力，
 * 而不是靠用户发现，然后用户调整」）：可变层的写回路径是**追加**（`mergePersonaSections` 只跳过
 * 逐字相同的条目），而模型每次复述同一件事的措辞都略有不同 —— 于是同一条规矩会平行躺好几份。
 * 真机实证：某实例的「对用户称呼」小节里有 **7 条**，其中 5 条都在说"称呼用户为主人"；
 * 这些重复把人格卡顶到注入预算上限，**真正的新内容反而进不了提示词**（见 P-056）。
 *
 * **判据**：本地 Dice 相似度（与记忆去重同一个 `similarity`，不调模型 —— P-029 同一条纪律）。
 * 阈值是**拿她真机那张卡标定**的：真正重复的三对落在 0.87–1.00，而"看着像、其实是两条不同规矩"
 * 的最高一对只有 0.68 ⇒ 取 **0.82**，两边都留出余量。
 *
 * **只做机器能确认的那部分**：措辞几乎相同的（例如「台词不加括号，直接写」与「台词不加括号、直接写」）
 * 这里并掉；**意思相同但用词完全不同**的（例如「称呼主人为『主人』」与「在该角色扮演设定中，
 * 以『主人』称呼用户」，Dice 只有 0.44）不是字符串相似度能判的，交给自进化整理时由模型合并 ——
 * 提示词里已经把"合并同义条目"写成硬要求。
 * @module humanity/persona/consolidate
 */
import { similarity } from '../memory/similar.js'
import { opposesByNegation } from '../text.js'
import type { PersonaDocument } from './types.js'

/**
 * 判定"同一条的另一种说法"的 Dice 阈值。
 *
 * 标定数据（某实例真机人格卡，2026-09-26）：
 * - **真重复**：1.000（台词不加括号 ×2）、0.938（以小说体推进 ×2）、0.872（台词带括号 ×2）；
 * - **必须留着的近似对**：0.684 / 0.531 / 0.508（行为边界里"互相包含但各是一条规矩"）。
 * 取 0.82：距最高的误报 0.14，距最低的真重复 0.05。
 */
export const PERSONA_MERGE_DICE = 0.82

/** 太短的条目不参与合并：两三个字的短语容易和任何话"像"，并掉它们只会丢信息。 */
const MIN_MERGE_CHARS = 6

/** 一次合并：留下了哪条、并掉了哪条。 */
export interface PersonaMerge {
  title: string
  kept: string
  dropped: string
}

/** 整合结果：新文档 + 合并清单（清单要能被人复核，不能悄悄改）。 */
export interface PersonaConsolidation {
  document: PersonaDocument
  merged: PersonaMerge[]
}

/**
 * 两条是否算"同一条的另一种说法"（导出给写入路径复用：新增时先问一句，别再造出重复）。
 * @param left - 已有条目。
 * @param right - 待写入条目。
 * @returns 是否应当视为同一条。
 */
export function isNearDuplicateItem(left: string, right: string): boolean {
  const a = left.trim()
  const b = right.trim()
  if (a === '') return false
  // 逐字相同**永远**算重复（哪怕只有两个字）：这是旧行为就有的那一档，不能被长度门槛弄丢。
  if (a === b) return true
  // **极性否决**：一条带否定、另一条不带 ⇒ 再像也是"反面"，绝不并（并掉等于替用户改意思）。
  // 真机实证：「不要在我工作时打扰我」⇄「要在我工作时打扰我」Dice 0.941 —— 旧逻辑正是靠
  // 那个"不"字之外的 12 个字把它判成重复的（2026-09-26 审计 P3）。
  if (opposesByNegation(a, b)) return false
  // 长度门槛只挡"相似度"这一档：两三个字的短语容易和任何话"像"，并掉它们只会丢信息。
  if (a.length < MIN_MERGE_CHARS || b.length < MIN_MERGE_CHARS) return false
  return similarity(a, b) >= PERSONA_MERGE_DICE
}

/**
 * 合并一个小节的条目：保留信息量更大的那条（更长），同样长则保留靠前的那条。
 * @param title - 小节标题（只用于记账）。
 * @param items - 该小节现有条目。
 * @param merged - 合并清单的收集器。
 * @returns 合并后的条目。
 */
function consolidateSection(title: string, items: readonly string[], merged: PersonaMerge[]): string[] {
  const keptItems: string[] = []
  for (const item of items) {
    const value = item.trim()
    if (value === '') continue
    const index = keptItems.findIndex((kept) => isNearDuplicateItem(kept, value))
    if (index < 0) {
      keptItems.push(value)
      continue
    }
    const kept = keptItems[index] as string
    // 保留更长的（它多半带着另一半没有的限定），同样长就保留先出现的那条：稳定、可预期。
    const winner = value.length > kept.length ? value : kept
    const loser = value.length > kept.length ? kept : value
    keptItems[index] = winner
    merged.push({ title, kept: winner, dropped: loser })
  }
  return keptItems
}

/**
 * 整合一份人格文档的可变层（纯函数，不改入参）。
 *
 * 逐个小节内部合并，**绝不跨小节**：不同小标题是用户自己分的类，跨节合并等于替用户改结构。
 * 完全相同的条目按原样保留一条（旧行为就是靠 `includes` 去重，这里不改变那一档的语义）。
 * @param doc - 当前人格文档。
 * @returns 新文档与被合并掉的条目清单（没有可合并项时 `merged` 为空数组）。
 */
export function consolidatePersona(doc: PersonaDocument): PersonaConsolidation {
  const merged: PersonaMerge[] = []
  const sections = (doc?.mutableLayer?.sections ?? []).map((section) => ({
    title: section?.title ?? '',
    items: consolidateSection(section?.title ?? '', section?.items ?? [], merged),
  }))
  const userDefined = (doc?.mutableLayer?.userDefined ?? []).map((entry) => ({ ...entry }))
  return { document: { ...doc, mutableLayer: { sections, userDefined } }, merged }
}
