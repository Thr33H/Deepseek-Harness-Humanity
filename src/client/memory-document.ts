/**
 * 记忆工作台的**界面状态形状与解析**（纯函数，无 React、无 RPC）。
 *
 * 为什么单独一层：控制器要同时处理"远程通道"和"状态形状"，把形状与解析拆出来后，
 * 解析规则（什么样的值才算一份可用的记忆文档、缺字段怎么兜）可以被单独测，
 * 也不用把 React 拉进测试。
 * @module deepseek-harness-humanity/client/memory-document
 */

/** 一条记忆的界面视图（与宿主 `section-doc.ts` 的 `MemoryEntryView` 同形）。 */
export interface MemoryEntryView {
  fingerprint: string
  scope: string
  /** 归属区域（长期记忆为空串）：界面用它显示"这条属于哪个区域"并列出可选区域。 */
  ownerId: string
  status: string
  content: string
  tags: string[]
  importance: number
  sensitive: boolean
  pinned: boolean
  conflictCount: number
  updatedAt: string
}

/** 生效策略的界面视图（工作台显示的就是宿主算好的那一份，不在这里重算）。 */
export interface MemoryPolicyView {
  mode: string
  scopes: Record<string, boolean>
  autoInject: boolean
  autoWrite: boolean
  injectLimit: number
  relevanceThreshold: number
  decay: boolean
  vector: boolean
  /** 高级开关是否被单独调过（true ⇒ 界面把模式显示成「自定义」）。 */
  customized: boolean
}

/** 高级开关的界面视图（与宿主 `MemoryAdvancedConfig` 同形）。 */
export interface MemoryAdvancedView {
  longTerm: boolean
  work: boolean
  session: boolean
  maxInject: number
  decay: boolean
}

/** 记忆工作台的完整状态。 */
export interface MemoryWorkbenchState {
  status: 'idle' | 'loading' | 'ready' | 'failed' | 'unavailable'
  writable: boolean
  error?: string
  /** 读取时的修订号；写命令时必须带回去（乐观并发控制）。 */
  revision?: number
  /** 顶层 `humanity` 配置的修订号（改模式时用）。 */
  configRevision?: number
  entries: MemoryEntryView[]
  policy: MemoryPolicyView
  /** 配置里的高级开关（界面渲染那一组开关用；写回走顶层配置）。 */
  advanced: MemoryAdvancedView
  /** 上一次操作的结论（宿主投影回来的一句话）。 */
  notice: string
  /** 宿主探测到本组合会丢弃插件注入（极简模式）。 */
  degraded: boolean
  /** 本地搜索词（纯客户端过滤）。 */
  query: string
  /** **条目操作**标记（确认/归档/整理…）；条目卡按钮据此禁用，避免连点。 */
  busy: string
  /**
   * **配置写入**标记（模式 / 高级开关）。
   *
   * 与 {@link busy} 分开是硬要求：共用一个标记时，拨任一开关都会让整页 29 条记忆的按钮与
   * 作用域下拉一起变灰再变亮 —— 那就是用户 2026-09-26 看到的"闪一下"。
   */
  configBusy: string
}

/** 未接通道时的初值：列表空、不可写、一切显示为"未知"。 */
export function emptyMemoryState(): MemoryWorkbenchState {
  return {
    status: 'idle',
    writable: false,
    entries: [],
    policy: {
      mode: 'balanced',
      scopes: { 'long-term': true, workspace: true, session: true },
      autoInject: true,
      autoWrite: true,
      injectLimit: 3,
      relevanceThreshold: 0.35,
      decay: true,
      vector: false,
      customized: false,
    },
    advanced: { longTerm: true, work: true, session: true, maxInject: 3, decay: true },
    notice: '',
    degraded: false,
    query: '',
    busy: '',
    configBusy: '',
  }
}

