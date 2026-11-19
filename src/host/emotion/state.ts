/**
 * 情绪状态机：**纯函数**，不碰 cordis、不调模型、不读时钟以外的任何东西。
 *
 * 之所以必须是纯函数（三个理由，都是同类实现踩出来的）：
 * 1. **可测试**：情绪这类"感觉"最容易变成调不动的黑箱，纯函数才能写"同一输入必然同一输出"的测试；
 * 2. **可复现**：同一份状态 + 同一组事件 + 同一时刻 ⇒ 逐位相同，不需要为了排查去重放对话；
 * 3. **不受进程影响**：没有定时器、没有心跳。衰减是**算出来的**，不是**攒出来的** ——
 *    进程关了、功能模式待了一周、跨月没打开，回到沉浸模式第一次读时一次补算到位。
 *
 * 这条纪律的出处：同类实现把「用 `setInterval` 每 30 秒 tick 驱动状态」明确列为反模式
 * （进程一停状态就死，还得维护守护进程），正确做法是存 `from/to` 两个时间戳一次算
 * （[dsh-serene 的 FRAMEWORK](https://github.com/chisato-lycoreco/dsh-serene)）。
 * @module humanity/emotion/state
 */
import {
  EMOTION_FLOOR,
  EMOTION_HALF_LIFE_MINUTES,
  EMOTION_MAX,
  EMOTION_TIERS,
  ENERGY_DAWN_HOUR,
  ENERGY_DAWN_RECOVERY,
  ENERGY_DRAIN_PER_HOUR,
  ENERGY_MAX,
  ENERGY_SLEEP_HOURS,
  MAX_CHARGES,
  SENSITIVITY_HALF_LIFE_MINUTES,
  WARMTH_BASELINE,
  WARMTH_HALF_LIFE_DAYS,
  type EmotionKind,
  type EmotionTarget,
  type EmotionTierId,
} from './constants.js'
import { decaySensitivity, isSting, recordSting, sensitivityFactor } from './sensitivity.js'
import type { EmotionCharge, EmotionState } from './types.js'

/** 一次情绪变化（由事件评估产出，或由对方在对话里直接触发）。 */
export interface EmotionShift {
  /** 哪一种情绪。 */
  kind: EmotionKind
  /**
   * 冲谁的（OCC 的归因）；省略时按 `world`（对事）处理。
   *
   * 为什么它是可选的：`world` 是最常见的一档（好消息、烦心事都不冲具体的人），
   * 让调用方每次都写一遍没有意义；只有真的要冲着谁时才必须写清楚。
   */
  target?: EmotionTarget
  /** 强度增量：正=加强，负=削弱（用来表达"被哄好了"）。 */
  delta: number
  /** 为什么（一句话）。空串表示"照旧，只是强度变了"。 */
  cause?: string
  /**
   * 这一笔是不是**记忆回声**（想起旧事带回一点温度）。
   *
   * 为什么需要标记：回声和本轮评估都会改同一条情绪，而 `cause` 只有一个位置。
   * 回声只是把旧温度带回来一点，**不该顶掉这一轮真正发生了什么** ——
   * 实测症状：召回了"她说信我"那条记忆，`cause` 却显示成评估给的原因，
   * 于是"想起过一件事"在这份状态里完全看不出来。
   */
  echo?: boolean
}

/**
 * 一次**完整的**评估结果：这一句话给她的全部影响。
 *
 * 为什么把三样东西装在一起，而不是分三次调用：它们来自同一次判断。
 * 分开写会出现"情绪动了、对方状态还停在三轮前"这种内部不一致的状态。
 */
export interface EmotionPulse {
  /** 情绪增减（最多几条，由评估侧约束）。 */
  shifts: readonly EmotionShift[]
  /** 关系温度增量（-5..5）；省略或 0 表示没变。 */
  warmth?: number
  /** 关系温度为什么动。 */
  warmthCause?: string
  /** 它对"对方此刻状态"的判断（空串=这次没看出来，**不覆盖**旧值）。 */
  perceived?: string
}

/** 分钟数 → 半衰期的剩余比例。 */
function remainingRatio(minutes: number, halfLifeMinutes: number): number {
  if (!Number.isFinite(minutes) || minutes <= 0) return 1
  if (!Number.isFinite(halfLifeMinutes) || halfLifeMinutes <= 0) return 0
  return Math.pow(0.5, minutes / halfLifeMinutes)
}

