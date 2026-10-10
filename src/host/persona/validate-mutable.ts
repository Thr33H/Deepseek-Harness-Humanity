/**
 * 可变层的判定：小标题、条目、兜底层，以及"这次写入是否丢了用户已有的内容"。
 *
 * 编排与四组判定分开放：`checkMutable` 只负责顺序与来源短路，具体规则各是一个 ≤40 行的函数。
 * @module humanity/persona/validate-mutable
 */
import { CORE_IDENTITY_KEYS, LOCKED_SECTION_TITLES, VALUE_SOFT_LIMIT } from './constants.js'
import type { MutableSection, PersonaDocument, PersonaIssue, UserDefinedEntry, WriteSource } from './types.js'
import { checkContentLoss } from './validate-loss.js'

/**
 * 小标题级问题的 `path`：**用名字而不是下标**（真机反馈 R3）。
 *
 * 为什么：同一次写入里有的问题报 `sections[8]`、有的报 `sections.回归测试节`，Agent 拿到两条
 * 指向同一节、写法却不同的路径，既难读也难以对上（历史记录 `supersededBy` 一直用的是名字）。
 * 统一成 `mutableLayer.sections.<名字>`；标题为空时退回下标（那种节点确实没有名字可用）。
 */
export const sectionPath = (title: string, index: number): string =>
  title === '' ? `mutableLayer.sections[${index}]` : `mutableLayer.sections.${title}`

/** 固定层字段名集合。 */
const CORE_KEYS = new Set<string>(CORE_IDENTITY_KEYS)

/**
 * 可变层的全部判定（编排）。
 * @param next - 规范化之后的候选文档。
 * @param prev - 当前生效文档；首次初始化时传 `undefined`。
 * @param source - 写入来源（"丢内容"只对 Agent 生效）。
 * @param issues - 结论收集器。
 */
export function checkMutable(
  next: PersonaDocument,
  prev: PersonaDocument | undefined,
  source: WriteSource,
  issues: PersonaIssue[],
): void {
  checkSections(next.mutableLayer.sections, issues)
  checkUserDefined(next.mutableLayer.userDefined, issues)
  // 锁定项的判定对**所有来源**生效（它在用户的权威编辑之前）：默认 8 项不可整项删除是数据模型的
  // 约束，不是"Agent 不许"，不能因为写入方是工作台就放行 —— 那正是"绕过界面直接请求删除"的口子。
  checkLockedSections(next, prev, issues)
  // 用户在工作台里的编辑是权威输入：删自己写的东西不该被拦（P-010 的高风险清单只针对自动写入）。
  if (source !== 'agent') return
  checkContentLoss(next, prev, issues)
}

/**
 * 锁定小节（{@link LOCKED_SECTION_TITLES}）不得**整项删除**（用户 2026-10-09）。
 *
 * 与 `identity.core-missing` 是同一类保护的两个半边：固定层 4 项 + 可变层前 4 项 = 默认 8 项，
 * 删哪一个都意味着"用户明确设定的底色少了一角"，而工作台上看不出少了什么。
 *
 * **只拦"删除"，不拦编辑**：小节里的条目照常增删改（清空后小节仍在，节本身留着）——
 * P-010 的高风险是"内容没了"，不是"这一节空着"。因此这里查的是"标题在不在"，
 * 不是"条目空不空"（后者由 `checkContentLoss` 管，且只对 Agent 生效）。
 *
 * **祖父化**（`prev` 里本来就没有这一节时不拦）：旧数据 / 外部写入留下的缺节文档不该因此
 * 变成"一个字都存不进去"的死结 —— 没有的东西谈不上被删除，用户还有机会把它补回来。
 * `prev` 缺席（首次写入）时按"应当齐全"从严判：校验器是**独立的一道门**，
 * 谁绕过规范化直接提交文档，就该被这道门拦下（与 `checkCoreFields` 同一口径）。
 * @param next - 规范化之后的候选文档。
 * @param prev - 当前生效文档；首次初始化时传 `undefined`。
 * @param issues - 结论收集器。
 */
function checkLockedSections(
  next: PersonaDocument,
  prev: PersonaDocument | undefined,
  issues: PersonaIssue[],
): void {
  const titles = new Set(next.mutableLayer.sections.map((section) => section.title))
  for (const title of LOCKED_SECTION_TITLES) {
    const had = prev === undefined || prev.mutableLayer.sections.some((section) => section.title === title)
    if (!had || titles.has(title)) continue
    issues.push({
      code: 'mutable.section-locked-missing',
      path: `mutableLayer.sections.${title}`,
      severity: 'rejected',
      message:
        `「${title}」是默认锁定项（身份卡 4 项 + 人格卡 4 项，共 8 项不可删），不能整节删除。` +
        `若不想保留它的内容，请清空里面的条目 —— 节本身保留。`,
    })
  }
}

/** 小标题与条目：重复、冒牌固定层字段名、无名小节、非标准集合、超长条目。 */
function checkSections(sections: readonly MutableSection[], issues: PersonaIssue[]): void {
  const seen = new Set<string>()
  for (const [index, section] of sections.entries()) {
    checkTitle(section, index, seen, issues)
    checkItemLengths(section, index, issues)
  }
}

/**
 * 小标题本身的四条判定。
 *
 * 空标题单独占一条（2026-09-26 审计 P2）：它**永远不会进提示词** —— `collectPersonaContent`
 * 只收有名字的小节 —— 而旧行为给它的是「不在标准集合内」这句无关痛痒的警告，
 * 用户和 Agent 都看不出那节内容根本没生效。空壳（无名 + 无条目）不作声：没有内容可丢。
 */
