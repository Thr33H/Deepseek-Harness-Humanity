/**
 * 每天的"自我整理"：把这一天的材料折成**信息层**的变化。
 *
 * ### 两条路（用户 2026-11-25 拍板）
 *
 * - **明确要求**（"以后别总说我认了"）：当天直接并进已有小节，不攒、不排队；
 * - **不明确的观察**：只进候选队列（见 `grow-queue.ts`），够次数、跨够多天再升级。
 *
 * ### 一条铁律：先读，再合并，最后写
 *
 * 写入永远是"整节快照"，不是盲追加 —— 否则跑几个月，同一件事会以七八种说法躺在同一节里。
 * 所以模型拿到的是**当前信息层的全文**，交回的也必须是"改完之后的完整列表"。
 *
 * ### 两道机器校验（模型说了不算）
 *
 * 1. **旧文字不许消失**：原来每一条都必须还能在新列表里找到（可以变长，不能变没）；
 * 2. **不许新造小节**：只能写进已有的小节 —— 新开一节早晚会和旧的那节同义。
 *
 * 任何一条不过，这一节**整节不写**，原因记进队列的 `lastRun.note`（插件日志进不了 docker logs）。
 * @module humanity/persona/grow
 */
import type { DocumentStore } from '../documents.js'
import type { LlmAccess } from '../llm.js'
import type { Log } from '../log.js'
import type { PersonaSection } from './section.js'
import type { MutableSection, PersonaDocument } from './types.js'
import {
  dueCandidates,
  mergeObservation,
  pruneQueue,
  readGrowQueue,
  removeCandidate,
  saveGrowQueue,
  sameTopic,
  type GrowAbout,
  type GrowCandidate,
  type GrowQueue,
} from './grow-queue.js'

/** 一天最多往信息层写几条升级（明确要求不受这条限制）。 */
export const MAX_WRITES_PER_DAY = 1
/** 一次最多改几个小节（多了就不是"整理"，是重写；明确要求多的时候也就几个）。 */
const MAX_SECTIONS = 5
/** 一节里一次最多新增几条（防"一口气灌十条"）。 */
const MAX_ADDED = 3
/** 一个条目最长多少字。 */
const MAX_ITEM_CHARS = 240
/** 一条候选最长多少字。 */
const MAX_CANDIDATE_CHARS = 40
/** 这一轮最多接受几条新观察。 */
const MAX_CANDIDATES = 12

/** 外部事实。 */
export interface GrowDeps {
  /** 文档表（存储未就绪时 `undefined`）。 */
  documents(): DocumentStore | undefined
  /** 人格读写入口。 */
  section: PersonaSection
  /** 后台模型调用口。 */
  llm: LlmAccess
  /** 日志。 */
  log: Log
}

/** 一次整理需要的输入。 */
export interface GrowInput {
  /** 这一天的两栏材料。 */
  material: { hers: readonly string[]; talk: readonly string[] }
  /** 哪一天（`YYYY-MM-DD`）。 */
  date: string
  /** 现在（ISO 8601）。 */
  nowIso: string
  /** 她的时区（只用于写"几号"）。 */
  timeZone?: string
}

/** 模型该交回来的东西。 */
interface GrowOutput {
  sections: Array<{ title: string; items: string[] }>
  candidates: Array<{ about: GrowAbout; section: string; text: string }>
}