/** 合并键：种类 + 对象（对TA的愤怒与对自己的愤怒是两条）。 */
function chargeKey(kind: EmotionKind, target: EmotionTarget): string {
  return `${kind}:${target}`
}

/**
 * 某一时刻在指定时区里的**墙钟毫秒**（"把本地时间当成 UTC 来读"）。
 *
 * 为什么不直接用 `Date#getHours()`：那读的是**进程的**时区。2026-11-19 实机抓到的现场是 ——
 * 我们在同一个进程里把 `process.env.TZ` 改成了 `Asia/Shanghai`，`Intl` 立刻跟着变（工作台显示
 * 时区已经正确），但 `Date` 的本地时间**仍然是 UTC**：于是精力按 UTC 的"清晨"算，界面却显示
 * 时区没问题 —— 又一次"看起来对、算起来错"。
 *
 * 所以凡是会影响判断的时间换算，一律**显式传时区**、用 `Intl` 拿墙钟，不依赖进程的默认时区。
 * @param epochMs - 时刻（epoch 毫秒）。
 * @param timeZone - IANA 时区名。
 * @returns 该时区墙钟对应的"伪 UTC"毫秒（可直接做加减与取整）。
 */
function wallClockMs(epochMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(epochMs))
  const field = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? '0')
  // `hour12:false` 在部分 ICU 版本把午夜给成 "24"，折回 0 点（与 `schedule-time.ts` 同一处坑）。
  return Date.UTC(field('year'), field('month') - 1, field('day'), field('hour') % 24, field('minute'), field('second'))
}

/**
 * 数一数这段时间里跨过了几次清晨（`ENERGY_DAWN_HOUR` 点）。
 *
 * 为什么按"清晨次数"而不是按"小时数"：人不是匀速回血的机器，睡一觉才是分界线。
 * 累了一整天，跨过那一次清晨就应当明显恢复；而白天连开三小时会只会越开越累。
 *
 * 两种算法：
 * - **给了时区**（生产路径）：在"墙钟时间轴"上数 —— 与进程时区无关，换机器/换容器都一样；
 * - **没给时区**（老调用点/测试）：退回进程本地时间，用 `Date#setDate(+1)` 递增而不是
 *   `+= 86400000`，跨夏令时时后者会漂一小时。
 * @param fromMs - 起点（epoch 毫秒）。
 * @param toMs - 终点（epoch 毫秒）。
 * @param timeZone - 生效时区；省略则用进程时区。
 * @returns 跨过的清晨次数（0 表示这段时间里没睡过）。
 */
function dawnsBetween(fromMs: number, toMs: number, timeZone?: string): number {
  if (toMs <= fromMs) return 0
  const DAY = 86_400_000
  const dawnOffset = ENERGY_DAWN_HOUR * 3_600_000
  if (timeZone !== undefined) {
    const fromWall = wallClockMs(fromMs, timeZone)
    const toWall = wallClockMs(toMs, timeZone)
    if (toWall <= fromWall) return 0
    // 当天的清晨（墙钟时间轴上的 06:00）；不晚于起点就顺延一天。
    let cursor = Math.floor(fromWall / DAY) * DAY + dawnOffset
    if (cursor <= fromWall) cursor += DAY
    let count = 0
    // 上限保护：万一时间戳被手改成一个荒谬的未来值，不要在这儿转几万圈。
    while (cursor <= toWall && count < 3_660) {
      count += 1
      cursor += DAY
    }
    return count
  }
  const cursor = new Date(fromMs)
  cursor.setHours(ENERGY_DAWN_HOUR, 0, 0, 0)
  if (cursor.getTime() <= fromMs) cursor.setDate(cursor.getDate() + 1)
  let count = 0
  // 上限保护同上。
  while (cursor.getTime() <= toMs && count < 3_660) {
    count += 1
    cursor.setDate(cursor.getDate() + 1)
  }
  return count
}

/**
 * 结算精力：醒着消耗、每跨一次清晨恢复。
 *
 * 睡眠那段的消耗要扣掉，否则"睡了一觉"会变成"睡的时候也累"，恢复量被白吃掉。
 * @param energy - 结算前的精力。
 * @param minutes - 经过的分钟数。
 * @param fromMs - 起点（epoch 毫秒）。
 * @param toMs - 终点（epoch 毫秒）。
 * @param timeZone - 生效时区（省略则用进程时区）。
 * @returns 结算后的精力（0–`ENERGY_MAX`）。
 */
