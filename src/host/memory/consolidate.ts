/**
 * 归拢（`period`）与阶段（`chapter`）：把零散的事慢慢合成一句概括。
 *
 * ### 为什么必须有这一步
 *
 * 只有 `episode` 的记忆，一件一件排着，越攒越像流水账。人不是这样记的：你会记得
 * "那阵子他总在半夜找我聊工作"，而不是"10 月 3 日他 23:40 找我、10 月 5 日他 23:10 找我……"。
 * 这一层就是那个"那阵子"。
 *
 * ### 怎么归（三个取舍）
 *
 * 1. **谁来做判断**：交给模型，不给它"相似度阈值"。中文字面的重合度判不出"散步"和"逛公园"
 *    是同一类事；而让人来判断"这两件事是不是同一类"，恰恰是模型擅长的。
 * 2. **原来那几条怎么办**：不删。它们只是**不再单独出现**（`covers` 里记着谁吸收了谁），
 *    所以工作台还看得到原话，需要时也能被单独翻出来。
 * 3. **写多重的账**：一条概括的代价取它收进来的最贵那条，感受取最强的那一次 ——
 *    概括不能成为"绕过秘密"的后门，也不能把一件扎人的事说得轻飘飘。
 *
 * ### 什么时候归
 *
 * 一天最多一次，而且只挑"放了半天以上的经历"（`CONSOLIDATE_MIN_AGE_MS`）。刚说完的话还在
 * 这一场对话里，当场压缩等于从她手里抢走细节。冷却看**库里最新一条概括的写入时刻**，
 * 不另存状态 —— 进程重启也不会把冷却弄丢。
 * @module humanity/memory/consolidate
 */
import type { LlmAccess, ModelRoute } from '../llm.js'
import type { Log } from '../log.js'
import {
  CHAPTER_MIN_SOURCES,
  CONSOLIDATE_COOLDOWN_MS,
  CONSOLIDATE_MAX_INPUT,
  CONSOLIDATE_MIN_AGE_MS,
  PERIOD_MIN_SOURCES,
  WHAT_CHAR_LIMIT,
} from './constants.js'
import type { MemoryAbout } from './constants.js'
import { strengthAt } from './decay.js'
import { createMemoryRecord } from './model.js'
import { asAbout, extractJsonArray } from './parse.js'
import type { MemoryStore } from './store.js'
import { unfolded } from './tiers.js'
import type { MemoryRecord } from './types.js'

/** 一天多少毫秒。 */
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 归拢的提示词：只要形状，不要判断标准。
 *
 * 「至少 3 件」写在提示词里而不只写在代码里：代码里那道是硬闸（不够就丢），
 * 写在这里是为了让它**先别生成**只有两件的概括，省一次返工。
 */
const PERIOD_SYSTEM = [
  '你在整理自己的记忆：把零散的经历合成一句概括。',
  '下面每一行是一条还没整理的经历，格式是「编号 | 日期 | 一句话」。',
  '',
  '把**同一类**的挑出来，合成一句像人回想时说的话 —— 比如「那阵子他总在半夜找我聊工作」。',
  '',
  '规则：',
  '- 每条概括至少由 3 条经历合成；凑不够 3 条的，不要输出。',
  '- 用「我」指你自己；其他人一律写名字，不写"你 / 他 / 对方"。',
  '- 只写这些经历**共同说明**的事，不要编造没出现的细节，不要加评价。',
  '- 一句概括不超过 60 字。',
  '- 不要把两个不同的人的事混进同一条。',
  '',
  '只输出 JSON 数组，不要解释、不要代码围栏：',
  '[{ "ids": ["1", "2", "3"], "what": "概括", "about": "self | user | us | world" }]',
].join('\n')

/** 阶段的提示词：同一个月里的小事合成"那阵子"。 */
const CHAPTER_SYSTEM = [
  '你在给自己的一段日子起一句概括。',
  '下面每一行是一条已经归拢过的"一类事"，格式是「编号 | 月份 | 一句话」。',
  '',
  '把**同一个月**的几件合成一句更粗的概括 —— 像人回想「十一月那阵子我们不太顺」。',
  '',
  '规则：',
  '- 每条概括至少由 3 条合成；同一个月凑不够 3 条的，不要输出。',
  '- 用「我」指你自己；其他人一律写名字，不写"你 / 他 / 对方"。',
  '- 只写它们共同说明的事，不要编造没出现的细节，不要加评价。',
  '- 一句概括不超过 60 字。',
  '',
  '只输出 JSON 数组，不要解释、不要代码围栏：',
  '[{ "ids": ["1", "2", "3"], "what": "概括", "about": "self | user | us | world" }]',
].join('\n')

