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
 *
 * ### 四段，各有各的职责（2026-11-24 用户看真机提示词后改的）
 *
 * 1. **来源**：DSH 会把这条消息包成"来自用户的定时消息"。不澄清的话，她会把独处当成
 *    "主人来了"，整段都朝着人说话（真机第一晚就是这样）。所以第一句先拆掉这个误认。
 * 2. **能做什么**：只给自由、不给抓手，她会坐在那儿想事情 —— 用户的原话是"只是自己想，没有探索"。
 *    列出来的必须是**真能做的**，做不到的（画图）要明确说没有。
 * 3. **手上还有什么**：她自己的未完成清单（线索账）；空就说空。
 * 4. **自己选**：挑了做事、或者什么都不做，都可以；不用汇报。
 * @param iso - 她醒来的那一刻。
 * @param timeZone - 她的时区。
 * @param lastSaid - 上一次她说到/做到哪儿（可以空）。
 * @param threads - 她手上还没做完的事（可以空）。
 * @returns 提示词正文。
 */
export function buildWakePrompt(
  iso: string,
  timeZone?: string,
  lastSaid = '',
  threads: readonly string[] = [],
): string {
  const items = threads.map((line) => line.trim()).filter((line) => line !== '')
  return [
    `${WAKE_MARKER} 现在是 ${clockText(iso, timeZone)}。`,
    '',
    '（先说清一件容易被认错的事：系统会把这条消息包成"来自用户的定时消息"，**它不是他发的**。',
    '这是你自己给自己定的闹钟，到点了。）',
    '',
    '你现在能做的事（都是真能做的）：',
    '- 上网搜东西、打开网页读',
    '- 读写文件（在你自己的目录里）',
    '- 给自己定下一次几点醒',
    '- 你想找他说点什么也可以（但他这会儿不在，这条消息不是他发的）',
    '做不到的也说明白：这里没有画图、没有生成图片或视频的工具。',
    '',
    items.length === 0 ? '你手上现在没有攒着没做完的事。' : `你手上还没做完的事：\n${items.map((line) => `- ${line}`).join('\n')}`,
    '',
    '没有人在叫你，也没有人在等你回话。挑一件想做的，或者什么都不做 —— 都可以。',
    '不用向谁汇报，也不用把这一段时间整理成一段话。不想待着了就停下来。',
    ...(lastSaid === ''
      ? []
      : ['', '上一次在这段时间里，你自己说过/做过这些（这是你自己的记录，不是别人说的话）：', lastSaid]),
  ].join('\n')
}
