/**
 * 「她主动找你说一句」——待投递的话，与什么时候该送。
 *
 * ### 为什么需要这一步
 *
 * 她有自己的一天，但她想让**他**知道点什么时，只能写在自己目录里：不翻就等于没有。
 * 这一条路给她一个真正的出口——她留一句，系统挑一个他不会被打断的时刻把它送进
 * 你们的会话，由**她自己开口**（不是一条冷冰冰的通知）。
 *
 * ### 三条护栏（少一条就变成推销机器人）
 *
 * 1. **一天最多一次**：她定时间也不行；
 * 2. **他正忙着就不送**：安静够 `TELL_QUIET_MINUTES` 才送（判据沿用单线程那份"他最后说话的时刻"）；
 * 3. **说过了就不追问**：送出去之后那句就没了，她不能连着说第二遍。
 * @module humanity/evolution/tell
 */
import type { DocumentStore } from '../documents.js'
import { TELL_DOC_KEY, TELL_MAX_CHARS, TELL_QUIET_MINUTES } from './constants.js'

/** 待投递的话与投递痕迹。 */
export interface TellDoc {
  /** 她想说的那句（空串 = 只有东西要给他看、没有话）。 */
  pending: string
  /**
   * 她想给他看的那个文件（空串 = 没有）。
   *
   * 只认**她自己目录里的顶层文件名**：她能写的地方就那儿，别的一律当没这个文件。
   */
  pendingShow: string
  /** 那句话是什么时候留下的（ISO 8601）。 */
  pendingAt: string
  /** 上一次真正被送出的时刻 / 那天 / 那句 / 那件东西。 */
  lastAt: string
  lastDay: string
  lastText: string
  /** 上一次送出去时她想给他看的东西（空串 = 没带）。 */
  lastShow: string
  /** 上一次没送成的原因（空串 = 一切正常）。 */
  lastReason: string
  /** 投递用的那个调度任务 id（复用同一个，别一天长一个）。 */
  taskId: string
  /** 那个任务当前指向的会话 id（他换了会话就要新建）。 */
  taskSession: string
}

/** 空记录。 */
export const EMPTY_TELL: TellDoc = {
  pending: '',
  pendingShow: '',
  pendingAt: '',
  lastAt: '',
  lastDay: '',
  lastText: '',
  lastShow: '',
  lastReason: '',
  taskId: '',
  taskSession: '',
}

/**
 * 读投递记录。
 * @param documents - 文档表句柄；未就绪时按空记录算。
 * @returns 记录（字段逐个兜底）。
 */
export function readTell(documents: DocumentStore | undefined): TellDoc {
  const value = documents?.read(TELL_DOC_KEY)?.value
  if (typeof value !== 'object' || value === null) return EMPTY_TELL
  const raw = value as Partial<Record<keyof TellDoc, unknown>>
  const text = (key: keyof TellDoc): string => (typeof raw[key] === 'string' ? (raw[key] as string) : '')
  return {
    pending: text('pending'),
    pendingShow: text('pendingShow'),
    pendingAt: text('pendingAt'),
    lastAt: text('lastAt'),
    lastDay: text('lastDay'),
    lastText: text('lastText'),
    lastShow: text('lastShow'),
    lastReason: text('lastReason'),
    taskId: text('taskId'),
    taskSession: text('taskSession'),
  }
}

/**
 * 写投递记录。
 * @param documents - 文档表句柄；未就绪时什么也不做。
 * @param doc - 完整记录。
 */
export async function saveTell(documents: DocumentStore | undefined, doc: TellDoc): Promise<void> {
  if (documents === undefined) return
  await documents.write(TELL_DOC_KEY, { ...doc })
}

/** 她这一次想交出去的东西。 */
export interface TellInput {
  /** 她想说的那句（可以空 —— 只给他看东西也行）。 */
  text?: string
  /** 她想给他看的那个文件（她自己目录里的顶层文件名）。 */
  show?: string
}

/** 能不能收下这一句。 */
export type QueueVerdict = { ok: true; text: string; show: string } | { ok: false; reason: string }

/** 文件名最多多少字（再长就不是文件名了）。 */
const MAX_NAME_CHARS = 120

