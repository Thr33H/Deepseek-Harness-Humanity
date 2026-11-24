/**
 * 睡前收账：把一天收成**一篇日记**和**几件事**。
 *
 * ### 为什么要有这一步
 *
 * 她一天里醒了很多次，每一次都是零散的（看了点什么、说了几句、又停了）。没有这一步，
 * 这一天在系统里就只剩一堆碎片，而她自己也"不知道这阵子过成了什么样"。
 * 收账是把她的一天**折叠**成两样东西：一篇第一人称的日记（给她和给自己看），
 * 以及 1–3 件值得记下的具体事（进记忆，会被想起来、也会淡）。
 *
 * ### 三条纪律
 *
 * 1. **只用她自己那一天的材料**（她说过的话、她看到的东西），不拿你们的对话去写她的日记；
 * 2. **日记不参与回忆**（不注入对话），它是本子；
 * 3. 材料是空的就**不写**：宁可这一天没有日记，也不编一篇。
 * @module humanity/evolution/diary
 */
import type { DocumentStore } from '../documents.js'

/** 日记存在哪（文档表的键）。 */
export const DIARY_DOC_KEY = 'humanity-diary'

/** 归档放哪（超出保留上线的旧日记搬到这里，不删）。 */
export const DIARY_ARCHIVE_KEY = 'humanity-diary-archive'

/** 保留多少篇（一天一篇，一年多一点；超出部分进归档，不删）。 */
export const DIARY_KEEP = 400

/** 一篇日记。 */
export interface DiaryEntry {
  /** 哪一天（YYYY-MM-DD，按她的时区）。 */
  date: string
  /** 第一人称正文。 */
  text: string
  /** 写下来的时刻（ISO 8601）。 */
  createdAt: string
  /**
   * 哪一刻被翻开的（ISO；空串 = 没被翻过）。
   *
   * 存在日记条目上而不是内存里：重启后"已经翻开过"必须还算数，
   * 否则每重启一次，同一天的正文就重新被藏起来一次。
   */
  openedAt: string
  /**
   * 哪一刻她知道"被翻过"了（ISO；空串 = 还不知道）。
   *
   * 为什么要单独记：她只会在**自己重读那一天**时才发现。所以"被翻开"与"她知道了"是两件事，
   * 中间可能隔好几天；`noticedAt` 还空着的时候，每次醒来都该提醒她一次（提醒过就记下）。
   */
  noticedAt: string
}

/** 读日记（时间顺序，旧的在前）。 */
export function readDiary(documents: DocumentStore | undefined): DiaryEntry[] {
  const value = documents?.read(DIARY_DOC_KEY)?.value
  if (typeof value !== 'object' || value === null) return []
  const entries = (value as { entries?: unknown }).entries
  if (!Array.isArray(entries)) return []
  return entries
    .map((raw) => {
      const item = raw as Partial<Record<keyof DiaryEntry, unknown>>
      return {
        date: typeof item.date === 'string' ? item.date : '',
        text: typeof item.text === 'string' ? item.text : '',
        createdAt: typeof item.createdAt === 'string' ? item.createdAt : '',
        openedAt: typeof item.openedAt === 'string' ? item.openedAt : '',
        noticedAt: typeof item.noticedAt === 'string' ? item.noticedAt : '',
      }
    })
    .filter((entry) => entry.text !== '')
}

/**
 * 把已经翻到"保留上线"之外的日记挪进归档文档（**不删**）。
 *
 * 为什么要有这一步：日记是她的本子，删掉就再也拿不回来；而命名空间与文档都不该无限长。
 * 归档只是搬地方，读法一样（同一种条目形状），以后想翻旧账仍然翻得到。
 * @param documents - 文档表。
 * @param entries - 要搬走的那几篇。
 */
async function archiveDiary(documents: DocumentStore, entries: readonly DiaryEntry[]): Promise<void> {
  const existing = documents.read(DIARY_ARCHIVE_KEY)?.value
  const kept = typeof existing === 'object' && existing !== null && Array.isArray((existing as { entries?: unknown }).entries)
    ? ((existing as { entries: unknown[] }).entries as DiaryEntry[])
    : []
  await documents.write(DIARY_ARCHIVE_KEY, { entries: [...kept, ...entries] })
}

/**
 * 追加一篇（同一天再写会覆盖那一天 —— 一天只有一篇）。
 * @param documents - 文档表。
 * @param entry - 这一篇。
 */
export async function appendDiary(documents: DocumentStore | undefined, entry: DiaryEntry): Promise<void> {
  if (documents === undefined) return
  const kept = readDiary(documents).filter((item) => item.date !== entry.date)
  const all = [...kept, entry]
  // 超出的不删，挪进归档：本子可以翻很久，但也不能无限长。
  const overflow = all.length > DIARY_KEEP ? all.slice(0, all.length - DIARY_KEEP) : []
  if (overflow.length > 0) await archiveDiary(documents, overflow)
  await documents.write(DIARY_DOC_KEY, { entries: all.slice(-DIARY_KEEP) })
}

/** 收账的输出契约。 */
export interface DiaryResult {
  /** 日记正文（第一人称）。 */
  diary: string
  /** 值得记下的具体事。 */
  memories: Array<{ what: string; about: string }>
}

/** 收账的系统提示。 */
const DIARY_SYSTEM = [
  '你在替一个人整理她自己的一天。材料只来自她自己在自己房间里做过、看到的事。',
  '输出一个 JSON 对象，不要解释、不要 Markdown 代码块：',
  '{"diary":"第一人称的日记，150–400 字","memories":[{"what":"一句话，第一人称","about":"self|world|us|user"}]}',
  '',
  '要求：',
  '- 日记用**她自己的口气**写（第一人称），写这一天她干了什么、看到什么、心里怎么想；',
  '- 不要写成流水账，也不要写成给别人看的汇报 —— 这是她自己的本子；',
  '- memories 只挑 **1–3 件**真正值得记住的具体事；没有就给空数组；',
  '- about：self=关于她自己、world=关于外面的事、us=关于她和对方、user=关于对方；',
  '- 材料里没有的东西一律不编。',
].join('\n')

/**
 * 造收账的调用输入。
 * @param notes - 这一天的零散材料（每行一条）。
 * @param date - 哪一天。
 * @returns 系统段与用户段。
 */
export function buildDiaryPrompt(notes: readonly string[], date: string): { system: string; text: string } {
  return {
    system: DIARY_SYSTEM,
    text: [`今天是 ${date}。这是这一天的零散记录（她说过的话、她看到的东西）：`, '', ...notes].join('\n'),
  }
}

/**
 * 解析收账的输出。
 * @param raw - 模型返回的原文。
 * @returns 可用结果；坏 JSON / 空日记时为 `undefined`。
 */
export function parseDiary(raw: string): DiaryResult | undefined {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const diary = typeof (parsed as { diary?: unknown }).diary === 'string' ? (parsed as { diary: string }).diary.trim() : ''
  if (diary === '') return undefined
  const rawMemories = (parsed as { memories?: unknown }).memories
  const allowed = new Set(['self', 'world', 'us', 'user'])
  const memories = Array.isArray(rawMemories)
    ? rawMemories
        .map((item) => {
          const candidate = item as { what?: unknown; about?: unknown }
          const what = typeof candidate.what === 'string' ? candidate.what.trim() : ''
          const about = typeof candidate.about === 'string' && allowed.has(candidate.about) ? candidate.about : 'self'
          return what === '' ? undefined : { what, about }
        })
        .filter((item): item is { what: string; about: string } => item !== undefined)
        .slice(0, 3)
    : []
  return { diary, memories }
}
