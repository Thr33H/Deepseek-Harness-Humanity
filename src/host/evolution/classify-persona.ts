/**
 * 可变层写回（从 `classify.ts` 拆出）：合并完整快照 → 以 agent 身份写入 → 被拒转提案。
 *
 * 权限依据：P-038「可变人格可自动整理」+ P-017「每次修改必须生成完整当前快照」——
 * 所以这里永远从 `persona.read()` 现读全文、合并、整份写回，绝不追加补丁；
 * 校验层（`writePersona`）拒绝时不硬闯，转成待确认提案（P-010 高风险不静默）。
 * @module humanity/evolution/classify-persona
 */
import { isNearDuplicateItem } from '../persona/consolidate.js'
import { PersonaWriteRejected } from '../persona/document.js'
import { isUntouchedIdentityCard } from '../persona/predicates.js'
import { personaPromptReport } from '../persona/render.js'
import type { PersonaDocument } from '../persona/types.js'
import type { ClassifyContext, ClassifyDeps, ProposalFactory } from './classify.js'
import { MAX_PROPOSAL_TEXT_CHARS } from './constants.js'
import type { AnalysisOutput } from './model.js'

/**
 * 先按模型的整合建议**并掉同义条目**（P-056）。
 *
 * 只有 `drop` 与现有条目**逐字一致**才算数：对不上就忽略 —— 宁可少并一条，
 * 也不能凭"大概指的是这句"去删用户的内容。`keep` 不在该小节里时不并（防止把两条都删掉）。
 * @param section - 该小节现有条目（原地改）。
 * @param consolidations - 该小节收到的整合建议。
 * @returns 实际并掉的条数。
 */
function applyConsolidations(
  section: { title: string; items: string[] },
  consolidations: readonly AnalysisRunConsolidation[],
): number {
  let dropped = 0
  for (const consolidation of consolidations) {
    const keep = consolidation.keep.trim()
    if (!section.items.includes(keep)) continue
    for (const raw of consolidation.drop) {
      const value = raw.trim()
      if (value === keep) continue
      const at = section.items.indexOf(value)
      if (at < 0) continue
      section.items.splice(at, 1)
      dropped += 1
    }
  }
  return dropped
}

/** 一次整合建议（模型输出合同里的一项）。 */
type AnalysisRunConsolidation = AnalysisOutput['sectionConsolidations'][number]

/**
 * 把小节建议合并进当前文档（完整快照重生成，P-017）；返回新文档、实际新增行与合并掉的条数。
 *
 * 顺序：**先整合、后追加** —— 同一轮里模型既提了合并又提了新条目时，先并掉重复的再看新条目，
 * 新条目才不会跟一条马上要消失的旧条目"撞车"而被误判成重复。
 */
export function mergePersonaSections(
  current: PersonaDocument,
  updates: AnalysisOutput['personaSections'],
  consolidations: AnalysisOutput['sectionConsolidations'] = [],
): { next: PersonaDocument; added: string[]; merged: number } {
  const sections = current.mutableLayer.sections.map((section) => ({ title: section.title, items: [...section.items] }))
  const userDefined = current.mutableLayer.userDefined.map((entry) => ({ ...entry }))
  const added: string[] = []
  let merged = 0

  // ① 同义整合：按模型建议并掉措辞不同、意思相同的条目。
  for (const consolidation of consolidations) {
    const title = consolidation.section.trim()
    const section = sections.find((item) => item.title === title)
    if (section === undefined) continue
    merged += applyConsolidations(section, [consolidation])
  }

  // ② 追加新条目（同义的算已存在，不再平行堆一份）。
  for (const update of updates) {
    const title = update.section.trim()
    let section = sections.find((item) => item.title === title)
    if (section === undefined) {
      // 文档里还没有这个小节：建一个空的再合并（校验层决定这个标题能不能存在）。
      section = { title, items: [] }
      sections.push(section)
    }
    for (const item of update.items) {
      const value = item.trim()
      // **同义也算已存在**（2026-09-26 修，P-056）：只比逐字相同的话，模型每次换个说法就多一条 ——
      // 真机上「对用户称呼」正是这样攒到 7 条、其中 5 条同义的。判据与整合器是同一个。
      if (value === '' || section.items.some((existing) => isNearDuplicateItem(existing, value))) continue
      section.items.push(value)
      added.push(`${title}：+ ${value}`)
    }
  }

  return { next: { ...current, mutableLayer: { sections, userDefined } }, added, merged }
}

