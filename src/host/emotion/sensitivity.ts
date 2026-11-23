/**
 * 情绪**敏感化**：同一个地方被反复碰到，下一次会更重一点。
 *
 * ### 它补的是哪一处空白
 *
 * 存储里每条情绪各算各的：事件来了加、时间到了衰减。于是"第一次被这样伤"与
 * "第五次被这样伤"在状态上完全一样 —— 前面四次没留下任何东西。可人不是这样：
 * 同一句话听到第五遍，火气不是从零开始。
 *
 * ### 依据
 *
 * 重复刺激会同时唤起两个方向相反的**非联想学习**过程，行为上看到的是两者的净值：
 * 一个让反应逐次变小（习惯化，只对同一种刺激成立），一个让反应逐次变大（敏感化，
 * 不挑具体刺激、且会随时间自行消退）。见 Groves, P. M. & Thompson, R. F. (1970),
 * *Habituation: A dual-process theory*, Psychological Review 77(5), 419–450
 * （[doi:10.1037/h0029810](https://doi.org/10.1037/h0029810)）。
 *
 * 这套依据决定了本模块的三个形状，不是三个随意选择：
 * 1. **不必认出"是不是同一句话"**：敏感化那一半本来就不是刺激特异的（习惯化才是）。
 *    所以记账的键是「哪种情绪 + 冲谁」，而不是原因的逐字比较 —— 后者每次都被模型改写，
 *    对不上就静默失效，是这个模块最不能接受的一种坏法。
 * 2. **自己会退**：痕迹按半衰期衰减（参数与理由见 `constants.ts` 的
 *    `SENSITIVITY_HALF_LIFE_MINUTES`）。不随时间退的旧账，几十轮后会变成另一种人格。
 * 3. **有上限**：水平向 1 饱和，放大最多 1.5 倍。上限写在结构里，不靠事后夹一下。
 *
 * ### 只做"变重"这一半
 *
 * 另一个方向是**脱敏**（被同一种方式伤到懒得计较、不再起反应）。它要么取决于
 * "这次对方是不是恶意"（OCC 的意图评估，当前评估器不产出这一层），要么属于
 * "心情整体变淡"，与"情绪只由事件升起"的纪律是两回事。所以这一轮不做它 ——
 * 不是漏了一块，是没有依据去定它的规则。
 *
 * ### 三条边界（每条都有测试钉着）
 *
 * - **好事不记账、也不放大**：反复被善待不会越来越激动。重复增益本来就被
 *   `state.ts` 的饱和曲线压着，这里不再加一层。判据是 {@link EMOTION_STING_DIRECTION}。
 * - **回声不记账**：想起一件旧事不是"又发生了一次"（`EmotionShift.echo`）。
 * - **记账用原始增量**：放大后的增量只作用于这一次的情绪，**不回流**成更快的敏感化。
 *   否则"敏感 → 增量更大 → 更敏感"会自己转起来，那是这个模块最危险的失效方式。
 * @module humanity/emotion/sensitivity
 */
import {
  EMOTION_STING_DIRECTION,
  MAX_SENSITIVITIES,
  SENSITIVITY_FLOOR,
  SENSITIVITY_MAX_BOOST,
  SENSITIVITY_REFERENCE_DELTA,
  SENSITIVITY_STEP,
  type EmotionKind,
  type EmotionTarget,
} from './constants.js'
import type { EmotionSensitivity } from './types.js'

/**
 * 这一笔变化是不是一次**伤害**（"被刺痛"）。
 *
 * 负面情绪被顶上来、正面情绪被削下去，都算；惊讶两向都不算（它只说"没想到"）。
 * 方向表见 {@link EMOTION_STING_DIRECTION}。
 * @param kind - 哪一种情绪。
 * @param delta - 这一笔的增量（正=加强，负=削弱）。
 * @returns 是伤害时为 `true`。
 */
export function isSting(kind: EmotionKind, delta: number): boolean {
  return delta * EMOTION_STING_DIRECTION[kind] > 0
}

/**
 * 是不是**负面**情绪（升上来就是刺痛的那四种：恐惧 / 悲伤 / 厌恶 / 愤怒）。
 *
 * 只回答极性，不回答"这一笔是不是伤害"（那是 {@link isSting}）。自调节只作用于负面情绪：
 * 好心情本来就该慢慢淡，不需要"冷静"（见 `constants.ts` 的 `SOOTHE_QUIET_MINUTES`）。
 * @param kind - 哪一种情绪。
 * @returns 负面情绪时为 `true`。
 */
export function isAversive(kind: EmotionKind): boolean {
  return EMOTION_STING_DIRECTION[kind] === 1
}

