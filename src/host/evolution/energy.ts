/**
 * 精力：她这副身体还剩多少力气。
 *
 * ### 为什么按 token 记消耗，而不是按时间
 *
 * 用时间量"累"是假的：她坐在那儿发呆一天也会掉精力。token 是"她真的过了多少东西"的度量，
 * 而且天然把两件事放进同一个账本 —— 跟你聊天、她自己出门看东西，花的是同一副身体。
 *
 * ### 为什么恢复是一条曲线，不是一个常数
 *
 * 睡一觉不是"每小时 +N"：头两小时最解乏，睡够了再睡几乎没用；夜里睡比白天睡值；
 * 缺得越多补得越快。这几条加起来，精力才会"自己停在某个水平"，而不是一路飙满或一路归零。
 *
 * ### 缓存读取要打折
 *
 * 真机实测（2026-11-23）：一轮对话里新输入约 1.2k token、输出约 0.7k，**缓存读取约 41k**。
 * 按原始 token 算，等于"每轮把同一段上下文重读一遍"都算成她花了力气 —— 长对话会瞬间把她累垮。
 * 所以按真实成本加权：`新输入 + 输出 + 0.1 × 缓存读`。
 * @module humanity/evolution/energy
 */

/** 精力的上下限。 */
export const ENERGY_MAX = 100
/** 一出生就是多少（不设 100：人不是满格醒来的）。 */
export const ENERGY_START = 80
/** 掉到这条线以下就该睡了。 */
export const SLEEP_AT = 25
/** 睡到这条线以上才算睡够。 */
export const WAKE_AT = 70
/** 睡多久才可能醒（防止精力刚回一点就"醒"）。 */
export const SLEEP_MIN_MINUTES = 90
/** 一格多少分钟。 */
export const BLOCK_MINUTES = 15
/** 一格的基础恢复量（会被下面三个因子缩放）。 */
export const BLOCK_RECOVERY = 2.4
/** 醒来那一下的迷糊：先扣掉。 */
export const SLEEP_INERTIA = 6
/** 最多算多久的睡眠（再长也不额外恢复）。 */
export const SLEEP_CAP_MINUTES = 12 * 60

/** 多少加权 token 值 1 点精力。 */
export const TOKENS_PER_POINT = 25_000
/** 疲劳斜率：一天花得越多，后面的每一份越贵。 */
export const FATIGUE_SLOPE = 0.6
/** 疲劳的参考量：花到这个数，系数到 1 + FATIGUE_SLOPE。 */
export const FATIGUE_REF_TOKENS = 1_200_000
/** 缓存读取的权重（按真实成本的比例）。 */
export const CACHE_READ_WEIGHT = 0.1

/** 精力的状态（存在自进化状态文档里）。 */
export interface EnergyState {
  /** 0–100。 */
  energy: number
  /** 上一次结算的时刻（ISO 8601）。 */
  energyAt: string
  /** 什么时候睡下的（ISO 8601；空串 = 醒着）。 */
  sleepingSince: string
}

/** 一段用量（`assistant/message` 自带的那份）。 */
export interface TokenUsageLike {
  inputTokens?: unknown
  outputTokens?: unknown
  cacheReadTokens?: unknown
}

/**
 * 把一次用量折成"花了多少力气"。
 *
 * 缓存读只算一成：它代表"把已经读过的上下文再读一遍"，不是新做的工作。
 * @param usage - 消息上的 `usage`。
 * @returns 加权后的 token 数；字段不是数字时按 0 算。
 */
export function weightedTokens(usage: TokenUsageLike | undefined): number {
  const pick = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
  return pick(usage?.inputTokens) + pick(usage?.outputTokens) + CACHE_READ_WEIGHT * pick(usage?.cacheReadTokens)
}

/**
 * 掉多少点。
 * @param weighted - 加权 token 数。
 * @param tokensToday - 今天已经花掉多少（用来算疲劳）。
 * @returns 要扣的点数（非负）。
 */
export function drainPoints(weighted: number, tokensToday: number): number {
  if (!Number.isFinite(weighted) || weighted <= 0) return 0
  const used = Math.max(0, Math.min(1, tokensToday / FATIGUE_REF_TOKENS))
  const fatigue = 1 + FATIGUE_SLOPE * used
  return (weighted / TOKENS_PER_POINT) * fatigue
}

/** 某个时刻在她时区里是几点。 */
function localHour(iso: string, timeZone?: string): number {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return 12
  const format = (zone?: string): string =>
    new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', hour12: false }).format(at)
  try {
    return Number(format(timeZone))
  } catch {
    return Number(format(undefined))
  }
}

/**
 * 这一格回多少。
 * @param energy - 这一格开始时的精力。
 * @param blockIndex - 这是睡下之后的第几格（从 0 开始）。
 * @param hour - 这一格所在的本地小时。
 * @returns 恢复量。
 */
