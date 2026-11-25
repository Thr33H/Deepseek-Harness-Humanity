/**
 * 收账的判定：这一天该不该收、收不了时原因怎么写。
 *
 * ### 为什么要把它单独抽出来
 *
 * 真机连着几天日记都是空的，而"为什么空"原来只写进日志 —— 日志进不了 `docker logs`
 * （见 `state.ts` 里那段说明），于是每查一次都要靠猜。判定散在收账流程里的时候，
 * 每条分支只能在真机上撞运气才验得到；抽成纯函数之后，每一条都能在用例里钉死。
 *
 * ### 三条规矩
 *
 * 1. **材料跟着它自己的那一天走**：手上是昨天的材料，就收昨天（跨午夜的正常情况），
 *    绝不因为"现在不是那天"把它丢掉；
 * 2. **一天只有一篇**：那一天已经有日记，就不是错误，安静跳过；
 * 3. **没有材料时必须说清是哪一种"没有"**：是她那天没开口、是清点里记过但手上空了
 *    （材料活不过重启）、还是这份清点之前的事看不出来。三种说法绝不能混成一句 ——
 *    混了就等于让外面的人拿一条错的原因去查一个不存在的毛病。
 * @module humanity/evolution/settle-plan
 */

/** 判定所需的事实（由调用方给；这个模块不读盘、不看钟）。 */
export interface SettleFacts {
  /** 现在按哪一天算（她的时区，`YYYY-MM-DD`；空串 = 算不出来）。 */
  today: string
  /** 手上那批材料属于哪一天（空串 = 手上没有材料）。 */
  notesDay: string
  /** 手上握着几行材料。 */
  notesCount: number
  /** 落盘清点：最近一次记材料是哪一天（空串 = 从来没记过）。 */
  recordedDay: string
  /** 落盘清点：那一天一共记过几行。 */
  recordedCount: number
  /** 已经写过日记的日期。 */
  writtenDates: readonly string[]
  /** 本进程起来的时刻（ISO 8601）。 */
  startedAt: string
  /** 本进程起来那天（她的时区；空串 = 解析不出来）。 */
  startedDay: string
  /** 她的时区（只用来把时刻写成"几号几点"）。 */
  timeZone?: string
}

/** 判定结果。 */
export type SettlePlan =
  | { kind: 'write'; date: string }
  | { kind: 'done' }
  | { kind: 'cannot'; reason: string }

/** 把一个时刻写成"11-25 10:17"（按她的时区；写不出来时退回原文）。 */
export function momentText(iso: string, timeZone?: string): string {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return iso
  const format = (zone?: string): Intl.DateTimeFormatPart[] =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      month: '2-digit',
      day: '2-digit',
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
  const pick = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? ''
  return `${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}`
}

/**
 * 没有材料时该怎么说。
 *
 * 三种情形各有各的证据，不许互相顶替：
 * - **清点里记过、手上没有** ⇒ 材料被重启冲掉了（有证据，可以直说）；
 * - **清点里没有、但这个进程那天之前就活着** ⇒ 她那天确实没开口（这一天全在本进程的视野里）；
 * - **其余** ⇒ 看不出来，只能如实说看不出来。
 * @param facts - 判定事实。
 * @param notesDate - 手上材料所属的日期（空串 = 没有）。
 * @returns 给人看的一句话。
 */
function noMaterialReason(facts: SettleFacts, notesDate: string): string {
  const date = facts.today
  if (notesDate !== '' && notesDate !== date) {
    return `${date} 没有可收的材料：手上那批是 ${notesDate} 的，那天的日记已经写过了`
  }
  const started = momentText(facts.startedAt, facts.timeZone)
  if (facts.recordedDay === date && facts.recordedCount > 0) {
    return `${date} 记过 ${facts.recordedCount} 行材料，收账时手上却是空的 —— `
      + `材料只活在内存里，进程重启就会把它们冲掉（这个进程是 ${started} 起来的）`
  }
  if (facts.startedDay !== '' && facts.startedDay < date) {
    return `${date} 没有材料：她这一天没在房间里说过话，也没调用过工具`
  }
  return `${date} 没有材料。这份清点是 ${started} 才开始的，那之前她有没有留下话看不出来 —— `
    + `也可能是重启冲掉了（材料只活在内存里）`
}

/**
 * 判定这一次该做什么。
 * @param facts - 判定事实。
 * @returns `write`（收那一天）、`done`（已经写过，正常）或 `cannot`（收不了，带原因）。
 */
export function decideSettle(facts: SettleFacts): SettlePlan {
  if (facts.today === '') {
    return { kind: 'cannot', reason: '算不出今天是哪一天（时间基准还没学到），这一次没有收账' }
  }
  const notesDate = facts.notesCount > 0 ? facts.notesDay : ''
  // 1. 手上材料所属的那一天先收：材料跟着它自己的那一天走。
  if (notesDate !== '' && !facts.writtenDates.includes(notesDate)) {
    return { kind: 'write', date: notesDate }
  }
  // 2. 那一天已经写过（或者手上本来就没有材料）：看今天。
  if (facts.writtenDates.includes(facts.today)) return { kind: 'done' }
  return { kind: 'cannot', reason: noMaterialReason(facts, notesDate) }
}
