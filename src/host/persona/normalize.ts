/**
 * 人格文档的**无损伤整理**（规范化）与"生效口径"。
 *
 * 两条边界（改动前先读）：
 * 1. `normalizePersona` 只做**不改变含义**的事（去空白、剥不可见字符、去重列表条目、
 *    丢掉整行空白），绝不删掉"有内容的节"，也绝不按主键去重身份性数据 —— 那两件事都会丢信息。
 * 2. `effectivePersona` 才是"落盘 / 读取 / 前后比对"用的口径（规范化 + 删掉空的自定义节）。
 *    它**不能**当作校验的输入：校验必须看到调用方到底传了什么，否则分不出"显式清空"与"漏传"。
 * @module humanity/persona/normalize
 */
import { stripControlChars } from '../text.js'
import { STANDARD_SECTION_TITLES } from './constants.js'
import { ensureCoreFields, renameLegacySections } from './migrations.js'
import type { IdentityCard, MutableLayer, MutableSection, PersonaDocument } from './types.js'

/**
 * 低风险规范化：去空白、剥控制字符、丢空项，并保持原有顺序。
 *
 * **为什么不做排序**：P-010 允许把排序算作低风险，但自然语言列表的顺序本身携带含义
 * （"先给结论，再给依据"倒过来就变了）。去空白与剥控制字符是无损的，排序不是，所以不做。
 *
 * **哪些地方不再"按主键去重"**（真机反馈缺陷 ①）：身份卡字段与「用户定义」的键是**身份性**的
 * —— 两条同名键意味着调用方给了矛盾输入，静默留第一条就是**静默丢数据**。这两处现在不去重，
 * 交给 `validatePersona` 报 `identity.key-duplicate` / `mutable.user-defined-duplicate`。
 * 小标题的**条目**仍然去重：列表内容里的重复是噪音，P-010 明确把"去重"列为低风险规范化。
 *
 * **哪些空行被丢、哪些必须留下**（真机反馈缺陷 ⑥，2026-09-23 追查"没写进去的「用户定义」"时发现）：
 * 只丢**键和值都空**的行（工作台上点「新增」还没填的那种），这是纯噪音；
 * **键空、值非空**的行必须**留下来交给校验器拒绝**（`identity.key-empty` /
 * `mutable.user-defined-key-empty`）—— 它是"用户填了内容却漏了名字"，直接丢掉就是又一次静默丢数据，
 * 而且用户完全看不出为什么刚填的内容消失了。原先这两个过滤器只判键，把这类行无声吃掉，
 * 顺带让 `identity.key-empty` 这条规则永远不可能触发（规范化在校验之前）。
 *
 * **空的非标准小标题不在这里删**（真机反馈 R1/R2/R4）：`items` 为空且标题不在标准集合内 ⇒ 这一节
 * 应当**消失**（否则就是删不掉的僵尸空壳），但删除由 `effectivePersona` 在**校验之后**做。
 *
 * > 规范化与校验必须分工，不能抢同一件事。上一版把"删除"塞进这里，校验拿到的 `next` 已经少了那一节
 * > ——"调用方显式传了 `items: []`（明确要删）"与"调用方漏传那一节（可能是误删）"在**数据上长得一模一样**，
 * > 于是每次显式删除都被报成 `mutable.section-dropped`（文案还劝人"要清空请传 items: []"），
 * > 传了也被拦 —— 删不掉、留空壳，两条路都走不通。
 * > 现在：**校验看的是调用方传了什么**（空节还在 ⇒ 能区分"显式清空"与"漏传"），
 * > 删除发生在校验通过之后的落盘步骤。
 * @param doc - 待整理的人格文档（不会被修改）。
 * @returns 整理后的新文档。
 */
export function normalizePersona(doc: PersonaDocument): PersonaDocument {
  const clean = (value: string): string => stripControlChars(value).trim()

  /** 整行都是空的（键值皆空）⇒ 只是没填，丢掉不算丢数据。 */
  const isBlankRow = (key: string, value: string): boolean => key === '' && value === ''

  const identityCard: IdentityCard = {
    ...doc.identityCard,
    // `ensureCoreFields`：旧数据缺核心字段时补齐（2026-09-23 真机事故的兼容点，见 migrations.ts）。
    fields: ensureCoreFields(
      doc.identityCard.fields
        .map((field) => ({ ...field, key: clean(field.key), value: clean(field.value) }))
        .filter((field) => !isBlankRow(field.key, field.value)),
    ),
  }

  const mutableLayer: MutableLayer = {
    sections: renameLegacySections(
      doc.mutableLayer.sections.map((section) => ({
        title: clean(section.title),
        items: dedupeBy(
          section.items.map((item) => clean(item)).filter((item) => item !== ''),
          (item) => item,
        ),
      })),
    ),
    userDefined: doc.mutableLayer.userDefined
      .map((entry) => ({ key: clean(entry.key), value: clean(entry.value) }))
      .filter((entry) => !isBlankRow(entry.key, entry.value)),
  }

  return { ...doc, identityCard, mutableLayer }
}

/**
 * 把"空的非标准小标题"整条删掉（真机反馈 Bug B / R1-R2：否则它会变成删不掉的僵尸空壳）。
 *
 * 规则：
 * - **非标准小标题 + `items: []` = 删除这一节**：自定义节是用户/Agent 自己加的，清空就没有内容可丢，
 *   剩下的只是一个名字；"显式传 `items: []`"是唯一能表达"删掉这个自定义节"的说法（不传 = 不动）。
 * - **标准小标题即使空着也保留**：它们是 P-020/P-022 的固定集合、也是 schema 的一部分，
 *   工作台按它展示、Agent 按它归位；"清空标准节"的含义是"这一节现在没有内容"，节本身留着。
 *
 * 私有：调用方一律用 { effectivePersona}（"规范化 + 删空壳"永远成对出现，别散开调用）。
 * @param doc - 已规范化的文档（不会被修改）。
 * @returns 删掉空壳节之后的新文档。
 */
function dropEmptyCustomSections(doc: PersonaDocument): PersonaDocument {
  const standard = new Set<string>(STANDARD_SECTION_TITLES)
  return {
    ...doc,
    mutableLayer: {
      ...doc.mutableLayer,
      sections: doc.mutableLayer.sections.filter(
        (section) => section.items.length > 0 || standard.has(section.title),
      ),
    },
  }
}

/**
 * **生效口径**：读取、落盘、以及"改之前 / 改之后"的比较都用它 —— 先规范化，再删掉空的非标准小标题。
 *
 * 为什么合成一个具名函数：这两步永远成对出现（`normalizePersona` 只做无损伤整理，删节留到校验之后），
 * 散成多处 `drop(normalize(x))` 会让"这里用的是哪个口径"变成记忆题，也迟早漏掉一处。
 * **不要**把它当作校验的 `next` —— 校验必须看到调用方传了什么，见 {@link normalizePersona}。
 * @param doc - 原始或已规范化的文档（不会被修改）。
 * @returns 生效形态的文档。
 */
export function effectivePersona(doc: PersonaDocument): PersonaDocument {
  return dropEmptyCustomSections(normalizePersona(doc))
}

/** 按主键去重，保留首次出现的项（后者会被丢弃）。 */
function dedupeBy<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>()
  const kept: T[] = []
  for (const item of items) {
    const key = keyOf(item)
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(item)
  }
  return kept
}
