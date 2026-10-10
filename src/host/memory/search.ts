/**
 * 本地检索引擎：给定当前用户发话，从活跃记忆里挑出最相关的 0–N 条。
 *
 * 单一方向：`用户发话` → {@link tokenize} → {@link scoreEntry} 打分 → 阈值筛 → 取前 N
 * → `MemoryStore.markUsed`（为 P-026 的衰减提供"最近有没有用过"）。
 *
 * 四条硬约束（改动前先读）：
 * 1. **不调用模型做查询改写**（P-029）：查询就是用户那句话本身，分词是本地规则；
 * 2. **只查 `active`**（P-026）：归档记忆默认不参与检索，要看得去工作台手动调回；
 * 3. **会话记忆不跨会话**（§4.2.1）：别的会话的会话记忆一律不参与，哪怕关键词全中；
 * 4. **作用域开关即时生效**（P-030）：被关掉的层不参与，和"模式 off"是同一套策略对象。
 *
 * 向量检索**刻意不在这里**（P-027：默认关闭、可选增强、派生可重建）。
 * @module humanity/memory/search
 */
import type { MemoryStore } from './store.js'
import { maybeRunDecay } from './decay.js'
import { matchesQuery, scoreEntry, type SearchContext } from './scoring.js'
import { tokenize } from './tokenize.js'
import type { MemoryScope } from './constants.js'
import type { MemoryEntry, MemoryPolicy } from './types.js'

/** 一次检索的输入。 */
export interface SearchQuery {
  /** 当前用户发话（原样，不做改写）。 */
  message: string
  /** 当前会话 id。 */
  sessionId: string
  /** 当前工作区 id；无工作区时为空串。 */
  workspaceId: string
}

/** 检索的可选调整（缺省全部走策略）。 */
export interface SearchOptions {
  /** 只在这个作用域里找（recall 的 scope 参数用它）；缺省 = 全部开启的层。 */
  scope?: MemoryScope
  /** 最多返回几条；缺省用 `policy.injectLimit`。 */
  limit?: number
  /** 相关度阈值；缺省用 `policy.relevanceThreshold`。 */
  threshold?: number
  /** 是否顺带记一次"被使用"；缺省 true（干跑对比时置 false，免得污染统计）。 */
  markUsed?: boolean
}

/**
 * 这条记忆是否**有资格**进入本次检索。
 *
 * 三条：作用域开关开着、是生效状态、会话记忆只属于当前会话。
 * @param entry - 待判定条目。
 * @param query - 检索输入。
 * @param policy - 当前生效策略。
 * @returns 可以参与检索时为 true。
 */
function isEligible(entry: MemoryEntry, query: SearchQuery, policy: MemoryPolicy): boolean {
  if (entry.status !== 'active') return false
  if (!policy.scopes[entry.scope]) return false
  // 归属必须对得上（2026-09-26 审计实测的真缺陷）：原来只对会话层设卡，区域记忆在别的工作区
  // 里只是**扣 0.15 分**，照样越过默认阈值被检索、被注入 —— 「只在某个工作目录里被想起」这句话
  // 就成了空话（也算跨区泄露）。归属读不到时**不猜**：宁可不注入，也不把别处的记忆带过来。
  if (entry.scope === 'session') return query.sessionId !== '' && entry.ownerId === query.sessionId
  if (entry.scope === 'workspace') return query.workspaceId !== '' && entry.ownerId === query.workspaceId
  return true
}

/**
 * 排序：分数降序，然后重要度、更新时间降序，最后指纹升序 —— 同分时结果也必须稳定，
 * 否则同一句话两轮注入的顺序会不一样（提示词缓存与用户观感都会抖）。
 */
function compareScored(
  left: { entry: MemoryEntry; score: number },
  right: { entry: MemoryEntry; score: number },
): number {
  if (left.score !== right.score) return right.score - left.score
  if (left.entry.importance !== right.entry.importance) return right.entry.importance - left.entry.importance
  if (left.entry.updatedAt !== right.entry.updatedAt) return left.entry.updatedAt < right.entry.updatedAt ? 1 : -1
  return left.entry.dedupeKey < right.entry.dedupeKey ? -1 : 1
}

