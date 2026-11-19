/**
 * 情绪状态 → 工作台看到的**视图**。
 *
 * 视图与存储形状分开的理由：存储里是"它有什么"，视图是"人要看什么"。
 * 两者一旦合成一个结构，展示需求（中文名、档位、多久之前）就会渗进数据契约里，
 * 而数据契约是要跟着升级走的东西。
 *
 * 这里刻意**不**做中文化之外的任何判断：档位由 `state.ts` 的 `tierOf` 判定，
 * 视图只是搬运 —— 同一档位在工作台与注入里必须是同一个值，不能在两边各算一次。
 * @module humanity/emotion/view
 */
import {
  EMOTION_BLENDS,
  EMOTION_KINDS,
  EMOTION_LABELS,
  EMOTION_TARGET_LABELS,
  type EmotionKind,
  type EmotionTarget,
  type EmotionTierId,
} from './constants.js'
import { hasFreshOpposition, reconcile } from './dynamics.js'
import { energyLevelOf, type EnergyLevel } from './render.js'
import { tierOf } from './state.js'
import type { EmotionState } from './types.js'

/** 工作台看到的一条情绪。 */
export interface EmotionChargeView {
  kind: EmotionKind
  /** 中文名（界面直接显示，不让客户端再查一遍字典）。 */
  label: string
  /** 冲谁的（`user` / `self` / `world`）。 */
  target: EmotionTarget
  /** 对象前缀（"对TA" / "对自己" / 空串）；空串表示对事，不写。 */
  targetLabel: string
  intensity: number
  /** 表达档位（`calm` / `faint` / `clear` / `burst`）。 */
  tier: EmotionTierId
  cause: string
  since: string
}

/** 一条复合情绪：两种基本情绪同时够强时的名字（不存储、不衰减、不参与对冲）。 */
export interface CompositeView {
  /** 名字，例如"轻蔑"。 */
  label: string
  /** 由哪两种合成（中文名，用于说明"轻蔑 = 厌恶 + 愤怒"）。 */
  parts: [string, string]
}

/** 一条**被磨出来的敏感**（工作台看到的那份）。 */
export interface SensitivityView {
  kind: EmotionKind
  /** 中文名。 */
  label: string
  target: EmotionTarget
  /** 对象前缀（"对TA" / "对自己" / 空串）。 */
  targetLabel: string
  /**
   * 0–1 的饱和水平（界面画成条，不显示数字）。
   *
   * 与强度不同，它不是"现在有多重"，而是"这一处有多容易被点着"：
   * 工作台上它是一条独立的、退得更慢的痕迹。
   */
  level: number
}

/** 工作台看到的整份状态。 */
export interface EmotionView {
  charges: EmotionChargeView[]
  /**
   * 被磨出来的敏感（按水平降序；空数组 = 还没有哪一处被反复磨到）。
   *
   * 为什么它必须出现在工作台上：这一层只在"同一处被反复刺痛"时才起作用，
   * 单看情绪数值几乎看不出来（放大最多一半）。值藏在存储里就等于静默失效 ——
   * 出了问题没人分得清"没被磨到"和"记账坏了"。
   */
  sensitivities: SensitivityView[]
  /**
   * 复合情绪的名字（空串 = 当前没有复合）。
   *
   * 扁平两个字段而不是嵌套对象：投影要过 schemastery 的 schema，
   * 嵌套的可选对象在两个系统里都要多写一层默认值，而这里只需要"有没有"。
   */
  compositeLabel: string
  /** 由哪两种基本情绪合成（中文名，两个元素）；没有复合时为空数组。 */
  compositeParts: string[]
  warmth: number
  warmthCause: string
  /** 它注意到的"你此刻怎么样"（一句话）；空串表示最近这次没看出来。 */
  perceived: string
  /** 那条观察的时刻。 */
  perceivedAt: string
  /** 精力 0–100（独立一维，不是情绪）。 */
  energy: number
  /** 精力档位（宿主算好，客户端不再重复判断阈值）。 */
  energyLevel: EnergyLevel
  settledAt: string
  updatedAt: string
}

