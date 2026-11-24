/**
 * 一次醒来之后的**纯结算**：精力、次数、睡没睡、下一次隔多久。
 *
 * 为什么把它从 `index.ts` 里抽出来：这段是"她一天怎么转"的核心，原来混在
 * "写状态 / 调调度 / 拼唤醒词"之间，只能靠真机验。抽成纯函数之后可以逐条钉住：
 * 醒着的醒来、睡着醒来、次数到顶、上限关掉。
 * @module humanity/evolution/lifecycle
 */
import {
  minutesToWake,
  settleEnergy,
  startsSleeping,
  WAKE_COST,
  type EnergyState,
} from './energy.js'
import { afterWake, nextGapSeconds, secondsToMorning, type EvolutionStateDoc, type WakeRhythm } from './state.js'
import { MIN_GAP_SECONDS } from './constants.js'

/** 结算所需的外部事实。 */
export interface WakeSettleInput {
  /** 醒来之前的状态。 */
  state: EvolutionStateDoc
  /** 醒来的时刻（ISO 8601）。 */
  at: string
  /** 她的时区。 */
  timeZone?: string
  /** 节奏参数（上限与间隔）。 */
  rhythm: WakeRhythm
  /** 随机源（测试注入固定值）。 */
  random?: () => number
}

/** 结算结果。 */
export interface WakeSettlement {
  /** 结算后的状态（只含改动的字段 + 原状态）。 */
  state: EvolutionStateDoc
  /** 这一次醒来是不是"刚睡下"（要收账）。 */
  fellAsleep: boolean
  /** 下一次隔多少秒；`undefined` = 不该再排（上限关掉）。 */
  gapSeconds: number | undefined
}

/**
 * 睡着的她要隔多久才该再被叫醒。
 *
 * 两条路必须分开：
 * - **今天到顶** ⇒ 等明天早上（这一天过完了）；
 * - **只是累了** ⇒ 按睡眠曲线，睡够就醒。
 *
 * 为什么单独成函数：结算（`settleWakeState`）与"重启后从状态重排"（`arm`）都要用同一条规矩，
 * 各写一份迟早会分叉 —— 分叉的后果是"重启一次，她就从睡到早上变成 90 分钟一醒"。
 * @param state - 当前状态（`dayCount` 与 `energy` 都要用）。
 * @param at - 现在（ISO 8601）。
 * @param timeZone - 她的时区。
 * @param rhythm - 节奏参数（用到上限）。
 * @returns 间隔秒数（已夹到最小投递间隔以上）。
 */
export function sleepGapSeconds(
  state: EvolutionStateDoc,
  at: string,
  timeZone: string | undefined,
  rhythm: WakeRhythm,
): number {
  const hitCap = rhythm.maxPerDay > 0 && state.dayCount >= rhythm.maxPerDay
  const raw = hitCap ? secondsToMorning(at, timeZone) : minutesToWake(state.energy, at, timeZone) * 60
  return Math.max(MIN_GAP_SECONDS, raw)
}

/**
 * 结算一次醒来。
 *
 * 顺序有意为之：
 * 1. 先按睡眠曲线结算（睡够了她自己会"醒"，`sleepingSince` 被清空、扣掉起床迷糊）；
 * 2. 再记一次醒来的起动成本 —— 这一步必须在 1 之后，否则起床迷糊会被算两次；
 * 3. 然后判断"今天到头了没有"（精力见底或次数到顶）；
 * 4. 最后决定下一次隔多久（睡着 ⇒ 按睡够要多久；醒着 ⇒ 随机间隔）。
 * @param input - 状态、时刻、时区、节奏与随机源。
 * @returns 结算后的状态、要不要收账、下一次间隔。
 */
export function settleWakeState(input: WakeSettleInput): WakeSettlement {
  const { state: raw, at, timeZone, rhythm } = input
  const energyState: EnergyState = {
    energy: raw.energy,
    energyAt: raw.energyAt === '' ? at : raw.energyAt,
    sleepingSince: raw.sleepingSince,
  }
  const settled = settleEnergy(energyState, at, timeZone)
  const wasSleeping = raw.sleepingSince !== '' || settled.sleepingSince !== ''
  const after: EvolutionStateDoc = {
    ...raw,
    ...settled,
    ...afterWake(raw, at, timeZone),
  }
  // 起动成本：光算 token 的话她一天只掉零点几，永远累不了（真机实测）。
  after.energy = Math.max(0, after.energy - WAKE_COST)

  const fellAsleep = startsSleeping({
    wasSleeping,
    energy: settled.energy,
    dayCount: after.dayCount,
    maxPerDay: rhythm.maxPerDay,
  })
  if (fellAsleep) after.sleepingSince = at

  /**
   * 到顶导致的"睡下"必须排到**第二天早上**，不能按睡眠曲线排。
   *
   * 真机后果（2026-11-24 写测试时发现）：按睡眠曲线排 ⇒ 1.5 小时后她"睡醒"，
   * 但次数已经到顶 ⇒ 又立刻判到顶、又睡 ⇒ 整个下午到午夜陷在"醒—睡"循环里，
   * 一天的上限变成每 90 分钟醒一次。到顶就是这一天过完了，只能等明天。
   */
  const gapSeconds = after.sleepingSince !== ''
    ? sleepGapSeconds(after, at, timeZone, rhythm)
    : nextGapSeconds(after, rhythm, at, timeZone, input.random)

  return { state: after, fellAsleep: fellAsleep && !wasSleeping, gapSeconds }
}