/**
 * 排序与筛选：**同步**（只读内存里的表快照），不推进使用统计。
 *
 * 为什么必须是同步的：系统提示词的 `section.text` 回调**只能返回字符串**
 * （`dsh-system-prompt` 的 `PromptSection.text` 签名），注入路径里没有 await 的机会。
 * 于是把"选哪些条目"（纯计算，同步）与"记一次使用"（要写盘，异步）拆开：
 * 注入用 {@link rankMemories} + 日志式异步补记，工具/recall 用 {@link searchMemory}。
 * @param store - 记忆读写入口。
 * @param policy - 当前生效策略。
 * @param query - 检索输入。
 * @param options - 可选调整（`markUsed` 在这里无意义，见 {@link searchMemory}）。
 * @returns 命中条目（可能为空数组）。
 */
export function rankMemories(
  store: MemoryStore,
  policy: MemoryPolicy,
  query: SearchQuery,
  options: SearchOptions = {},
): MemoryEntry[] {
  const tokens = tokenize(query.message)
  if (tokens.size === 0) return []

  const context: SearchContext = { sessionId: query.sessionId, workspaceId: query.workspaceId }
  const now = new Date().toISOString()
  const threshold = options.threshold ?? policy.relevanceThreshold
  const limit = Math.max(0, options.limit ?? policy.injectLimit)

  const scored = store
    .list(undefined, 'active')
    .filter((entry) => isEligible(entry, query, policy))
    .filter((entry) => options.scope === undefined || entry.scope === options.scope)
    // 先过"有交集"的门，再谈分数：低阈值下质量底噪会淹没相关性（见 `matchesQuery`）。
    .filter((entry) => matchesQuery(entry, tokens))
    .map((entry) => ({ entry, score: scoreEntry({ entry, queryTokens: tokens, context, now }) }))
    .filter((item) => item.score >= threshold)
    .sort(compareScored)
    .slice(0, limit)

  return scored.map((item) => item.entry)
}

/**
 * 记一次"被使用"（`markUsed`）：这是使用统计的唯一推进入口，也是 P-026 判断"长期未用"的依据。
 *
 * 一次检索命中几条就记几条；失败**不抛**给调用方（统计是派生数据，写不进去不该毁掉这次检索）。
 * @param store - 记忆读写入口。
 * @param entries - 本轮命中的条目。
 * @param onError - 单条失败时的回调（日志）；缺省静默（由调用方决定要不要记）。
 */
export async function markMemoriesUsed(
  store: MemoryStore,
  entries: readonly MemoryEntry[],
  onError?: (error: unknown) => void,
): Promise<void> {
  for (const entry of entries) {
    try {
      await store.markUsed(entry.dedupeKey)
    } catch (error) {
      onError?.(error)
    }
  }
}

/**
 * 检索（带使用统计）：先 {@link rankMemories} 选出条目，再 {@link markMemoriesUsed} 记一次使用。
 *
 * 次数只影响排序，**不因为高频就注入**（P-031）。`options.markUsed === false` 时跳过统计，
 * 供"干跑对比"用（免得实验本身改变了下一轮的排序）。
 * @param store - 记忆读写入口。
 * @param policy - 当前生效策略。
 * @param query - 检索输入。
 * @param options - 可选调整。
 * @returns 命中条目（可能为空数组）。
 */
export async function searchMemory(
  store: MemoryStore,
  policy: MemoryPolicy,
  query: SearchQuery,
  options: SearchOptions = {},
): Promise<MemoryEntry[]> {
  const hits = rankMemories(store, policy, query, options)
  if (options.markUsed !== false) await markMemoriesUsed(store, hits)
  // 顺带维护：到期才真的跑（见 `maybeRunDecay`），**不 await** —— 检索结果先回去，
  // 维护在后台完成；失败也不影响这次检索。
  void maybeRunDecay(store, policy, new Date().toISOString())
  return hits
}