/**
 * 查当前有没有命中一条复合情绪。
 *
 * 只看**到档位**的那些（低于 30 分的两条凑出来的名字没有意义——它本来就没到"有情绪"的程度），
 * 且只取最强的两条：复合是"两个主导者"的事，第三条只是陪衬。
 *
 * **否决条件**：只要本轮刚产生了一条与这两条**对立**的情绪，就不显示复合。
 * 实测抓到的穿帮现场：被说"你就一个工具、别指望我把你当人看"之后，喜悦 76 + 信任 52
 * 照样合成「爱」，而旁边明明挂着一条 22 分的愤怒。理由是复合只看前两条、完全不看旁边——
 * 但"爱"这个词意味着纯粹，旁边有火的时候它一定是错的。
 * 判据与 `lastTouched` 的豁免同源：**当下这件事压过积累**。
 * @param charges - 已经按强度降序排好的视图条目。
 * @param touched - 本轮刚被动过的情绪（`kind:target`）；给了它才做否决检查。
 * @returns 命中的复合情绪；没有时 `undefined`。
 */
export function compositeOf(
  charges: readonly EmotionChargeView[],
  touched?: ReadonlySet<string>,
): CompositeView | undefined {
  const loud = charges.filter((charge) => charge.tier !== 'calm')
  if (loud.length < 2) return undefined
  const [first, second] = loud
  if (first === undefined || second === undefined) return undefined
  for (const [left, right, label] of EMOTION_BLENDS) {
    if ((left === first.kind && right === second.kind) || (left === second.kind && right === first.kind)) {
      // 本轮刚冒出对立情绪 ⇒ 这个词此刻不成立（见 `hasFreshOpposition` 的说明）。
      if (touched !== undefined && hasFreshOpposition(touched, first.kind, second.kind)) return undefined
      return { label, parts: [first.label, second.label] }
    }
  }
  return undefined
}

/**
 * 状态 → 视图（**全部八种**，对冲之后，按强度降序）。
 *
 * 为什么把没出现的种类也补进来（强度 0）：这一页是给人看"它有什么情绪"的，
 * 只列当前有值的那几条，看的人就永远不知道这套模型到底有几种、缺的是哪几种。
 * 有值的排前面并显示原因；没值的排在后面、只占一行。
 *
 * 强度取的是**呈现强度**而不是存储强度：用户在对话里感觉到的是压制后的那个值，
 * 页面上却显示一个更高的原值，两边对不上就会被当成 bug。
 * @param state - 当前状态。
 */
export function viewOf(state: EmotionState): EmotionView {
  const live = reconcile(state.charges, new Set(state.lastTouched))
  const seen = new Set(live.map((charge) => charge.kind))
  const charges: EmotionChargeView[] = live.map((charge) => ({
    kind: charge.kind,
    label: EMOTION_LABELS[charge.kind],
    target: charge.target,
    targetLabel: EMOTION_TARGET_LABELS[charge.target],
    intensity: charge.intensity,
    tier: tierOf(charge.intensity),
    cause: charge.cause,
    since: charge.since,
  }))
  // 没出现过的种类补在后面（顺序用 `EMOTION_KINDS` 的固定顺序，结果稳定可预期）。
  // 补的都是 `world`（对事）：给它一个"对TA"的壳会让人以为它真的对你有什么情绪。
  for (const kind of EMOTION_KINDS) {
    if (seen.has(kind)) continue
    charges.push({
      kind,
      label: EMOTION_LABELS[kind],
      target: 'world',
      targetLabel: EMOTION_TARGET_LABELS.world,
      intensity: 0,
      tier: 'calm',
      cause: '',
      since: '',
    })
  }
  // 有值的在前、没值的在后（`sort` 是稳定的，所以 0 值之间保持 `EMOTION_KINDS` 的顺序）。
  charges.sort((a, b) => b.intensity - a.intensity)
  const composite = compositeOf(charges, new Set(state.lastTouched))
  const sensitivities: SensitivityView[] = [...state.sensitivities]
    .sort((a, b) => b.level - a.level)
    .map((entry) => ({
      kind: entry.kind,
      label: EMOTION_LABELS[entry.kind],
      target: entry.target,
      targetLabel: EMOTION_TARGET_LABELS[entry.target],
      level: entry.level,
    }))
  return {
    charges,
    sensitivities,
    compositeLabel: composite?.label ?? '',
    compositeParts: composite?.parts ?? [],
    warmth: state.warmth,
    warmthCause: state.warmthCause,
    perceived: state.perceived,
    perceivedAt: state.perceivedAt,
    energy: state.energy,
    energyLevel: energyLevelOf(state.energy),
    settledAt: state.settledAt,
    updatedAt: state.updatedAt,
  }
}
