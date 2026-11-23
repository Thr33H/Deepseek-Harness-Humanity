/**
 * 她自己的时间的**状态**：房间任务、上次醒来、今天醒了几次、下一次排在哪。
 *
 * 为什么存在文档表里而不是新开一张表：这是一份单值状态（整个套件只有一份），
 * 加表要动数据代数与迁移链，而文档表本来就是"长期持有的一份内容"。
 * @module humanity/evolution/state
 */
import type { DocumentStore } from '../documents.js'
import { EVOLUTION_DOC_KEY, MIN_GAP_SECONDS, NEXT_MORNING_HOUR } from './constants.js'

/** 状态文档的形状。空串/0 是"还没有"的唯一判据，不引入 null。 */
export interface EvolutionStateDoc {
  /** 房间里那个调度任务的 id（空串 = 还没建）。 */
  taskId: string
  /** 房间的会话 id（第一次投递后才有）。 */
  roomSessionId: string
  /** 上一次醒来（ISO 8601）。 */
  lastWakeAt: string
  /** 下一次预定醒来（ISO 8601；空串 = 没排）。 */
  nextAt: string
  /** `dayCount` 属于哪一天（YYYY-MM-DD，按她的时区）。 */
  dayKey: string
  /** 那天已经醒了几次。 */
  dayCount: number
  /**
   * 上一次排程失败的原因（空串 = 最近一次是成功的）。
   *
   * 为什么要落盘：真机上插件的日志**进不了 `docker logs`**（`log.ts` 有条实测记录）。
   * 排程失败如果只写日志，等于"她没有自己的日子"而没人知道为什么 —— 这份状态是唯一
   * 能被外部读到的证据，也是以后工作台那一行状态的数据源。
   */
  lastError: string
  /** 上一次尝试排程的时刻（ISO 8601）。 */
  lastAttemptAt: string
}

/** 还没开始过的状态。 */
export const EMPTY_STATE: EvolutionStateDoc = {
  taskId: '',
  roomSessionId: '',
  lastWakeAt: '',
  nextAt: '',
  dayKey: '',
  dayCount: 0,
  lastError: '',
  lastAttemptAt: '',
}

/** 醒来的节奏参数（配置的现读镜像）。 */
export interface WakeRhythm {
  /** 一天最多醒几次（0 = 不主动醒）。 */
  maxPerDay: number
  /** 两次之间的最短间隔（分钟）。 */
  minGapMinutes: number
  /** 两次之间的最长间隔（分钟）。 */
  maxGapMinutes: number
}

/**
 * 读状态（没写过就是 `EMPTY_STATE`）。
 * @param documents - 文档表句柄；存储未就绪时为 `undefined`。
 * @returns 状态（字段逐个兜底：老文档缺字段时不会变成 `undefined`）。
 */
export function readState(documents: DocumentStore | undefined): EvolutionStateDoc {
  const value = documents?.read(EVOLUTION_DOC_KEY)?.value
  if (typeof value !== 'object' || value === null) return EMPTY_STATE
  const raw = value as Partial<Record<keyof EvolutionStateDoc, unknown>>
  const text = (key: keyof EvolutionStateDoc): string => {
    const candidate = raw[key]
    return typeof candidate === 'string' ? candidate : ''
  }
  const count = typeof raw.dayCount === 'number' && Number.isFinite(raw.dayCount) ? raw.dayCount : 0
  return {
    taskId: text('taskId'),
    roomSessionId: text('roomSessionId'),
    lastWakeAt: text('lastWakeAt'),
    nextAt: text('nextAt'),
    dayKey: text('dayKey'),
    dayCount: Math.max(0, Math.trunc(count)),
    lastError: text('lastError'),
    lastAttemptAt: text('lastAttemptAt'),
  }
}

/**
 * 整份写回。
 *
 * 为什么是整份 `write` 而不是 `merge`：这份文档在旧版本里被旧引擎的投影占用过
 * （`runs`/`proposals`/`status` …）。整份写回会把那些已经没人读的字段一次清掉；
 * 深合并则会永久留着它们，而且"状态里到底有哪些字段"会变得说不清。
 * @param documents - 文档表句柄；未就绪时什么也不做（下一次会重算）。
 * @param state - 完整状态。
 */