function settleEnergy(
  energy: number,
  minutes: number,
  fromMs: number,
  toMs: number,
  timeZone?: string,
): number {
  const hours = minutes / 60
  const dawns = dawnsBetween(fromMs, toMs, timeZone)
  const sleepHours = Math.min(hours, dawns * ENERGY_SLEEP_HOURS)
  const awakeHours = Math.max(0, hours - sleepHours)
  const next = energy - awakeHours * ENERGY_DRAIN_PER_HOUR + dawns * ENERGY_DAWN_RECOVERY
  return Math.max(0, Math.min(ENERGY_MAX, next))
}

/**
 * 把状态结算到 `now`：强度按各自半衰期衰减，关系温度向基线回归。
 *
 * **时间单调**：`now` 不晚于 `settledAt`（时钟回拨、并发读、两次结算同一时刻）时原样返回，
 * 不做任何计算。宁可少算一次，也不允许"倒着算"把强度算大。
 * @param state - 当前状态。
 * @param now - 要结算到的时刻（ISO 8601）。
 * @param timeZone - 生效时区（决定"清晨"落在几点；省略则用进程时区）。
 * @returns 结算后的新状态（`settledAt` 前移；`updatedAt` 不动 —— 衰减不是变化）。
 */
export function settle(state: EmotionState, now: string, timeZone?: string): EmotionState {
  const from = Date.parse(state.settledAt)
  const to = Date.parse(now)
  /**
   * 起点丢失（空串 / 坏值）：把结算点补成现在，**不要**提前返回。
   *
   * 这一条是实测抓出来的：存储里曾经出现 `settledAt: ""` 的状态，于是每次结算都在这里
   * 提前返回，情绪**永远不会衰减** —— 表面上一切正常（数据读得出来、页面也显示），
   * 实际上是强度条被冻在那儿。缺失的起点只能当作"从这一刻起算"，没有别的选择。
   */
  if (!Number.isFinite(from)) return { ...state, settledAt: now }
  if (!Number.isFinite(to) || to <= from) return state

  const minutes = (to - from) / 60_000
  const charges: EmotionCharge[] = []
  for (const charge of state.charges) {
    const intensity = charge.intensity * remainingRatio(minutes, EMOTION_HALF_LIFE_MINUTES[charge.kind])
    // 低于地板就丢掉：留着一条 0.4 的残渣会让"平静"永远不成立。
    if (intensity < EMOTION_FLOOR) continue
    charges.push({ ...charge, intensity })
  }

  // 关系温度向基线回归（不是降到 0：它本来就该有个"默认的亲近度"）。
  const warmthRatio = remainingRatio(minutes, WARMTH_HALF_LIFE_DAYS * 24 * 60)
  const warmth = WARMTH_BASELINE + (state.warmth - WARMTH_BASELINE) * warmthRatio

  return {
    ...state,
    charges,
    /**
     * 敏感化的痕迹用**另一个**半衰期：它要比情绪本身耐用（见 `constants.ts` 的说明）。
     * 与情绪强度共用同一个"剩余比例"公式，免得两处各写一遍幂运算。
     */
    sensitivities: decaySensitivity(
      state.sensitivities,
      remainingRatio(minutes, SENSITIVITY_HALF_LIFE_MINUTES),
    ),
    warmth,
    energy: settleEnergy(state.energy, minutes, from, to, timeZone),
    settledAt: now,
  }
}

/**
 * 施加一次评估结果。**先结算再叠加**，所以"两个小时后补一次事件"和"当时就补"结果一致
 * （差在半衰期的中间段，这正是不该被忽略的部分）。
 * @param state - 当前状态（最好是已结算到 `now` 的）。
 * @param pulse - 这一次的变化；空脉冲（没有情绪、没有温度、没有观察）会被判成"没变化"。
 * @param now - 事件发生的时刻。
 * @param timeZone - 生效时区（透传给结算；省略则用进程时区）。
 * @returns 新状态；没有任何变化时**原样返回入参**（调用方据此跳过一次落盘）。
 */