/** 高级开关：逐字段取值 + 兜底（缺字段说明宿主还是旧版本，界面照样能显示）。 */
function advancedOf(raw: unknown): MemoryAdvancedView {
  const fallback = emptyMemoryState().advanced
  if (raw === null || typeof raw !== 'object') return fallback
  const source = raw as Record<string, unknown>
  return {
    longTerm: pick(source, 'longTerm', fallback.longTerm),
    work: pick(source, 'work', fallback.work),
    session: pick(source, 'session', fallback.session),
    maxInject: pick(source, 'maxInject', fallback.maxInject),
    decay: pick(source, 'decay', fallback.decay),
  }
}

/** 读一个字段，类型不符就用兜底值（远端数据是"别人给的东西"，不假设它守规矩）。 */
function pick<T>(source: Record<string, unknown>, key: string, fallback: T): T {
  const value = source[key]
  return typeof value === typeof fallback ? (value as T) : fallback
}

/** 一条条目：逐字段取值 + 兜底。`fingerprint` 为空说明这条数据不可用，直接过滤掉。 */
function entryOf(raw: unknown): MemoryEntryView | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const source = raw as Record<string, unknown>
  const fingerprint = pick(source, 'fingerprint', '')
  if (fingerprint === '') return undefined
  const tags = Array.isArray(source.tags) ? source.tags.filter((tag) => typeof tag === 'string') : []
  return {
    fingerprint,
    scope: pick(source, 'scope', 'long-term'),
    ownerId: pick(source, 'ownerId', ''),
    status: pick(source, 'status', 'active'),
    content: pick(source, 'content', ''),
    tags: tags as string[],
    importance: pick(source, 'importance', 0),
    sensitive: pick(source, 'sensitive', false),
    pinned: pick(source, 'pinned', false),
    conflictCount: pick(source, 'conflictCount', 0),
    updatedAt: pick(source, 'updatedAt', ''),
  }
}

/**
 * 把宿主给的一段值解析成记忆文档。
 *
 * 只要求"是个对象"：缺字段一律兜底 —— 工作台读的是**投影**，旧版本的投影少几个字段不该让
 * 整个页面变成错误页。
 * @param value - 命名空间里的一段值。
 * @returns 条目、策略与结论。
 * @throws 当值根本不是对象时（那说明命名空间坏了，界面该如实报错而不是显示空列表）。
 */
export function asMemoryDocument(value: unknown): {
  entries: MemoryEntryView[]
  policy: MemoryPolicyView
  advanced: MemoryAdvancedView
  notice: string
  degraded: boolean
} {
  if (value === null || typeof value !== 'object') {
    throw new Error('记忆命名空间的值不是对象')
  }
  const source = value as Record<string, unknown>
  const fallback = emptyMemoryState().policy
  const rawPolicy = (source.policy ?? {}) as Record<string, unknown>
  const rawScopes = (rawPolicy.scopes ?? {}) as Record<string, unknown>

  const entries = Array.isArray(source.entries)
    ? source.entries.map(entryOf).filter((entry): entry is MemoryEntryView => entry !== undefined)
    : []

  return {
    entries,
    policy: {
      mode: pick(rawPolicy, 'mode', fallback.mode),
      scopes: { ...fallback.scopes, ...(rawScopes as Record<string, boolean>) },
      autoInject: pick(rawPolicy, 'autoInject', fallback.autoInject),
      autoWrite: pick(rawPolicy, 'autoWrite', fallback.autoWrite),
      injectLimit: pick(rawPolicy, 'injectLimit', fallback.injectLimit),
      relevanceThreshold: pick(rawPolicy, 'relevanceThreshold', fallback.relevanceThreshold),
      decay: pick(rawPolicy, 'decay', fallback.decay),
      vector: pick(rawPolicy, 'vector', fallback.vector),
      customized: pick(rawPolicy, 'customized', fallback.customized),
    },
    advanced: advancedOf(source.advanced),
    notice: pick(source, 'notice', ''),
    degraded: pick(source, 'degraded', false),
  }
}
