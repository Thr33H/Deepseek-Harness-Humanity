/**
 * 「她自己整理自己」的候选队列 —— **重复是唯一的投票，时间会作废废票**。
 *
 * ### 为什么要它
 *
 * 信息层（意识与经验）原来只有两个来源：出生那一次，与对方在工作台上手动改。
 * 她不会因为"这一天过得怎么样"而更新自己。而如果每天都能随便写，她会被一句随口的话改一次，
 * 几天就成另一个人。所以分两条路：
 *
 * - **明确的要求**（"以后别总说我认了"）当天就写 —— 那是指令，不是观察；
 * - **不明确的观察**（"想吃糖葫芦"反复出现）先进这里攒证据：同一条被提到够多次、跨够多天，
 *   才算她自己的认知；久不再提就作废。
 *
 * ### 三条规矩（都是纯函数，用例钉住）
 *
 * 1. **同一件事只留一条**：按"词重合度"判，且带极性判据 ——
 *    「爱吃糖葫芦」与「不爱吃糖葫芦」很像，但它们是两件事；
 * 2. **升级要跨天**：一天里连说三遍不该当晚就变成长期认知；
 * 3. **会作废**：冷候选（1 次）7 天没人提就丢，热候选（≥2 次）留 15 天。
 * @module humanity/persona/grow-queue
 */
import type { DocumentStore } from '../documents.js'
import { opposesByNegation, similarity } from '../text.js'

/** 队列存哪（与人格文档分开：它是过程，不是她）。 */
export const GROW_DOC_KEY = 'humanity-persona-grow'

/** 一条观察要够几次才算数。 */
export const PROMOTE_COUNT = 3
/** 而且要跨几天 —— 防"一天连说三遍"。 */
export const PROMOTE_DAYS = 3
/** 冷候选（提到 1 次）多久没再提就作废（天）。 */
export const KEEP_DAYS = 7
/** 热候选（提到 ≥2 次）留多久（天）。 */
export const KEEP_DAYS_WARM = 15
/** 多像才算"同一件事"（与记忆模块同一把尺子）。 */
export const SAME_TOPIC = 0.62
/** 队列上限（防止它自己长成一个垃圾场）。 */
export const MAX_CANDIDATES = 60
/** 一条候选最多记几天的痕迹（够判"跨天"就行）。 */
const MAX_DAYS = 30

/** 这条观察关于谁。 */
export type GrowAbout = 'user' | 'self'

/** 队列里的一条观察。 */
export interface GrowCandidate {
  /** 一句话观察（"爱吃糖葫芦"）。 */
  text: string
  /** 关于他 / 关于她自己。 */
  about: GrowAbout
  /** 将来写进哪一节（必须是已有的小节名）。 */
  section: string
  /** 被提到过几次。 */
  count: number
  /** 提到过的那几天（`YYYY-MM-DD`，去重、升序）。 */
  days: string[]
  /** 第一次与最近一次（ISO 8601）。 */
  firstAt: string
  lastAt: string
}

/** 上一次跑完留下的痕迹（给人看，不参与任何判定）。 */
export interface GrowRun {
  at: string
  /** 这次真的写进信息层的（条目文本）。 */
  wrote: string[]
  /** 这次新进队列 / 又被提到一次的。 */
  queued: string[]
  /** 出了什么状况（空串 = 一切正常）。 */
  note: string
}

/** 队列文档。 */
export interface GrowQueue {
  candidates: GrowCandidate[]
  lastRun: GrowRun
}

/** 空队列。 */
export const EMPTY_QUEUE: GrowQueue = {
  candidates: [],
  lastRun: { at: '', wrote: [], queued: [], note: '' },
}

/** 两个人的说法是不是同一件事（极性相反的不算）。 */
export function sameTopic(left: string, right: string): boolean {
  if (left.trim() === '' || right.trim() === '') return false
  if (opposesByNegation(left, right)) return false
  return similarity(left, right) >= SAME_TOPIC
}

/**
 * 这条候选还能留多久（天）。
 *
 * 越接近升级的留得越久：只提过一次的本来就像随口一说；提过两次的已经在成形了。
 * @param candidate - 一条观察。
 * @returns 天数。
 */
export function keepDaysOf(candidate: GrowCandidate): number {
  return candidate.count >= 2 ? KEEP_DAYS_WARM : KEEP_DAYS
}

/**
 * 剔掉已经作废的候选。
 * @param queue - 当前队列。
 * @param nowIso - 现在。
 * @returns 新队列（不改原对象）。
 */
export function pruneQueue(queue: GrowQueue, nowIso: string): GrowQueue {
  const now = Date.parse(nowIso)
  if (!Number.isFinite(now)) return queue
  const kept = queue.candidates.filter((candidate) => {
    const last = Date.parse(candidate.lastAt)
    if (!Number.isFinite(last)) return false
    return now - last <= keepDaysOf(candidate) * 86_400_000
  })
  return { ...queue, candidates: kept }
}

