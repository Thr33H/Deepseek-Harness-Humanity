/**
 * 被窥探之后的反应：**性格决定多重，宜人性决定"怕还是气"**（纯函数，不碰存储）。
 *
 * ### 为什么要有这一块
 *
 * 设计里写的是「反应强度 = 基础 × 性格系数（敏感的人重，大大咧咧的人轻）」，而 2026-11-21
 * 落地的第一版把它写死成"怕 45" —— 不管她是什么性子，被翻到同一个地方、都是同一个强度。
 * 那时性格还没有能参与计算的数；现在人格那边有四根轴，这条线才接得上。
 *
 * ### 为什么只看两根轴
 *
 * - **情绪稳定性**决定"多疼"：同一句重话，稳的人过一晚就好，不稳的人会反复想一个星期。
 * - **宜人性**决定"朝哪去"：高宜人性更可能接成"是不是我自己不好"（受伤、怕），
 *   低宜人性更可能接成"你凭什么"（恼）。
 *
 * 外向性与开放性跟"被冒犯之后的反应"没有直接关系，不参与 —— 硬拉进来只会让每个数都变成
 * 四个东西搅在一起，出了问题也说不清是哪一根轴在起作用。
 *
 * ### 性格读不到时
 *
 * 退回基准值。**不能**把它当成"她很稳定"（那等于悄悄替她改性子），也不能当成
 * "她很容易崩"（那等于罚她还没初始化人格）。
 * @module humanity/memory/reaction
 */
import { PEEK_ANGER_BELOW, PEEK_BASE_INTENSITY, PEEK_INTENSITY_SPREAD } from './constants.js'
import type { MemoryCharacter, MemoryFeeling } from './types.js'

/** 夹到 0–1；不是数就当作"读不到"，返回 `undefined`。 */
function axisValue(value: number): number | undefined {
  if (!Number.isFinite(value)) return undefined
  return Math.min(1, Math.max(0, value))
}

/**
 * 算出她发现「你翻了她一直没说的事」之后，心里那一下是什么、有多重。
 *
 * 强度以 45 为基准，按情绪稳定性上下浮动 30：最稳 15、最容易崩 75。
 * 上下再夹一道 5–90，避免端点值让记录看起来像坏了。
 * @param character - 她的性格（只含用得上的两根轴）；读不到时传 `undefined`。
 * @returns 当时的感觉（种类 + 强度），写进她记下的那一笔。
 */
export function peekReaction(character: MemoryCharacter | undefined): MemoryFeeling {
  const stability = character === undefined ? undefined : axisValue(character.stability)
  const agreeableness = character === undefined ? undefined : axisValue(character.agreeableness)
  if (stability === undefined || agreeableness === undefined) {
    return { kind: 'fear', intensity: PEEK_BASE_INTENSITY }
  }
  const raw = PEEK_BASE_INTENSITY + (0.5 - stability) * PEEK_INTENSITY_SPREAD
  return {
    kind: agreeableness < PEEK_ANGER_BELOW ? 'anger' : 'fear',
    intensity: Math.round(Math.min(90, Math.max(5, raw))),
  }
}
