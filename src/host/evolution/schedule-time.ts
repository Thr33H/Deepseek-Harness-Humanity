/**
 * 定时计算：把「每日/每周/每月 + 时刻 + 时区」折成下一次的 epoch 毫秒（纯函数，可注入时钟）。
 *
 * 跨平台纪律（G-006）：只用 `Intl.DateTimeFormat` 与 `Date` 的 UTC 面——不碰系统命令、
 * 不依赖宿主时区数据库之外的东西。时区名非法/时刻非法**都不抛**：回退默认并回调警告，
 * 调度器路径上抛错等于整个模块停摆（G-002 精神：降级 + 说清楚）。
 *
 * DST 处理：先在「时区墙钟 = UTC + 偏移」的伪 UTC 轴上算出目标墙钟时刻，
 * 再用**目标时刻附近的偏移**换算回 epoch（一次迭代足够：偏移在目标点重取，
 * 夏令时切换日最多差一小时，差值会被下一次 reconcile 收敛）。
 */
import type { ScheduleMode } from '../config.js'

/** 调度配置（`modules.evolution.schedule` 的形状）。 */
export interface ScheduleConfig {
  mode: ScheduleMode
  idleMinutes: number
  /** 触发时刻（HH:MM，按时区解释）。 */
  timeOfDay: string
  /** 每周：周几（1=周一 … 7=周日）。 */
  weekday: number
  /** 每月：几号（1–28，schema 层限定，避开大小月与闰月差异）。 */
  monthDay: number
  /** IANA 时区名；空串 = 系统时区。 */
  timezone: string
}

/** 默认触发时刻（与 config.ts schema 的默认值一致：P-035 工程默认）。 */
const FALLBACK_TIME = { hour: 3, minute: 0 }

/** 解析 HH:MM；非法回退默认并警告（不抛）。 */
function parseTimeOfDay(value: string, warn?: (message: string) => void): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (match !== null) {
    const hour = Number(match[1])
    const minute = Number(match[2])
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) return { hour, minute }
  }
  warn?.(`定时触发时刻「${value}」不合法（期望 HH:MM），本次按 03:00 计算`)
  return FALLBACK_TIME
}

/** 时区名可用性探测：Intl 构造抛 RangeError 即非法；返回 undefined = 用系统时区。 */
function resolveTimezone(name: string, warn?: (message: string) => void): string | undefined {
  if (name.trim() === '') return undefined
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name })
    return name
  } catch {
    warn?.(`时区「${name}」无法识别，本次按系统时区计算`)
    return undefined
  }
}

/** 某时刻在指定时区的「墙钟 − UTC」偏移毫秒（undefined 时区 = 系统时区）。 */
function tzOffsetMs(epochMs: number, timezone?: string): number {
  if (timezone === undefined) return -new Date(epochMs).getTimezoneOffset() * 60000
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(epochMs))
  const field = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? '0')
  // hour12:false 的午时在部分 ICU 版本给 "24"：折回 0 点。
  const wallUtc = Date.UTC(field('year'), field('month') - 1, field('day'), field('hour') % 24, field('minute'), field('second'))
  return wallUtc - (epochMs - (epochMs % 1000))
}

/** 在伪 UTC 轴（墙钟）上把"下一个触发时刻"算出来。 */
function nextWallTarget(wallMs: number, schedule: ScheduleConfig, time: { hour: number; minute: number }): number {
  const wall = new Date(wallMs)
  wall.setUTCHours(time.hour, time.minute, 0, 0)

  if (schedule.mode === 'daily') {
    if (wall.getTime() <= wallMs) wall.setUTCDate(wall.getUTCDate() + 1)
    return wall.getTime()
  }
  if (schedule.mode === 'weekly') {
    const isoDay = wall.getUTCDay() === 0 ? 7 : wall.getUTCDay()
    const weekday = Math.min(7, Math.max(1, Math.trunc(schedule.weekday) || 1))
    wall.setUTCDate(wall.getUTCDate() + ((weekday - isoDay + 7) % 7))
    if (wall.getTime() <= wallMs) wall.setUTCDate(wall.getUTCDate() + 7)
    return wall.getTime()
  }
  // monthly：monthDay 限定 1–28，任何月份都存在这一天，不需要月末裁剪。
  const monthDay = Math.min(28, Math.max(1, Math.trunc(schedule.monthDay) || 1))
  wall.setUTCDate(monthDay)
  if (wall.getTime() <= wallMs) wall.setUTCMonth(wall.getUTCMonth() + 1)
  return wall.getTime()
}