function checkTitle(
  section: MutableSection,
  index: number,
  seen: Set<string>,
  issues: PersonaIssue[],
): void {
  const { title, items } = section
  if (title === '') {
    if (items.length > 0) {
      issues.push({
        code: 'mutable.section-title-empty',
        path: sectionPath(title, index),
        severity: 'rejected',
        message:
          `可变层有一节没有小标题（里面还有 ${items.length} 条内容），而**没有名字的小节不会进提示词**。` +
          `请给它取个名字（自定义标题即可），或把这些条目并入已有小节。`,
      })
    }
    return
  }

  if (seen.has(title)) {
    issues.push({
      code: 'mutable.section-duplicate',
      path: sectionPath(title, index),
      severity: 'rejected',
      message: `可变层出现重复小标题「${title}」，同一类内容只能有一个当前快照。`,
    })
  }
  seen.add(title)

  // 固定层字段名不得混进可变层（真机反馈缺陷 ②，硬拒绝而非警告）：固定层是"只有用户能改、
  // 对 Agent 封存"的那一层；允许可变层出现同名「姓名 / 性别 / 人格偏好」，就会出现一个
  // **看起来同样权威、却不受封存保护**的冒牌条目 —— 注入时两处都进提示词，模型看到两个
  // 互相矛盾的底色，用户也不知道该信哪个。调用方这么写，语义上一定搞错了层次。
  if (CORE_KEYS.has(title)) {
    issues.push({
      code: 'mutable.core-key-shadowed',
      path: sectionPath(title, index),
      severity: 'rejected',
      message: `「${title}」是固定层字段名，不能作为可变层小标题；固定层只能由用户在 Humanity 工作台修改。`,
    })
  }

  // 0.1.14：这里原本有一条 `mutable.section-non-standard`（"小标题不在标准集合内，Agent 下次整理时应归类"）。
  // 用户 2026-10-09 的产品决定把"标准/非标准"这个区分整个取消 —— 除原生 4 个之外**其余都一样待遇**，
  // 所以那条提示连同问题码一起删除（见 `constants.ts` 的 `PERSONA_ISSUE_CODES` 注释）。
  // ⚠️ 删的是**这一条提示**，不是小标题校验：空标题、重复标题、冒牌固定层字段名、超长条目
  // 仍由上面与下面的判定照旧拦下（`mutable.section-title-empty` 等一字未动）。
}

/** 单个小标题里的条目长度（P-015：只警告、不硬拒绝）。 */
function checkItemLengths(section: MutableSection, index: number, issues: PersonaIssue[]): void {
  for (const [itemIndex, item] of section.items.entries()) {
    if (item.length > VALUE_SOFT_LIMIT) {
      issues.push({
        code: 'mutable.item-too-long',
        path: `${sectionPath(section.title, index)}.items[${itemIndex}]`,
        severity: 'warning',
        message: `条目超过 ${VALUE_SOFT_LIMIT} 字，建议拆成多条短句。`,
      })
    }
  }
}

/**
 * 兜底层「用户定义」：键不能空、不能重复、不能冒充固定层字段名。
 *
 * 「用户定义」的键是**身份性**的：两条同名键意味着调用方给了矛盾输入，规范化阶段不再按主键去重
 * （那样会把第二个无声吃掉 —— 真机反馈缺陷 ① 里最危险的一类：数据丢了，界面还显示"保存成功"），
 * 所以这里必须报错，把决定权交回调用方。**对所有来源生效**：同名键不是"风险"，是自相矛盾的输入。
 */
function checkUserDefined(entries: readonly UserDefinedEntry[], issues: PersonaIssue[]): void {
  const seen = new Set<string>()

  for (const [index, entry] of entries.entries()) {
    // 键空、值非空：用户填了内容却漏了名字（真机反馈缺陷 ⑥）。**拒绝**而不是丢掉 ——
    // 静默丢弃会让"刚填的内容不见了"，而用户完全不知道自己做错了什么。
    if (entry.key === '') {
      issues.push({
        code: 'mutable.user-defined-key-empty',
        path: `mutableLayer.userDefined[${index}].key`,
        severity: 'rejected',
        message: `「用户定义」有一项只填了内容、没有名字（值：「${entry.value}」），请补上键名再保存。`,
      })
    }
    if (seen.has(entry.key)) {
      issues.push({
        code: 'mutable.user-defined-duplicate',
        path: `mutableLayer.userDefined[${index}].key`,
        severity: 'rejected',
        message: `「用户定义」出现重复键「${entry.key}」，同一事实只能有一个当前值（这次没有任何内容被写入）。`,
      })
    }
    seen.add(entry.key)

    if (CORE_KEYS.has(entry.key)) {
      issues.push({
        code: 'mutable.core-key-shadowed',
        path: `mutableLayer.userDefined[${index}].key`,
        severity: 'rejected',
        message: `「${entry.key}」是固定层字段名，不能作为「用户定义」的键；固定层只能由用户在 Humanity 工作台修改。`,
      })
    }
  }
}

// 「对用户称呼」**不再是高风险**（2026-09-23 真机反馈后的裁定：一个人可以有多个称呼）。
// 曾经这里有一条 `mutable.address-changed` 拒绝；它把用户指向一个当时还不存在的"工作台确认"入口，
// 而且 Agent 在对话里已经问清、用户也已经答过，仍会被拒 —— 那是死结，不是保护。