/** 把 ISO 时刻读成毫秒；读不出来返回 `undefined`。 */
function timeOf(iso: string): number | undefined {
  if (iso === '') return undefined
  const at = Date.parse(iso)
  return Number.isFinite(at) ? at : undefined
}

/** 一条记录属于哪个月（UTC，`YYYY-MM`）。 */
function monthKeyOf(when: string): string {
  const at = timeOf(when)
  return at === undefined ? '' : new Date(at).toISOString().slice(0, 7)
}

/**
 * 还能被归拢的经历：`episode`、没被吸收、而且已经放了半天以上。
 *
 * 按发生时间从早到晚排 —— 模型读时间顺序更容易看出"那阵子"。
 * @param records - 全部记忆。
 * @param now - 现在。
 * @returns 最多 `CONSOLIDATE_MAX_INPUT` 条。
 */
export function periodCandidates(records: readonly MemoryRecord[], now: Date): MemoryRecord[] {
  const floor = now.getTime() - CONSOLIDATE_MIN_AGE_MS
  return unfolded(records)
    .filter((record) => record.tier === 'episode')
    .filter((record) => {
      const at = timeOf(record.createdAt)
      return at !== undefined && at <= floor
    })
    .sort((left, right) => (left.when < right.when ? -1 : left.when > right.when ? 1 : 0))
    .slice(0, CONSOLIDATE_MAX_INPUT)
}

/**
 * 还能被合进"一段时期"的归拢：`period`、没被吸收、而且那个月已经过完。
 *
 * 为什么要求月份过完：一段日子还没过完就给它下结论，等于替还没发生的事定性。
 * @param records - 全部记忆。
 * @param now - 现在。
 * @returns 候选（未按月份分组）。
 */
export function chapterCandidates(records: readonly MemoryRecord[], now: Date): MemoryRecord[] {
  const current = monthKeyOf(now.toISOString())
  return unfolded(records).filter((record) => record.tier === 'period' && monthKeyOf(record.when) !== current)
}

/**
 * 按月份把候选分成几堆（只有够数的堆才留下）。
 * @param periods - `chapterCandidates` 的结果。
 * @param _now - 现在（保留参数以便将来按"过了多少天"再筛）。
 * @returns 月份 → 那一堆归拢。
 */
export function chapterBuckets(periods: readonly MemoryRecord[], _now: Date): Map<string, MemoryRecord[]> {
  const buckets = new Map<string, MemoryRecord[]>()
  for (const record of periods) {
    const key = monthKeyOf(record.when)
    if (key === '') continue
    const list = buckets.get(key) ?? []
    list.push(record)
    buckets.set(key, list)
  }
  for (const [key, list] of buckets) if (list.length < CHAPTER_MIN_SOURCES) buckets.delete(key)
  return buckets
}

/**
 * 现在该不该归拢。
 *
 * 两个条件缺一不可：**有够数的素材**，而且**离上次归拢超过一天**。
 * 冷却看库里最新一条概括的写入时刻，所以重启进程不会让它提前跑。
 * @param records - 全部记忆。
 * @param now - 现在。
 * @returns 该跑则 `true`。
 */
export function consolidationDue(records: readonly MemoryRecord[], now: Date): boolean {
  const ready =
    periodCandidates(records, now).length >= PERIOD_MIN_SOURCES ||
    chapterBuckets(chapterCandidates(records, now), now).size > 0
  if (!ready) return false
  let lastAt = 0
  for (const record of records) {
    if (record.tier !== 'period' && record.tier !== 'chapter') continue
    const at = timeOf(record.createdAt)
    if (at !== undefined && at > lastAt) lastAt = at
  }
  return lastAt === 0 || now.getTime() - lastAt >= CONSOLIDATE_COOLDOWN_MS
}

/** 一条概括（模型给的原始形状）。 */
interface Group {
  ids: string[]
  what: string
  about: MemoryAbout
}

/**
 * 这一堆事**多数**是关于谁的。
 *
 * 模型偶尔会把 `about` 写坏（写成中文、写个不存在的值）。与其因此丢掉一整条概括，
 * 不如按它收进来的那些记录投票 —— 这个答案是**从数据里推出来的**，不是我们猜的。
 * @param sources - 被收进来的记录。
 * @returns 出现最多的那个 `about`；一样多时取第一条的。
 */
