/**
 * 性格的**被动漂移**：四根轴的位置怎么被经历推着走。
 *
 * ### 它是什么、不是什么
 *
 * - **不是**她能在会话里调的开关，也没有工具可调 —— 性格要是能随时调，等于随时给自己换人设，
 *   与"底色封存"直接冲突（用户 2026-11-23 明确不要自调节入口）。
 * - **是**一轮对话结束后、系统按已经发生的事折算出来的**极小一步**。她自己察觉不到 ——
 *   人也察觉不到自己的性格正在变。
 * - 状态只有**一份**（写在人格文档的 `character` 层里，不按会话分），与情绪"全局一份"同一原则。
 *
 * ### 推动规则（用户 2026-11-23 定，双向）
 *
 * | 轴 | 升 | 降 |
 * |---|---|---|
 * | 情绪稳定性 | 关系温度明显上升（被安抚） | 被刺痛（愤怒/恐惧/悲伤/厌恶被顶上来，或正面情绪被削） |
 * | 外向性 | 亲密互动（对TA的喜悦/信任明显上升） | 关系温度明显下降（被冷落） |
 * | 宜人性 | 被善待（关系温度明显上升） | 被刺痛 |
 * | 开放性 | 遇到没见过的东西（惊讶明显上升） | 受挫（被刺痛） |
 *
 * ### 三条硬约束
 *
 * 1. **范围是天花板与地板**：`value` 永远夹在 `[min, max]` 里，撞到就停；
 * 2. **每轮每轴最多一步**：同一轮里十条情绪也只是一步，不让一次吵架把人推下悬崖；
 * 3. **慢慢落地**：漂移先攒在内存里，满一天且够一个阈值才写一次人格文档 ——
 *    每轮都写会把人格历史刷成流水账。
 * @module humanity/persona/drift
 */
import { CHARACTER_AXES, type CharacterAxisKey } from './constants.js'
import type { PersonaDocument } from './types.js'

/** 一次推动的幅度。0.005 ≈ 范围（0.25）的 2%，走完整个范围要几十次同类经历。 */
export const DRIFT_STEP = 0.005

/** 关系温度变动多少算"明显"（升=被安抚，降=被冷落）。 */
export const DRIFT_WARMTH_DELTA = 3

/** 情绪增量多少算"明显有感"（与评估器的标尺一致）。 */
export const DRIFT_STRONG_SHIFT = 6

/** 攒够多少才值得写一次人格文档。 */
export const DRIFT_FLUSH_THRESHOLD = 0.01

/** 两次落地之间至少隔多久（一天一次，历史不会变成流水账）。 */
export const DRIFT_FLUSH_MS = 24 * 3_600_000

/** 一次评估里跟推动有关的输入（只取需要的字段，结构读取）。 */
export interface DriftInput {
  shifts: ReadonlyArray<{ kind: string; target?: string; delta: number; vicarious?: boolean; echo?: boolean }>
  /** 这一轮关系温度的变动（缺省=没变）。 */
  warmth?: number
}

/** 负面情绪（被顶上来才算刺痛）。 */
const AVERSIVE = new Set(['anger', 'fear', 'sadness', 'disgust'])

/** 正面情绪（被削下去也算刺痛）。 */
const PLEASANT = new Set(['joy', 'trust', 'anticipation'])

/**
 * 把一轮评估折算成每一根轴该走的那一小步。
 *
 * 纯函数：只读输入、不碰存储，便于逐条验规则。
 * @param input - 这一轮的增减与温度变化。
 * @returns 每根轴要加多少（没有就不出现；每根轴已夹到 ±一步）。
 */
