/**
 * 自进化的存储契约（zod schema）与工厂：**默认值的唯一真源**（与 `memory/model.ts` 同构）。
 *
 * 单一方向的数据流：`写入方` → `createRunRecord`/`createProposal`（补默认值 + id）→ schema 校验 → 存储。
 * 读回的旧记录同样过 schema：形状不对的**在边界上**被拒，而不是让坏数据渗进运行逻辑。
 *
 * 模型解析输出（{@link AnalysisOutputSchema}）也在这里：它是"模型说了什么"与"我们允许写什么"
 * 之间的合同 —— 逐字段校验、逐字段上限（G-003：不让一个坏字段毁掉整批，也不放行一个坏字段）。
 * @module humanity/evolution/model
 */
import { z } from 'zod'

import {
  MAX_PROPOSAL_TEXT_CHARS,
  PROPOSAL_KINDS,
  PROPOSAL_STATUSES,
  RUN_MODES,
  RUN_STATUSES,
  RUN_TRIGGERS,
  STATE_KEY,
} from './constants.js'
import type { ProposalRecord, RunRecord, StateRecord } from './types.js'

/** 运行记录契约。计数与用量都有默认值：早期字段缺失不该让整条记录报废。 */
export const RunRecordSchema = z.object({
  id: z.string().min(1),
  mode: z.enum(RUN_MODES),
  trigger: z.enum(RUN_TRIGGERS),
  status: z.enum(RUN_STATUSES),
  startedAt: z.string().min(1),
  finishedAt: z.string().default(''),
  scannedSessions: z.number().int().nonnegative().default(0),
  parsedEvents: z.number().int().nonnegative().default(0),
  memoriesWritten: z.number().int().nonnegative().default(0),
  proposalsCreated: z.number().int().nonnegative().default(0),
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  calls: z.number().int().nonnegative().default(0),
  narrative: z.string().default(''),
  insights: z.array(z.string()).default([]),
  error: z.string().default(''),
})

/** 提案契约。`payload` 是 JSON **字符串**：应用侧按 kind 再解析校验，存储层不猜结构。 */
export const ProposalRecordSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(PROPOSAL_KINDS),
  title: z.string().min(1).max(MAX_PROPOSAL_TEXT_CHARS),
  reason: z.string().max(MAX_PROPOSAL_TEXT_CHARS).default(''),
  payload: z.string().default('{}'),
  diff: z.string().default(''),
  status: z.enum(PROPOSAL_STATUSES).default('pending'),
  createdAt: z.string().min(1),
  decidedAt: z.string().default(''),
  sourceRunId: z.string().default(''),
  sourceSessionIds: z.array(z.string()).default([]),
})

/** 扫描游标契约。`failures` 带默认值：旧记录（M5 首版）没有该字段，读取端零迁移补齐。 */
export const CursorRecordSchema = z.object({
  sessionId: z.string().min(1),
  lastSeq: z.number().int().nonnegative().default(0),
  lastRunAt: z.string().default(''),
  failures: z.number().int().nonnegative().default(0),
})

/** 模块级单值状态契约。 */
export const StateRecordSchema = z.object({
  baselineAt: z.string().default(''),
  notifiedWatermark: z.string().default(''),
  nextRunAt: z.number().int().nonnegative().default(0),
  dailyDate: z.string().default(''),
  dailyCalls: z.number().int().nonnegative().default(0),
  dailyInputTokens: z.number().int().nonnegative().default(0),
  dailyOutputTokens: z.number().int().nonnegative().default(0),
})

/** 单值状态的出厂值。 */
export const STATE_INITIAL: StateRecord = StateRecordSchema.parse({})

/** 单值状态的固定键（导出以便测试断言表里只有这一行）。 */
export { STATE_KEY }

/**
 * 造一条 `running` 态的运行记录（终态字段由 run.ts 收尾时补齐）。
 * @param mode - 运行形态。
 * @param trigger - 触发来源。
 * @param at - 开始时刻（ISO）；缺省取当前时间。
 */
export function createRunRecord(mode: RunRecord['mode'], trigger: RunRecord['trigger'], at?: string): RunRecord {
  return RunRecordSchema.parse({
    id: globalThis.crypto.randomUUID(),
    mode,
    trigger,
    status: 'running',
    startedAt: at ?? new Date().toISOString(),
  })
}

