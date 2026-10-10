/**
 * 记忆数据模型的**类型**（宿主与工作台共用的唯一真源）。
 *
 * 与 `constants.ts` 的分工：这里只放形状（interface），不放值。
 * @module humanity/memory/types
 */
import type { MemoryMode } from '../config.js'
import type { MemoryConfirmSource, MemoryOrigin, MemoryScope, MemoryStatus } from './constants.js'

/**
 * 一条记忆。
 *
 * 字段取舍的依据是 P-027：**只存摘要、事实、引用**。所以这里既有正文（摘要/事实），
 * 也有一组"引用"字段（会话/消息 id）与一整套排序信号（重要度、置信度、使用次数、时间），
 * 但**没有任何**原始会话转写字段 —— 原始内容永远留在 DSH 会话里，需要时回查。
 */
export interface MemoryEntry {
  /** 稳定标识（去重后同一个事实只有一条）。 */
  id: string
  /** 作用域（长期/工作/会话）。 */
  scope: MemoryScope
  /** 记忆正文：摘要或事实本身，不含原文。 */
  content: string
  /** 关键词标签，本地检索的主信号。 */
  tags: string[]
  /** 重要度 0–5。重要条目不参与衰减（P-026）。 */
  importance: number
  /** 置信度 0–1。自动写入 < 1；用户明确说出的为 1。 */
  confidence: number
  /** 敏感标记：只有用户明确说"记住"才允许为真（P-033），可在工作台查看与删除。 */
  sensitive: boolean
  /** 用户标记（钉住/置顶）：不衰减、不归档，优先级最高。 */
  pinned: boolean
  /** 写入来源。自动管线不得改写它（P-033）。 */
  origin: MemoryOrigin
  /** 来源会话 id（引用，不是原文）。 */
  sourceSessionId: string
  /** 来源消息 id（引用）；空串 = 只知道来自哪个会话。 */
  sourceMessageId: string
  /**
   * 作用域归属：`workspace` 存工作区 id、`session` 存会话 id、`long-term` 为空串。
   *
   * 为什么不复用 `sourceSessionId`：一条长期事实可以在多个会话里被反复确认，
   * "从哪来的"和"归谁管"是两件事，混用会让作用域开关失去意义。
   */
  ownerId: string
  /** 写入时刻（ISO 8601 UTC）。 */
  createdAt: string
  /** 最近一次内容变更时刻（ISO 8601 UTC）。 */
  updatedAt: string
  /** 最近一次被检索命中并使用的时刻（ISO 8601 UTC）；空串 = 从未用过。 */
  lastUsedAt: string
  /** 被使用次数。只影响排序，**不因为高频就注入**（P-031）。 */
  useCount: number
  /** 生命周期状态。 */
  status: MemoryStatus
  /** 归档时刻（ISO 8601 UTC）；空串 = 未归档。 */
  archivedAt: string
  /** 去重指纹：同作用域下内容相同即视为同一条（见 `buildDedupeKey`）。 */
  dedupeKey: string
  /**
   * 与哪些条目**可能矛盾**（对方的去重指纹）。空数组 = 没有检测到冲突。
   *
   * 只标记、不解决：判据是本地关键词启发式（见 `conflict.ts`），它没有资格自动决定
   * "用户到底喜欢还是不喜欢咖啡"。冲突由用户在工作台处理（M3 步骤 8）。
   */
  conflictWith: string[]
  /**
   * 是**哪一端**把这条待确认记录确认成生效的（T2 的"双端同源"审计依据）。
   * 从未经过待确认的条目为空串（{@link NOT_CONFIRMED}）。
   */
  confirmedVia: MemoryConfirmSource | ''
  /** 条目结构版本（G-004）。 */
  entryVersion: number
}

/**
 * 新建一条记忆所需的信息。
 *
 * 只有"写入方一定知道"的字段出现在这里；其余字段由 `MemoryEntrySchema` 的默认值补齐 ——
 * 默认值因此只有一处真源，不会出现"工厂一套、schema 一套"的分叉。
 */