export function nudgesOf(input: DriftInput): Partial<Record<CharacterAxisKey, number>> {
  /** 被"人"刺痛（冲着她来的）：影响她怎么待人。 */
  let stungByPerson = false
  /** 被"事"刺痛（外面的世界、她自己的挫折）：不该影响她怎么待人。 */
  let stungByWorld = false
  let intimate = false
  let novel = false
  for (const shift of input.shifts) {
    // 回声（想起旧事）与"替你难过"不算发生在她身上的事，不推动性格。
    if (shift.vicarious === true || shift.echo === true) continue
    const delta = Number(shift.delta)
    if (!Number.isFinite(delta) || delta === 0) continue
    const stinging = (AVERSIVE.has(shift.kind) && delta > 0) || (PLEASANT.has(shift.kind) && delta < 0)
    if (stinging) {
      /**
       * 为什么按对象分开记：**宜人性说的是"怎么待人"**。
       * 你气她一句会让她对人更紧一点；看到一条她看不惯的帖子、或对自己失望，
       * 只该让她的稳定性和开放性动 —— 世界的破事不该让她对你更坏
       * （设计方案 §6.3 记着这条缺陷，2026-11-24 拆开）。
       * 取不到对象时按"人"算：那是唯一会让她调整待人的情形。
       */
      if (shift.target === 'world' || shift.target === 'self') stungByWorld = true
      else stungByPerson = true
    }
    if ((shift.kind === 'joy' || shift.kind === 'trust') && delta >= DRIFT_STRONG_SHIFT && shift.target === 'user') {
      intimate = true
    }
    if (shift.kind === 'surprise' && delta >= DRIFT_STRONG_SHIFT) novel = true
  }
  const warmth = Number(input.warmth ?? 0)
  const soothed = Number.isFinite(warmth) && warmth >= DRIFT_WARMTH_DELTA
  const cold = Number.isFinite(warmth) && warmth <= -DRIFT_WARMTH_DELTA

  const raw: Partial<Record<CharacterAxisKey, number>> = {}
  const add = (key: CharacterAxisKey, amount: number): void => {
    raw[key] = (raw[key] ?? 0) + amount
  }
  if (stungByPerson) {
    add('stability', -DRIFT_STEP)
    add('agreeableness', -DRIFT_STEP)
    add('openness', -DRIFT_STEP)
  }
  if (stungByWorld) {
    add('stability', -DRIFT_STEP)
    add('openness', -DRIFT_STEP)
  }
  if (soothed) {
    add('stability', DRIFT_STEP)
    add('agreeableness', DRIFT_STEP)
  }
  if (cold) add('extraversion', -DRIFT_STEP)
  if (intimate) add('extraversion', DRIFT_STEP)
  if (novel) add('openness', DRIFT_STEP)

  // 同一轮同一根轴只走一步：+0.005 与被刺的 -0.005 同时出现时互相抵消，不该变成 0 以外的值。
  const bounded: Partial<Record<CharacterAxisKey, number>> = {}
  for (const key of CHARACTER_AXES) {
    const amount = raw[key]
    if (amount === undefined || amount === 0) continue
    bounded[key] = Math.max(-DRIFT_STEP, Math.min(DRIFT_STEP, amount))
  }
  return bounded
}

/** 把累积的推动写进文档（纯函数：返回新文档，不改传入的那份）。 */
export function applyDrift(
  doc: PersonaDocument,
  accumulated: Partial<Record<CharacterAxisKey, number>>,
): { document: PersonaDocument; changed: boolean } {
  const layers = doc.character
  if (layers === undefined || layers === null || layers.derivedAt === '') return { document: doc, changed: false }
  let changed = false
  const axes = layers.axes.map((axis) => {
    const amount = accumulated[axis.key]
    if (amount === undefined || amount === 0) return axis
    const low = Math.min(axis.min, axis.max)
    const high = Math.max(axis.min, axis.max)
    // 保留三位小数：0.005 一步，四舍五入到两位会被抹平成 0。
    const next = Math.round(Math.max(low, Math.min(high, axis.value + amount)) * 1000) / 1000
    if (next === axis.value) return axis
    changed = true
    return { ...axis, value: next }
  })
  if (!changed) return { document: doc, changed: false }
  return { document: { ...doc, character: { ...layers, axes } }, changed: true }
}

/** 累积器：把每一步加起来（不落盘，重启即丢 —— 丢的也只是不到一天的碎步）。 */
export function accumulate(
  accumulator: Partial<Record<CharacterAxisKey, number>>,
  step: Partial<Record<CharacterAxisKey, number>>,
): Partial<Record<CharacterAxisKey, number>> {
  const next = { ...accumulator }
  for (const key of CHARACTER_AXES) {
    const amount = step[key]
    if (amount === undefined || amount === 0) continue
    next[key] = (next[key] ?? 0) + amount
  }
  return next
}

/** 累积的幅度够不够写一次。 */
export function dueToFlush(accumulator: Partial<Record<CharacterAxisKey, number>>, intervalOk: boolean): boolean {
  if (!intervalOk) return false
  return CHARACTER_AXES.some((key) => Math.abs(accumulator[key] ?? 0) >= DRIFT_FLUSH_THRESHOLD)
}