/** 造一条提案所需的最小输入。 */
export interface ProposalInput {
  kind: ProposalRecord['kind']
  title: string
  reason?: string
  payload?: unknown
  diff?: string
  sourceRunId?: string
  sourceSessionIds?: string[]
  createdAt?: string
}

/**
 * 造一条 `pending` 态提案。payload 在这里序列化成字符串并做字节上限检查：
 * 超限抛错由调用方（classify）捕获转日志——一条失控的提案不该毁掉整轮运行。
 *
 * 字节长度用 `TextEncoder` 而不是 `Buffer`：本仓库不依赖 `@types/node`
 * （与 `memory/model.ts` 用 `globalThis.crypto` 同一理由），TextEncoder 是三平台都有的标准 API。
 * @param input - 提案内容。
 * @param maxPayloadBytes - payload 字节上限（来自 constants）。
 */
export function createProposal(input: ProposalInput, maxPayloadBytes: number): ProposalRecord {
  const payload = JSON.stringify(input.payload ?? {})
  if (new TextEncoder().encode(payload).length > maxPayloadBytes) {
    throw new Error(`提案 payload 超过 ${maxPayloadBytes} 字节上限（kind=${input.kind}）`)
  }
  return ProposalRecordSchema.parse({
    id: globalThis.crypto.randomUUID(),
    kind: input.kind,
    title: input.title,
    reason: input.reason ?? '',
    payload,
    diff: input.diff ?? '',
    status: 'pending',
    createdAt: input.createdAt ?? new Date().toISOString(),
    sourceRunId: input.sourceRunId ?? '',
    sourceSessionIds: input.sourceSessionIds ?? [],
  })
}

/** 解析输出里的记忆候选（写回走记忆管线，最终上限由 `remember()` 把关）。 */
const MemoryCandidateSchema = z.object({
  content: z.string().min(1).max(2000),
  scope: z.enum(['long-term', 'workspace']),
  tags: z.array(z.string().max(50)).max(10).default([]),
  sensitive: z.boolean().default(false),
})

/** 解析输出里的可变层小节更新（合并进完整快照后走人格校验，P-017）。 */
const PersonaSectionUpdateSchema = z.object({
  section: z.string().min(1).max(60),
  items: z.array(z.string().min(1).max(500)).max(50),
})

/**
 * 解析输出里的**同义条目整合**建议（P-056）。
 *
 * 为什么需要模型这一档：字符串相似度能并掉「台词不加括号，直接写 / 台词不加括号、直接写」，
 * 并不掉「称呼主人为『主人』/ 在该角色扮演设定中，以『主人』称呼用户」（Dice 只有 0.44）——
 * 那一档只有读懂意思才能判。`drop` 必须与该小节现有条目**逐字一致**才算数（对不上就忽略，不猜）。
 */
const PersonaConsolidationSchema = z.object({
  section: z.string().min(1).max(60),
  keep: z.string().min(1).max(500),
  drop: z.array(z.string().min(1).max(500)).min(1).max(20),
  reason: z.string().max(300).default(''),
})

/** 解析输出里的固定层提案（只提案不写入，P-038）。 */
const PersonaFixedProposalSchema = z.object({
  fieldKey: z.string().min(1).max(60),
  fieldValue: z.string().min(1).max(300),
  reason: z.string().min(1).max(300),
})

/** 解析输出里的技能提案（P-041 查重后决定形态）。 */
const SkillProposalSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(300),
  content: z.string().min(1).max(20000),
  reason: z.string().min(1).max(300),
})

/**
 * 一次解析调用的**输出合同**。
 *
 * 每个数组独立上限：模型输出失控时 schema 直接拒绝整个结果（重试一次后跳过该会话、游标不推进 ——
 * 宁可下次重看，不可把坏数据写进人格与记忆）。`narrative`/`insights` 只在梦境模式被消费。
 */
export const AnalysisOutputSchema = z.object({
  memories: z.array(MemoryCandidateSchema).max(20).default([]),
  personaSections: z.array(PersonaSectionUpdateSchema).max(9).default([]),
  sectionConsolidations: z.array(PersonaConsolidationSchema).max(10).default([]),
  personaFixed: z.array(PersonaFixedProposalSchema).max(5).default([]),
  skills: z.array(SkillProposalSchema).max(5).default([]),
  insights: z.array(z.string().min(1).max(500)).max(20).default([]),
  narrative: z.string().max(6000).default(''),
})

/** 解析输出的类型面。 */
export type AnalysisOutput = z.infer<typeof AnalysisOutputSchema>