function dominantAbout(sources: readonly MemoryRecord[]): MemoryAbout {
  const tally = new Map<MemoryAbout, number>()
  for (const record of sources) tally.set(record.about, (tally.get(record.about) ?? 0) + 1)
  let best = sources[0]?.about ?? 'us'
  for (const [about, count] of tally) if (count > (tally.get(best) ?? 0)) best = about
  return best
}

/**
 * 把模型给的数组收窄成可用的概括。
 *
 * 三条硬闸：编号必须真的存在、条数必须够、**一条经历只能进一条概括**
 * （否则同一件事会被两句话各说一遍）。任何一条不满足就丢掉这一组，不影响别的组。
 * `about` 写坏不算致命（按来源投票补上），因为那不影响"这件事到底发没发生"。
 * @param raw - 模型给的数组。
 * @param known - 这次交给模型的候选（编号 → 记录）。
 * @param min - 每组至少几条。
 * @returns 可落库的概括。
 */
export function pickGroups(raw: readonly unknown[], known: ReadonlyMap<string, MemoryRecord>, min: number): Group[] {
  const used = new Set<string>()
  const groups: Group[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const candidate = item as Record<string, unknown>
    if (!Array.isArray(candidate.ids)) continue
    // 模型偶尔会把编号写成 "#3" 或带空格；剥掉这些装饰再对号。
    const ids = [
      ...new Set(
        candidate.ids
          .map((id) => String(id).trim().replace(/^#/, ''))
          .filter((id) => known.has(id)),
      ),
    ]
    if (ids.length < min) continue
    if (ids.some((id) => used.has(id))) continue
    // `what` 写不出来这条就没意义了（一条不知道在说什么的概括不该进库）；
    // 但接受 `summary` 这个常见别名，免得因为字段名不同白丢一次归拢。
    const rawWhat = candidate.what ?? candidate.summary
    const what = typeof rawWhat === 'string' ? rawWhat.trim() : ''
    if (what === '') continue
    for (const id of ids) used.add(id)
    const sources = ids.map((id) => known.get(id) as MemoryRecord)
    groups.push({
      ids,
      what: what.slice(0, WHAT_CHAR_LIMIT),
      about: asAbout(candidate.about) ?? dominantAbout(sources),
    })
  }
  return groups
}

/**
 * 把几条合成一条更粗的记录。
 *
 * 三个"取哪个"的规矩，都是为了不让概括变成后门：
 * - **代价取最贵的**：概括不能比它收进来的任何一条更容易说出口；
 * - **感受取当时最强的**：那阵子里最扎人的一下，就是这段日子的味道。
 *   注意它**不是**取"现在最牢的"：坏情绪本来褪得快（fading affect bias），
 *   按现在的强度挑，会让一段难过的日子里只剩下那些还高兴得起来的事；
 * - **确定度记 `inferred`**：这是她从小事里推出来的，不是亲眼看见的一件具体事。
 * @param sources - 被收进来的记录。
 * @param about - 关于谁（模型给，已校验）。
 * @param what - 概括。
 * @param tier - 这一条属于哪一档。
 * @param now - 现在（算当前强度用）。
 * @returns 待落库的记录。
 */
export function mergeSources(
  sources: readonly MemoryRecord[],
  about: MemoryAbout,
  what: string,
  tier: 'period' | 'chapter',
  now: Date,
): MemoryRecord {
  const latest = sources.reduce((left, right) => (left.when >= right.when ? left : right))
  const sharpest = sources.reduce((left, right) => (left.felt.intensity >= right.felt.intensity ? left : right))
  const mostDurable = sources.reduce((left, right) =>
    strengthAt(left, now) >= strengthAt(right, now) ? left : right,
  )
  const costliest = sources.reduce((left, right) => (left.cost >= right.cost ? left : right))
  return createMemoryRecord({
    what,
    about,
    certain: 'inferred',
    when: latest.when,
    felt: sharpest.felt,
    cost: costliest.cost,
    costWhy: costliest.costWhy,
    strength: strengthAt(mostDurable, now),
    covers: sources.map((record) => record.id),
    tier,
  })
}

/** 归拢需要的外部事实。 */
export interface ConsolidateDeps {
  /** 后台模型入口；路由不可用时整条路径安静跳过。 */
  llm: LlmAccess
  log: Log
  /** 现在（测试注入固定时刻用）。 */
  now?(): Date
}

/** 问一次模型，拿回一个数组；失败一律返回 `undefined`（调用方安静跳过）。 */
async function askGroups(
  deps: ConsolidateDeps,
  route: ModelRoute,
  system: string,
  text: string,
  maxTokens: number,
  what: string,
): Promise<unknown[] | undefined> {
  try {
    const result = await deps.llm.streamText({ route, system, text, maxTokens, timeoutMs: 30_000 })
    const parsed = extractJsonArray(result.text)
    if (parsed === undefined) deps.log.warn(`${what}的输出解析不了：这一次没有归拢（不影响对话）`)
    return parsed
  } catch (error) {
    deps.log.warn(`${what}的模型调用失败：这一次没有归拢（不影响对话）`, error)
    return undefined
  }
}

/** 把一条记录摆成模型能读的一行（编号从 1 开始，见 `numbered`）。 */
interface Numbered {
  /** 给模型看的正文。 */
  text: string
  /** 编号 → 记录。 */
  known: Map<string, MemoryRecord>
}

/**
 * 把候选编成 1、2、3…再交给模型。
 *
 * 为什么不直接把 id 给它：uuid 是一串 36 位、没有任何语义的字符，模型抄错一位我们这边就
 * 认不出来（真机第一次归拢就是这么空手的）。编号短、可数、模型不会抄错，我们这边也能
 * 稳稳地映射回去。
 * @param records - 这次交给模型的候选。
 * @param labelOf - 每条除了编号还要带的信息（日期或月份）。
 * @returns 正文与编号表。
 */
function numbered(records: readonly MemoryRecord[], labelOf: (record: MemoryRecord) => string): Numbered {
  const known = new Map<string, MemoryRecord>()
  const lines: string[] = []
  records.forEach((record, index) => {
    const key = String(index + 1)
    known.set(key, record)
    lines.push(`${key} | ${labelOf(record)} | ${record.what}`)
  })
  return { text: lines.join('\n'), known }
}

/**
 * 归拢一次：先"经历 → 一类事"，再"一类事 → 一段时期"。
 *
 * 两段都可能什么都不写（素材不够、模型不可用、输出不合格），那就安静地什么都不做 ——
 * 宁可这一轮没归拢，也不要写进一条编出来的概括。
 * @param store - 记忆读写入口。
 * @param deps - 模型入口、日志与时钟。
 * @returns 这次写进去的概括（可能为空数组）。
 */
export async function consolidate(store: MemoryStore, deps: ConsolidateDeps): Promise<MemoryRecord[]> {
  const now = deps.now?.() ?? new Date()
  const all = store.all()
  if (!consolidationDue(all, now)) return []
  const route = deps.llm.route()
  if (route === undefined) return []
  const written: MemoryRecord[] = []

  const episodes = periodCandidates(all, now)
  if (episodes.length >= PERIOD_MIN_SOURCES) {
    const listed = numbered(episodes, (record) => record.when.slice(0, 10))
    const raw = await askGroups(deps, route, PERIOD_SYSTEM, listed.text, 700, '记忆归拢')
    if (raw !== undefined) {
      for (const group of pickGroups(raw, listed.known, PERIOD_MIN_SOURCES)) {
        const sources = group.ids.map((key) => listed.known.get(key) as MemoryRecord)
        written.push(await store.put(mergeSources(sources, group.about, group.what, 'period', now)))
      }
      if (written.length > 0) deps.log.info(`记忆归拢：把 ${episodes.length} 条经历合成 ${written.length} 条概括`)
    }
  }

  // 阶段用的是刚写进去的那批，所以重新读一次库。
  const periods = chapterCandidates(store.all(), now)
  for (const [month, bucket] of chapterBuckets(periods, now)) {
    const listed = numbered(bucket, () => month)
    const raw = await askGroups(deps, route, CHAPTER_SYSTEM, listed.text, 400, `记忆阶段（${month}）`)
    if (raw === undefined) continue
    for (const group of pickGroups(raw, listed.known, CHAPTER_MIN_SOURCES)) {
      const sources = group.ids.map((key) => listed.known.get(key) as MemoryRecord)
      written.push(await store.put(mergeSources(sources, group.about, group.what, 'chapter', now)))
    }
  }
  if (written.length > 0) deps.log.info(`记忆阶段/归拢：这次一共写下 ${written.length} 条更粗的记录`)
  return written
}