/**
 * 她能不能现在留这一句 / 这一样东西。
 * @param doc - 当前记录。
 * @param today - 今天的 day key（她的时区）。
 * @param input - 她想留的内容。
 * @returns 收下（附修剪后的文本与文件名）或拒绝原因。
 */
export function canQueue(doc: TellDoc, today: string, input: TellInput): QueueVerdict {
  const text = (input.text ?? '').replace(/\s+/g, ' ').trim()
  const show = (input.show ?? '').trim()
  if (text === '' && show === '') return { ok: false, reason: '要说的话和要给他看的东西，至少得有一个。' }
  if (text.length > TELL_MAX_CHARS) {
    return { ok: false, reason: `太长了（超过 ${TELL_MAX_CHARS} 字）。一两句就够，剩下的留着自己知道。` }
  }
  if (show !== '') {
    if (show.length > MAX_NAME_CHARS) return { ok: false, reason: '文件名太长了，认不出来。' }
    if (show.includes('/') || show.includes('\\') || show.includes('..') || show.startsWith('.')) {
      return { ok: false, reason: '只认你自己目录里的文件名（不带路径）。' }
    }
  }
  if (doc.pending !== '' || doc.pendingShow !== '') {
    return { ok: false, reason: '还有一句没送出去；等那句送到了再说下一句。' }
  }
  if (doc.lastDay !== '' && doc.lastDay === today) {
    return { ok: false, reason: '今天已经找过他说过一次了。一天一次，明天再说。' }
  }
  return { ok: true, text, show }
}

/** 该不该现在送。 */
export type DeliverVerdict =
  | { ok: true; text: string; show: string }
  | { ok: false; reason: string }

/**
 * 现在能不能把待投递的话送出去。
 *
 * 「他忙不忙」不在这里判：那要看运行时那份"他最后一次说话的时刻"，属于调用方。
 * 这里只判**记录本身**说不说得通（有没有东西、今天说过没有、有没有地方可送）。
 * @param doc - 当前记录。
 * @param today - 今天的 day key。
 * @param talkSessionId - 他最近说话的那个会话（空串 = 还没说过话）。
 * @returns 能送（附文本与文件名）或不能送的原因（空串原因 = 还没到时候，不必记）。
 */
export function canDeliver(doc: TellDoc, today: string, talkSessionId: string): DeliverVerdict {
  if (doc.pending === '' && doc.pendingShow === '') return { ok: false, reason: '' }
  if (doc.lastDay !== '' && doc.lastDay === today) return { ok: false, reason: '' }
  if (talkSessionId === '') {
    return { ok: false, reason: '还没有他跟她说过话的会话，这句话送不出去（等他来一次）。' }
  }
  return { ok: true, text: doc.pending, show: doc.pendingShow }
}

/**
 * 造"她主动找他"那一段提示词。
 *
 * 为什么要说这么清楚：这条消息在会话里长得像"他发来一句话"。不拆穿，她会以为是他来了，
 * 于是答非所问（同一个坑在"她自己醒来"那里已经踩过一次，见 `wake.ts`）。
 * @param text - 她留的那句（可以为空）。
 * @param show - 她想给他看的文件名（可以为空）。
 * @returns 投递时用的提示词。
 */
export function buildTellPrompt(text: string, show = ''): string {
  const lines = ['[你主动找他] 你现在想跟他说一句话。', '']
  if (text !== '') lines.push(`你想说的是：${text}`, '')
  if (show !== '') {
    lines.push(
      `你还想给他看一样东西：${show}（它在你自己的目录里）。`,
      '说的时候把它的名字带出来，他会在页面上的「她留下的东西」里看到它。',
      '',
    )
  }
  lines.push(
    '（这条不是他发来的：是你自己决定在这会儿找他的。）',
    '用你自己的话把这句话说出来，一两句就够。',
    '不要说"这是定时消息"、不要提系统、不要解释你怎么会在这时候出现。',
    '他可能不在；说完了就停，别追问，也别再补一条。',
  )
  return lines.join('\n')
}

/** 他安静够久了吗（毫秒判据由调用方给"最后一次说话的时刻"）。 */
export function quietEnough(lastBusyAt: number, now: number): boolean {
  if (!Number.isFinite(lastBusyAt) || lastBusyAt <= 0) return true
  return now - lastBusyAt >= TELL_QUIET_MINUTES * 60_000
}