export interface MemoryEntryInput {
  /** 作用域。 */
  scope: MemoryScope
  /** 正文（摘要或事实）。 */
  content: string
  /** 写入来源；必填，见 {@link MemoryEntry.origin}。 */
  origin: MemoryOrigin
  /** 来源会话 id。 */
  sourceSessionId: string
  /** 显式指定 id（迁移/导入用）；省略时自动生成。 */
  id?: string
  /**
   * 写入时刻（ISO 8601）；省略时取现在。
   *
   * 为什么允许显式传入：导入旧数据、迁移、以及需要"历史时刻"的场景（衰减核算的回归测试就是）
   * 都必须能落一个**真实发生过的时间**。省略时才是"现在"，而不是永远覆盖成现在 ——
   * 后者会让调用方以为传了时间，实际被悄悄改掉。
   */
  createdAt?: string
  /** 内容变更时刻（ISO 8601）；省略时取 {@link createdAt}。 */
  updatedAt?: string
  /** 标签。 */
  tags?: string[]
  /** 重要度；省略时取 `DEFAULT_IMPORTANCE`。 */
  importance?: number
  /** 置信度；省略时取 `DEFAULT_CONFIDENCE`。 */
  confidence?: number
  /** 敏感标记；省略时取 `false`（P-033）。 */
  sensitive?: boolean
  /** 用户标记；省略时取 `false`。 */
  pinned?: boolean
  /** 来源消息 id。 */
  sourceMessageId?: string
  /** 作用域归属 id。 */
  ownerId?: string
  /** 状态；省略时取 `NEW_ENTRY_STATUS`（待确认）。 */
  status?: MemoryStatus
}

/**
 * 生效记忆策略：预设模式 + 高级开关**解析之后**的结果。
 *
 * 为什么要有这一层而不是到处读开关：行为由"模式 × 若干开关"共同决定，
 * 若每个消费方各自拼一遍，同一份配置在不同代码路径里会算出不同行为。
 * 全部消费方只读这个解析结果，工作台展示的也是它（P-030：显示当前生效策略）。
 */
export interface MemoryPolicy {
  /** 当前预设模式。 */
  mode: MemoryMode
  /** 三层作用域各自是否启用（可独立开关）。 */
  scopes: Record<MemoryScope, boolean>
  /** 是否启用自动写入管线。 */
  autoWrite: boolean
  /** 是否自动注入（一键关闭的落点，P-028）。 */
  autoInject: boolean
  /** 自动注入条数上限，已被夹到 0–`MAX_INJECT_LIMIT`。 */
  injectLimit: number
  /** 自动注入 token 上限。 */
  injectTokenBudget: number
  /** 相关度阈值：低于它的记忆不返回（P-028）。默认见 `RELEVANCE_THRESHOLD`。 */
  relevanceThreshold: number
  /** 衰减归档（P-026）。 */
  decay: boolean
  /** "长期未用"的窗口（天）：窗口内完全不衰减。 */
  decayUnusedDays: number
  /** 重要度的半衰期（天）：窗口之后每过这么久减半。 */
  decayHalfLifeDays: number
  /** 向量检索（默认关，§4.2.5）。 */
  vector: boolean
  /**
   * 高频常驻。MVP **恒为 false**（P-031）：频率只影响排序，不因为高频就注入。
   * 留在策略里是为了让工作台如实显示"当前策略里它是关的"，而不是看不见。
   */
  pinFrequent: boolean
  /**
   * 自动写入敏感内容。**恒为 false**：P-033 规定敏感信息只有用户明确说"记住"才写，
   * 因此它不是一个开关，而是管线的硬约束。
   */
  autoWriteSensitive: boolean
}

/**
 * 高级开关（P-030）。全部可选：只覆盖用户真正动过的那几项，其余跟随预设。
 *
 * 这里刻意**没有** `pinFrequent` / `autoWriteSensitive`：那两项由决策钉死，
 * 开放成开关等于把决策变成"用户自己不小心打开的功能"。
 */
export interface MemoryPolicyOverrides {
  /** 三层作用域的独立开关。 */
  scopes?: Partial<Record<MemoryScope, boolean>>
  /** 是否启用自动写入。 */
  autoWrite?: boolean
  /** 是否自动注入。 */
  autoInject?: boolean
  /** 自动注入条数（超出上限会被夹住）。 */
  injectLimit?: number
  /** 自动注入 token 上限。 */
  injectTokenBudget?: number
  /** 相关度阈值（0–1；超出范围会被夹住）。 */
  relevanceThreshold?: number
  /** 衰减归档。 */
  decay?: boolean
  /** "长期未用"窗口（天）。 */
  decayUnusedDays?: number
  /** 重要度半衰期（天）。 */
  decayHalfLifeDays?: number
  /** 向量检索。 */
  vector?: boolean
}
