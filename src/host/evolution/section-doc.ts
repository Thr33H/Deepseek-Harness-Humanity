/**
 * 自进化工作台看到的**文档形状**：运行时间线、提案队列、徽标计数与命名空间 schema。
 *
 * 字段所有权与记忆命名空间同一条约定（见 `memory/section.ts` 文件头）：
 * `runs`/`proposals`/`pendingCounts`/`status`/`notice` 只有宿主写（投影），
 * `request` 只有客户端写（命令槽）。真源在 storageDomain，这里只是视图（G-008：
 * settings 易变层只承载工作台视图通道）。
 * @module humanity/evolution/section-doc
 */
import Schema from '@deepseek-ai/schemastery'

import { EvolutionRequestSchema, type EvolutionRequestView } from './section-request.js'

// 消费方（section-runtime 等）仍从本文件取类型：这里只做转出口，不改它们的 import。
export type { EvolutionRequestView }
import type { ProposalRecord, RunRecord } from './types.js'

/** 工作台看到的运行记录（时间线条目；梦境叙事与洞察一起带出去）。 */
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

/** 工作台看到的提案。 */
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

/** 待确认计数（P-042：徽标 + 顶部数量；memory 一栏由宿主投影时并入记忆侧的 pending）。 */
export interface PendingCountsView {
  memory: number
  persona: number
  route: number
  total: number
}

/** 模块可用性状态（工作台如实显示"哪个环节降级了、为什么"）。 */
export interface StatusView {
  /** 自进化开关（humanity.enabled && evolution.enabled）。 */
  enabled: boolean
  /** 存储是否就绪。 */
  storeReady: boolean
  /** 会话查询服务是否在场（缺席 = 不能扫描）。 */
  scanReady: boolean
  /** 模型路由是否可用（缺席 = 不能解析；未配置默认模型也是 false）。 */
  modelReady: boolean
}

/** 命名空间里的文档。 */
export interface EvolutionDocument {
  runs: RunView[]
  proposals: ProposalView[]
  pendingCounts: PendingCountsView
  status: StatusView
  /** 下一次定时触发的 epoch 毫秒；0 = 未排程。 */
  nextRunAt: number
  /**
   * 时间基准：当前生效的时区（`Intl` 的规范名，例如 `Asia/Shanghai`；空串 = 宿主没提供）。
   *
   * 为什么工作台必须显示它：时区一错，症状是"她下午才睡醒""用量早上八点才归零"这种
   * 没人会往时间上想的怪事（2026-11-19 实机现场）。显示出来，错了能一眼看到。
   */
  timeZone: string
  /** 它是怎么来的：`auto` 跟浏览器 / `env` 运维指定 / `default` 还没学到。 */
  timeZoneSource: string
  /** 学到它的时刻（ISO 8601；空串 = 没学过）。 */
  timeZoneLearnedAt: string
  /** 扫描基线（空串 = 尚未建立）。 */
  baselineAt: string
  /** 当日模型调用计数与上限（P-051 花费可见）。 */
  dailyCalls: number
  dailyCallCap: number
  notice: string
  request: EvolutionRequestView
}

/** 命名空间 schema：只声明形状（validate 钩子里做最小语义检查，见 section.ts）。 */
export const EvolutionDocSchema = Schema.object({
  runs: Schema.array(
    Schema.object({
      id: Schema.string().default(''),
      mode: Schema.string().default(''),
      trigger: Schema.string().default(''),
      status: Schema.string().default(''),
      startedAt: Schema.string().default(''),
      finishedAt: Schema.string().default(''),
      scannedSessions: Schema.number().default(0),
      parsedEvents: Schema.number().default(0),
      memoriesWritten: Schema.number().default(0),
      proposalsCreated: Schema.number().default(0),
      inputTokens: Schema.number().default(0),
      outputTokens: Schema.number().default(0),
      calls: Schema.number().default(0),
      narrative: Schema.string().default(''),
      insights: Schema.array(Schema.string()).default([]),
      error: Schema.string().default(''),
    }),
  ).default([]),
  proposals: Schema.array(
    Schema.object({
      id: Schema.string().default(''),
      kind: Schema.string().default(''),
      title: Schema.string().default(''),
      reason: Schema.string().default(''),
      diff: Schema.string().default(''),
      status: Schema.string().default(''),
      createdAt: Schema.string().default(''),
      decidedAt: Schema.string().default(''),
    }),
  ).default([]),
  pendingCounts: Schema.object({
    memory: Schema.number().default(0),
    persona: Schema.number().default(0),
    route: Schema.number().default(0),
    total: Schema.number().default(0),
  }),
  status: Schema.object({
    enabled: Schema.boolean().default(true),
    storeReady: Schema.boolean().default(false),
    scanReady: Schema.boolean().default(false),
    modelReady: Schema.boolean().default(false),
  }),
  nextRunAt: Schema.number().default(0),
  // 时间基准（0.1.19）：空串 = 宿主没提供或还没学到，客户端据此显示"还没学到"。
  timeZone: Schema.string().default(''),
  timeZoneSource: Schema.string().default(''),
  timeZoneLearnedAt: Schema.string().default(''),
  baselineAt: Schema.string().default(''),
  dailyCalls: Schema.number().default(0),
  /** 今日 token（输入/输出分开记；总览的"消耗"用它）。 */
  dailyInputTokens: Schema.number().default(0),
  dailyOutputTokens: Schema.number().default(0),
  dailyCallCap: Schema.number().default(0),
  notice: Schema.string().default(''),
  request: EvolutionRequestSchema,
})

/** 运行记录 → 视图。 */
export function runViewOf(record: RunRecord): RunView {
  return {
    id: record.id,
    mode: record.mode,
    trigger: record.trigger,
    status: record.status,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    scannedSessions: record.scannedSessions,
    parsedEvents: record.parsedEvents,
    memoriesWritten: record.memoriesWritten,
    proposalsCreated: record.proposalsCreated,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    calls: record.calls,
    narrative: record.narrative,
    insights: [...record.insights],
    error: record.error,
  }
}

/** 提案 → 视图（payload 不带出去：内容大且客户端审核只需要标题/理由/diff）。 */
export function proposalViewOf(record: ProposalRecord): ProposalView {
  return {
    id: record.id,
    kind: record.kind,
    title: record.title,
    reason: record.reason,
    diff: record.diff,
    status: record.status,
    createdAt: record.createdAt,
    decidedAt: record.decidedAt,
  }
}