export function apply(state: EmotionState, pulse: EmotionPulse, now: string, timeZone?: string): EmotionState {
  const hasShift = pulse.shifts.length > 0
  const hasWarmth = pulse.warmth !== undefined && pulse.warmth !== 0
  const hasPerceived = pulse.perceived !== undefined && pulse.perceived !== ''
  // 三样都没动 ⇒ 这不是一次变化。返回**同一个对象**，让调用方能用引用相等判断。
  if (!hasShift && !hasWarmth && !hasPerceived) return state

  const settled = settle(state, now, timeZone)
  /**
   * 按 **种类 + 对象** 合并：同一轮里"对TA生气"和"对自己生气"是两条，
   * 而重复的"对TA生气"才叠加。少了对象这一维，两种完全不同的生气会被并成一条。
   */
  const byKey = new Map<string, EmotionCharge>()
  for (const charge of settled.charges) byKey.set(chargeKey(charge.kind, charge.target), { ...charge })

  /** 本轮**真的被改到**的 key（用来标记"当下这件事"，见 `EmotionState.lastTouched`）。 */
  const touched = new Set<string>()
  /**
   * 本轮这些地方**被刺痛**过 → 刺激的原始大小（记账用，见 `sensitivity.ts`）。
   *
   * 为什么按 key 去重：一条脉冲 = 一次事件。评估偶尔会给同一处两条增减（"愤怒 +15、愤怒 +10"），
   * 那仍然是一件事，记两次账等于把一次伤害当成两次。取绝对值最大的那笔当刺激大小，
   * 于是结果不受 shift 的排列顺序影响（`apply` 的可复现性不靠调用方的书写顺序）。
   */
  const stings = new Map<string, { kind: EmotionKind; target: EmotionTarget; delta: number }>()

  for (const shift of pulse.shifts) {
    const target = shift.target ?? 'world'
    const k = chargeKey(shift.kind, target)
    const existing = byKey.get(k)
    const current = existing?.intensity ?? 0
    /**
     * **敏感化**：同一处被反复刺痛之后，这一笔增量会更重（`sensitivity.ts` 说明依据与边界）。
     *
     * 两条限制都写在这一行里：
     * - 只放大"被刺痛"的那一向 —— 被哄好的那一笔不该放大，好事更不该；
     * - 回声不放大，也不记账 —— 想起一件事不是又发生了一次。
     */
    const sting = shift.echo !== true && isSting(shift.kind, shift.delta)
    const delta = sting ? shift.delta * sensitivityFactor(settled.sensitivities, shift.kind, target) : shift.delta
    /**
     * **边际递减**：强度越高，同样的好话效果越小。
     *
     * 实测抓到的：连夸三轮，信任 55→67→87→99，增量 +12 → +20 → +12。
     * 没有任何递减 —— 而真实的人被连夸三次，第三次基本只剩"嗯"。
     *
     * 形式用"剩余空间"比例而不是拍一个衰减系数：`delta × (上限 − 当前) / 上限`。
     * 它在数学上让强度**渐近**于 100 而不真的到 —— 这正合常识：
     * 情绪可以满，但不会真的"满格"（真满格了就再也没法更高兴了）。
     *
     * ⚠️ 只对**增强**打折。削弱不打折：坏消息一向是全额生效的，
     * 而且打折会让"哄回来"变得很慢 —— 那不符合"气消得快"的观察。
     */
    const gain = delta > 0 ? delta * ((EMOTION_MAX - current) / EMOTION_MAX) : delta
    const next = current + gain
    const intensity = Math.max(0, Math.min(EMOTION_MAX, next))
    touched.add(k)
    // 刺痛记账：即使这一笔把情绪削到消失（"开心被浇灭"）也照样算一次伤害。
    if (sting) {
      const seen = stings.get(k)
      if (seen === undefined || Math.abs(shift.delta) > Math.abs(seen.delta)) {
        stings.set(k, { kind: shift.kind, target, delta: shift.delta })
      }
    }
    /**
     * 回声只加强度，不改原因 —— 除非这条情绪本来就没有原因（那就用回声的"想起「…」"）。
     * 理由：`cause` 要回答的是"它此刻为什么是这样"，而这一轮真正发生的事更有解释力。
     */
    const cause = shift.echo === true && existing !== undefined && existing.cause !== ''
      ? existing.cause
      : shift.cause !== undefined && shift.cause !== ''
        ? shift.cause
        : (existing?.cause ?? '')
    // 归零即移除：`intensity` 已经 clamp 到 0，"还剩 0"和"没有"是同一件事。
    if (intensity < EMOTION_FLOOR) {
      byKey.delete(k)
      // 被削到消失的那条不算"当下这件事"：它已经不在了。
      touched.delete(k)
      continue
    }
    byKey.set(k, {
      kind: shift.kind,
      target,
      intensity,
      cause,
      // `since` 只在新建或原因变化时刷新：同一件事持续加强不该显示成"刚刚发生"。
      since: existing !== undefined && cause === existing.cause ? existing.since : now,
    })
  }

  const warmth = pulse.warmth === undefined
    ? settled.warmth
    : Math.max(0, Math.min(EMOTION_MAX, settled.warmth + pulse.warmth))
  const warmthCause = pulse.warmthCause !== undefined && pulse.warmthCause !== ''
    ? pulse.warmthCause
    : settled.warmthCause

  const kept = clampCharges([...byKey.values()])

  /**
   * 把本轮的刺痛记进痕迹。**循环放在最后**：放大系数一律读"记账前"的那份痕迹，
   * 所以这一次的伤害不会给自己当放大器（否则同一笔事件会被放两次）。
   * 用**原始增量**记账，同理：不能把放大后的结果再记回去（那会形成正反馈）。
   */
  let sensitivities = settled.sensitivities
  for (const sting of stings.values()) {
    sensitivities = recordSting(sensitivities, sting.kind, sting.target, sting.delta)
  }

  return {
    ...settled,
    charges: kept,
    /**
     * 记下本轮动过哪些情绪：渲染时它们豁免被对冲压制（见 `EmotionState.lastTouched`）。
     *
     * 必须**在裁剪之后**再按实际留下的条目过滤一遍：裁剪是"超过四条时丢掉最弱的"，
     * 被丢掉的那条如果还留在名单里，就成了一条指向不存在情绪的脏 key（实测抓到过）。
     */
    lastTouched: [...touched].filter((key) =>
      kept.some((charge) => chargeKey(charge.kind, charge.target) === key),
    ),
    sensitivities,
    warmth,
    warmthCause,
    // 观察为空表示"这次没看出来"，不该把上一轮读到的对方状态擦掉。
    perceived: hasPerceived ? pulse.perceived ?? '' : settled.perceived,
    perceivedAt: hasPerceived ? now : settled.perceivedAt,
    updatedAt: now,
  }
}

