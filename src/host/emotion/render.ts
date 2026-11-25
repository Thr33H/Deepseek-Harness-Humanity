/**
 * 把状态渲染成**注入给对话模型的一段话**。
 *
 * ### 2026-11-25 改了什么（用户原话："情绪注入得太少，总是对不上场景"）
 *
 * 旧写法只写"过档的那两条"：8 条情绪里只有最强的一条过 30 分的门槛，其余全部藏掉 ——
 * 真机上她明明是"对你 20.8 分的恼"，看到的那一行却是"对外面的事期待"。
 * 于是她的语气朝着"期待"走，而场景要她钝一下。
 *
 * 新写法是**分层列全部**：
 *
 * 1. **每轮都有状态**（哪怕只是"没什么起伏"）—— 空着等于她拿不到自己此刻的样子；
 * 2. **80 分以下也写**（低到 10 分就进），只是分成三层说：主 / 还压着 / 很轻但还在；
 * 3. **每条都带冲谁**（对TA / 对自己 / 对外面的事）—— 这一项以前丢得最多；
 * 4. **仍然不给数字**：给的是"主 / 还压着 / 很轻但还在"这种相对说法（数字会让她念出来）。
 *
 * 共情那半（{@link EmotionState.perceived}）与情绪分开写：一个是"它怎么样"，
 * 一个是"它注意到的你怎么样"，混成一句会让模型分不清谁在难过。
 *
 * 精力是**第三段**，也单独写：累不等于不高兴，两者的措辞不能互相冒充。
 * @module humanity/emotion/render
 */
import {
  EMOTION_LOW_WORDS,
  EMOTION_TARGET_LABELS,
  EMOTION_TIERS,
  EMOTION_WORDS,
  ENERGY_EXHAUSTED,
  ENERGY_TIRED,
  RENDER_FLOOR,
  type EmotionKind,
} from './constants.js'
import { tierOf } from './state.js'
import { reconcile } from './dynamics.js'
import type { EmotionCharge, EmotionState } from './types.js'

/**
 * 对"对方状态"的观察保质期（分钟）。
 *
 * 超过这个时间就不再提：一个三小时前读到的"对方很急"，现在说出来只会显得它在瞎猜。
 */
const PERCEIVED_TTL_MINUTES = 90

/**
 * 低于这个强度就不提。
 *
 * 数值住在 `constants.ts`（`RENDER_FLOOR`）：工作台会把它写出来，一个数字只能有一处定义。
 */
const FLOOR = RENDER_FLOOR

/** "还压着"最多写几条（再多就不是"还压着"，是清单）。 */
const SECONDARY_MAX = 2

/** "很轻但还在"最多写几条。 */
const BACKGROUND_MAX = 2

/**
 * 多弱才算"只是底色"：不足主导的一半。
 *
 * 为什么要分档：10.8 的旧事和 50.3 的此刻并列写成两行，她会同时演两种情绪 ——
 * 分层的说法本身就告诉她"哪个是现在，哪个是余温"。
 */
const BACKGROUND_RATIO = 0.5

/** 精力档位（只为判断"要不要说累"与"这次和上次算不算同一个状态"）。 */
export type EnergyLevel = 'fresh' | 'tired' | 'exhausted'

