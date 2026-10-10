/**
 * **旧数据适配**：让"以前的文档"在新数据模型下自动变合法。
 *
 * 为什么单独一个文件：这类代码的读者只有两种 —— "我加了个字段/改了标题，旧数据怎么办" 与
 * "这段为什么在这儿"。它跟常规规范化（去空白、去重）混在一起时会被混为一谈，
 * 而两者的纪律完全不同：**迁移是允许改内容的**（补字段、改标题），规范化**不许**（只做无损整理）。
 *
 * 三条硬要求（每一处迁移都必须满足）：
 * 1. **幂等** —— 跑第二遍结果不变（每次读取都会经过规范化，不幂等就会每轮抖一次）；
 * 2. **放在任何校验之前** —— 设置命名空间的 `validate` 钩子**注册时也会跑一次**
 *    （`register` → `resolve` → `validate`），旧数据形状问题若留到那里拒，
 *    会让整个命名空间注册失败（2026-09-23 真机事故：面板直接连不上）；
 * 3. **不丢内容** —— 合并/补齐只能加，不能把用户已有的东西抹掉；拿不准的留给校验器拒绝。
 * @module humanity/persona/migrations
 */
import { CORE_IDENTITY_KEYS } from './constants.js'
import type { IdentityField, MutableSection } from './types.js'

/**
 * 旧小标题 → 现名（一次性迁移表；以后改标题时在这里加一行即可，幂等）。
 *
 * 「当前状态」→「情绪」（用户 2026-09-23）：语义从"临时上下文"变成"用户此刻的心情"。
 */
export const LEGACY_SECTION_TITLES: ReadonlyMap<string, string> = new Map([['当前状态', '情绪']])

/**
 * 保证身份卡里**每个核心字段都存在**，缺的按默认值补上（`value: ''`、`custom: false`）。
 *
 * ### 为什么必须有它（2026-09-23 真机事故）
 *
 * 往 `CORE_IDENTITY_KEYS` 里加字段（如「主语言」）会立刻让**已有数据**在 schema 下"缺核心字段"：
 * schemastery 的 `Schema.array` 是**整体替换**语义，不会替旧数组补第 4 个元素。
 * 而设置命名空间的 `validate` 钩子**注册时就会跑一次**，于是 `identity.core-missing` 一抛，
 * **整个命名空间注册失败** —— 客户端永远连不上工作台，表现是"插件把人格面板弄坏了"，
 * 而用户什么都没做。所以补齐必须发生在**任何校验之前**，并且属于规范化的一部分
 * （读、写、工作台保存、Agent 工具、注册钩子全都经过它）。
 * 补出来的字段与"用户从没填过"完全同形，不引入"已初始化"之类的副作用。
 *
 * 三条不变量：
 * 1. **幂等**：已有该键就不再补（第二次规范化结果不变）；
 * 2. **顺序稳定**：核心字段按 `CORE_IDENTITY_KEYS` 顺序排在最前，其余字段保持原顺序跟在后面
 *    （与 `tools.ts` 的 `mergeIdentityFields` 同一口径，工作台与提示词的展示顺序因此一致）；
 * 3. **不吞重复**：同一核心键出现两次时只把第一次放进核心区，多出来的那次留在后面 ——
 *    它必须继续被 `identity.key-duplicate` 拒绝，不能被这里静默吃掉。
 * @param fields - 已清理过、已丢掉空白行的字段列表。
 * @returns 核心字段齐全的列表。
 */
export function ensureCoreFields(fields: readonly IdentityField[]): IdentityField[] {
  const coreKeys = new Set<string>(CORE_IDENTITY_KEYS)
  const takenCore = new Set<string>()
  /** 非核心字段 + 重复出现的核心字段（后者要留着让校验器报重复）。 */
  const extras: IdentityField[] = []

  for (const field of fields) {
    if (coreKeys.has(field.key) && !takenCore.has(field.key)) {
      takenCore.add(field.key)
      continue
    }
    extras.push(field)
  }

  const core: IdentityField[] = CORE_IDENTITY_KEYS.map(
    (key) => fields.find((field) => field.key === key) ?? { key, value: '', custom: false },
  )
  return [...core, ...extras]
}

/**
 * 把旧标题就地改名，并处理"新旧同时存在"的情况。
 *
 * 为什么不是简单改名：老数据里可能同时有「当前状态」和「情绪」（例如用户手工加过后一个）。
 * 直接改名会得到两个同名小标题 ⇒ 校验判 `mutable.section-duplicate` ⇒ 用户每次保存都被拒，
 * 而他什么都没做错。所以这里把旧节的条目**并入**新节（同名条目由常规去重规则合一），
 * 内容不丢、结果合法。
 * @param sections - 已清理过标题与小节的列表。
 * @returns 迁移后的列表（顺序保持，旧节位置让给它改成的那个新节）。
 */
export function renameLegacySections(sections: readonly MutableSection[]): MutableSection[] {
  const renamed: MutableSection[] = sections.map((section) => ({
    title: LEGACY_SECTION_TITLES.get(section.title) ?? section.title,
    items: [...section.items],
  }))

  const merged: MutableSection[] = []
  for (const section of renamed) {
    const existing = merged.find((candidate) => candidate.title === section.title)
    if (existing === undefined) {
      merged.push(section)
      continue
    }
    // 新旧同名（迁移撞车）：条目并到一起，去重交给常规规则。
    existing.items = dedupeItems([...existing.items, ...section.items])
  }
  return merged
}

/** 按文本去重、保留首次出现（迁移合并时用；与 `normalize.ts` 的条目去重同一口径）。 */
function dedupeItems(items: readonly string[]): string[] {
  const seen = new Set<string>()
  const kept: string[] = []
  for (const item of items) {
    if (seen.has(item)) continue
    seen.add(item)
    kept.push(item)
  }
  return kept
}
