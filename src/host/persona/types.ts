/**
 * 人格数据模型的**类型**（宿主与浏览器共用的唯一真源）。
 *
 * 与 `constants.ts` 的分工：这里只放形状（interface / 联合类型），不放值。
 * @module humanity/persona/types
 */
import type { ConfirmableIssueCode, PersonaIssueCode } from './constants.js'

/** 身份卡的一个字段。`custom` 区分默认三段式与用户自行添加的字段。 */
export interface IdentityField {
  key: string
  value: string
  custom: boolean
}

/** 固定层：自然语言身份卡。 */
export interface IdentityCard {
  fields: IdentityField[]
  /** 首次初始化时刻（ISO 8601）。空串 = 未初始化——P-002 要求用独立标记，不比对内容。 */
  initializedAt: string
  /** 封存时刻。空串 = 未封存。封存后 Agent 不可再写固定层。 */
  sealedAt: string
}

/** 可变层的一个标准小标题及其内容（自然语言短文本，每项一行）。 */
export interface MutableSection {
  title: string
  items: string[]
}

/** 兜底层「用户定义」的一项：键值对。 */
export interface UserDefinedEntry {
  key: string
  value: string
}

/** 可变层：意识与经验层。 */
export interface MutableLayer {
  sections: MutableSection[]
  /** 兜底层。能归类的项由 Agent 移入标准小标题，剩下的留在这里（P-018/P-019）。 */
  userDefined: UserDefinedEntry[]
}

/** 完整人格文档。 */
export interface PersonaDocument {
  schemaVersion: number
  identityCard: IdentityCard
  mutableLayer: MutableLayer
}

/** 谁在写。用户在工作台里的编辑是权威输入，Agent 的自动整理才受高风险约束。 */
export type WriteSource = 'user' | 'agent'

/** 问题的严重度：`rejected` 挡住写入，`warning` 只提示。 */
export type IssueSeverity = 'rejected' | 'warning'

/**
 * 结构化的校验结论。
 *
 * `code` 是机器可读的稳定标识（P-011：插件返回结构化原因，不输出生硬文案），
 * `path` 指向文档里的位置，`message` 是给工作台中性渲染用的一句话。
 */
export interface PersonaIssue {
  code: PersonaIssueCode
  path: string
  severity: IssueSeverity
  message: string
}

/** 校验结论。`ok === false` 表示必须拒绝这次写入。 */
export interface PersonaValidation {
  ok: boolean
  issues: PersonaIssue[]
}

/** 校验的额外上下文。 */
export interface ValidateOptions {
  /**
   * 已经过用户在**对话里**确认（走审批/提问 seam）的 rejected 问题代码。
   * 命中的问题会**降级为 warning**（仍然出现在结论里，Agent 才能如实汇报"按你的确认删除了"），
   * 不在 {@link CONFIRMABLE_ISSUES} 白名单里的代码一律忽略。
   */
  confirmed?: readonly ConfirmableIssueCode[]
}
