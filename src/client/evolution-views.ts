/**
 * 自进化投影的**视图形状与逐条解析**（从 `evolution-document.ts` 拆出：那边管整份文档，
 * 这边管单条运行/提案的字段兜底）。坏字段一律兜底——"一个字段坏了"不该毁整页。
 * @module deepseek-harness-humanity/client/evolution-views
 */

/** 运行时间线条目（与宿主 `RunView` 同形）。 */
export interface RunView {
  id: string
  mode: string
  trigger: string
  status: string
  startedAt: string
  finishedAt: string
  scannedSessions: number
  parsedEvents: number
  memoriesWritten: number
  proposalsCreated: number
  inputTokens: number
  outputTokens: number
  calls: number
  narrative: string
  insights: string[]
  error: string
}

/** 提案条目（与宿主 `ProposalView` 同形）。 */
export interface ProposalView {
  id: string
  kind: string
  title: string
  reason: string
  diff: string
  status: string
  createdAt: string
  decidedAt: string
}

/** 待确认计数（徽标与顶部数量）。 */
export interface PendingCountsView {
  memory: number
  persona: number
  route: number
  total: number
}

/** 模块可用性状态（哪个环节降级了、工作台如实显示）。 */
export interface StatusView {
  enabled: boolean
  storeReady: boolean
  scanReady: boolean
  modelReady: boolean
}

/** 数值兜底读取（坏字段当 0，不 NaN 进界面）。 */
export function numOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** 字符串兜底读取。 */
export function strOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 字符串数组兜底读取。 */
function strArrayOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/** 解析一条运行记录视图。 */
export function runOf(value: unknown): RunView {
  const record = (value ?? {}) as Record<string, unknown>
  return {
    id: strOf(record.id),
    mode: strOf(record.mode),
    trigger: strOf(record.trigger),
    status: strOf(record.status),
    startedAt: strOf(record.startedAt),
    finishedAt: strOf(record.finishedAt),
    scannedSessions: numOf(record.scannedSessions),
    parsedEvents: numOf(record.parsedEvents),
    memoriesWritten: numOf(record.memoriesWritten),
    proposalsCreated: numOf(record.proposalsCreated),
    inputTokens: numOf(record.inputTokens),
    outputTokens: numOf(record.outputTokens),
    calls: numOf(record.calls),
    narrative: strOf(record.narrative),
    insights: strArrayOf(record.insights),
    error: strOf(record.error),
  }
}

/** 解析一条提案视图。 */
export function proposalOf(value: unknown): ProposalView {
  const record = (value ?? {}) as Record<string, unknown>
  return {
    id: strOf(record.id),
    kind: strOf(record.kind),
    title: strOf(record.title),
    reason: strOf(record.reason),
    diff: strOf(record.diff),
    status: strOf(record.status),
    createdAt: strOf(record.createdAt),
    decidedAt: strOf(record.decidedAt),
  }
}

/**
 * 时刻的**短显示**：`MM-DD HH:mm`（与总览「最近行为」同一口径，都是记录里的 ISO 时刻）。
 *
 * 为什么要有它：`2026-09-26T08:30:43.152Z` 是开发者串，铺在列表里既长又难扫。
 * 完整 ISO 不丢 —— 调用方把它放进 `title`，要精确到毫秒时悬停就能看到。
 * @param iso - 记录里的 ISO 时刻。
 * @returns 短时刻；空串原样返回（没记录就别编一个时间）。
 */
export function shortStamp(iso: string): string {
  return iso.length < 16 ? iso : iso.slice(5, 16).replace('T', ' ')
}
