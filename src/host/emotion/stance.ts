/**
 * 评估用的**立场快照**：把人格里"这件事对她意味着什么"的那几样东西，压成一小段。
 *
 * ### 为什么情绪评估需要人格
 *
 * OCC（Ortony / Clore / Collins 1988）的评估本来就是**相对于这个人**的：同一件事让人高兴还是
 * 恶心，取决于她想要什么（目标）、在乎什么（标准）、喜欢什么（态度）。少了这一层，评估器只剩
 * 一个通用的人，而通用的人自带一套通用道德 —— 于是"她是谁"写得再清楚，情绪层也会按另一套判。
 *
 * 2026-11-20 的实机现场：人格写着「对亲近的人有强烈偏好」，她对对方发来的这类内容
 * 回得热络；而评估器（看不到人格）判成了「对TA厌烦（因为又发来露骨的性要求）」，
 * 还写了「对方只想着自己的欲望」—— 那句判断随后渗进了她的台词，也被记进了敏感化的账。
 *
 * ### 为什么只给这几样、不给整份人格
 *
 * 1. **别让它演戏**：评估器的职责是"判断"，给它整份人格容易变成"扮演"。
 * 2. **成本**：每轮一次调用，人格可以很长。
 * 3. **漂移**：自由文本会变；这里只取**会改变"事件意义"**的槽位：她是谁（性格一行）、
 *    底色里的人格偏好与自定义字段（比如"特殊癖好"）、行为边界、关系、称呼，
 *    以及信息里自定义的小节与条目。**说话风格不取** —— 那是"怎么表达"，不是"什么有意思"。
 *
 * ### 为什么读的是"现读"函数
 *
 * 人格随时可改；缓存一份就会在人格改过之后继续按旧立场判（实机表现："改了人格，情绪没跟着变"）。
 *
 * ### 为什么不回读"原因"
 *
 * 状态里的 `cause` 是**我们自己上一次的输出**。把它喂回评估器，它会当成事实继续推理 ——
 * 实机现场的那句"**又**发来露骨的性要求"就是这么来的（原因里写着上一回的判断）。
 * 所以评估输入只给"情绪 + 强度 + 对象"，不给原因（见 `appraise.ts` 的 `describeState`）。
 * @module humanity/emotion/stance
 */
import { characterLine } from '../persona/render-character.js'

/**
 * 人格命名空间名（字面量，不从 persona 模块 import）。
 *
 * 为什么抄一份：只为读**一个字符串**而把 persona 的 schema/写入逻辑拉进情绪模块的依赖图里不值得；
 * 而 `test/emotion-stance.test.mjs` 有一条用例直接比对两边的常量 —— 抄错会立刻变红。
 */
export const PERSONA_NAMESPACE = 'humanity-persona'

/** 一条"键：值"设定（底色里除姓名/性别/主语言之外的字段，以及用户自定义条目）。 */
export interface StanceEntry {
  key: string
  value: string
}

/** 一个自定义信息小节。 */
export interface StanceSection {
  title: string
  items: string[]
}

/** 评估用的立场快照（每一格都可能为空）。 */
export interface AppraisalStance {
  /** 她是谁（性格层那一行；空串 = 还没推导出性格）。 */
  character: string
  /** 底色里的「人格偏好」与自定义字段（如「特殊癖好」）。 */
  traits: StanceEntry[]
  /** 「行为边界」条目 —— 她的底线；空数组 = 没有特别写明。 */
  boundaries: string[]
  /** 「关系」条目 —— 对方是谁。 */
  relation: string[]
  /** 「对TA的称呼」条目。 */
  address: string[]
  /** 信息里**非原生**的小节（自定义设定）。 */
  sections: StanceSection[]
  /** 用户自定义的键值条目。 */
  custom: StanceEntry[]
}

/** 底色里不参与"意义判断"的字段：姓名、性别、主语言（人格偏好单独处理）。 */
const IRRELEVANT_FIELDS = ['姓名', '性别', '主语言'] as const
const PREFERENCE_KEY = '人格偏好'

/** 信息里的原生小节（已经各归其位；剩下的才进"其他设定"）。 */
const NATIVE_SECTIONS = ['对TA的称呼', '说话风格', '行为边界', '关系'] as const
const BOUNDARY_SECTION = '行为边界'
const RELATION_SECTION = '关系'
const ADDRESS_SECTION = '对TA的称呼'

/** 从任意值里安全取字符串数组（形状残缺就当作空）。 */
function stringsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item !== '')
}

/** 从任意值里安全取"键：值"条目。 */
function entriesOf(value: unknown): StanceEntry[] {
  if (!Array.isArray(value)) return []
  const out: StanceEntry[] = []
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue
    const item = entry as { key?: unknown; value?: unknown }
    if (typeof item.key !== 'string' || typeof item.value !== 'string') continue
    const key = item.key.trim()
    const text = item.value.trim()
    if (key === '' || text === '') continue
    out.push({ key, value: text })
  }
  return out
}