/**
 * 把痕迹按时间变淡，丢掉已经浅到没有意义的那些。
 *
 * 为什么把"比例"作为参数传进来，而不是在这里自己算半衰期：衰减公式只有一份
 * （`state.ts` 的 `remainingRatio`），两处各写一遍幂运算，迟早会有一处改漏；
 * 而这里只需要"剩多少"。
 * @param entries - 结算前的痕迹。
 * @param ratio - 剩余比例（0–1，`remainingRatio(经过分钟数, 半衰期)` 的结果）。
 * @returns 变淡后的痕迹（低于地板的不再出现）。
 */
export function decaySensitivity(
  entries: readonly EmotionSensitivity[],
  ratio: number,
): EmotionSensitivity[] {
  const next: EmotionSensitivity[] = []
  for (const entry of entries) {
    const level = entry.level * ratio
    if (level < SENSITIVITY_FLOOR) continue
    next.push({ ...entry, level })
  }
  return trim(next)
}

/**
 * 这一处此刻的**放大倍数**：1（没被磨过）到 1.5（磨到顶）。
 *
 * 读的是**记账前**的痕迹：这一次的伤害不能给自己当放大器，否则同一笔事件会
 * 因为"它把自己记上去了"而多放一次。
 * @param entries - 当前的痕迹。
 * @param kind - 这一笔的情绪。
 * @param target - 这一笔的对象。
 * @returns 1–1.5 之间的倍数（上限是 `1 + {@link SENSITIVITY_MAX_BOOST}`）。
 */
export function sensitivityFactor(
  entries: readonly EmotionSensitivity[],
  kind: EmotionKind,
  target: EmotionTarget,
): number {
  const level = entries.find((entry) => entry.kind === kind && entry.target === target)?.level ?? 0
  return 1 + SENSITIVITY_MAX_BOOST * level
}

/**
 * 记一次伤害：把这一处的痕迹往上推一点。
 *
 * 推移量按**剩余空间**算（`level + (1 − level) × 步长`），所以它渐近 1 而不越过 ——
 * 前几次推得动，磨了几十次之后几乎推不动。这与强度那边的边际递减是同一种直觉，
 * 但两者管的是不同的东西（那边是"这一次加多少"，这里是"这一处有多容易被点着"）。
 *
 * 步长还要按刺激大小折算：一次只值 5 分的冒犯与一次 30 分的伤害不该留下一样深的痕迹。
 * 当量取 {@link SENSITIVITY_REFERENCE_DELTA}，与评估器提示词里的"明显有感"是同一把尺子。
 * @param entries - 记账前的痕迹。
 * @param kind - 这一笔的情绪。
 * @param target - 这一笔的对象。
 * @param delta - 这一笔的**原始**增量（不是放大后的那个）。
 * @param context - 这一笔的出处（原因与时刻）；用户 2026-11-22 要"能看出为什么敏感"，所以落进痕迹里。
 * @returns 记账后的痕迹（同一个键只有一条）。
 */
export function recordSting(
  entries: readonly EmotionSensitivity[],
  kind: EmotionKind,
  target: EmotionTarget,
  delta: number,
  context: { cause?: string; at?: string } = {},
): EmotionSensitivity[] {
  const weight = Math.min(1, Math.abs(delta) / SENSITIVITY_REFERENCE_DELTA)
  if (!(weight > 0)) return [...entries]

  const existing = entries.find((entry) => entry.kind === kind && entry.target === target)
  const current = existing?.level ?? 0
  const entry: EmotionSensitivity = {
    kind,
    target,
    level: current + (1 - current) * SENSITIVITY_STEP * weight,
    // 只留最近一次：这一层要回答"最近被什么磨的"，不是给每一道痕迹写日记。
    lastCause: context.cause !== undefined && context.cause !== '' ? context.cause : (existing?.lastCause ?? ''),
    lastDelta: delta,
    lastLevelBefore: current,
    lastAt: context.at !== undefined && context.at !== '' ? context.at : (existing?.lastAt ?? ''),
  }
  const next = existing === undefined
    ? [...entries, entry]
    : entries.map((item) => (item === existing ? entry : item))
  return trim(next)
}

/**
 * 把痕迹条数收敛到上限（丢最浅的那条）。
 *
 * 为什么不是直接拒绝新增：拒绝会让"最新被磨的那一处"永远记不上，而它恰恰是最该记的。
 * 被牺牲的应当是最浅的旧痕迹 —— 它本来就快被时间清掉了。
 * @param entries - 任意条数的痕迹。
 * @returns 不超过 {@link MAX_SENSITIVITIES} 条。
 */
function trim(entries: EmotionSensitivity[]): EmotionSensitivity[] {
  if (entries.length <= MAX_SENSITIVITIES) return entries
  return [...entries].sort((a, b) => b.level - a.level).slice(0, MAX_SENSITIVITIES)
}
