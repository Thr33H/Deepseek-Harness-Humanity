/**
 * 检索：此刻她"想得起来"哪几条（**纯函数**，不碰存储）。
 *
 * ### 为什么不用向量
 *
 * 单用户、几千条、一年增长不到 3000 行 —— 这个量级上关键词重合 + 强度 + 心情已经够用，
 * 而向量要额外的模型调用、要维护索引、还会让"她为什么想起这条"变得无法解释。
 *
 * ### 分数拆成三块，不合成一个黑箱
 *
 * 「相关」「还牢不牢」「跟此刻的心情对不对味」是三件不同的事。工作台要能回答
 * "她这会儿为什么带进这一条"，所以三块分开返回，合成只是最后一步。
 * @module humanity/memory/search
 */
import { IDENTITY_HINTS, MIN_SHARED_RELEVANCE, MIN_SHARED_TOKENS, RELEVANCE_THRESHOLD } from './constants.js'
import { isFaded, strengthAt } from './decay.js'
import { foldedIds } from './tiers.js'
import type { MemoryHit, MemoryMood, MemoryRecord } from './types.js'

/** 三块的权重：相关最重要，其次是她还记不记得住，最后是心情。 */
const WEIGHT = { relevance: 0.55, strength: 0.3, mood: 0.15 } as const

/** 中文按双字切、英文按词切；标点与空白丢掉。 */
function tokensOf(text: string): Set<string> {
  const tokens = new Set<string>()
  const cleaned = text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
  // 英文/数字：整词收一遍（双字切法会把 "vram" 切成 "vr"/"ra"，认不出整词）。
  for (const word of text.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []) tokens.add(word)
  // 中文双字：中文没有空格，2-gram 是最省事又能用的近似。
  for (let index = 0; index + 1 < cleaned.length; index += 1) tokens.add(cleaned.slice(index, index + 2))
  return tokens
}

/**
 * 一条记录"能被哪些字眼找到"。
 *
 * 概括只有一句话，但它是从几件事攒出来的，而对方提起来的往往是**具体那件事里的词**
 * （"我们还去园子里散步吗"）。所以可检索文本 = 它自己的话 + 它收进来的那些记录的话
 * （递归，带环保护）。
 *
 * 不这样做，归拢会让记忆**更难被想起来**：明明有"十月那阵子我们不太顺"，
 * 问"那阵子是不是老在夜里聊天"却答不记得 —— 那是把归拢做成了删除。
 * @param records - 全部记忆。
 * @returns id → 可检索文本。
 */
function searchableText(records: readonly MemoryRecord[]): Map<string, string> {
  const byId = new Map(records.map((record) => [record.id, record]))
  const cache = new Map<string, string>()
  const expand = (id: string, seen: Set<string>): string => {
    const cached = cache.get(id)
    if (cached !== undefined) return cached
    const record = byId.get(id)
    if (record === undefined || seen.has(id)) return ''
    seen.add(id)
    const parts = [record.what, record.detail]
    for (const cover of record.covers) parts.push(expand(cover, seen))
    const text = parts.filter((part) => part !== '').join(' ')
    cache.set(id, text)
    return text
  }
  const index = new Map<string, string>()
  for (const record of records) index.set(record.id, expand(record.id, new Set()))
  return index
}

/**
 * 这段可检索文本与当前这句话有多相关（0–1），并给出接住了几个词。
 *
 * 拿"发生了什么"和细节一起比：要点是骨架，细节里常有能被提起的具体词
 * （一个地名、一部片名）。
 *
 * 为什么要一并返回"接住几个词"：长句子的分母大，五个词对上也只有 0.28 ——
 * 准入不能只看比值（见 `MIN_SHARED_TOKENS` 的说明）。
 * @param text - 这条记忆的可检索文本（见 `searchableText`）。
 * @param query - 当前这句话切出来的词。
 * @returns 相关度与接住的词数。
 */
function matchOf(text: string, query: Set<string>): { relevance: number; shared: number } {
  if (query.size === 0) return { relevance: 0, shared: 0 }
  const hay = tokensOf(text)
  if (hay.size === 0) return { relevance: 0, shared: 0 }
  let shared = 0
  for (const token of query) if (hay.has(token)) shared += 1
  // 除以查询词数而不是并集：我们问的是"这句话里有多少被这条记忆接住了"。
  return { relevance: shared / query.size, shared }
}

/**
 * 心情对味的加成：同向的旧事更容易被想起。
 *
 * 只加成**排序**，不参与阈值 —— 阈值决定"有没有资格被注入"，加成决定"谁排在前面"。
 * 让加成参与阈值，等于说"心情差的时候更容易想起无关的旧事"，那是噪声。
 * @param record - 这条记忆。
 * @param mood - 此刻的心情。
 * @returns 0 或 1。
 */