/** 收账提示：系统段。 */
const GROW_SYSTEM = [
  '这是你自己的一天。把这一天里值得留下的，写进**你自己**（你的信息层：意识与经验）。材料是你这一天的两栏记录。',
  '你要做两件事：',
  '一、【他明确要求过的】他说过、要你以后怎么做的话（"以后别…""别再…""记住…"）。这一类**当场写进你自己**，不攒。',
  '二、【你观察到的】关于他、或者关于你自己、值得长期记住的事（喜好、习惯、边界、口头禅）。',
  '　　这一类**只列出来**，攒够次数再决定要不要写进自己。',
  '输出一个 JSON 对象，不要解释、不要 Markdown 代码块：',
  '{"sections":[{"title":"说话风格","items":["……","……"]}],"candidates":[{"about":"user","section":"关系","text":"爱吃糖葫芦"}]}',
  '硬性要求：',
  '1. sections 只列**要改的小节**；items 是那一节**改完之后的完整列表**，不是增量补丁；',
  '2. **只能加**：原来那一节的每一条都必须还在新列表里（可以并进更长的句子，不许消失）；',
  '3. **不许新造小节**：只能用下面给出的已有小节名；',
  '4. 想加的东西先并进**已有的那一条**；',
  '　 例如：已有「喜欢的食物：西瓜、芒果」→ 改成「喜欢的食物：西瓜、芒果、糖葫芦」；',
  '　 ✗ 不许改成两条：「喜欢的食物：西瓜、芒果」+「爱吃糖葫芦」——同义的条目会越攒越多，最后一节里全是一句话的意思。',
  '　 只有在**真的没有一条装得下**的时候，才在同一个已有小节里新起一条；',
  '5. candidates 每条只写一句话（≤30 字）；about=user 是"关于他"，about=self 是"关于她自己"；',
  '6. 材料里没有的东西一律不编；没有可写的就给空数组。',
].join('\n')

/**
 * 解析模型的输出（容忍它多说几句）。
 * @param raw - 原文。
 * @returns 结构化结果；坏 JSON 时 `undefined`。
 */
export function parseGrow(raw: string): GrowOutput | undefined {
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
  const rawSections = (parsed as { sections?: unknown }).sections
  const rawCandidates = (parsed as { candidates?: unknown }).candidates
  const sections = Array.isArray(rawSections)
    ? rawSections
        .map((item) => {
          const section = item as { title?: unknown; items?: unknown }
          const title = typeof section.title === 'string' ? section.title.trim() : ''
          const items = Array.isArray(section.items)
            ? section.items.filter((line): line is string => typeof line === 'string' && line.trim() !== '')
            : []
          return title === '' || items.length === 0 ? undefined : { title, items }
        })
        .filter((item): item is { title: string; items: string[] } => item !== undefined)
    : []
  const allowed = new Set<GrowAbout>(['user', 'self'])
  const candidates = Array.isArray(rawCandidates)
    ? rawCandidates
        .map((item) => {
          const candidate = item as { about?: unknown; section?: unknown; text?: unknown }
          const text = typeof candidate.text === 'string' ? candidate.text.trim() : ''
          const about = typeof candidate.about === 'string' && allowed.has(candidate.about as GrowAbout)
            ? (candidate.about as GrowAbout)
            : 'self'
          const section = typeof candidate.section === 'string' ? candidate.section.trim() : ''
          return text === '' ? undefined : { about, section, text }
        })
        .filter((item): item is { about: GrowAbout; section: string; text: string } => item !== undefined)
    : []
  return { sections, candidates }
}

/** 判"字还在不在"时忽略的标点与空白（合并时它们会变，位置也不代表意思）。 */
const IGNORED_CHARS = /[\s，。、；：！？「」『』【】（）()《》·,.;:!?]/

/**
 * 旧条目里的字是不是都还在（顺序不乱）。
 *
 * 为什么不是"完全包含"：真实的合并会在句子中间插字 ——
 * 「不使用官腔官话」→「不使用「我认」「明白了」等官腔官话」，完全包含判不出来，
 * 那样每一次正常的合并都会被误拒。反过来只有"丢字"才拦得住真正的删除。
 * @param previous - 旧的条目。
 * @param next - 新的条目。
 * @returns 字都还在为 `true`。
 */
export function survives(previous: string, next: string): boolean {
  const wanted = [...previous].filter((char) => !IGNORED_CHARS.test(char))
  const haystack = [...next]
  let cursor = 0
  for (const char of wanted) {
    while (cursor < haystack.length && haystack[cursor] !== char) cursor += 1
    if (cursor >= haystack.length) return false
    cursor += 1
  }
  return true
}

/**
 * 一道机器校验：原来那一节的每一条都必须还能在新列表里找到（字不许少）。
 *
 * 为什么不能只靠模型自觉：它很擅长"顺手润色一下"，而润色掉一条就是删了她的一段自己。
 * @param previous - 原来的条目。
 * @param next - 新的条目。
 * @returns 丢掉的旧条目（空数组 = 没丢）。
 */
