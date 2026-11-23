/**
 * 记忆工作台的**视图数据**：投影文档的形状、空值，以及"把宿主给的值收窄成文档"。
 *
 * 与宿主 `memory/section-doc.ts` 的字段一一对应。这里重复一份类型而不是 import 宿主模块：
 * 那会把整棵宿主树打进浏览器 bundle（与 `memory-channel.ts` 同一条纪律）。
 *
 * 收窄函数**逐字段兜底**：宿主返回的形状我们没权力假设完整，渲染期读到 `undefined` 会把
 * 整个页面带崩（人格那边吃过这个亏）。
 * @module deepseek-harness-humanity/client/memory-document
 */
/** 工作台上的一条记忆。 */
export interface MemoryEntryView {
  id: string
  what: string
  when: string
  about: string
  certain: string
  feltKind: string
  /** 情绪种类的人话（宿主给；空串 = 当时没有记录）。 */
  feltLabel: string
  feltIntensity: number
  strength: number
  recalled: number
  cost: number
  costWhy: string
  tier: string
  /** 由几件事合成（0 = 一件具体的事）。 */
  covers: number
  createdAt: string
}

/** 面板统计。 */
export interface MemoryStatsView {
  total: number
  episode: number
  period: number
  chapter: number
  recalled: number
}

/** 上一次被她想起来的其中一条。 */
export interface RecalledItemView {
  /** 正文；`withheld` 为真时是空串。 */
  what: string
  /** 相关度档位：`high` / `mid` / `low`。 */
  match: string
  /** 她想起了这件事，但不想说。 */
  withheld: boolean
}

/** 上一次回忆：因为哪句话、想起了哪几条。 */
export interface RecallView {
  at: string
  cue: string
  items: RecalledItemView[]
}

/** 宿主投影过来的整份文档。 */
export interface MemoryDocument {
  entries: MemoryEntryView[]
  stats: MemoryStatsView
  projectedAt: string
  storeReady: boolean
  /** 休眠中：人格还没封存，humanity 还没正式启动（界面要说"还没开始"）。 */
  dormant: boolean
  /** 客户端写的命令（宿主消费后清空）。 */
  request: { op: string; id: string }
  /** 上一次动作的结论（宿主写、只出现一次）。 */
  notice: string
  /** 上一次回忆（"她为什么想起这条"）。 */
  lastRecall: RecallView
}

/** 工作台状态。 */
export interface MemoryWorkbenchState {
  status: 'idle' | 'loading' | 'ready' | 'unavailable' | 'failed'
  doc: MemoryDocument
  error?: string
}

/** 空文档（通道还没接上、或宿主还没投影过）。 */
export function emptyMemoryDocument(): MemoryDocument {
  return {
    entries: [],
    stats: { total: 0, episode: 0, period: 0, chapter: 0, recalled: 0 },
    projectedAt: '',
    storeReady: false,
    dormant: false,
    request: { op: '', id: '' },
    notice: '',
    lastRecall: { at: '', cue: '', items: [] },
  }
}

/** 读一个字符串字段，读不出来用兜底值。 */
const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback)

/** 读一个数字字段，读不出来用兜底值。 */
const num = (value: unknown, fallback = 0): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)

/** 把一条记录收窄。 */
function entryOf(raw: unknown): MemoryEntryView {
  const item = (raw ?? {}) as Record<string, unknown>
  return {
    id: str(item.id),
    what: str(item.what),
    when: str(item.when),
    about: str(item.about, 'world'),
    certain: str(item.certain, 'inferred'),
    feltKind: str(item.feltKind),
    feltLabel: str(item.feltLabel),
    feltIntensity: num(item.feltIntensity),
    strength: num(item.strength),
    recalled: num(item.recalled),
    cost: num(item.cost),
    costWhy: str(item.costWhy),
    tier: str(item.tier, 'episode'),
    covers: num(item.covers),
    createdAt: str(item.createdAt),
  }
}

/** 把宿主给的一条回忆条目收窄。 */
function recalledItemOf(raw: unknown): RecalledItemView {
  const item = (raw ?? {}) as Record<string, unknown>
  return { what: str(item.what), match: str(item.match), withheld: item.withheld === true }
}

/** 把宿主给的"上一次回忆"收窄；缺字段一律退化成空（渲染期不许读到 undefined）。 */
function recallOf(raw: unknown): RecallView {
  const value = (raw ?? {}) as Record<string, unknown>
  return {
    at: str(value.at),
    cue: str(value.cue),
    items: Array.isArray(value.items) ? value.items.map(recalledItemOf) : [],
  }
}

/**
 * 把宿主给的值收窄成一份完整的文档。
 *
 * 任何一层缺失都退化成空值，绝不让渲染期拿到 `undefined`。
 * @param value - 命名空间里的值。
 * @returns 文档。
 */
export function asMemoryDocument(value: unknown): MemoryDocument {
  if (value === null || typeof value !== 'object') return emptyMemoryDocument()
  const raw = value as Record<string, unknown>
  const stats = (raw.stats ?? {}) as Record<string, unknown>
  const entries = Array.isArray(raw.entries) ? raw.entries.map(entryOf) : []
  return {
    entries,
    stats: {
      total: num(stats.total, entries.length),
      episode: num(stats.episode),
      period: num(stats.period),
      chapter: num(stats.chapter),
      recalled: num(stats.recalled),
    },
    projectedAt: str(raw.projectedAt),
    storeReady: raw.storeReady === true,
    dormant: raw.dormant === true,
    request: { op: str((raw.request as Record<string, unknown>)?.op), id: str((raw.request as Record<string, unknown>)?.id) },
    notice: str(raw.notice),
    lastRecall: recallOf(raw.lastRecall),
  }
}