/**
 * 按强度裁剪到并存上限（{@link MAX_CHARGES}）。
 *
 * 八种情绪 × 三个对象最多 24 条、上限只有 {@link MAX_CHARGES} 条，所以这个函数是**真的会走到**的。
 * 超过上限时保留最强的几条：多出来的往往是被这一轮带起来的边角情绪，
 * 该被牺牲的是最弱的那条，不该是整份状态。
 * @param charges - 待裁剪的情绪。
 * @returns 原数组（没超上限时不动）或按强度降序的前 `MAX_CHARGES` 条。
 */
function clampCharges(charges: EmotionCharge[]): EmotionCharge[] {
  if (charges.length <= MAX_CHARGES) return charges
  return [...charges].sort((a, b) => b.intensity - a.intensity).slice(0, MAX_CHARGES)
}

/**
 * 强度落在哪一档（取"强度 ≥ at 的最高一档"）。
 * @param intensity - 强度 0–100。
 * @returns 档位 id。
 */
export function tierOf(intensity: number): EmotionTierId {
  let tier: EmotionTierId = 'calm'
  for (const entry of EMOTION_TIERS) {
    if (intensity >= entry.at) tier = entry.id
  }
  return tier
}

/**
 * 当前**主导**情绪（最强的一条）。
 *
 * 主导不是"唯一"：其余几条仍然参与渲染（`describe` 会带上第二名），因为
 * "又气又委屈"的关键就在"又"。这里只回答"谁在领头"。
 * @param state - 当前状态。
 * @returns 最强的一条；没有情绪时为 `undefined`。
 */
export function dominantOf(state: EmotionState): EmotionCharge | undefined {
  let leader: EmotionCharge | undefined
  for (const charge of state.charges) {
    if (leader === undefined || charge.intensity > leader.intensity) leader = charge
  }
  return leader
}