/** 从任意值里安全取某个小节的条目。 */
function sectionItems(sections: unknown, title: string): string[] {
  if (!Array.isArray(sections)) return []
  for (const entry of sections) {
    if (entry === null || typeof entry !== 'object') continue
    const section = entry as { title?: unknown; items?: unknown }
    if (section.title === title) return stringsOf(section.items)
  }
  return []
}

/** 从任意值里取所有"非原生"的信息小节。 */
function customSections(sections: unknown): StanceSection[] {
  if (!Array.isArray(sections)) return []
  const out: StanceSection[] = []
  for (const entry of sections) {
    if (entry === null || typeof entry !== 'object') continue
    const section = entry as { title?: unknown; items?: unknown }
    if (typeof section.title !== 'string') continue
    const title = section.title.trim()
    if (title === '' || (NATIVE_SECTIONS as readonly string[]).includes(title)) continue
    const items = stringsOf(section.items)
    if (items.length === 0) continue
    out.push({ title, items })
  }
  return out
}

/**
 * 把一份（形状可能残缺的）人格文档读成立场快照。
 *
 * 全空时返回 `undefined` —— 那种情况与"没有人格"等价，评估器就退回原来的通用判断
 * （宁可没有立场，也不要拿一堆空标题冒充立场）。
 * @param value - 人格命名空间里的原始值（`unknown`：我们不假设它一定完整）。
 * @returns 立场快照；读不出任何东西时 `undefined`。
 */
export function readStance(value: unknown): AppraisalStance | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const doc = value as {
    identityCard?: { fields?: unknown }
    character?: unknown
    mutableLayer?: { sections?: unknown; userDefined?: unknown }
  }
  const fields = entriesOf(doc.identityCard?.fields)
  const traits = fields.filter(
    (field) => field.key === PREFERENCE_KEY || !(IRRELEVANT_FIELDS as readonly string[]).includes(field.key),
  )
  const stance: AppraisalStance = {
    character: characterLine(doc.character as Parameters<typeof characterLine>[0]),
    traits,
    boundaries: sectionItems(doc.mutableLayer?.sections, BOUNDARY_SECTION),
    relation: sectionItems(doc.mutableLayer?.sections, RELATION_SECTION),
    address: sectionItems(doc.mutableLayer?.sections, ADDRESS_SECTION),
    sections: customSections(doc.mutableLayer?.sections),
    custom: entriesOf(doc.mutableLayer?.userDefined),
  }
  const empty = stance.character === ''
    && stance.traits.length === 0
    && stance.boundaries.length === 0
    && stance.relation.length === 0
    && stance.address.length === 0
    && stance.sections.length === 0
    && stance.custom.length === 0
  return empty ? undefined : stance
}

/**
 * 把立场快照渲染成评估器读的一小段（**第二人称**）。
 *
 * 为什么是"你"而不是"她"：这件事就是"她自己判断它对自己意味着什么"。用第三人称等于让模型
 * 以外人的身份揣测一个角色，人格的约束力会被稀释；第二人称则和对话那边的系统提示同一个口吻。
 * 防"演起来"不靠人称，靠"只输出 JSON、不要写台词"（见 `appraise.ts`）。
 * @param stance - 立场快照。
 * @returns 多行文本；整份为空时返回空串（调用方据此不加这一段）。
 */
export function renderStance(stance: AppraisalStance | undefined): string {
  if (stance === undefined) return ''
  const lines: string[] = ['【你的立场】下面是你自己的情况；判断这件事对你的意义时，以这个为准：']
  if (stance.character !== '') lines.push(`- 你是谁：${stance.character.replace(/^-\s*此刻的你：/, '')}`)
  for (const trait of stance.traits) lines.push(`- 你的${trait.key}：${trait.value}`)
  lines.push(stance.boundaries.length === 0
    ? '- 你的底线：没有特别写明（那就别替自己补一条）'
    : `- 你的底线：${stance.boundaries.join('；')}`)
  if (stance.relation.length > 0) lines.push(`- 你和对方的关系：${stance.relation.join('；')}`)
  if (stance.address.length > 0) lines.push(`- 你叫对方：${stance.address.join('；')}`)
  for (const section of stance.sections) lines.push(`- 你的${section.title}：${section.items.join('；')}`)
  for (const entry of stance.custom) lines.push(`- 你的${entry.key}：${entry.value}`)
  return lines.join('\n')
}

/**
 * 造一个"现读立场"的入口。
 *
 * 包装成一个只读函数（而不是把人格文档传进来）的原因：人格是随时可改的，
 * 评估每一次都该用**当时**的那份；缓存一份就会在人格改过之后继续按旧立场判。
 * @param read - 按命名空间读当前生效文档（设置服务的 `get`）。
 * @returns 每次调用时现读、现解析；读不到时 `undefined`。
 */
export function stanceReader(read: (ns: string) => unknown): () => AppraisalStance | undefined {
  return () => {
    try {
      return readStance(read(PERSONA_NAMESPACE))
    } catch {
      // 读人格只是"锦上添花"：读不到就按通用判断，绝不能让情绪评估因此失败。
      return undefined
    }
  }
}
