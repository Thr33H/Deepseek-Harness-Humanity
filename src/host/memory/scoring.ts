/**
 * 相关性评分：**纯函数**，输入一条记忆 + 查询记号 + 上下文，输出 0–1 的分。
 *
 * 为什么单独一个文件并且全是纯函数：评分是整套检索里最需要**能对着数字讲清楚**的部分
 * （"为什么这条排在前面"必须可复现）。纯函数没有存储、没有时间副作用，测试可以逐个信号钉死。
 *
 * 七个信号与权重（合计 1.0，因此总分天然落在 0–1）：
 *
 * | 信号 | 权重 | 依据 |
 * |---|---|---|
 * | 关键词命中 | 0.40 | 命中数 / 查询记号数；两句话在说同一件事的主要证据 |
 * | 标签命中 | 0.15 | 有任意一个标签命中即满分 —— 标签是人工/Agent 挑出来的强信号 |
 * | 作用域 | 0.15 | §4.2.1：会话 > 工作 > 长期；**没有工作区上下文时长期更该出场** |
 * | 重要度 | 0.10 | `importance / IMPORTANCE_MAX`（P-026 把重要度当稳定信号用） |
 * | 新鲜度 | 0.10 | 距最近一次使用/更新越近越高，线性衰减到 `DECAY_UNUSED_DAYS` 归零 |
 * | 使用频率 | 0.05 | P-031：只影响排序，**不因为高频就注入** |
 * | 置信度 | 0.05 | 用户明确说出的（=1）比 Agent 推断的（<1）略优先 |
 *
 * 权重刻意都为正、且不设"一票否决"：任何单一信号都不该单独决定注入。
 * @module humanity/memory/scoring
 */
import { DECAY_UNUSED_DAYS, IMPORTANCE_MAX, USE_COUNT_SATURATION } from './constants.js'
import { overlapCount, tokenize } from './tokenize.js'
import type { MemoryEntry } from './types.js'

/** 各信号的权重（合计 1.0）。 */
export const WEIGHTS = {
  keyword: 0.4,
  tag: 0.15,
  scope: 0.15,
  importance: 0.1,
  freshness: 0.1,
  usage: 0.05,
  confidence: 0.05,
} as const

/** 检索上下文（当前这次对话的位置）。 */
export interface SearchContext {
  /** 当前会话 id；空串 = 未知（此时会话记忆一律不参与）。 */
  sessionId: string
  /** 当前工作区 id；空串 = 未知。 */
  workspaceId: string
}

/** 评分的输入。 */
export interface ScoreInput {
  entry: MemoryEntry
  /** 查询记号（`tokenize(message)` 的结果，由调用方算一次复用）。 */
  queryTokens: ReadonlySet<string>
  context: SearchContext
  /** 当前时刻（ISO 8601）；显式传入，评分才是纯函数、测试才可复现。 */
  now: string
}

/**
 * 这条记忆与查询是否有**任何**关键词/标签交集。
 *
 * 为什么需要这道门（不是防御，是修一个真实缺陷）：总分里混着"相关性"（关键词/标签）与
 * "质量"（重要度/新鲜度/置信度/作用域），而质量的底噪就有 ≈0.21 分。于是**阈值在低端完全失去选择性** ——
 * 深召回把阈值降到 0.15 时，一条与当前话题毫无关系的记忆照样过线，被当成"相关记忆"注入。
 * 门的作用是把"不相关"从这个连续分数里彻底排除：没有任何交集 ⇒ 它不是这条消息的候选，
 * 质量再高也不算（质量只负责在**候选之间**排序）。
 * @param entry - 候选记忆。
 * @param queryTokens - 查询记号。
 * @returns 有交集时为 true。
 */
export function matchesQuery(entry: MemoryEntry, queryTokens: ReadonlySet<string>): boolean {
  if (queryTokens.size === 0) return false
  const body = tokenize(`${entry.content} ${entry.tags.join(' ')}`)
  return overlapCount(queryTokens, body) > 0
}

/** 各信号**加权后**的分量；求和即总分。 */
export type ScoreBreakdown = Readonly<Record<keyof typeof WEIGHTS, number>>

/** 关键词命中：命中数 / 查询记号数（查询为空则为 0）。 */
function keywordScore(input: ScoreInput): number {
  if (input.queryTokens.size === 0) return 0
  const body = tokenize(`${input.entry.content} ${input.entry.tags.join(' ')}`)
  return overlapCount(input.queryTokens, body) / input.queryTokens.size
}

/** 标签命中：任意一个关键词落在标签里就算满分（标签是强信号）。 */
function tagScore(input: ScoreInput): number {
  const tagTokens = tokenize(input.entry.tags.join(' '))
  return Math.min(1, overlapCount(input.queryTokens, tagTokens))
}

/**
 * 作用域信号（§4.2.1：会话 > 工作 > 长期）。
 *
 * 长期记忆在**没有工作区上下文**时给 0.5：那种场合下用户要的正是"稳定偏好"，
 * 而工作记忆连归属都对不上，给 0。
 */
function scopeScore(entry: MemoryEntry, context: SearchContext): number {
  if (entry.scope === 'session') return entry.ownerId === context.sessionId ? 1 : 0
  if (entry.scope === 'workspace') {
    return context.workspaceId !== '' && entry.ownerId === context.workspaceId ? 1 : 0
  }
  return context.workspaceId === '' ? 0.5 : 0.25
}

/** 新鲜度：距最近一次使用（没用过就看更新时间）线性衰减，到 `DECAY_UNUSED_DAYS` 归零。 */
function freshnessScore(entry: MemoryEntry, now: string): number {
  const stamp = entry.lastUsedAt === '' ? entry.updatedAt : entry.lastUsedAt
  const ageMs = Date.parse(now) - Date.parse(stamp)
  if (!Number.isFinite(ageMs)) return 0
  const ageDays = Math.max(0, ageMs) / 86_400_000
  return Math.max(0, 1 - ageDays / DECAY_UNUSED_DAYS)
}

/** 使用频率：到 `USE_COUNT_SATURATION` 次即满分（再多也不额外加权，P-031）。 */
function usageScore(entry: MemoryEntry): number {
  return Math.min(1, entry.useCount / USE_COUNT_SATURATION)
}

/**
 * 算出各信号的加权分量。
 * @param input - 评分输入。
 * @returns 七个分量（键与 {@link WEIGHTS} 一致），求和即总分。
 */
export function breakdownOf(input: ScoreInput): ScoreBreakdown {
  const { entry, context } = input
  return {
    keyword: WEIGHTS.keyword * keywordScore(input),
    tag: WEIGHTS.tag * tagScore(input),
    scope: WEIGHTS.scope * scopeScore(entry, context),
    importance: WEIGHTS.importance * (entry.importance / IMPORTANCE_MAX),
    freshness: WEIGHTS.freshness * freshnessScore(entry, input.now),
    usage: WEIGHTS.usage * usageScore(entry),
    confidence: WEIGHTS.confidence * entry.confidence,
  }
}

/**
 * 一条记忆的相关性得分（0–1）。
 * @param input - 评分输入。
 * @returns 总分。
 */
export function scoreEntry(input: ScoreInput): number {
  const parts = breakdownOf(input)
  let total = 0
  for (const value of Object.values(parts)) total += value
  return total
}
