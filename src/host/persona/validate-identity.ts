/**
 * 固定层的判定：字段名、长度、核心字段、以及"对 Agent 封存"。
 *
 * 从 `validate.ts` 拆出来的原因：固定层与可变层的判定没有任何共同状态，
 * 分开放之后每一处都能一眼看完（函数 ≤40 行是硬要求，不是审美偏好）。
 * @module humanity/persona/validate-identity
 */
import { CORE_IDENTITY_KEYS, VALUE_SOFT_LIMIT } from './constants.js'
import { isUntouchedIdentityCard } from './predicates.js'
import type { IdentityField, PersonaDocument, PersonaIssue, WriteSource } from './types.js'

/**
 * 固定层的全部判定（编排）。
 * @param next - 规范化之后的候选文档。
 * @param prev - 当前生效文档；首次初始化时传 `undefined`。
 * @param source - 写入来源（只有 Agent 受封存约束）。
 * @param issues - 结论收集器。
 */
export function checkIdentity(
  next: PersonaDocument,
  prev: PersonaDocument | undefined,
  source: WriteSource,
  issues: PersonaIssue[],
): void {
  const fields = next.identityCard.fields
  checkFieldRows(fields, issues)
  checkKeyDuplicates(fields, issues)
  checkShadowsMutable(next, prev, issues)
  checkCoreFields(fields, issues)
  checkSealed(next, prev, source, issues)
}

/**
 * 反向查重：固定层字段名不得与可变层小标题 / 用户定义键撞名。
 *
 * 为什么需要反向（2026-09-25 真机反馈）：`core-key-shadowed` 只查「写可变层」方向，用户在固定层
 * 加一个「对用户称呼」字段能无任何提示地保存成功 —— 此后每次写可变层都会被 shadow 拒绝，
 * 而用户看不懂为什么。在撞名的源头拦，比在每次受害者侧拦便宜且可解释。
 * 祖父化：prev 里已同名的字段不查 —— 否则一份已经撞名的旧文档会拒掉之后**所有**保存，用户无从修复。
 */
function checkShadowsMutable(next: PersonaDocument, prev: PersonaDocument | undefined, issues: PersonaIssue[]): void {
  const shadowed = new Set<string>([
    ...next.mutableLayer.sections.map((section) => section.title),
    ...next.mutableLayer.userDefined.map((entry) => entry.key),
  ])
  shadowed.delete('') // 空名由 key-empty / user-defined-key-empty 专管，不参与撞名判定
  const preexisting = new Set((prev?.identityCard.fields ?? []).map((field) => field.key))
  for (const [index, field] of next.identityCard.fields.entries()) {
    if (field.key === '' || !shadowed.has(field.key) || preexisting.has(field.key)) continue
    issues.push({
      code: 'identity.shadows-mutable',
      path: `identityCard.fields[${index}].key`,
      severity: 'rejected',
      message: `字段名「${field.key}」与可变层的小标题或用户定义键撞名，请改其中一个名字。`,
    })
  }
}

/** 逐行检查：没有名字的字段不能保存，超长值只警告（P-015）。 */
function checkFieldRows(fields: readonly IdentityField[], issues: PersonaIssue[]): void {
  for (const [index, field] of fields.entries()) {
    if (field.key === '') {
      issues.push({
        code: 'identity.key-empty',
        path: `identityCard.fields[${index}].key`,
        severity: 'rejected',
        message: '身份卡存在没有名字的字段，无法保存。',
      })
    }
    if (field.value.length > VALUE_SOFT_LIMIT) {
      issues.push({
        code: 'identity.value-too-long',
        path: `identityCard.fields[${index}].value`,
        severity: 'warning',
        message: `字段值超过 ${VALUE_SOFT_LIMIT} 字，会明显增加注入成本，建议写短。`,
      })
    }
  }
}

/**
 * 字段名不能重复。
 *
 * 真机反馈缺陷 ①：规范化阶段**不再**按主键去重（那样会把第二个同名键无声吃掉），
 * 所以这条判定必须存在，否则重复键就会静默落盘。
 */
function checkKeyDuplicates(fields: readonly IdentityField[], issues: PersonaIssue[]): void {
  const seen = new Set<string>()
  for (const [index, field] of fields.entries()) {
    if (seen.has(field.key)) {
      issues.push({
        code: 'identity.key-duplicate',
        path: `identityCard.fields[${index}].key`,
        severity: 'rejected',
        message: `身份卡出现重复字段「${field.key}」，同一事实只能有一个当前值。`,
      })
    }
    seen.add(field.key)
  }
}

/**
 * P-012 的核心字段是固定层的最小集合；缺任何一个都意味着"用户明确设定的核心事实没了"（P-010 高风险）。
 *
 * ⚠️ **这条规则只对"不经规范化的调用方"生效**：`normalizePersona` 的 `ensureCoreFields` 会把缺的核心字段
 * 补成空值（旧数据 + 新 schema 的兼容点，2026-09-23 真机事故），所以正常路径下这里永远为真。
 * 保留它是因为校验器是**独立的一道门**：谁绕过规范化直接提交文档，就该被这道门拦下。
 */
function checkCoreFields(fields: readonly IdentityField[], issues: PersonaIssue[]): void {
  for (const key of CORE_IDENTITY_KEYS) {
    if (!fields.some((field) => field.key === key)) {
      issues.push({
        code: 'identity.core-missing',
        path: 'identityCard.fields',
        severity: 'rejected',
        message: `身份卡缺少核心字段「${key}」，不能通过删除来绕开它。`,
      })
    }
  }
}

/**
 * 封存：Agent 不能改固定层（P-013/P-023）。用户在工作台里改是允许的——只有用户能改。
 *
 * **唯一的例外是首次初始化**（P-003：Agent 引导 → 写入固定层 → 封存）。封存是"初始化完成
 * 之后"才成立的状态，所以判据必须是「当前固定层是否已经有人写过」，而不是「调用方有没有传 prev」：
 * `section.write()` 里的 prev 永远是当前生效文档（未初始化时那份默认文档也算一份），
 * 把"默认文档"读成"已封存"会让聊天初始化这条路径永远走不通。
 */
function checkSealed(
  next: PersonaDocument,
  prev: PersonaDocument | undefined,
  source: WriteSource,
  issues: PersonaIssue[],
): void {
  if (source !== 'agent' || prev === undefined) return
  if (sameJson(prev.identityCard, next.identityCard)) return
  if (isUntouchedIdentityCard(prev.identityCard)) return
  issues.push({
    code: 'identity.sealed',
    path: 'identityCard',
    severity: 'rejected',
    message: '人格底色已对 Agent 封存，Agent 不能修改；如需变更，请用户前往 Humanity 工作台。',
  })
}

/** 结构化深比较：对象键序无关，用于判断两段内容是否真的不同。 */
function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(sortKeys(left)) === JSON.stringify(sortKeys(right))
}

/** 递归按键名排序，让 `sameJson` 不受键序影响。 */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, inner]) => [key, sortKeys(inner)]),
  )
}
