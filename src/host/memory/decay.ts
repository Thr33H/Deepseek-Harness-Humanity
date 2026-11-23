/**
 * 遗忘的形状（**纯函数**，不碰存储）。
 *
 * ### 为什么是幂律，不是指数
 *
 * 「每 30 天减半」是到点跳崖：前 29 天一点没忘、第 30 天突然掉一半。真实的遗忘没有这个断点 ——
 * 刚发生的事掉得最快，之后越来越慢，而且**不会归零**（只是需要更清楚的线索才想得起来）。
 *
 * 实证支持的是幂函数（Anderson & Schooler 1991, *Reflections of the environment in memory*,
 * Psychological Science 2(6), 396–408：记忆的"需要概率"同时依赖近期性与频率，拟合出来是幂律）。
 *
 * ### 为什么读的时候算、不写回
 *
 * 结算会被读很多次（工作台轮询、每次注入）。如果每次读都改写强度，就变成"谁读得勤谁先忘"。
 * 所以这里只**算**，不落盘 —— 结果只取决于时间。
 * @module humanity/memory/decay
 */
import {
  DETAIL_LIFETIME_DAYS,
  DORMANT_BELOW,
  FADED_BELOW,
  MOOD_TONE,
  NEGATIVE_FADE_FACTOR,
  STRENGTH_DECAY,
  STRENGTH_T0_DAYS,
} from './constants.js'
import type { MemoryRecord } from './types.js'

/** 一天有多少毫秒。 */
const DAY_MS = 24 * 60 * 60 * 1000

/** 把 ISO 时刻读成毫秒；读不出来返回 `undefined`（脏数据不该让整条记忆炸掉）。 */
function timeOf(iso: string): number | undefined {
  if (iso === '') return undefined
  const at = Date.parse(iso)
  return Number.isFinite(at) ? at : undefined
}

/**
 * 一条记忆此刻还剩多牢。
 *
 * 基准是"上一次被想起"（没有就取写入时刻）那一刻的强度，之后按幂律衰减。
 * 负性情绪的记忆衰减更快 —— 同一件事，几年后提起来不疼了，但还是会笑。
 * @param record - 这条记忆。
 * @param now - 现在。
 * @returns 0–1 的强度。
 */
export function strengthAt(record: MemoryRecord, now: Date): number {
  const base = timeOf(record.recalledAt) ?? timeOf(record.createdAt)
  if (base === undefined) return record.strength
  const days = Math.max(0, (now.getTime() - base) / DAY_MS)
  // 幂律：(1 + t/T0)^(−d)。t=0 时是 1（不衰减），t 增大后趋缓但不停。
  // 负性情绪用更陡的指数 —— "疼劲先没"比"乘一个系数"更接近它该有的形状。
  const exponent =
    MOOD_TONE[record.felt.kind] === -1 ? STRENGTH_DECAY * NEGATIVE_FADE_FACTOR : STRENGTH_DECAY
  const factor = Math.pow(1 + days / STRENGTH_T0_DAYS, -exponent)
  return Math.min(1, Math.max(0, record.strength * factor))
}

/**
 * 细节是否该掉了。
 *
 * 只影响 `detail`，**不影响 `what`** —— 事还在，细节没了。
 * @param record - 这条记忆。
 * @param now - 现在。
 * @returns 该丢细节则 `true`。
 */
export function detailExpired(record: MemoryRecord, now: Date): boolean {
  if (record.detail === '') return false
  const at = timeOf(record.createdAt)
  if (at === undefined) return false
  return (now.getTime() - at) / DAY_MS >= DETAIL_LIFETIME_DAYS
}

/**
 * 这条记忆是不是已经淡到"平时想不起来"了。
 *
 * 淡了不等于删除：它仍然可以被特定的线索唤醒（提到那个话题、那个地方）。
 * @param strength - 当前强度。
 */
export const isDormant = (strength: number): boolean => strength < DORMANT_BELOW

/**
 * 这条记忆是不是已经淡到"连想起来都难"。
 *
 * 仍然不物理删除 —— 除了用户明确要求。
 * @param strength - 当前强度。
 */
export const isFaded = (strength: number): boolean => strength < FADED_BELOW