export async function saveState(documents: DocumentStore | undefined, state: EvolutionStateDoc): Promise<void> {
  if (documents === undefined) return
  await documents.write(EVOLUTION_DOC_KEY, state)
}

/**
 * 某个时刻在她的时区里是哪一天。
 *
 * 为什么不用 `toISOString().slice(0,10)`：那是 UTC 的日期。凌晨 00:30 和清晨 06:00
 * 在 UTC 上是同一天、在东八区上是两天 —— 情绪那边的"清晨"已经踩过同一个坑。
 * @param iso - ISO 8601 时刻。
 * @param timeZone - IANA 时区；缺省用进程时区（已由 `clock.ts` 校准）。
 * @returns `YYYY-MM-DD`；时刻解析不出来时返回空串。
 */
export function dayKeyOf(iso: string, timeZone?: string): string {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return ''
  const format = (zone?: string): string =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(at)
  try {
    return format(timeZone)
  } catch {
    // 时区名坏了（用户手填错）不该让整条作息崩掉：退回进程时区。
    return format(undefined)
  }
}

/** 某个时刻在她的时区里是几点几分。 */
function localClock(iso: string, timeZone?: string): { hour: number; minute: number } | undefined {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return undefined
  const format = (zone?: string): Intl.DateTimeFormatPart[] =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(at)
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = format(timeZone)
  } catch {
    parts = format(undefined)
  }
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '')
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '')
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return undefined
  return { hour, minute }
}

/** 从现在到明天早上（`NEXT_MORNING_HOUR` 点）还有多少秒。 */
function secondsToMorning(iso: string, timeZone?: string): number {
  const clock = localClock(iso, timeZone)
  if (clock === undefined) return 12 * 3_600
  const nowMinutes = clock.hour * 60 + clock.minute
  const target = NEXT_MORNING_HOUR * 60
  const until = target > nowMinutes ? target - nowMinutes : target - nowMinutes + 24 * 60
  return Math.max(MIN_GAP_SECONDS, until * 60)
}

/**
 * 下一次醒来该隔多久。
 *
 * 三条规矩：
 * 1. 今天的次数到了上限 ⇒ 等到明天早上（**上限不是配额**：到了就停，不补、不凑）；
 * 2. 平时在 `[minGap, maxGap]` 之间随机取 —— 定时就变成打卡；
 * 3. 一切结果都夹到 DSH 要求的最小投递间隔以上。
 * @param state - 当前状态（算"今天醒了几次"要用）。
 * @param rhythm - 节奏参数。
 * @param nowIso - 现在（ISO 8601）。
 * @param timeZone - 她的时区。
 * @param random - 随机源（测试注入固定值）。
 * @returns 间隔秒数；`undefined` = 不该再排（例如上限为 0）。
 */
export function nextGapSeconds(
  state: EvolutionStateDoc,
  rhythm: WakeRhythm,
  nowIso: string,
  timeZone?: string,
  random: () => number = Math.random,
): number | undefined {
  if (rhythm.maxPerDay <= 0) return undefined
  const day = dayKeyOf(nowIso, timeZone)
  const used = day !== '' && state.dayKey === day ? state.dayCount : 0
  if (used >= rhythm.maxPerDay) return secondsToMorning(nowIso, timeZone)
  const low = Math.max(MIN_GAP_SECONDS / 60, Math.min(rhythm.minGapMinutes, rhythm.maxGapMinutes))
  const high = Math.max(low, Math.max(rhythm.minGapMinutes, rhythm.maxGapMinutes))
  const minutes = low + random() * (high - low)
  return Math.max(MIN_GAP_SECONDS, Math.round(minutes * 60))
}

/**
 * 走一次"醒来"的记账。
 * @param state - 醒来之前的状态。
 * @param nowIso - 这一刻。
 * @param timeZone - 她的时区。
 * @returns 改完的字段（`dayKey`/`dayCount`/`lastWakeAt`）。
 */
export function afterWake(
  state: EvolutionStateDoc,
  nowIso: string,
  timeZone?: string,
): Pick<EvolutionStateDoc, 'dayKey' | 'dayCount' | 'lastWakeAt'> {
  const day = dayKeyOf(nowIso, timeZone)
  const count = day !== '' && state.dayKey === day ? state.dayCount + 1 : 1
  return { dayKey: day, dayCount: count, lastWakeAt: nowIso }
}