function moodOf(record: MemoryRecord, mood: MemoryMood | undefined): number {
  if (mood === undefined || mood.tone === 0 || record.felt.kind === '') return 0
  const positive = ['joy', 'trust', 'anticipation'].includes(record.felt.kind)
  const negative = ['sadness', 'disgust', 'anger', 'fear'].includes(record.felt.kind)
  if (positive && mood.tone === 1) return 1
  if (negative && mood.tone === -1) return 1
  return 0
}

/**
 * 她此刻**最牢的那几条**（不看当前这句话）。
 *
 * ### 为什么需要这条"不看问题"的路
 *
 * 纯关键词检索有个死穴：它能回答"你还记得小明吗"，却回答不了"**你还记得我吗**" ——
 * 后者一个具体的词都没提，和任何记忆都不重合，于是命中 0 条，她就说"第一次见面"。
 *
 * 而人不是这样：醒来的时候不会先想"对方今天要聊什么"才决定想起谁。**她本来就该记得你。**
 * 所以新会话的第一句、以及"查不到直接相关"的时候，都要退回这条路。
 * @param records - 候选记忆。
 * @param limit - 最多几条。
 * @param now - 现在。
 * @returns 按"牢不牢 × 跟我多大关系"排序，淡掉的不要。
 */
export function strongest(records: readonly MemoryRecord[], limit: number, now: Date = new Date()): MemoryHit[] {
  const hits: MemoryHit[] = []
  // 已经被归拢成"那阵子"的，不再单独出现：概括已经代表它们了。
  const folded = foldedIds(records)
  for (const record of records) {
    // 已经淡到快没了的，不算"她还记得"；已经被归拢进"那阵子"的，也不再单独出现。
    if (folded.has(record.id)) continue
    const strength = strengthAt(record, now)
    if (isFaded(strength)) continue
    hits.push({ record, score: strength, parts: { relevance: 0, strength, mood: 0 } })
  }
  hits.sort((left, right) => right.score - left.score)

  // 「对方是谁」的那一条提到最前。
  //
  // 为什么不让它按强度排队：一句"他叫小明、是男生"的强度往往不高（一次自我介绍没有多少情绪），
  // 会被"他亲了我"这种强记忆挤下去 —— 于是她知道"有人亲过她"，却不知道眼前这个人是谁，
  // 整场对话把他当陌生人（2026-11-21 真机）。
  const isIdentity = (record: MemoryRecord): boolean =>
    record.about === 'user' && IDENTITY_HINTS.some((hint) => record.what.includes(hint))
  const anchorAt = hits.findIndex((hit) => isIdentity(hit.record))
  if (anchorAt > 0) {
    const [anchor] = hits.splice(anchorAt, 1)
    hits.unshift(anchor as MemoryHit)
  }
  return hits.slice(0, Math.max(0, limit))
}

/**
 * 此刻想得起来的那几条，按分数从高到低。
 *
 * 三条硬规则：
 * 1. **淡到几乎没有的不参与**（`isFaded`）—— 它们还在库里，但要靠线索唤醒，不是日常检索；
 * 2. 低于相关度阈值的**宁可不给**（空着比塞错更安全）；
 * 3. 条数由调用方截断（`MAX_INJECT`），这里只负责排序。
 * @param records - 候选记忆（通常是全库）。
 * @param message - 当前这句话。
 * @param options - 此刻的心情（可选）。
 * @returns 命中的记忆，按分数降序。
 */
export function recall(
  records: readonly MemoryRecord[],
  message: string,
  options: { mood?: MemoryMood; now?: Date } = {},
): MemoryHit[] {
  const now = options.now ?? new Date()
  const query = tokensOf(message)
  const text = searchableText(records)
  const hits: MemoryHit[] = []
  const folded = foldedIds(records)
  for (const record of records) {
    // 已经被归拢的不再单独出现：这一层要的是"那阵子"，不是一堆明细。
    if (folded.has(record.id)) continue
    const strength = strengthAt(record, now)
    if (isFaded(strength)) continue
    const { relevance, shared } = matchOf(text.get(record.id) ?? record.what, query)
    const mood = moodOf(record, options.mood)
    const score = WEIGHT.relevance * relevance + WEIGHT.strength * strength + WEIGHT.mood * mood
    // 两道准入：比值够高，或者**接住的词够多且不至于太泛**（长句子专用，见 constants）。
    const admitted =
      relevance >= RELEVANCE_THRESHOLD || (shared >= MIN_SHARED_TOKENS && relevance >= MIN_SHARED_RELEVANCE)
    if (!admitted) continue
    hits.push({ record, score, parts: { relevance, strength, mood } })
  }
  return hits.sort((left, right) => right.score - left.score)
}
