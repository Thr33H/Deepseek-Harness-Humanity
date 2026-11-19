/**
 * 自进化工作台的**界面状态形状与解析**（纯函数，无 React、无 RPC）。
 *
 * 与 `memory-document.ts` 同一分层：解析规则（什么样的值才算一份可用的投影文档、
 * 缺字段怎么兜）单独可测。宿主投影是权威数据，这里只做**防御性读取**——
 * 浏览器侧拿到坏形状时降级成空态，绝不让一个字段把整页带崩。
 * @module deepseek-harness-humanity/client/evolution-document
 */
import type { EvolutionRequest } from './evolution-channel.js'
import { EMPTY_EVOLUTION_REQUEST } from './evolution-channel.js'
import { defaultEvolutionConfig, type EvolutionConfigView } from './evolution-config-doc.js'
import { numOf, proposalOf, runOf, strOf, type PendingCountsView, type ProposalView, type RunView, type StatusView } from './evolution-views.js'

// 视图形状在 evolution-views.ts 定义；这里原样转出口，消费方（页面组件）仍从本文件取类型。
export type { ProposalView, RunView, PendingCountsView, StatusView } from './evolution-views.js'

/** 自进化工作台的完整状态。 */
export interface EvolutionWorkbenchState {
  status: 'idle' | 'loading' | 'ready' | 'failed' | 'unavailable'
  writable: boolean
  error?: string
  /** 命名空间修订号（写命令时带回，乐观并发）。 */
  revision?: number
  /** 顶层 `humanity` 配置修订号（改调度/预算时用）。 */
  configRevision?: number
  runs: RunView[]
  proposals: ProposalView[]
  pendingCounts: PendingCountsView
  evolutionStatus: StatusView
  /** 顶层配置里 `modules.evolution` 的当前值（设置表单的数据源；宿主 schema 是真源）。 */
  config: EvolutionConfigView
  nextRunAt: number
  /** 时间基准：当前生效的时区（空串 = 宿主没提供）。 */
  timeZone: string
  /** 它是怎么来的：`auto` / `env` / `default`（空串 = 宿主没提供）。 */
  timeZoneSource: string
  /** 学到它的时刻（ISO 8601；空串 = 没学过）。 */
  timeZoneLearnedAt: string
  baselineAt: string
  dailyCalls: number
  /** 今日 token（输入/输出分开记）。 */
  dailyInputTokens: number
  dailyOutputTokens: number
  dailyCallCap: number
  notice: string
  request: EvolutionRequest
  /** 正在进行的操作标记（`''` = 空闲）。 */
  busy: string
}

/** 未接通道时的初值。 */
export function emptyEvolutionState(): EvolutionWorkbenchState {
  return {
    status: 'idle',
    writable: false,
    runs: [],
    proposals: [],
    pendingCounts: { memory: 0, persona: 0, route: 0, total: 0 },
    evolutionStatus: { enabled: true, storeReady: false, scanReady: false, modelReady: false },
    config: defaultEvolutionConfig(),
    nextRunAt: 0,
    timeZone: '',
    timeZoneSource: '',
    timeZoneLearnedAt: '',
    baselineAt: '',
    dailyCalls: 0,
    dailyInputTokens: 0,
    dailyOutputTokens: 0,
    dailyCallCap: 0,
    notice: '',
    request: EMPTY_EVOLUTION_REQUEST,
    busy: '',
  }
}

/**
 * 把命名空间里的原始值解析成界面状态的数据部分。
 *
 * 顶层不是对象就抛（控制器把整条通道判为不可用）；字段级坏值一律兜底——
 * "一个字段坏了"与"整份文档坏了"是两种故障，处置也不同。
 * @param value - `describe` 返回的命名空间值。
 */
export function asEvolutionDocument(value: unknown): Omit<EvolutionWorkbenchState, 'status' | 'writable' | 'error' | 'revision' | 'configRevision' | 'config' | 'busy'> {
  if (value === null || typeof value !== 'object') throw new Error('自进化命名空间的值不是对象')
  const record = value as Record<string, unknown>
  const counts = (record.pendingCounts ?? {}) as Record<string, unknown>
  const status = (record.status ?? {}) as Record<string, unknown>
  const request = (record.request ?? {}) as Record<string, unknown>

  return {
    runs: Array.isArray(record.runs) ? record.runs.map(runOf) : [],
    proposals: Array.isArray(record.proposals) ? record.proposals.map(proposalOf) : [],
    pendingCounts: {
      memory: numOf(counts.memory),
      persona: numOf(counts.persona),
      route: numOf(counts.route),
      total: numOf(counts.total),
    },
    evolutionStatus: {
      enabled: status.enabled !== false,
      storeReady: status.storeReady === true,
      scanReady: status.scanReady === true,
      modelReady: status.modelReady === true,
    },
    nextRunAt: numOf(record.nextRunAt),
    timeZone: strOf(record.timeZone),
    timeZoneSource: strOf(record.timeZoneSource),
    timeZoneLearnedAt: strOf(record.timeZoneLearnedAt),
    baselineAt: strOf(record.baselineAt),
    dailyCalls: numOf(record.dailyCalls),
    dailyInputTokens: numOf(record.dailyInputTokens),
    dailyOutputTokens: numOf(record.dailyOutputTokens),
    dailyCallCap: numOf(record.dailyCallCap),
    notice: strOf(record.notice),
    request: {
      op: strOf(request.op),
      id: strOf(request.id),
      mode: strOf(request.mode),
      rescanKind: strOf(request.rescanKind),
      rescanValue: strOf(request.rescanValue),
    },
  }
}
