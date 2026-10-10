/**
 * 单个工具的共用助手：把模型给的**快照**整理成可落盘的形态。
 *
 * 两个工具都需要"把参数整理成完整文档"这一步，而这一步的语义（漏传 = 不动、显式 `[]` = 清空、
 * 核心字段永远存在）是**规则**而不是实现细节，单独放一处，避免两个工具各写一份。
 * @module humanity/persona/tool-helpers
 */
import { CORE_IDENTITY_KEYS, STANDARD_SECTION_TITLES } from './constants.js'
import type { IdentityField, MutableSection, PersonaDocument } from './types.js'

/**
 * 把工具参数里的身份卡字段整理成完整固定层。
 *
 * 两条规则：
 * - **核心三段式永远存在**（P-012），顺序固定在最前，未提供就是空串；
 * - 自定义字段保持参数里的顺序，重复键**保留首次出现**——与 `normalizePersona` 的去重语义一致。
 *   两处不一致就会出现"工具算出来的值和最终落盘的值不一样"。
 * @param raw - 模型给的字段列表。
 * @returns 归一化后的字段列表。
 */
export function mergeIdentityFields(raw: readonly { key: string; value: string }[]): IdentityField[] {
  const firstValue = new Map<string, string>()
  for (const field of raw) {
    const key = field.key.trim()
    if (key === '' || firstValue.has(key)) continue
    firstValue.set(key, field.value)
  }

  const core: IdentityField[] = CORE_IDENTITY_KEYS.map((key) => ({
    key,
    value: firstValue.get(key) ?? '',
    custom: false,
  }))

  const seen = new Set<string>(CORE_IDENTITY_KEYS)
  const custom: IdentityField[] = []
  for (const field of raw) {
    const key = field.key.trim()
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    custom.push({ key, value: field.value, custom: true })
  }

  return [...core, ...custom]
}

/**
 * 把模型给的快照整理成可落盘的完整可变层。
 *
 * **语义（2026-09-23 真机反馈缺陷 ⑤ 之后：刻意区分"漏传"与"传空"）**
 *
 * | 参数里 | 含义 | 结果 |
 * |---|---|---|
 * | 某节**完全没出现** | **不动这一节** | 原样保留它当前的条目（不丢内容，也不再拒绝整次更新） |
 * | 某节出现且 `items: []` | **显式清空这一节** | 会删内容 ⇒ 校验层报 `mutable.section-cleared`，走对话内确认 |
 * | 某节出现且有条目 | 用这份条目替换该节 | 常规写入 |
 *
 * 为什么把"漏传"改成"不动"：原先是"漏传有内容的节 ⇒ 整次更新被拒（section-dropped）"，
 * 与"传空数组 ⇒ 静默清空"并列时，两个差别极大的操作都很隐晦：模型很容易以为"漏传 = 清空"，
 * 或者被一次莫名其妙的拒绝卡住（真机反馈原话：两个操作差别极大但都隐晦）。现在各自有单一、
 * 可预期的含义：**不动就一个字都不用写，要删就必须显式写 `[]`**。
 *
 * 另外两条仍然保留：
 * 1. **标准小标题按 P-020 的固定顺序排列**（顺序是标准的一部分：工作台按它展示、Agent 按它归位）；
 * 2. **非标准小标题保持参数顺序、附在标准集合之后**（P-016 允许用户自由添加）；
 * 3. 同名小标题**不在这里去重**：重复标题是 P-010 的高风险项，该由校验器拒绝。
 * @param raw - 模型给出的快照。
 * @param current - 当前生效文档（"漏传 = 保留原值"要用它）。
 * @returns 补齐、排序后的完整可变层。
 */
export function completeSections(raw: readonly MutableSection[], current: PersonaDocument): MutableSection[] {
  const standard = new Set<string>(STANDARD_SECTION_TITLES)
  const currentByTitle = new Map(current.mutableLayer.sections.map((section) => [section.title, section]))

  const standardSections = STANDARD_SECTION_TITLES.flatMap((title) => {
    // 保留同名的全部条目（不在这里去重）：重复小标题是 P-010 的高风险项，
    // 该由校验器拒绝，而不是被这里的整理悄悄抹平。
    const given = raw.filter((section) => section.title === title)
    if (given.length > 0) return given.map((section) => ({ title, items: [...section.items] }))

    // 漏传 ⇒ **不动这一节**：有内容就原样带回；没有就给空壳把标准集合补齐。
    const existing = currentByTitle.get(title)
    return [{ title, items: existing === undefined ? [] : [...existing.items] }]
  })

  // 非标准小标题：参数里给的照给；**漏传但当前有内容的也原样带回**（同一句"漏传 = 不动"）。
  const nonStandardGiven = raw
    .filter((section) => !standard.has(section.title))
    .map((section) => ({ title: section.title, items: [...section.items] }))

  const givenTitles = new Set(nonStandardGiven.map((section) => section.title))
  const nonStandardKept = current.mutableLayer.sections
    .filter((section) => !standard.has(section.title) && !givenTitles.has(section.title))
    .map((section) => ({ title: section.title, items: [...section.items] }))

  return [...standardSections, ...nonStandardGiven, ...nonStandardKept]
}

/**
 * 参数里是否夹带了会写固定层的字段。
 *
 * 参数 schema 里没有这些字段，但工具边界**不该依赖"schema 里没写"**——schema 日后改了，
 * 这条 guard 仍然拦得住。
 * @param name - 被调用的工具名。
 * @param args - 模型给的原始参数。
 * @returns 夹带越权字段时为 true。
 */
export function carriesIdentityWrite(name: string, args: unknown): boolean {
  if (args === null || typeof args !== 'object') return false
  const keys = new Set(Object.keys(args as Record<string, unknown>))
  if (keys.has('identityCard') || keys.has('sealedAt') || keys.has('initializedAt')) return true
  // `fields` 是 init 的合法参数、update 的越权参数 —— 必须按工具名区分，不能只看字段名。
  return name === 'humanity_persona_update' && keys.has('fields')
}

/** 还没初始化就想整理可变层时给 Agent 的指引。 */
export const NOT_INITIALIZED_REASON =
  '人格固定层还没有初始化。请先在对话里了解用户，调用 humanity_persona_init 写入固定层，再来整理可变层。'

/** 固定层已封存时给 Agent 的指引。 */
export const SEALED_REASON =
  '人格底色已封存：Agent 不能修改固定层。如需变更，请用户在 Humanity 工作台修改。'