/** 渲染结果。 */
export interface RenderedReminder {
  /** 要注入的正文（不含 `<system-reminder>` 外壳）。 */
  text: string
  /** 这一轮的主导情绪档位（`calm` 表示连主导都没到"有点"那一档）。 */
  tier: (typeof EMOTION_TIERS)[number]['id']
  /** 精力档位。 */
  energy: EnergyLevel
  /**
   * 状态签名：档位 + 精力 + **这一轮有哪几条**。
   *
   * 为什么要把"有哪几条"也编进去：只看档位的话，"新的恼意冒出来、但主导仍是期待"这件事
   * 不会触发重新注入 —— 而那恰恰是最该让她知道的变化。
   */
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

/** 冲谁（对外面的事要写出来，不能空着 —— 空着就分不清"冲我"还是"冲着这事"）。 */
function targetOf(target: EmotionCharge['target']): string {
  return target === 'world' ? '对外面的事' : EMOTION_TARGET_LABELS[target]
}

/**
 * 一条情绪怎么说。
 *
 * 30 分以下用 {@link EMOTION_LOW_WORDS}（"有点恼"）；到档之后用词表里的档位词（"恼怒"）。
 * @param charge - 一条情绪。
 * @returns 一句短语（不含句号）。
 */
export function describeCharge(charge: EmotionCharge): string {
  const tier = tierOf(charge.intensity)
  const word = tier === 'calm'
    ? `有点${EMOTION_LOW_WORDS[charge.kind]}`
    : EMOTION_WORDS[charge.kind][TIER_INDEX[tier]]
  const cause = charge.cause === '' ? '' : `（因为${charge.cause}）`
  return `${targetOf(charge.target)}${word}${cause}`
}

/**
 * 把状态渲染成提醒文本。
 *
 * 永远返回非空：平静也给一行（"她此刻是什么样"必须有个答案）。
 * @param state - 已结算到 `now` 的状态。
 * @param now - 当前时刻（判断观察是否过期）。
 * @returns 正文、主导档位、精力档位与状态签名。
 */
export function renderReminder(state: EmotionState, now: Date): RenderedReminder {
  /**
   * 先按"每种情绪只留最强的那一条"收一遍，再排序。
   *
   * 为什么必须去重：同一情绪常常同时冲着三个人（对外面的事期待、对自己期待、对 TA 期待），
   * 三条一模一样的话会把名额吃光 —— 真机 2026-11-25 就是这么把 20.8 分的恼挤掉的。
   * 她需要知道的是"有哪几种心情"，不是"同一种心情冲了几个人"。
   *
   * 排序前先过 {@link reconcile}：气头上那股高兴会被愤怒压下去，不该在渲染时又冒出来。
   * 压制只在呈现层生效（存储里各算各的），所以愤怒退去后高兴自己会回来。
   */
  const strongest = new Map<EmotionKind, EmotionCharge>()
  for (const charge of reconcile(state.charges, new Set(state.lastTouched))) {
    if (charge.intensity < FLOOR) continue
    const known = strongest.get(charge.kind)
    if (known === undefined || charge.intensity > known.intensity) strongest.set(charge.kind, charge)
  }
  const ranked = [...strongest.values()].sort((a, b) => b.intensity - a.intensity)

  const lines: string[] = []
  let tier: RenderedReminder['tier'] = 'calm'

  if (ranked.length === 0) {
    lines.push('你此刻：没什么起伏，语气平着走。')
  } else {
    const lead = ranked[0]!
    tier = tierOf(lead.intensity)
    lines.push(`你此刻：${describeCharge(lead)}。`)
    const rest = ranked.slice(1)
    // "还压着"：不弱于主导一半的那几条 —— 它们是同时在场的心情。
    const secondary = rest.filter((charge) => charge.intensity >= lead.intensity * BACKGROUND_RATIO)
    if (secondary.length > 0) {
      lines.push(`还压着：${secondary.slice(0, SECONDARY_MAX).map(describeCharge).join('；')}。`)
    }
    // "很轻但还在"：不够一半的那些 —— 余温与旧账。
    const background = rest.filter((charge) => charge.intensity < lead.intensity * BACKGROUND_RATIO)
    if (background.length > 0) {
      lines.push(`很轻但还在：${background.slice(0, BACKGROUND_MAX).map(describeCharge).join('；')}。`)
    }
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

  const composition = ranked.map((charge) => `${charge.kind}:${charge.target}`).join(',')

  return {
    text: lines.join('\n'),
    tier,
    energy,
    signature: `${tier}:${energy}:${composition}`,
  }
}