/**
 * 计算下一次定时触发（严格晚于 `fromMs`）。
 * @param schedule - 调度配置。
 * @param fromMs - 起算时刻（epoch 毫秒）。
 * @param warn - 配置非法时的一次性告警出口。
 * @returns epoch 毫秒；`mode='idle'` 时返回 0（没有定时触发这回事）。
 */
export function computeNextRunAt(schedule: ScheduleConfig, fromMs: number, warn?: (message: string) => void): number {
  if (schedule.mode === 'idle') return 0
  const time = parseTimeOfDay(schedule.timeOfDay, warn)
  const timezone = resolveTimezone(schedule.timezone, warn)

  const offset = tzOffsetMs(fromMs, timezone)
  const wallTarget = nextWallTarget(fromMs + offset, schedule, time)
  // 用目标时刻附近的偏移换算回 epoch（DST 一次迭代收敛，见文件头）。
  const approximate = wallTarget - offset
  return wallTarget - tzOffsetMs(approximate, timezone)
}

/**
 * epoch 毫秒 → UTC 日期串（`YYYY-MM-DD`）。
 *
 * ⚠️ 只在**拿不到调度配置**时兜底。展示与记账一律用 {@link dayKeyOf}：调度按
 * `schedule.timezone` 解释「每天」，UTC 日期与它对不上（2026-09-26 审计 E5）。
 */
export function utcDateOf(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10)
}

/** 两位数补零。 */
const pad2 = (value: number): string => String(value).padStart(2, '0')

/**
 * epoch 毫秒 → **调度时区**里的日期串（`YYYY-MM-DD`）。
 *
 * 为什么不能用 `toISOString().slice(0, 10)`（2026-09-26 审计 E5）：那是 **UTC** 日期，而调度
 * 按 `schedule.timezone` 解释"每天几点"。容器在 CST（UTC+8）时，UTC 日期要到北京时间 08:00
 * 才翻页 —— 工作台的「今日用量」会在早上 8 点突然归零，而 03:00 那次定时运行被算进**前一个
 * UTC 日**：每日上限的窗口与用户以为的"今天"整整错开 8 小时。
 *
 * 记账（`run-loop`）与展示（`section-runtime`）必须用**同一个键**，否则还会出现
 * "界面显示今天用了 0 次、实际已经用满"这种自相矛盾的状态。
 * @param epochMs - 时刻（epoch 毫秒）。
 * @param schedule - 调度配置（只取 `timezone`）；形状不全时按系统时区算（不抛）。
 * @param warn - 时区名非法时的告警出口。
 * @returns `YYYY-MM-DD`；时区为空串或非法时按**系统时区**算。
 */
export function dayKeyOf(
  epochMs: number,
  schedule: ScheduleConfig | undefined,
  warn?: (message: string) => void,
): string {
  const timezone = resolveTimezone(schedule?.timezone ?? '', warn)
  if (timezone === undefined) {
    // 系统时区：用本地字段拼 —— `toISOString()` 在这里正好是错的那一个（它就是 UTC）。
    const local = new Date(epochMs)
    return `${local.getFullYear()}-${pad2(local.getMonth() + 1)}-${pad2(local.getDate())}`
  }
  // 墙钟 = UTC + 偏移：加上偏移之后再取 UTC 字段，得到的就是该时区的墙上日期。
  return new Date(epochMs + tzOffsetMs(epochMs, timezone)).toISOString().slice(0, 10)
}

/** 定时模式的运行形态：每周/每月是长窗口（梦境），每日是增量（DEV-PLAN §4 工程默认）。 */
export function modeForSchedule(schedule: ScheduleConfig): 'incremental' | 'dream' {
  return schedule.mode === 'weekly' || schedule.mode === 'monthly' ? 'dream' : 'incremental'
}