/**
 * 可变层写回；被拒时转成提案。
 *
 * ### 两道闸（0.1.10 起第一道，0.1.11 扩第二道）
 *
 * 1. **护栏**（`context.personaGuardActive`）：预算已超（`truncated`）**或**接近上限
 *    （`used/budget ≥ 0.85`）⇒ `personaSections`（补充新条目）一律忽略，只认 `sectionConsolidations`。
 * 2. **写入前预演**（0.1.11）：护栏没触发时也不是照单全收 —— 把拟新增条目先合进候选文档、
 *    **重新拟合**一次；若这一批会让注入变成"已截断"（`truncated`）就整批丢弃、只保留整合。
 *
 * 为什么预演必须存在（真机教训，2026-10-09T03:20:47Z）：那轮读到 `1880/2065，预算内`，
 * 于是放行，**追加 3 条之后就超了** —— 只看"此刻超没超"永远晚一步，必须看"写完会不会超"。
 * 预演用的是**与真实注入同一套拟合**（宿主喂进来的 `personaFit`），不重算预算。
 * @returns `updated`（是否真的写入）、`proposals`（新增提案数）、`merged`（实际并掉的条数）、
 *   `additionsDropped`（被护栏或预演拦下的新增条数，供运行记录记账）。
 */
export async function writePersonaSections(
  deps: ClassifyDeps,
  context: ClassifyContext,
  output: AnalysisOutput,
  addProposal: ProposalFactory,
): Promise<{ updated: boolean; proposals: number; merged: number; additionsDropped: number }> {
  const persona = deps.persona()
  const empty = { updated: false, proposals: 0, merged: 0, additionsDropped: 0 }
  // 只有整合建议、没有新条目时也要走完（P-056：整合本身就是一次有效的整理）。
  if (persona === undefined) return empty
  // 逐层兜底：这份"模型输出"可能来自旧版合同或测试替身（缺新字段），缺了就是"没有整合建议"。
  const consolidations = output.sectionConsolidations ?? []
  const requested = output.personaSections ?? []
  if (consolidations.length === 0 && requested.length === 0) return empty
  const current = persona.read()
  if (isUntouchedIdentityCard(current.identityCard)) return empty // 未初始化：人格还不存在，不谈整理

  // ① 整合：**永远保留**（护栏只停"追加"，不停"合并" —— 合并是在腾地方）。
  const consolidated = mergePersonaSections(current, [], consolidations)
  let next = consolidated.next
  let added: string[] = []
  let additionsDropped = 0

  // ② 追加：先合进候选再看拟合结果（护栏触发时也要合一遍 —— 只是为了如实报出"拦了几条"）。
  if (requested.length > 0) {
    const candidate = mergePersonaSections(next, requested, [])
    const blocked = context.personaGuardActive === true || wouldTruncate(deps, candidate.next)
    if (blocked) {
      additionsDropped = candidate.added.length
    } else {
      next = candidate.next
      added = candidate.added
    }
  }

  const merged = consolidated.merged
  if (added.length === 0 && merged === 0) return { ...empty, additionsDropped }
  try {
    await persona.write(next, 'agent')
    return { updated: true, proposals: 0, merged, additionsDropped }
  } catch (error) {
    if (!(error instanceof PersonaWriteRejected)) throw error
    const created = addProposal(context, {
      kind: 'persona',
      title: `可变层整理被校验拒绝（${added.length} 项待确认）`,
      reason: error.issues.map((issue) => `${issue.code}: ${issue.message}`).join('；').slice(0, MAX_PROPOSAL_TEXT_CHARS),
      payload: { type: 'mutable', sections: requested, consolidations },
      diff: added.join('\n').slice(0, 4000),
    })
    return { updated: false, proposals: created ? 1 : 0, merged, additionsDropped }
  }
}

/**
 * **预演**：把"加了这批新条目"的候选文档拿去重新拟合，看注入会不会被截断。
 *
 * ⚠️ 这里的"会超"就是产品口径的 `truncated`（提示词末尾那句「已截断」、工作台那句"有几条没进去"
 * 用的都是它），因此它包含两种情形：**装不下**（有条目被弃）与**装下了但被裁**（单条超过
 * `VALUE_SOFT_LIMIT = 120` ⇒ 注入时尾巴被切掉）。后者一并拦下是有意的：人格卡最坏的结果是
 * "写进去了却不生效"，一条只进得去前半截的条目正属此类 —— 宁可这一轮不写、并如实记一笔
 * "拦下拟新增 N 条"（运行记录里看得见），也不要静默收下半条。
 * 若用户更希望"长条目照收、注入时裁"，把判据收窄成 `fit.dropped > 0` 即可（改这一处）。
 *
 * 只有一处口径算得对（{@link ClassifyDeps.personaFit}，宿主接线到 `personaPromptReport`）；
 * 接线缺席时（旧接线 / 测试替身）回退到同一函数 + `independentJudgment: true` ——
 * 该口径下固定段占用更大、预算更小，**偏保守**（只会少放一条，不会多放一条）。
 * @param deps - 写回依赖。
 * @param candidate - 已合并新条目的候选文档。
 * @returns 加进去之后注入会被截断时为 true。
 */
function wouldTruncate(deps: ClassifyDeps, candidate: PersonaDocument): boolean {
  const fit = deps.personaFit?.(candidate) ?? personaPromptReport(candidate, { independentJudgment: true })
  // 拟合读不出来（形状异常等）时**放行**：预演是"多一道闸"，不该变成"一个静默的写入禁令"。
  return fit !== undefined && fit.truncated
}
