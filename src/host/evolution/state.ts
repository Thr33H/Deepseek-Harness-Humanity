/**
 * 她自己的时间的**状态**：房间任务、上次醒来、今天醒了几次、下一次排在哪。
 *
 * 为什么存在文档表里而不是新开一张表：这是一份单值状态（整个套件只有一份），
 * 加表要动数据代数与迁移链，而文档表本来就是"长期持有的一份内容"。
 * @module humanity/evolution/state
 */
import type { DocumentStore } from '../documents.js'
import {
  EVOLUTION_DOC_KEY,
  MIN_GAP_SECONDS,
  NEXT_MORNING_HOUR,
  NOTES_DOC_KEY,
  NOTES_MAX_LINES,
  TALK_MAX_LINES,
} from './constants.js'

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
  /** 精力（0–100）。 */
  energy: number
  /** 精力上一次结算的时刻（ISO 8601）。 */
  energyAt: string
  /** 什么时候睡下的（ISO 8601；空串 = 醒着）。 */
  sleepingSince: string
  /** `tokensDayKey` 那天花掉多少加权 token。 */
  tokensToday: number
  /** `tokensToday` 属于哪一天。 */
  tokensDayKey: string
  /**
   * 上一次排程失败的原因（空串 = 最近一次是成功的）。
   *
   * 为什么要落盘：真机上插件的日志**进不了 `docker logs`**（`log.ts` 有条实测记录）。
   * 排程失败如果只写日志，等于"她没有自己的日子"而没人知道为什么 —— 这份状态是唯一
   * 能被外部读到的证据，也是以后工作台那一行状态的数据源。
   */
  lastError: string
  /**
   * 睡前收账最后失败的原因（空串 = 没失败过）。
   *
   * 为什么要单独记：收账是后台异步跑的，失败只进日志 —— 而日志不落到 docker logs，
   * 于是一篇没写成的日记会**完全没有痕迹**。
   */
  lastSettleError: string
  /**
   * 上一轮醒来她调了几次工具（0 = 只说了话）。
   *
   * 为什么要记：她"说了要做却没动手"是这一块最大的未解问题。把它记进状态，
   * 工作台就能如实显示"她上一轮到底做了什么"，不必去翻会话文件。
   */
  lastTurnTools: number
  /**
   * 闹钟从什么时候起被"你在别处说话"压住（空串 = 没被压）。
   *
   * 单线程有个副作用：你只要不断地说，她就永远没有自己的时间。
   * 把起点记下来，工作台才说得清"已经被压了多久"。
   */
  busySince: string
  /**
   * 上一次自评的结果（`kind:count:targets`；空串 = 没跑过）。
   *
   * 为什么要记：她独处时的自评原来只写日志，而日志看不见 ——
   * "她看了却没感觉"与"这条路坏了"在外面分不出来（2026-11-24 真机）。
   */
  lastAppraise: string
  /** 上一次尝试排程的时刻（ISO 8601）。 */
  lastAttemptAt: string
  /**
   * 他最近在哪个会话里跟她说话（空串 = 还没说过）。
   *
   * 「她主动找你说一句」要送到这里：送到她自己的房间没有意义 —— 他不在那儿。
   */
  talkSessionId: string
  /** 那个会话第一次被记下的时刻（ISO 8601）。 */
  talkSeenAt: string
  /**
   * 房间名字最近一次对齐的结果（人话）。
   *
   * 为什么要落到状态里：这个部署里插件的日志进不了 `docker logs`，
   * 而"名字没改成"的三种原因（服务不在 / 会话不活 / 名字非法）下一步完全不同，
   * 状态文档是外部唯一读得到的地方。
   */
  roomTitleNote: string
  /**
   * 现在这个房间会话属于哪一天（YYYY-MM-DD）。
   *
   * 为什么要有：她的房间**每天是一个新会话**（写完日记，这一天就收口）。
   * 靠它判断"今天要不要开新会话"，以及"旧的那个该结束了"。
   */
  roomDay: string
}

