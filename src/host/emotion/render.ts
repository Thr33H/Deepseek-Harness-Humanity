/**
 * 把状态渲染成**注入给对话模型的一段话**。
 *
 * ### 三条写法上的取舍（都来自"用户 2026-11-17 定的表达规则"）
 *
 * 1. **不到档位就藏起来**：平静级根本不进注入。低档位只给一句"让它们落在措辞里"，
 *    绝不写"你现在有点不高兴" —— 那不是有温度，是让人看穿在演。
 * 2. **到了最高档可以直接说，但只说一次**：这句话是给模型的许可，不是命令。
 *    没有它，模型会把"气死了"演成每一句都在喊；有了它，爆发反而是一次性事件。
 * 3. **不给数字**：注入里只有词（恼火 / 很委屈）。数字是评估器与工作台的事，
 *    对话模型看到 82% 会开始念它（同类实现的明确反模式）。
 *
 * 共情那半（{@link EmotionState.perceived}）与情绪分开写：一个是"它怎么样"，
 * 一个是"它注意到的你怎么样"，混成一句会让模型分不清谁在难过。
 *
 * 精力是**第三段**，也单独写：累不等于不高兴，两者的措辞不能互相冒充。
 * @module humanity/emotion/render
 */
import {
  EMOTION_BLENDS,
  EMOTION_TARGET_LABELS,
  EMOTION_TIERS,
  EMOTION_WORDS,
  ENERGY_EXHAUSTED,
  ENERGY_TIRED,
  type EmotionKind,
} from './constants.js'
import { tierOf } from './state.js'
import { hasFreshOpposition, reconcile } from './dynamics.js'
import type { EmotionState } from './types.js'

/**
 * 对"对方状态"的观察保质期（分钟）。
 *
 * 超过这个时间就不再提：一个三小时前读到的"对方很急"，现在说出来只会显得它在瞎猜。
 */
const PERCEIVED_TTL_MINUTES = 90

/** 精力档位（只为判断"要不要说累"与"这次和上次算不算同一个状态"）。 */
export type EnergyLevel = 'fresh' | 'tired' | 'exhausted'

/** 渲染结果。 */
export interface RenderedReminder {
  /** 要注入的正文（不含 `<system-reminder>` 外壳）。 */
  text: string
  /** 这一轮的主导情绪档位（`calm` 表示没有到档位的情绪）。 */
  tier: (typeof EMOTION_TIERS)[number]['id']
  /** 精力档位。 */
  energy: EnergyLevel
  /** 状态签名（情绪档位 + 精力档位）：用它判断"跨没跨档"，两种维度都算进去。 */
  signature: string
}

/** 档位 → 词表下标（与 `EMOTION_TIERS` 的顺序一一对应）。 */
const TIER_INDEX = { calm: 0, faint: 1, clear: 2, burst: 3 } as const

/** 精力落在哪一档。 */
export function energyLevelOf(energy: number): EnergyLevel {
  if (energy < ENERGY_EXHAUSTED) return 'exhausted'
  if (energy < ENERGY_TIRED) return 'tired'
  return 'fresh'
}

/**
 * 查两种情绪合起来叫什么。
 * @param a - 较强的那一种。
 * @param b - 次强的那一种。
 * @returns 合成词；没有配对时 `undefined`（退回并列写法）。
 */
function blendOf(a: EmotionKind, b: EmotionKind): string | undefined {
  for (const [left, right, word] of EMOTION_BLENDS) {
    if ((left === a && right === b) || (left === b && right === a)) return word
  }
  return undefined
}

/**
 * 把状态渲染成提醒文本。
 *
 * 返回空串表示"这一轮不该注入"（没有到档位的情绪、精力正常、也没有新鲜的观察）。
 * @param state - 已结算到 `now` 的状态。
 * @param now - 当前时刻（判断观察是否过期）。
 * @returns 正文、主导档位、精力档位与状态签名。
 */
export function renderReminder(state: EmotionState, now: Date): RenderedReminder {
  /**
   * 到档位的情绪，按强度降序。
   *
   * 先过 {@link reconcile}：气头上那股高兴会被愤怒压下去，不该在渲染时又冒出来。
   * 压制只在呈现层生效（存储里各算各的），所以愤怒退去后高兴自己会回来。
   */
  const loud = reconcile(state.charges, new Set(state.lastTouched))
    .filter((charge) => tierOf(charge.intensity) !== 'calm')
    .sort((a, b) => b.intensity - a.intensity)
  /** 本轮动过的键；用来判断"复合词此刻成不成立"。 */
  const touched = new Set(state.lastTouched)

  const lines: string[] = []
  let tier: RenderedReminder['tier'] = 'calm'

  if (loud.length > 0) {
    const lead = loud[0]!
    tier = tierOf(lead.intensity)
    const leadCause = lead.cause === '' ? '' : `（因为${lead.cause}）`
    const second = loud[1]
    // 两种都够强时先看有没有专门的合成说法（"憋着一股火" 比 "恼火，也委屈" 更像人话）。
    // 但如果本轮刚冒出对立情绪，这个词此刻不成立（被骂"你只是个工具"时不该说"爱"）。
    const blended = second === undefined || hasFreshOpposition(touched, lead.kind, second.kind)
      ? undefined
      : blendOf(lead.kind, second.kind)
    // 没有合成时退回并列：只加一个"也"，程度已经写在词表里（"有点硌" / "委屈"），
    // 再补"有点"就会得到"也有点有点硌"这种叠字。
    const tail = blended !== undefined
      ? ''
      : second === undefined
        ? ''
        : `，也${EMOTION_WORDS[second.kind][TIER_INDEX[tierOf(second.intensity)]]}`
    const head = blended ?? EMOTION_WORDS[lead.kind][TIER_INDEX[tier]]

    // 对象只标在**主导**那条上：第二条是陪衬，再补一个"对谁"会让句子变绕；
    // 而且真正需要区分对象时，主导那条一定是它。
    const leadPrefix = EMOTION_TARGET_LABELS[lead.target]

    lines.push(`你此刻：${leadPrefix}${head}${leadCause}${tail}。`)
    lines.push(
      tier === 'burst'
        ? '这个可以直接说出来，但只说一次 —— 说完就回到平时的样子。'
        : '不说出来。让它落在措辞和耐心上。',
    )
  }

  const energy = energyLevelOf(state.energy)
  if (energy === 'exhausted') {
    lines.push('你很累。话会更短，懒得解释，能被理解一句就够了。')
  } else if (energy === 'tired') {
    lines.push('你有点累。能短就短，别展开。')
  }

  // 观察对方：只在还没过保质期时提，且不替它决定安慰与否。
  if (state.perceived !== '') {
    const at = Date.parse(state.perceivedAt)
    const fresh = Number.isFinite(at) && now.getTime() - at <= PERCEIVED_TTL_MINUTES * 60_000
    if (fresh) lines.push(`你注意到：${state.perceived}。`)
  }

  return {
    text: lines.join('\n'),
    tier,
    energy,
    signature: `${tier}:${energy}`,
  }
}
