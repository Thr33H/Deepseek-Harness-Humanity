/**
 * 情绪的 schema 与出厂状态（宿主侧）。
 *
 * `cause` 为什么是字符串而不是枚举：本模块最贵的一课来自同类实现
 * （[bhava 的 ADR-004](https://github.com/MacCracken/bhava/blob/main/docs/adr/004-occ-appraisal-model.md) 自述）——
 * 直接把「被夸 +10 / 被批评 −10」写死，结果是**情绪与上下文脱节**：它知道自己不高兴，
 * 但不知道为什么。而"为什么"恰恰是模型能把情绪落到措辞上的唯一线索。
 * 所以每一条情绪都必须带着一句人话的原因进状态，原因缺失时宁可整条不出现。
 */
import { z } from 'zod'

import {
  EMOTION_KINDS,
  EMOTION_MAX,
  EMOTION_STATE_VERSION,
  EMOTION_TARGETS,
  ENERGY_INITIAL,
  ENERGY_MAX,
  MAX_CHARGES,
  MAX_SENSITIVITIES,
  WARMTH_BASELINE,
} from './constants.js'
import type { EmotionState } from './types.js'

/**
 * 单条情绪的存储契约。
 *
 * `cause` 与 `since` 有默认值：它们是**展示与渲染**用的，缺了只是少一句话，
 * 不该让整份状态读不出来（坏一条害死整库的教训见 `store-open.ts` 的 F3 说明）。
 */
export const EmotionChargeSchema = z.object({
  kind: z.enum(EMOTION_KINDS),
  // 旧条目没有这个字段：默认 `world`（对事）是最中性的读法，不需要任何迁移。
  target: z.enum(EMOTION_TARGETS).default('world'),
  intensity: z.number().min(0).max(EMOTION_MAX),
  cause: z.string().default(''),
  since: z.string().default(''),
  // 旧条目没有这个字段：读成空串 = "不知道最近一次被碰到是什么时候"，
  // 自调节于是不生效（按原来的半衰期算）—— 宁可少算，也不要拿一个猜的时刻去加速衰减。
  lastAt: z.string().default(''),
  // 适应用的两个计数：旧数据读成 0/空 = "这一段还没被推过"，行为与加它之前一致。
  recentGains: z.number().int().nonnegative().default(0),
  recentGainsAt: z.string().default(''),
})

/**
 * 一处被磨出来的敏感的存储契约。
 *
 * `level` 只允许 0–1：它是饱和累积，越界说明有别的写入路径（或手改过磁盘），
 * 那种状态不可信，宁可整份重置 —— 与强度越界同一条纪律。
 */
export const EmotionSensitivitySchema = z.object({
  kind: z.enum(EMOTION_KINDS),
  target: z.enum(EMOTION_TARGETS).default('world'),
  level: z.number().min(0).max(1),
  // 最后一次被磨的出处（用户 2026-11-22 要"能看出为什么敏感"）。
  // 旧条目没有这三项：读成空/0 = "没记过原因"，界面会如实说不知道。
  lastCause: z.string().default(''),
  lastDelta: z.number().default(0),
  lastLevelBefore: z.number().min(0).max(1).default(0),
  lastAt: z.string().default(''),
})

/**
 * 上一次评估给某一处带来的增减（工作台画箭头用）。
 *
 * 之前漏在 schema 外面，结果**写进去又被解析剥掉**：状态里明明有增减，投影出来全是 0，
 * 箭头一个都不显示（2026-11-22 真机现场）。凡是落盘的字段都必须在这里出现 ——
 * `z.object` 默认会把没声明的键剥掉。
 */
export const EmotionDeltaSchema = z.object({
  kind: z.enum(EMOTION_KINDS),
  target: z.enum(EMOTION_TARGETS).default('world'),
  delta: z.number(),
  // 上一次评估之前的值（画"从上次到现在净变化"用）。老状态没有它：null = 不知道起点，不画段。
  before: z.number().min(0).max(EMOTION_MAX).nullable().default(null),
})

/**
 * 整份情绪状态的存储契约。
 *
 * 刻意**不**把 `MAX_CHARGES` 写成 `.max()` 的硬约束：超过上限时的正确做法是
 * 保留最强的几条（`state.ts` 的 `apply` 负责裁剪），而不是让一整份状态解析失败。
 * 这里只限制到一个宽松的防御性上限，防止手改数据把表撑爆。
 */
export const EmotionStateSchema = z.object({
  version: z.number().int().positive().default(EMOTION_STATE_VERSION),
  charges: z.array(EmotionChargeSchema).max(MAX_CHARGES * 4).default([]),
  // 旧条目没有这个字段：读成空数组 = "没有哪一处被磨过"，与加这个字段之前的行为一致。
  // 所以它**不需要**升 `EMOTION_STATE_VERSION`（那不是"换模型"，只是多了一个带默认值的字段）。
  sensitivities: z.array(EmotionSensitivitySchema).max(MAX_SENSITIVITIES * 4).default([]),
  // 旧状态没有它：读成空数组 = "上一轮没动过任何一处"，箭头不画，行为与加它之前一致。
  lastDeltas: z.array(EmotionDeltaSchema).max(64).default([]),
  warmth: z.number().min(0).max(EMOTION_MAX).default(WARMTH_BASELINE),
  warmthCause: z.string().default(''),
  energy: z.number().min(0).max(ENERGY_MAX).default(ENERGY_INITIAL),
  settledAt: z.string().default(''),
  perceived: z.string().default(''),
  perceivedAt: z.string().default(''),
  // 旧条目没有这个字段：读成空数组 = 不豁免任何情绪，行为和加这个字段之前完全一致。
  lastTouched: z.array(z.string()).default([]),
  updatedAt: z.string().default(''),
})

/**
 * 出厂状态：平静、关系温度落在基线。
 *
 * `settledAt` 取**当前时刻**而不是空串：空串会让第一次结算算出"从 1970 年到现在"的巨大间隔，
 * 而那份状态其实这一刻才诞生。
 * @param now - 当前时刻（ISO 8601）。
 */
export function createInitialEmotionState(now: string): EmotionState {
  return EmotionStateSchema.parse({
    version: EMOTION_STATE_VERSION,
    charges: [],
    sensitivities: [],
    warmth: WARMTH_BASELINE,
    warmthCause: '',
    energy: ENERGY_INITIAL,
    settledAt: now,
    perceived: '',
    perceivedAt: '',
    updatedAt: now,
  })
}