/** 一条新观察。 */
export interface GrowObservation {
  text: string
  about: GrowAbout
  /** 想写进哪一节（空串 = 让调用方给默认值）。 */
  section: string
}

/**
 * 把一条观察并进队列：像的就加一次，不像的新开一条。
 * @param queue - 当前队列（应已 `pruneQueue` 过）。
 * @param observation - 这次看到的。
 * @param day - 哪一天（`YYYY-MM-DD`）。
 * @param nowIso - 现在。
 * @returns 新队列。
 */
export function mergeObservation(
  queue: GrowQueue,
  observation: GrowObservation,
  day: string,
  nowIso: string,
): GrowQueue {
  const text = observation.text.trim()
  if (text === '') return queue
  const candidates = [...queue.candidates]
  const index = candidates.findIndex((candidate) => sameTopic(candidate.text, text))
  if (index >= 0) {
    const previous = candidates[index]
    if (previous === undefined) return queue
    const days = previous.days.includes(day) ? previous.days : [...previous.days, day].slice(-MAX_DAYS)
    candidates[index] = {
      ...previous,
      count: previous.count + 1,
      days,
      lastAt: nowIso,
    }
    return { ...queue, candidates }
  }
  const fresh: GrowCandidate = {
    text,
    about: observation.about,
    section: observation.section,
    count: 1,
    days: [day],
    firstAt: nowIso,
    lastAt: nowIso,
  }
  candidates.push(fresh)
  // 超上限时丢最冷的（count 最小、最久没提的那条）。
  if (candidates.length > MAX_CANDIDATES) {
    candidates.sort((left, right) => right.count - left.count || Date.parse(right.lastAt) - Date.parse(left.lastAt))
    candidates.length = MAX_CANDIDATES
  }
  return { ...queue, candidates }
}

/**
 * 哪些候选已经够条件、该写进信息层了。
 *
 * 「跨几天」按**去重后的天数**算：同一天里被记了三次（合并时会去重，但旧数据可能不是）
 * 也只算一天。
 * @param queue - 当前队列。
 * @param limit - 这一次最多几条（每日上限）。
 * @returns 够条件的（最多 `limit` 条，越早的越优先）。
 */
export function dueCandidates(queue: GrowQueue, limit: number): GrowCandidate[] {
  if (limit <= 0) return []
  return queue.candidates
    .filter((candidate) => candidate.count >= PROMOTE_COUNT && new Set(candidate.days).size >= PROMOTE_DAYS)
    .sort((left, right) => Date.parse(left.firstAt) - Date.parse(right.firstAt))
    .slice(0, limit)
}

/**
 * 从队列里拿掉某一条（已经写进信息层的那些）。
 * @param queue - 当前队列。
 * @param text - 要拿掉的观察文本。
 * @returns 新队列。
 */
export function removeCandidate(queue: GrowQueue, text: string): GrowQueue {
  return { ...queue, candidates: queue.candidates.filter((candidate) => candidate.text !== text) }
}

/**
 * 读队列。
 * @param documents - 文档表句柄；未就绪时按空队列算。
 * @returns 队列（字段逐个兜底）。
 */
export function readGrowQueue(documents: DocumentStore | undefined): GrowQueue {
  const value = documents?.read(GROW_DOC_KEY)?.value
  if (typeof value !== 'object' || value === null) return EMPTY_QUEUE
  const raw = value as { candidates?: unknown; lastRun?: unknown }
  const candidates = Array.isArray(raw.candidates)
    ? raw.candidates.filter((item): item is GrowCandidate => {
        const candidate = item as Partial<GrowCandidate> | null
        return (
          typeof candidate === 'object'
          && candidate !== null
          && typeof candidate.text === 'string'
          && candidate.text.trim() !== ''
          && typeof candidate.count === 'number'
          && Number.isFinite(candidate.count)
        )
      })
    : []
  const run = raw.lastRun as Partial<GrowRun> | undefined
  return {
    candidates,
    lastRun: {
      at: typeof run?.at === 'string' ? run.at : '',
      wrote: Array.isArray(run?.wrote) ? run.wrote.filter((item): item is string => typeof item === 'string') : [],
      queued: Array.isArray(run?.queued) ? run.queued.filter((item): item is string => typeof item === 'string') : [],
      note: typeof run?.note === 'string' ? run.note : '',
    },
  }
}

/**
 * 写队列。
 * @param documents - 文档表句柄；未就绪时什么也不做。
 * @param queue - 完整队列。
 */
export async function saveGrowQueue(documents: DocumentStore | undefined, queue: GrowQueue): Promise<void> {
  if (documents === undefined) return
  await documents.write(GROW_DOC_KEY, { candidates: queue.candidates, lastRun: queue.lastRun })
}
