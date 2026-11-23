/**
 * 醒来时她看到的那段话。
 *
 * ### 为什么这么写
 *
 * 调度消息在会话里长得像"有人发来一句话"，所以第一句必须立刻把这件事说清：
 * **没有人在叫她，也没有人在等她回话**。否则她会把这段独处当成"对方来了"，
 * 而这正是整套设计要避免的错位（情绪评估只认 `user` 来源，但模型自己读不出来源标记）。
 *
 * ### 为什么只给一段、不给清单
 *
 * 自主感来自"醒来干什么由她自己定"（设计第 2.4 条）。任何"今天建议你做 A/B/C"的清单
 * 都会把它变成派活。这一段只说清边界（没有人在等、不用汇报），不说任务。
 * @module humanity/evolution/wake
 */
import { WAKE_MARKER } from './constants.js'

/**
 * 按她的时区渲染"现在几点"。
 * @param iso - 时刻。
 * @param timeZone - IANA 时区；坏值时退回进程时区。
 * @returns 人话时间（例：`2026年11月23日星期一 15:04`）。
 */
function clockText(iso: string, timeZone?: string): string {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return '现在'
  const format = (zone?: string): string =>
    new Intl.DateTimeFormat('zh-CN', {
      timeZone: zone,
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(at)
  try {
    return format(timeZone)
  } catch {
    return format(undefined)
  }
}

/**
 * 造醒来提示词。
 * @param iso - 这一刻。
 * @param timeZone - 她的时区。
 * @returns 提示词正文。
 */
export function buildWakePrompt(iso: string, timeZone?: string, lastSaid = ''): string {
  return [
    `${WAKE_MARKER} 现在是 ${clockText(iso, timeZone)}。`,
    '',
    '没有人在叫你，也没有人在等你回话。这一段时间是你自己的。',
    '',
    '你可以看看外面在发生什么，接着上次没做完的事，或者什么都不做。',
    '不用向谁汇报，也不用把这一段时间整理成一段话。',
    '不想待着了就停下来。',
    ...(lastSaid === ''
      ? []
      : ['', '上一次在这段时间里，你自己说过/做过这些（这是你自己的记录，不是别人说的话）：', lastSaid]),
  ].join('\n')
}
