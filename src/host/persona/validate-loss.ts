/**
 * 可变层的**丢内容判定**：Agent 不得通过"删掉整节"来丢失用户内容（P-010）。
 *
 * 为什么从 `validate-mutable.ts` 拆出来：那份文件贴着 200 行行数门，而"这一节的内容还在不在"
 * 与"小标题、条目本身合不合法"是两组独立的判定 —— 前者要拿**上一版文档**做对比，
 * 后者只看当前值；混在一起时，读代码的人得先分辨手上这个 `issues.push` 属于哪一组。
 * @module humanity/persona/validate-loss
 */
import { STANDARD_SECTION_TITLES } from './constants.js'
import type { PersonaDocument, PersonaIssue } from './types.js'

/** 标准小标题集合（"清空自定义节 = 删除"的判据要看它）。 */
const STANDARD_TITLES = new Set<string>(STANDARD_SECTION_TITLES)

/**
 * 两种丢内容的方式，语义刻意分开（2026-09-23 真机反馈 ⑤ / R1 / R2 / R4 之后定下）：
 * - **显式传 `items: []` 把有内容的一节清空**（`section-cleared`）：这是"删内容 / 删自定义节"的
 *   正门，rejected，但工具层把它当**可确认项**（用户在对话里点确认后放行）；
 * - **标题从快照里消失**（`section-dropped`）：调用方**漏传**了这一节，rejected；工具层已把"漏传"
 *   处理成"不动这一节"（`tools.ts` 的 completeSections），所以正常路径不会碰到它。
 *
 * 两者的区别之所以**现在才成立**：删除不在 `normalizePersona` 里做了（见 `effectivePersona`），
 * 否则"显式传 items: []（明确要删）"与"漏传（可能误删）"在校验器眼里一模一样 ——
 * 于是显式删除被误报成"整节不见了"（R1），还劝人"要清空请传 items: []"（R4）。
 * @param next - 规范化之后的候选文档。
 * @param prev - 当前生效文档；首次初始化时传 `undefined`。
 * @param issues - 结论收集器。
 */
export function checkContentLoss(
  next: PersonaDocument,
  prev: PersonaDocument | undefined,
  issues: PersonaIssue[],
): void {
  if (prev === undefined) return

  for (const previous of prev.mutableLayer.sections) {
    if (previous.items.length === 0) continue
    const stillThere = next.mutableLayer.sections.find((section) => section.title === previous.title)
    if (stillThere === undefined) {
      issues.push({
        code: 'mutable.section-dropped',
        path: `mutableLayer.sections.${previous.title}`,
        severity: 'rejected',
        message:
          `「${previous.title}」原有内容，但这次快照里**整节不见了**（漏传）。若要保留请显式传入原内容；` +
          `要删除这个自定义节请显式传 items: []（会在对话里确认）。`,
      })
      continue
    }
    if (stillThere.items.length === 0) {
      const custom = !STANDARD_TITLES.has(previous.title)
      issues.push({
        code: 'mutable.section-cleared',
        path: `mutableLayer.sections.${previous.title}`,
        severity: 'rejected',
        message:
          `「${previous.title}」原有内容，这次被显式清空` +
          (custom ? '（自定义小标题清空即删除该节）' : '（标准小标题清空后保留空节）') +
          `；删除用户内容需要用户在对话里确认。`,
      })
    }
  }
}
