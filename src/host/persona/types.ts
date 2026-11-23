/**
 * 人格数据模型的**类型**（宿主与浏览器共用的唯一真源）。
 *
 * 与 `constants.ts` 的分工：这里只放形状（interface / 联合类型），不放值。
 * @module humanity/persona/types
 */
import type { CharacterAxisKey, ConfirmableIssueCode, PersonaIssueCode } from './constants.js'

/** 底色的一个字段。`custom` 区分默认三段式与对方自行添加的字段。 */
export interface IdentityField {
  key: string
  value: string
  custom: boolean
}

/** 底色：自然语言底色。 */
export interface IdentityCard {
  fields: IdentityField[]
  /** 首次初始化时刻（ISO 8601）。空串 = 未初始化——P-002 要求用独立标记，不比对内容。 */
  initializedAt: string
  /** 封存时刻。空串 = 未封存。封存后 Agent 不可再写底色。 */
  sealedAt: string
}

/** 信息的一个标准小标题及其内容（自然语言短文本，每项一行）。 */
export interface MutableSection {
  title: string
  items: string[]
}

/** 兜底层「自定义」的一项：键值对。 */
export interface UserDefinedEntry {
  key: string
  value: string
}

/** 信息：意识与经验层。 */
export interface MutableLayer {
  sections: MutableSection[]
  /** 兜底层。能归类的项由 Agent 移入标准小标题，剩下的留在这里（P-018/P-019）。 */
  userDefined: UserDefinedEntry[]
}

/**
 * 性格的一根轴：**一个范围 + 此刻的值**（2026-11-20 新增）。
 *
 * 为什么不是单个数字：底色决定"她最多能变到哪儿"（`min`/`max` 是她天生画出来的笼子），
 * 经历只能在笼子里推 `value`。没有笼子，一根轴被反复往一个方向推，跑一年就会漂成另一个人；
 * 有笼子，就只会在"还是她"的范围内长大。
 *
 * 三者的分工与心理学里的层级对应：域（几乎不动）→ 笼子由域算出来；facet（几年尺度）→
 * 就是 `value` 能走的那条路；状态（分钟级）不落库，由情绪模块当轮现算。
 */
export interface CharacterAxis {
  /** 这根轴能推到的最低点（0–1）。 */
  min: number
  /** 这根轴能推到的最高点（0–1）。 */
  max: number
  /** 此刻的值，恒在 `[min, max]` 内。 */
  value: number
  /**
   * 为什么是这个范围 —— 初始化时她自己的话。
   *
   * 不是装饰字段：以后想知道"她为什么这么怕被说胖"，只能顺着它找回源头。
   * 空的理由等于一个没有来历的设定。
   */
  reason: string
}

/** 一根轴连同它的键（用数组存，避免把键名当对象属性名带来的转义问题）。 */
export interface CharacterAxisEntry extends CharacterAxis {
  key: CharacterAxisKey
}

/**
 * 性格层。
 *
 * `derivedAt` 为空串 = **还没有性格**（未初始化）。这时文档里没有任何轴，
 * 校验不能因此判它"缺轴" —— 与底色的 `initializedAt` 同一个口径。
 */
export interface CharacterLayer {
  /** 笼子的推导时刻（ISO 8601）。 */
  derivedAt: string
  axes: CharacterAxisEntry[]
}

/** 完整人格文档。 */
export interface PersonaDocument {
  schemaVersion: number
  identityCard: IdentityCard
  mutableLayer: MutableLayer
  character: CharacterLayer
}

/** 谁在写。对方在工作台里的编辑是权威输入，Agent 的自动整理才受高风险约束。 */
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
   * 已经过对方在**对话里**确认（走审批/提问 seam）的 rejected 问题代码。
   * 命中的问题会**降级为 warning**（仍然出现在结论里，Agent 才能如实汇报"按你的确认删除了"），
   * 不在 {@link CONFIRMABLE_ISSUES} 白名单里的代码一律忽略。
   */
  confirmed?: readonly ConfirmableIssueCode[]
}
