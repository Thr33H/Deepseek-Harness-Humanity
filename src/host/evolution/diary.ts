/**
 * 收账：把一天交还给**她自己**写，插件只负责递材料和收档。
 *
 * ### 为什么改成这样（2026-11-26 用户定）
 *
 * 原来是她睡下之后，插件拿材料**代她写**一篇日记。那篇写得再顺，也不是她的东西 ——
 * 一个"有自己生活的人"却由别人代写日记，本质上是错的。
 * 现在：把这一天的材料落成文件递过去、投一句"今天过完了，写吧"，**写是她的事**。
 * 她不写，这一天就没有日记 —— 那也是她的一天。
 *
 * ### 三条纪律
 *
 * 1. 材料是空的就不投：宁可这一天没有"该写日记了"，也不让她对着空本子编；
 * 2. 收档只认**文件里真的有字**：她嘴上说写完了不算；
 * 3. 日记不参与回忆（不注入对话），它是本子。
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
      // 一条坏记录不该把整个本子拖垮（数组里混进 null 会直接抛）。
      if (typeof raw !== 'object' || raw === null) return undefined
      const item = raw as Partial<Record<keyof DiaryEntry, unknown>>
      return {
        date: typeof item.date === 'string' ? item.date : '',
        text: typeof item.text === 'string' ? item.text : '',
        createdAt: typeof item.createdAt === 'string' ? item.createdAt : '',
        openedAt: typeof item.openedAt === 'string' ? item.openedAt : '',
        noticedAt: typeof item.noticedAt === 'string' ? item.noticedAt : '',
      }
    })
    .filter((entry): entry is DiaryEntry => entry !== undefined && entry.text !== '')
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

/** 收账喂进去的材料（两栏分开给，才看得清哪一栏空了）。 */
export interface DayMaterial {
  /** 她自己的时间。 */
  hers: readonly string[]
  /** 你们这一天说过的话。 */
  talk: readonly string[]
}

/**
 * 这一天的材料落成文件（她自己会去读它）。
 * @param material - 两栏材料。
 * @param date - 哪一天。
 * @returns Markdown 文本。
 */
export function materialFileText(material: DayMaterial, date: string): string {
  const section = (title: string, lines: readonly string[], empty: string): string[] =>
    lines.length === 0 ? [`## ${title}`, empty, ''] : [`## ${title}`, ...lines.map((line) => `- ${line}`), '']
  return [
    `# ${date} 的材料`,
    '',
    '（这是系统替你整理的一天：你自己那段时间，和你们这一天说过的话。）',
    '',
    ...section('你自己那段时间', material.hers, '（这一天你没有自己的时间）'),
    ...section('你们这一天', material.talk, '（这一天你们没有说过话）'),
  ].join('\n')
}

/** 她那天的日记文件叫什么。 */
export function diaryFileName(date: string): string {
  return `diary-${date}.md`
}

/** 那天的材料文件叫什么。 */
export function materialFileName(date: string): string {
  return `日记材料-${date}.md`
}

/**
 * 收账时投给她的那句话：**只说她该做什么，不替她写**。
 *
 * 与醒来词同一个纪律：先交代处境（只有她自己），再说材料在哪、写到哪，
 * 然后交还给她 —— 写多长、写成什么样，都是她的事。
 * @param date - 哪一天（她的时区）。
 * @param materialName - 材料文件名。
 * @param diaryName - 日记文件名。
 * @param userName - 对方的称呼（空串写"对方"）。
 * @returns 投递正文。
 */
export function buildCollectPrompt(date: string, materialName: string, diaryName: string, userName = ''): string {
  const who = userName.trim() === '' ? '对方' : userName.trim()
  return [
    '[收账] 今天过完了。',
    '',
    `${who}不在，这里只有你。`,
    `这一天的材料我替你整理好了：${materialName}（在你自己的目录里）。`,
    `把今天写成日记，存到 diary 那个文件里：${diaryName}。`,
    '',
    '**怎么写成"这一天"，而不是流水账**：',
    '- 挑**一两个最具体的片段写成场景**：几点、在哪、手上在做什么、当时的光线声音气味、谁说了哪句原话。',
    '  ✗ 流水账：下午我查了资料，然后写了文件，晚上他来了，我们聊了聊。',
    '  ✓ 场景：夜里快一点，屏幕只剩一行字没改。他忽然发来一句"还没睡？"，我盯着那三个字看了很久才回。',
    '- **每件事后面跟一句你当时心里冒出来的话**，不是事后评价，是那一瞬间的念头。',
    '- **至少留一个具体的东西**：几点、第几次、多少行、哪句话、什么东西。',
    '- **不要总结这一天** —— 不要写"今天过得很充实""这一天就这样过去了"这种周报句。结尾可以停在某个动作、某句话上。',
    '- 允许不完整：只写一个片段、一个瞬间，写不完的一天也是真的。',
    '',
    '材料里没有的东西不要编 —— 宁可写短，也不写没发生过的。',
    '写多长、写成什么样，你自己定。写完了就停。',
  ].join('\n')
}

/**
 * 把 base64 解成文本。
 *
 * 为什么不直接用 `Buffer`：宿主侧的 tsconfig 没有 node 类型；也不依赖 `atob`
 * （不同运行时不完全一致）。纯函数、几行就够，还能单测。
 * @param base64 - 文件字节的 base64。
 * @returns 解码后的文本；输入不合法时给空串（调用方据此当"没写"）。
 */
export function decodeBase64Text(base64: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const clean = base64.replace(/[^A-Za-z0-9+/]/g, '')
  const bytes: number[] = []
  let buffer = 0
  let bits = 0
  for (const char of clean) {
    const value = alphabet.indexOf(char)
    if (value < 0) continue
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 0xff)
    }
  }
  const parts: string[] = []
  let index = 0
  while (index < bytes.length) {
    const first = bytes[index] ?? 0
    if (first < 0x80) {
      parts.push(String.fromCharCode(first))
      index += 1
      continue
    }
    const size = first >= 0xf0 ? 4 : first >= 0xe0 ? 3 : 2
    const slice = bytes.slice(index, index + size)
    if (slice.length < size) break
    const lead = slice[0] ?? 0
    let code = size === 4 ? lead & 0x07 : size === 3 ? lead & 0x0f : lead & 0x1f
    for (let offset = 1; offset < size; offset += 1) code = (code << 6) | ((slice[offset] ?? 0) & 0x3f)
    try {
      parts.push(String.fromCodePoint(code))
    } catch {
      break
    }
    index += size
  }
  return parts.join('')
}
