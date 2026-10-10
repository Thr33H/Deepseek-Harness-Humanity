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
  skill: number
  route: number
  total: number
}

/**
 * 一条技能（M7；与宿主 `SkillView` 同形）。
 *
 * `status` 五态由宿主算好（目录与提案的差集 + 注册表核对），工作台只负责**如实显示** ——
 * 让用户一眼看出"这条技能是真的落在磁盘上、只活在运行时注册里，还是根本没生效"。
 */
export interface SkillView {
  name: string
  description: string
  content: string
  /** `on-disk` / `runtime-only` / `unregistered` / `file-only` / `diverged`（陌生值按 `file-only` 显示，不猜）。 */
  status: string
  /** 文件路径（回答"技能在哪"）；仅运行时注册 / 没生效时为空。 */
  file: string
  /** 来源提案标题（用户手写的技能为空）。 */
  origin: string
  decidedAt: string
  /** 是否被停用（官方 `disable-model-invocation`：模型不再自动调用，文件保留）。 */
  disabled: boolean
  /** 这条技能用到的插件（卸载对应插件后它无法正常工作，页面据此如实警告）。 */
  pluginDeps: string[]
}

/** 技能编辑表单（工作台 → 宿主；M7 的新建/修改共用这三个字段）。 */
export interface SkillDraftView {
  name: string
  description: string
  content: string
}

/** 模块可用性状态（哪个环节降级了、工作台如实显示）。 */
export interface StatusView {
  enabled: boolean
  storeReady: boolean
  scanReady: boolean
  modelReady: boolean
  skillsReady: boolean
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

/** 解析一条技能视图（M7）。 */
export function skillOf(value: unknown): SkillView {
  const record = (value ?? {}) as Record<string, unknown>
  return {
    name: strOf(record.name),
    description: strOf(record.description),
    content: strOf(record.content),
    status: strOf(record.status),
    file: strOf(record.file),
    origin: strOf(record.origin),
    decidedAt: strOf(record.decidedAt),
    disabled: record.disabled === true,
    pluginDeps: Array.isArray(record.pluginDeps) ? record.pluginDeps.filter((item) => typeof item === 'string') : [],
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
