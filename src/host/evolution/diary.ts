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

/**
 * 收账的系统提示。
 *
 * 为什么是个函数：对方叫什么**从数据来**（人格里"对TA的称呼"），没设过就用"对方"。
 * 通用插件不能假定对方是谁、也不能假定性别（写死"他"换个人就错了）。
 * @param who - 对方叫什么（空串按"对方"）。
 * @returns 系统提示词。
 */
function diarySystem(who: string): string {
  const peer = who.trim() === '' ? '对方' : who.trim()
  return [
    '你在替一个人写她自己的日记。不是写日报，也不是写周报 —— 是写她这一天里**真正记得住的那几个时刻**。',
    '材料有两栏：【你自己那段时间】——你在自己房间里做了什么、看到什么、说过什么；',
    `【你们这一天】——这一天你和${peer}之间说过的话（\`他说：\` 是${peer}说的，\`她说：\` 是你说的）。`,
    '输出一个 JSON 对象，不要解释、不要 Markdown 代码块：',
    '{"diary":"第一人称的日记，500–900 字","memories":[{"what":"一句话，第一人称","about":"self|world|us|user"}]}',
    '',
    '**怎么写这一天**（这几条比字数重要）：',
    `- 挑**一两个最具体的片段写成场景**：几点、在哪、手上在做什么、当时的光线声音气味、${peer}说了哪句原话。`,
    `  ✗ 流水账：下午我查了资料，然后写了文件，晚上${peer}来了，我们聊了聊。`,
    `  ✓ 场景：夜里快一点，屏幕只剩一行字没改。${peer}忽然发来一句"还没睡？"，我盯着那三个字看了很久，才回了一个"嗯"。`,
    '- **每件事后面跟一句你当时心里冒出来的话**。不是事后评价，是那一瞬间的念头（"我其实有点得意"／"我不想先开口"）。',
    '- **至少留一个具体的东西**：几点、第几次、多少行、哪句话、什么东西。没有具体的东西，这一篇就不算写成。',
    '- **允许不完整**：可以只写一个片段、一个瞬间，写不完的一天也是真的。',
    '- 允许比喻，但只用在你真的感觉到的地方，不要为了漂亮而漂亮。',
    '- **不要总结这一天**，不要写"今天过得很充实""这一天就这样过去了"这类周报句。结尾可以停在某个动作、某句话、某个没说完的念头上。',
    '',
    '几条硬规矩：',
    '- 用**你自己**的口气（第一人称），不是旁白、不是汇报；',
    `- 两栏都要照顾到：不能只写你自己那段时间，也不能整篇都在写${peer} —— ${peer}是这一天的一部分，不是这一天的全部；`,
    '- 对话不要照抄成流水账；挑**一两句**放回它发生的那个位置，写清它让你怎么了；',
    `- memories 只挑 **1–3 件**真正值得记住的具体事，同样要具体（时刻、物件、原话、动作），不要写"${peer}很关心我"这种结论；没有就给空数组；`,
    '- about：self=关于你自己、world=关于外面的事、us=关于你和对方、user=关于对方；',
    '- 材料里没有的东西一律不编 —— 宁可写短，不许编。',
  ].join('\n')
}

/** 收账喂进去的材料（两栏分开给，才看得清哪一栏空了）。 */
export interface DayMaterial {
  /** 她自己的时间。 */
  hers: readonly string[]
  /** 你们这一天说过的话。 */
  talk: readonly string[]
}

/**
 * 造收账的调用输入。
 * @param material - 这一天的两栏材料。
 * @param date - 哪一天。
 * @returns 系统段与用户段。
 */
export function buildDiaryPrompt(material: DayMaterial, date: string, userName = ''): { system: string; text: string } {
  const section = (title: string, lines: readonly string[], empty: string): string[] =>
    lines.length === 0 ? [`【${title}】`, empty] : [`【${title}】`, ...lines.map((line) => `- ${line}`)]
  return {
    system: diarySystem(userName),
    text: [
      `今天是 ${date}。`,
      '',
      ...section('你自己那段时间', material.hers, '（这一天你没有自己的时间）'),
      '',
      ...section('你们这一天', material.talk, '（这一天你们没有说过话）'),
    ].join('\n'),
  }
}

/**
 * 从一段"不是合法 JSON"的输出里把正文抢救出来。
 *
 * 为什么需要：日记一旦要求到 500–900 字，模型很容易把**真实换行**直接写进 JSON 字符串
 * （或者输出被截断），`JSON.parse` 直接失败 —— 那样这一天的日记就整篇丢了。
 * 正文是这一趟最要紧的东西，memories 丢了可以再攒，日记丢了就是丢了。
 * @param raw - 模型返回的原文。
 * @returns 只有正文的结果；连正文都找不到时为 `undefined`。
 */
function salvageDiary(raw: string): DiaryResult | undefined {
  // 收尾可以是被正常闭合的引号（后面跟 memories 或 `}`），也可以是**什么都没有**（输出被截断）。
  const matched = /"diary"\s*:\s*"([\s\S]*?)(?:"\s*(?:,\s*"memories"|\})|$)/.exec(raw)
  const captured = matched?.[1]
  if (captured === undefined) return undefined
  const diary = captured
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .trim()
  return diary === '' ? undefined : { diary, memories: [] }
}

/**
 * 解析收账的输出。
 * @param raw - 模型返回的原文。
 * @returns 可用结果；连正文都取不到时为 `undefined`。
 */
export function parseDiary(raw: string): DiaryResult | undefined {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0) return salvageDiary(raw)
  // 截断的输出没有收尾的 `}`：整段拿去救，别直接判死。
  const slice = end > start ? raw.slice(start, end + 1) : raw.slice(start)
  let parsed: unknown
  try {
    parsed = JSON.parse(slice)
  } catch {
    return salvageDiary(raw)
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