export function lostItems(previous: readonly string[], next: readonly string[]): string[] {
  return previous
    .map((item) => item.trim())
    .filter((item) => item !== '')
    .filter((item) => !next.some((line) => survives(item, line.trim())))
}

/**
 * 把模型交回的小节并进文档（逐节校验，坏的那节整节不写）。
 * @param document - 当前人格文档。
 * @param proposed - 模型交回的小节。
 * @returns 新文档、写进去的小节名、被拒的小节名。
 */
export function applySections(
  document: PersonaDocument,
  proposed: ReadonlyArray<{ title: string; items: string[] }>,
): { next: PersonaDocument; applied: string[]; rejected: string[] } {
  const applied: string[] = []
  const rejected: string[] = []
  const sections: MutableSection[] = document.mutableLayer.sections.map((section) => ({ ...section }))
  for (const change of proposed.slice(0, MAX_SECTIONS)) {
    const index = sections.findIndex((section) => section.title === change.title)
    const previous = index >= 0 ? sections[index] : undefined
    if (previous === undefined) {
      // 新造小节：不许（同义小节早晚会分叉）。
      rejected.push(`${change.title}（没有这个小节）`)
      continue
    }
    const items = change.items.map((item) => item.trim()).filter((item) => item !== '')
    if (items.length === 0) {
      rejected.push(`${change.title}（交回来是空的）`)
      continue
    }
    if (items.some((item) => item.length > MAX_ITEM_CHARS)) {
      rejected.push(`${change.title}（有条目太长）`)
      continue
    }
    const lost = lostItems(previous.items, items)
    if (lost.length > 0) {
      rejected.push(`${change.title}（会丢掉：${(lost[0] ?? '').slice(0, 20)}…）`)
      continue
    }
    if (items.length - previous.items.length > MAX_ADDED) {
      rejected.push(`${change.title}（一次加太多）`)
      continue
    }
    if (items.join('\n') === previous.items.join('\n')) continue
    sections[index] = { ...previous, items }
    applied.push(change.title)
  }
  return {
    next: { ...document, mutableLayer: { ...document.mutableLayer, sections } },
    applied,
    rejected,
  }
}

/** 她现在的信息层里是不是已经有这一条了（含近似说法）。 */
function alreadyKnown(document: PersonaDocument, text: string): boolean {
  const lines = [
    ...document.mutableLayer.sections.flatMap((section) => section.items),
    ...document.mutableLayer.userDefined.map((entry) => `${entry.key}：${entry.value}`),
  ]
  return lines.some((line) => line.includes(text) || sameTopic(line, text))
}

/**
 * 造提示里的"当前信息层"。
 * @param document - 当前人格文档。
 * @returns 多行文本。
 */
function renderPersona(document: PersonaDocument): string[] {
  const lines: string[] = []
  for (const section of document.mutableLayer.sections) {
    if (section.items.length === 0) continue
    lines.push(`- ${section.title}：`)
    for (const item of section.items) lines.push(`　　· ${item}`)
  }
  for (const entry of document.mutableLayer.userDefined) lines.push(`- ${entry.key}：${entry.value}`)
  return lines.length === 0 ? ['（信息层还是空的）'] : lines
}

/** 造提示里的"队列现状"。 */
function renderQueue(queue: GrowQueue, due: readonly GrowCandidate[]): string[] {
  const dueText = new Set(due.map((candidate) => candidate.text))
  const pending = queue.candidates.filter((candidate) => !dueText.has(candidate.text))
  const lines: string[] = []
  if (pending.length > 0) {
    lines.push('【观察队列（已经攒着、还不够次数）】')
    for (const candidate of pending) {
      lines.push(`- ${candidate.text}（${candidate.about === 'user' ? '关于他' : '关于她自己'}，提到 ${candidate.count} 次，跨 ${candidate.days.length} 天）`)
    }
  }
  if (due.length > 0) {
    lines.push('', '【今天够条件、必须写进信息层的】')
    for (const candidate of due) {
      lines.push(`- ${candidate.text}（${candidate.about === 'user' ? '关于他' : '关于她自己'}）→ 并进「${candidate.section}」`)
    }
  }
  return lines
}

