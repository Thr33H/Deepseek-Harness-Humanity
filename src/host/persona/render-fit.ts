/**
 * 人格内容的**预算拟合**（纯函数）：把要注入的内容装进限定字符数，并如实记账压掉了什么。
 *
 * 为什么从 `render.ts` 拆出来：那边贴着文件行数质量门，而"怎么排字"与"装不下时先牺牲谁"
 * 是两个独立问题 —— 后者要能被单独读懂、单独测。
 *
 * ⚠️ **2026-09-26 修的一处结构性缺陷**（用户发现某实例的提示词末尾挂着「已截断」）：旧实现把
 * **一个小节当成一整行**，放不下就整节丢掉 —— 真机上 7 节里有 3 节从来没进过提示词。
 * 现在改成**逐条填充 + 轮转配额**：每节先保底一条，剩下的按轮次一条一条加；唯一的限制是字符
 * 预算（曾经的"每节最多 N 条"已删：它与成本无关，只会造出一个不可解释的悬崖）。
 * @module humanity/persona/render-fit
 */
import { clip, isClippedItem } from './clip.js'

/** 一个待注入的小节。 */
export interface FitSection {
  title: string
  items: readonly string[]
}

/** 拟合输入：头部原子行（标题 / 固定层）、小节、尾部原子行（用户定义）。 */
export interface FitInput {
  head: readonly string[]
  sections: readonly FitSection[]
  tail: readonly string[]
}

/** 一个小节的账：进了几条、还剩几条没进。 */
export interface SectionFit {
  title: string
  injected: number
  dropped: number
}

/** 一次拟合的结果与账目。 */
export interface FitResult {
  lines: string[]
  stats: FitStats
}

/** 提示词里那一行被截断的说明；工作台也用它。 */
export const TRUNCATION_MARKER = '（人格内容超出注入预算，已截断）'

/** 拟合账目（工作台与提示词都要如实说明"有多少条没进去"）。 */
export interface FitStats {
  /** 可用于人格内容的字符数（已扣掉永不截断的固定段）。 */
  budget: number
  /** 实际用掉多少字符。 */
  used: number
  /** 进提示词的条目数（不含固定层字段）。 */
  injected: number
  /** 没进提示词的条目数。 */
  dropped: number
  /** 每个小节的账（顺序与文档一致）。 */
  sections: readonly SectionFit[]
  /** 是否有内容被截断（提示词据此决定加不加标记）。 */
  truncated: boolean
}

/** 一条行占的字符数（`+1` 是它后面那个换行）。 */
function costOf(lines: readonly string[]): number {
  return lines.reduce((sum, line) => sum + line.length + 1, 0)
}

/** 某小节"只放前 count 条"时的行（含未注入说明）。 */
function sectionLines(section: FitSection, count: number): string[] {
  const hidden = section.items.length - count
  const shown = section.items.slice(0, count).map(clip).join('；')
  const lines = [`- ${section.title}：${shown}`]
  if (hidden > 0) lines.push(`  （该节另有 ${hidden} 条未注入）`)
  return lines
}

/** 拟合过程中的可变账（逐行推进，最后汇总成 {@link FitStats}）。 */
interface FitCursor {
  lines: string[]
  used: number
  truncated: boolean
}

/**
 * 原子行：放不下就此打住（后面的也不再放，保持文档顺序的语义）。
 * @param cursor - 当前账。
 * @param line - 待放的行。
 * @param limit - 内容可用上限。
 * @returns 是否放下。
 */
function pushAtomic(cursor: FitCursor, line: string, limit: number): boolean {
  if (cursor.used + line.length + 1 > limit) {
    cursor.truncated = true
    return false
  }
  cursor.lines.push(line)
  cursor.used += line.length + 1
  return true
}

/**
 * 在预算内挑出每个小节各放几条：**先保底一条**（让每个维度都在场），再轮转加条。
 *
 * 轮转而不是"前面的小节吃饱"：内容有长有短，顺序填充会让后面那几个小节整节消失 ——
 * 那正是真机上"7 节丢了 3 节"的来源。
 * @param sections - 待放的小节。
 * @param cursor - 当前账（就地推进）。
 * @param limit - 小节可用的字符上限。
 * @returns 每个小节各放几条（0 = 整节没进）。
 */
function fillSections(sections: readonly FitSection[], cursor: FitCursor, limit: number): number[] {
  const taken = sections.map(() => 0)
  for (let index = 0; index < sections.length; index += 1) {
    const cost = costOf(sectionLines(sections[index] as FitSection, 1))
    if (cursor.used + cost > limit) {
      cursor.truncated = true
      break
    }
    cursor.used += cost
    taken[index] = 1
  }
  let grew = true
  while (grew) {
    grew = false
    for (let index = 0; index < sections.length; index += 1) {
      const section = sections[index] as FitSection
      const count = taken[index] as number
      if (count === 0 || count >= section.items.length) continue
      const delta = costOf(sectionLines(section, count + 1)) - costOf(sectionLines(section, count))
      if (cursor.used + delta > limit) continue
      cursor.used += delta
      taken[index] = count + 1
      grew = true
    }
  }
  return taken
}

/**
 * 把内容拟进预算。
 *
 * 顺序即优先级：头部原子行（谁、什么底色）→ 可变层小节 → 尾部原子行（兜底条目）。
 * `taken === 0` 的小节整节省略，但它在账目里如实记为 dropped（不会静默消失）。
 * @param input - 头部行、小节与尾部行。
 * @param budget - 可用字符数。
 * @returns 行与账目。
 */
export function fitPersonaContent(input: FitInput, budget: number): FitResult {
  // 给「已截断」标记留位：它也是进提示词的字符（旧实现把它算在预算外，靠运气才没超）。
  const limit = Math.max(0, budget - TRUNCATION_MARKER.length - 1)
  const cursor: FitCursor = { lines: [], used: 0, truncated: false }
  for (const line of input.head) {
    if (!pushAtomic(cursor, line, limit)) break
  }

  // 尾部（用户定义）先占位：它是用户亲手写的兜底内容，不该被可变层挤掉。
  const tailCost = costOf(input.tail)
  const reservedTail = cursor.used + tailCost <= limit ? tailCost : 0
  if (reservedTail === 0 && input.tail.length > 0) cursor.truncated = true
  const taken = fillSections(input.sections, cursor, limit - reservedTail)

  const sections: SectionFit[] = []
  let injected = 0
  let dropped = 0
  for (let index = 0; index < input.sections.length; index += 1) {
    const section = input.sections[index] as FitSection
    const count = taken[index] as number
    if (count > 0) {
      cursor.lines.push(...sectionLines(section, count))
      // 进了提示词但被裁过 ⇒ 账目上必须算截断，否则工作台会说"全都进去了"（见 `isClippedItem`）。
      if (section.items.slice(0, count).some(isClippedItem)) cursor.truncated = true
    }
    sections.push({ title: section.title, injected: count, dropped: section.items.length - count })
    injected += count
    dropped += section.items.length - count
  }
  if (dropped > 0) cursor.truncated = true

  for (const line of input.tail) {
    if (!pushAtomic(cursor, line, limit)) break
  }
  if (cursor.truncated) cursor.lines.push(TRUNCATION_MARKER)

  return {
    lines: cursor.lines,
    stats: { budget, used: cursor.used, injected, dropped, sections, truncated: cursor.truncated },
  }
}
