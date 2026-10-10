/**
 * 自进化模块的类型：**存储记录**与**结构 seam**。
 *
 * seam 类型为什么全部结构化声明而不 import 官方包：与 `memory/identity.ts` 同一取舍——
 * `dsh-session-query` / `dsh-llm` / `dsh-skill` 都不是本插件依赖（G-002 零硬依赖），
 * 只用到窄窄几个方法，结构声明 + 运行时形状检查即可；官方包缺席时降级而不是编译失败。
 * 字段出处（2026-09-25 实读，两处版本核对一致）：
 * - `SessionRecord`/`SessionEventSearchDocument`：`dsh-session-query/lib/types/types.d.ts:14-21,43-54,208-211`；
 * - `SessionHeader`：`dsh-session/lib/types/types.d.ts:58-95`（`origin`/`delegationDepth`/`cwd`/`parentSession`）；
 * - `StreamChunk`/`TokenUsage`：`dsh-llm/lib/types/types.d.ts:359-390,136-148`；
 * - `SkillSummary`：`dsh-skill/lib/types/index.d.ts:268`（`list()` 返回值）。
 * @module humanity/evolution/types
 */
import type { RUN_MODES, RUN_STATUSES, RUN_TRIGGERS, PROPOSAL_KINDS, PROPOSAL_STATUSES } from './constants.js'

/** 运行形态。 */
export type RunMode = (typeof RUN_MODES)[number]
/** 触发来源。 */
export type RunTrigger = (typeof RUN_TRIGGERS)[number]
/** 运行状态。 */
export type RunStatus = (typeof RUN_STATUSES)[number]
/** 提案类别。 */
export type ProposalKind = (typeof PROPOSAL_KINDS)[number]
/** 提案状态。 */
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number]

/** 一次整理运行的记录（梦境叙事与洞察也在其中——梦境只是运行的一种形态，P-034）。 */
export interface RunRecord {
  id: string
  mode: RunMode
  trigger: RunTrigger
  status: RunStatus
  /** ISO 8601 UTC；未结束为空串。 */
  startedAt: string
  finishedAt: string
  scannedSessions: number
  parsedEvents: number
  memoriesWritten: number
  proposalsCreated: number
  /** 本轮模型调用的 token 用量累计（P-051 可见性：花了多少必须能看到）。 */
  inputTokens: number
  outputTokens: number
  calls: number
  /** 仅梦境：叙事正文（时间线展示）。 */
  narrative: string
  /** 仅梦境：洞察列表。 */
  insights: string[]
  /** failed/skipped 的原因（工作台如实显示，不静默）。 */
  error: string
}

/** 一条待用户确认的提案（P-038：固定人格/技能/路由只提案，不自动生效）。 */
export interface ProposalRecord {
  id: string
  kind: ProposalKind
  title: string
  reason: string
  /** 应用所需的完整内容，JSON 字符串（结构按 kind 在应用侧校验）。 */
  payload: string
  /** 展示用差异说明（人格=旧新对照；技能=与现有技能的关系）。 */
  diff: string
  status: ProposalStatus
  createdAt: string
  /** 用户做出决定的时刻；未决定为空串。 */
  decidedAt: string
  sourceRunId: string
  sourceSessionIds: string[]
}

/** 一个会话的扫描游标（G-007 增量水位：避免每次重扫全部会话）。 */
export interface CursorRecord {
  sessionId: string
  /** 已消化到的事件 seq（含）；下次扫描从 lastSeq+1 起。 */
  lastSeq: number
  /** 最近一次触碰该会话的运行时刻（ISO）。 */
  lastRunAt: string
  /**
   * 连续解析失败次数（熔断计数）：到上限后强制推进游标跳过该批，
   * 防"同一批内容永远消化不动 → 每次触发都重试烧钱"（P-051 不偷偷烧钱的另一面）。
   */
  failures: number
}

