/**
 * 扫描层：把「哪些会话、哪些事件该进这一轮整理」算出来（G-007 增量水位）。
 *
 * 数据来源只有一个：`ctx.sessionQuery`（官方统一查询服务，实时优先、返回脱存储克隆，
 * 不会把会话拉活——编译 `dsh-session-query/lib/types/index.d.ts:67,81,118`）。
 * 本文件不碰任何服务生命周期，只做纯计算 + 两次查询，因此可整层 fake 测试。
 *
 * 三条决策落点：
 * - **P-037 基线**：默认只扫「基线（首次运行时建立）之后创建」的会话；回扫是显式命令，
 *   按范围（7 天 / 工作区 / 单会话 / 全部）另行放行。
 * - **P-036 子会话排除**：`origin='subagent'`、`delegationDepth>0`、`parentSession` 非空——
 *   三个标记**任一命中即排除**（字段缺失按主会话处理：DSH 0.1.5-rc.2 的主会话本来就不带这些字段）。
 * - **预算裁剪**：会话数与单会话事件数都有上限；事件按 seq 升序取**最早**的一批，
 *   游标停在这批的末尾——剩下的下一轮接着消化，永不跳过（跳了就是永久丢）。
 * @module humanity/evolution/scan
 */
import type { CursorRecord, EventDocLike, SessionQueryLike, SessionRecordLike } from './types.js'

/** 手动回扫范围（P-037 工作台四档入口）。 */
export type RescanRange =
  | { kind: 'days'; days: number }
  | { kind: 'workspace'; cwd: string }
  | { kind: 'session'; sessionId: string }
  | { kind: 'all' }

/** 扫描预算（来自配置 `modules.evolution.budget`）。 */
export interface ScanBudget {
  maxSessionsPerRun: number
  maxEventsPerSession: number
}

/** 一个待消化的会话（事件已取回并按预算裁剪）。 */
export interface ScanTarget {
  sessionId: string
  /** 会话工作目录（工作记忆归属用；读不到为空串）。 */
  cwd: string
  /** 本次消化的事件（seq 升序）。 */
  events: EventDocLike[]
  /** 本轮起点（游标语义：消化成功后把游标推到 events 末尾 seq）。 */
  fromSeq: number
}

/** 一次采集的结果。 */
export interface ScanResult {
  targets: ScanTarget[]
  /** 命中过滤但被预算/子会话/空事件挡掉的会话数（投影里如实显示）。 */
  skippedSessions: number
  /** 建立的新基线（首轮返回当前时刻，其余返回空串表示不动）。 */
  newBaselineAt: string
}

/** 采集选项。 */
export interface ScanOptions {
  /** 当前基线；空串 = 尚未建立（本次建立并只扫"现在之后"，即首轮不扫任何东西，P-037）。 */
  baselineAt: string
  includeSubSessions: boolean
  budget: ScanBudget
  /** 回扫命令的范围；缺省 = 常规增量。 */
  rescan?: RescanRange
  /** 当前时刻（ISO）；注入以便测试。 */
  now: string
}

/** 游标读取窄面（state.ts 的子集，测试可只 fake 这一个方法）。 */
export interface CursorReader {
  getCursor(sessionId: string): CursorRecord | undefined
}

/** 会话是不是子代理/工作流派生（P-036 的三标记判定）。 */
function isSubSession(record: SessionRecordLike): boolean {
  const header = record.header
  if (header.origin === 'subagent') return true
  if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) return true
  return typeof header.parentSession === 'string' && header.parentSession !== ''
}

/** 按扫描模式拼会话过滤器（AND 语义；空数组 = 不过滤）。 */
function sessionFilters(options: ScanOptions): unknown[] {
  const { rescan, baselineAt, now } = options
  if (rescan === undefined) {
    // 常规增量：只要基线之后创建的会话。基线未建立时用 now（首轮什么都不扫）。
    const from = Date.parse(baselineAt === '' ? now : baselineAt)
    return Number.isFinite(from) ? [{ kind: 'created-at', from }] : []
  }
  if (rescan.kind === 'days') return [{ kind: 'created-at', from: Date.parse(now) - rescan.days * 86400000 }]
  if (rescan.kind === 'workspace') return [{ kind: 'cwd', values: [rescan.cwd] }]
  if (rescan.kind === 'session') return [{ kind: 'id', values: [rescan.sessionId] }]
  return []
}

/** 事件过滤器：只看当前表面（被压缩/替换掉的影子内容不重复消化）+ 游标之后的新事件。 */
function eventFilters(fromSeq: number): unknown[] {
  const filters: unknown[] = [{ kind: 'surface', values: ['current'] }]
  if (fromSeq > 0) filters.push({ kind: 'seq', from: fromSeq + 1 })
  return filters
}

/**
 * 采集本轮要消化的会话与事件。
 *
 * 逐会话读事件、读满预算即停：先全量读完再裁剪会在大会话库上白读一倍数据
 * （sessionQuery 的读取是真实 IO，G-001 高效低成本）。
 * @param query - `ctx.sessionQuery` 窄面。
 * @param cursors - 游标读取。
 * @param options - 基线/开关/预算/回扫范围。
 */
export async function collectScanTargets(
  query: SessionQueryLike,
  cursors: CursorReader,
  options: ScanOptions,
): Promise<ScanResult> {
  const records = await query.filterSessions(sessionFilters(options))
  let skipped = 0
  const targets: ScanTarget[] = []

  for (const record of records) {
    if (targets.length >= options.budget.maxSessionsPerRun) {
      skipped += 1
      continue
    }
    if (!options.includeSubSessions && isSubSession(record)) {
      skipped += 1
      continue
    }
    const sessionId = record.header.id
    // 回扫无视游标从头读；常规增量从上次水位继续（无游标 = 全新会话，从头）。
    const fromSeq = options.rescan === undefined ? (cursors.getCursor(sessionId)?.lastSeq ?? 0) : 0
    const events = await query.filterEvents(sessionId, eventFilters(fromSeq))
    if (events.length === 0) continue
    // 超预算的会话只消化最早一批（游标停在这批末尾，剩余下一轮接着来）——它是"部分消化"，
    // 不算被跳过，不进 skipped 计数。
    const capped = events.slice(0, options.budget.maxEventsPerSession)
    targets.push({ sessionId, cwd: record.header.cwd ?? '', events: capped, fromSeq })
  }

  return {
    targets,
    skippedSessions: skipped,
    newBaselineAt: options.baselineAt === '' && options.rescan === undefined ? options.now : '',
  }
}