/** 还没开始过的状态。 */
export const EMPTY_STATE: EvolutionStateDoc = {
  taskId: '',
  roomSessionId: '',
  lastWakeAt: '',
  nextAt: '',
  dayKey: '',
  dayCount: 0,
  energy: 80,
  energyAt: '',
  sleepingSince: '',
  tokensToday: 0,
  tokensDayKey: '',
  lastError: '',
  lastSettleError: '',
  lastTurnTools: 0,
  busySince: '',
  lastAppraise: '',
  lastAttemptAt: '',
  talkSessionId: '',
  talkSeenAt: '',
  roomTitleNote: '',
  roomDay: '',
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
    energy: typeof raw.energy === 'number' && Number.isFinite(raw.energy) ? Math.max(0, Math.min(100, raw.energy)) : 80,
    energyAt: text('energyAt'),
    sleepingSince: text('sleepingSince'),
    tokensToday: typeof raw.tokensToday === 'number' && Number.isFinite(raw.tokensToday) && raw.tokensToday > 0 ? raw.tokensToday : 0,
    tokensDayKey: text('tokensDayKey'),
    lastError: text('lastError'),
    lastSettleError: text('lastSettleError'),
    busySince: text('busySince'),
    lastAppraise: text('lastAppraise'),
    lastTurnTools: typeof raw.lastTurnTools === 'number' && Number.isFinite(raw.lastTurnTools) ? Math.max(0, Math.trunc(raw.lastTurnTools)) : 0,
    lastAttemptAt: text('lastAttemptAt'),
    talkSessionId: text('talkSessionId'),
    talkSeenAt: text('talkSeenAt'),
    roomTitleNote: text('roomTitleNote'),
    roomDay: text('roomDay'),
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
 * 当天材料的本子。
 *
 * 为什么落盘：材料原来只在内存里，而真机上一天要重启十几次 —— 她明明说过话，
 * 睡前收账时手上却是空的，于是那一天既没日记也没人知道为什么。落盘之后重启不再丢她的一天。
 *
 * 为什么分两栏：**她自己的时间**（她在房间里说的话、看到的东西）与**你们的对话**
 * （沉浸会话里两个人这一天说过的话）是两种材料。日记写的是"她这一天"，两栏都要进；
 * 但分开存，才能说清"这一天她有没有自己的时间"，也才好控制两边各占多少。
 */
export interface NotesDoc {
  /** 这些材料属于哪一天（`YYYY-MM-DD`，她的时区；空串 = 本子空着）。 */
  day: string
  /** 她自己的时间：她在房间里说过的话、看到的东西。 */
  hers: string[]
  /** 你们的对话：沉浸会话里这一天说过的话（她那一侧与对方那一侧）。 */
  talk: string[]
  /** 最后一笔材料是什么时候记的（ISO 8601）。 */
  lastAt: string
}

/** 空本子。 */
export const EMPTY_NOTES: NotesDoc = { day: '', hers: [], talk: [], lastAt: '' }

/** 一行材料都还没记。 */
export function isEmptyNotes(notes: NotesDoc): boolean {
  return notes.hers.length === 0 && notes.talk.length === 0
}

/** 两栏加起来几行（判"有没有材料"只看这个数）。 */
export function noteCountOf(notes: NotesDoc): number {
  return notes.hers.length + notes.talk.length
}

/**
 * 读材料本子。
 *
 * 兼容两种旧形状：0.8.1 的 `{ day, count }`（只有条数、没有正文）读成空本子 ——
 * 不拿一个数字冒充材料；0.8.2 的 `{ day, lines }` 读成"她自己的时间"那一栏。
 * @param documents - 文档表句柄；未就绪时按空本子算。
 * @returns 本子（没有正文的一律当空）。
 */
export function readNotes(documents: DocumentStore | undefined): NotesDoc {
  const value = documents?.read(NOTES_DOC_KEY)?.value
  if (typeof value !== 'object' || value === null) return EMPTY_NOTES
  const raw = value as { day?: unknown; hers?: unknown; talk?: unknown; lines?: unknown; lastAt?: unknown }
  const text = (candidate: unknown): string[] =>
    Array.isArray(candidate)
      ? candidate.filter((line): line is string => typeof line === 'string' && line.trim() !== '')
      : []
  const hers = text(raw.hers ?? raw.lines).slice(-NOTES_MAX_LINES)
  const talk = text(raw.talk).slice(-TALK_MAX_LINES)
  if (hers.length === 0 && talk.length === 0) {
    return { day: '', hers: [], talk: [], lastAt: typeof raw.lastAt === 'string' ? raw.lastAt : '' }
  }
  return {
    day: typeof raw.day === 'string' ? raw.day : '',
    hers,
    talk,
    lastAt: typeof raw.lastAt === 'string' ? raw.lastAt : '',
  }
}

/**
 * 写材料本子。
 * @param documents - 文档表句柄；未就绪时什么也不做。
 * @param doc - 完整本子。
 */
export async function saveNotes(documents: DocumentStore | undefined, doc: NotesDoc): Promise<void> {
  if (documents === undefined) return
  await documents.write(NOTES_DOC_KEY, {
    day: doc.day,
    hers: [...doc.hers],
    talk: [...doc.talk],
    lastAt: doc.lastAt,
  })
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
export function secondsToMorning(iso: string, timeZone?: string): number {
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