/**
 * 跑一次整理。
 *
 * 失败一律只记痕迹、不抛：自我整理坏了不该把这一天的日记也带走。
 * @param deps - 外部事实。
 * @param input - 这一次的输入。
 */
export async function growDay(deps: GrowDeps, input: GrowInput): Promise<void> {
  const documents = deps.documents()
  if (documents === undefined) return
  const document = deps.section.read()
  // 还没出生（底色没封存）就不整理：那时她连"自己"都还没有。
  if (document.identityCard.sealedAt === '') return
  const material = [...input.material.hers, ...input.material.talk]
  if (material.length === 0) return

  const queue = pruneQueue(readGrowQueue(documents), input.nowIso)
  const due = dueCandidates(queue, MAX_WRITES_PER_DAY)
  const route = deps.llm.route()
  if (route === undefined) {
    await saveGrowQueue(documents, { ...queue, lastRun: { at: input.nowIso, wrote: [], queued: [], note: '没有可用的模型，这一天没有整理' } })
    return
  }

  const text = [
    `今天是 ${input.date}。`,
    '',
    '【她自己那段时间】',
    input.material.hers.length === 0 ? '（这一天她没有自己的时间）' : '',
    ...input.material.hers.map((line) => `- ${line}`),
    '',
    '【你们这一天】',
    input.material.talk.length === 0 ? '（这一天你们没有说过话）' : '',
    ...input.material.talk.map((line) => `- ${line}`),
    '',
    '【现在的信息层】',
    ...renderPersona(document),
    '',
    ...renderQueue(queue, due),
  ].filter((line, index, all) => !(line === '' && all[index - 1] === '')).join('\n')

  const result = await deps.llm.streamText({ route, system: GROW_SYSTEM, text, maxTokens: 1600, timeoutMs: 60_000 })
  const parsed = parseGrow(result.text)
  if (parsed === undefined) {
    await saveGrowQueue(documents, { ...queue, lastRun: { at: input.nowIso, wrote: [], queued: [], note: '整理输出没法用（模型没按格式回），这一天没有更新' } })
    return
  }

  const { next, applied, rejected } = applySections(document, parsed.sections)
  const notes: string[] = []
  /** 写入真的落地了吗（校验被拒时不能当作写成了，否则队列会把候选提前删掉）。 */
  let landedDocument = document
  let wroteTitles: string[] = []
  if (applied.length > 0) {
    try {
      await deps.section.write(next, 'agent')
      landedDocument = next
      wroteTitles = applied
    } catch (error) {
      notes.push(`写入被拒：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (rejected.length > 0) notes.push(`没写：${rejected.join('；')}`)

  // 队列：到期的写成就拿掉，没写成就留着等下次；新观察按相似合并。
  const written = landedDocument.mutableLayer.sections.flatMap((section) => section.items)
  let merged: GrowQueue = queue
  for (const candidate of due) {
    const landed = written.some((item) => item.includes(candidate.text) || sameTopic(item, candidate.text))
    if (landed) merged = removeCandidate(merged, candidate.text)
    else notes.push(`「${candidate.text}」够条件但没写进去`)
  }
  const queued: string[] = []
  for (const candidate of parsed.candidates.slice(0, MAX_CANDIDATES)) {
    const observation = {
      text: candidate.text.slice(0, MAX_CANDIDATE_CHARS),
      about: candidate.about,
      section: candidate.section,
    }
    // 已经在信息层里的不再进队列（省得攒到升级才发现白攒）。
    if (alreadyKnown(document, observation.text)) continue
    if (due.some((item) => sameTopic(item.text, observation.text))) continue
    merged = mergeObservation(merged, observation, input.date, input.nowIso)
    queued.push(observation.text)
  }

  await saveGrowQueue(documents, {
    ...merged,
    lastRun: { at: input.nowIso, wrote: wroteTitles, queued, note: notes.join('；') },
  })
  deps.log.info(`自我整理（${input.date}）：写了 ${wroteTitles.length} 节，进队列 ${queued.length} 条 ${notes.length === 0 ? '' : `（${notes.join('；')}）`}`)
}