function blockRecovery(energy: number, blockIndex: number, hour: number): number {
  // 缺得越多补得越快（0 分时 ×1.4，满值时 ×0.6）。
  const deficit = Math.max(0, Math.min(1, (ENERGY_MAX - energy) / ENERGY_MAX))
  const deficitFactor = 0.6 + 0.8 * deficit
  // 夜里睡更值；下午最不值。
  const circadian = hour >= 22 || hour < 6 ? 1.25 : hour < 9 ? 1 : 0.75
  // 睡久了变浅：前两小时最深，之后变浅但不再变得更浅
  // （再浅下去会出现"睡满 12 小时还没睡够"——那不是睡眠，是昏迷）。
  const depth = blockIndex < 8 ? 1 : blockIndex < 16 ? 0.7 : 0.5
  return BLOCK_RECOVERY * deficitFactor * circadian * depth
}

/**
 * 结算精力到 `now`。
 *
 * 只在**睡着**的时候随时间变化；醒着时精力只由 token 消耗推动（见 {@link drainPoints}）。
 * 睡够（精力 ≥ {@link WAKE_AT} 且已睡满 {@link SLEEP_MIN_MINUTES}）就醒来，并扣掉起床迷糊。
 * @param state - 上一次结算后的状态。
 * @param nowIso - 现在。
 * @param timeZone - 她的时区。
 * @returns 结算后的状态（`energyAt` 一定是 `nowIso`）。
 */
export function settleEnergy(state: EnergyState, nowIso: string, timeZone?: string): EnergyState {
  const from = Date.parse(state.energyAt)
  const now = Date.parse(nowIso)
  if (!Number.isFinite(now)) return state
  if (state.sleepingSince === '') {
    // 醒着：精力不随时间变，只更新结算时刻。
    return { ...state, energyAt: nowIso }
  }
  const sleepStart = Date.parse(state.sleepingSince)
  if (!Number.isFinite(from) || !Number.isFinite(sleepStart)) {
    return { ...state, energyAt: nowIso }
  }
  const start = Math.max(from, sleepStart)
  const minutes = Math.max(0, Math.min(SLEEP_CAP_MINUTES, (now - start) / 60_000))
  const blocks = Math.floor(minutes / BLOCK_MINUTES)
  let energy = Math.max(0, Math.min(ENERGY_MAX, state.energy))
  for (let index = 0; index < blocks; index += 1) {
    const at = new Date(start + index * BLOCK_MINUTES * 60_000).toISOString()
    energy = Math.min(ENERGY_MAX, energy + blockRecovery(energy, index, localHour(at, timeZone)))
    const slept = (index + 1) * BLOCK_MINUTES
    if (energy >= WAKE_AT && slept >= SLEEP_MIN_MINUTES) {
      // 醒了：先扣掉起床迷糊，再交还一个"醒着"的状态。
      return {
        energy: Math.max(0, energy - SLEEP_INERTIA),
        energyAt: nowIso,
        sleepingSince: '',
      }
    }
  }
  return { energy, energyAt: nowIso, sleepingSince: state.sleepingSince }
}

/**
 * 还要睡多久才会自然醒（分钟）。
 *
 * 与 {@link settleEnergy} 用同一条曲线，所以"排的时间"和"真到点的结算"不会打架。
 * @param energy - 现在的精力。
 * @param fromIso - 从什么时候开始算（通常是"现在"）。
 * @param timeZone - 她的时区。
 * @returns 分钟数（至少到下一条睡眠最短时长）。
 */
export function minutesToWake(energy: number, fromIso: string, timeZone?: string): number {
  const start = Date.parse(fromIso)
  if (!Number.isFinite(start)) return SLEEP_MIN_MINUTES
  let current = Math.max(0, Math.min(ENERGY_MAX, energy))
  const blocks = Math.ceil(SLEEP_CAP_MINUTES / BLOCK_MINUTES)
  for (let index = 0; index < blocks; index += 1) {
    const at = new Date(start + index * BLOCK_MINUTES * 60_000).toISOString()
    current = Math.min(ENERGY_MAX, current + blockRecovery(current, index, localHour(at, timeZone)))
    const slept = (index + 1) * BLOCK_MINUTES
    if (current >= WAKE_AT && slept >= SLEEP_MIN_MINUTES) return slept
  }
  return SLEEP_CAP_MINUTES
}

/**
 * 该不该睡下了。
 * @param state - 结算后的状态。
 * @returns `true` = 该睡（已经是睡着状态时返回 `false`，避免重复记睡点）。
 */
export function shouldSleep(state: EnergyState): boolean {
  return state.sleepingSince === '' && state.energy <= SLEEP_AT
}

/**
 * 让"今天已经花了多少 token"跨天归零。
 * @param dayKey - 状态里记的日期。
 * @param today - 现在的日期（她的时区）。
 * @param tokensToday - 记着的量。
 * @returns 今天该用的量。
 */
export function tokensTodayOf(dayKey: string, today: string, tokensToday: number): number {
  if (dayKey === '' || today === '' || dayKey !== today) return 0
  return Number.isFinite(tokensToday) && tokensToday > 0 ? tokensToday : 0
}