/** 模块级单值状态（key 固定 `main`）。 */
export interface StateRecord {
  /** 扫描基线：只处理这之后创建的会话（P-037 默认不回扫旧历史）。空串 = 尚未建立。 */
  baselineAt: string
  /** 已通知的待确认批次水位（pending id 集合的哈希——P-043 同一批只提醒一次）。 */
  notifiedWatermark: string
  /** 下一次定时运行的 epoch 毫秒；0 = 未排程。 */
  nextRunAt: number
  /** 当日用量统计的日期（YYYY-MM-DD，用户时区无关：按 UTC 计即可，预算是量级控制）。 */
  dailyDate: string
  dailyCalls: number
  dailyInputTokens: number
  dailyOutputTokens: number
}

/** 领域表窄视图（与 `memory/store.ts` 的 `MemoryTableHandle` 同形，泛型化；update 是官方原子读改写，编译 `dsh-storage-domain/lib/types/domain.d.ts:72-77`「concurrent updates never interleave」）。 */
export interface TableHandle<V> {
  get(key: string): V | undefined
  entries(): IterableIterator<[string, V]>
  put(key: string, value: V): Promise<void>
  delete(key: string): Promise<boolean>
  update(key: string, fn: (current: V) => V): Promise<V>
}

/** `ctx.sessionQuery` 的窄面（只用两个方法；缺席时整个扫描层降级）。 */
export interface SessionQueryLike {
  filterSessions(filters: readonly unknown[], signal?: AbortSignal): Promise<SessionRecordLike[]>
  filterEvents(sessionId: string, filters: readonly unknown[]): Promise<EventDocLike[]>
}

/** `SessionHeader` 的窄面（缺字段按最保守处理：疑似子会话就排除）。 */
export interface SessionHeaderLike {
  id: string
  createdAt: number
  cwd?: string
  parentSession?: string
  origin?: string
  delegationDepth?: number
}

/** `SessionRecord` 的窄面。 */
export interface SessionRecordLike {
  header: SessionHeaderLike
  live: boolean
  persisted: boolean
}

/** `SessionEventSearchDocument` 的窄面（语义事件文档：seq + 提取文本）。 */
export interface EventDocLike {
  sessionId: string
  seq: number
  type: string
  time: number
  text: string
}

/**
 * `ctx.llm.stream` 产出的块（结构读取：只消费 type 为 text-delta/usage/finish 的字段，
 * 其余块型一律忽略。单一接口而非字面量联合——`{type: string}` 兜底成员会让 TS 的
 * 判别收窄失效，而对"外来数据"来说可选字段 + 运行时判断本来就是更诚实的形状）。
 */
export interface StreamChunkLike {
  type: string
  text?: string
  usage?: TokenUsageLike
  reason?: string
}

/** `TokenUsage` 的窄面。 */
export interface TokenUsageLike {
  inputTokens: number
  outputTokens: number
}

/** `ctx.llm` 的窄面（stream + 路由核验用 listProviders；`LlmProviderInfo` = `{id, name}`，编译 `dsh-llm/lib/types/types.d.ts:180-185`——**路由键在 `id` 不在 `provider`**，2026-09-25 TEST 真机抓住的字段名错误）。 */
export interface LlmLike {
  stream(options: unknown): AsyncIterable<StreamChunkLike>
  listProviders(): Array<{ id: string; name?: string }>
}

/** `ctx.agentDefaultModel` 的窄面。 */
export interface DefaultModelLike {
  currentSelection(): { provider: string; model: string; reasoningEffort?: string }
}

/** `ctx.skills` 的窄面（查重用 list/get；注册在 `skills.ts` 的桥里，不在解析路径上）。 */
export interface SkillsLike {
  list(options?: unknown): Promise<Array<{ name: string; description?: string }>>
  /** 读完整技能正文（含 content）；用于"已有但过时"的 diff。可选：缺席时更新提案不带正文对比。 */
  get?(name: string, options?: unknown): Promise<{ content?: string } | undefined>
}

/** 一次模型调用的路由（provider + model）。 */
export interface ModelRoute {
  provider: string
  model: string
}

/** 一次模型调用的结果（正文 + 用量 + 结束原因）。 */
export interface StreamTextResult {
  text: string
  inputTokens: number
  outputTokens: number
  finishReason: string
}
