/**
 * 自动写入管线：**规范化 → 校验口径 → 去重 → 冲突检测 → 落盘**（P-025）。
 *
 * 单一方向，改动前请保持：`工具/后续管线` → {@link normalizeMemoryContent} →
 * {@link remember}（本次写入的全部判断都在这里）→ `MemoryStore.put` → 存储。
 *
 * 三条与决策直接对应的规则：
 * 1. **敏感内容只进待确认**（P-033）：`sensitivity: 'sensitive'` ⇒ `status: pending`，等用户确认；
 *    自动管线永远不把敏感内容直接写成生效、更不会提升为长期记忆或常驻摘要。
 * 2. **只自动写低风险稳定信息**（P-025）：模糊/一次性内容由调用方判断后记成会话记忆或干脆不记。
 * 3. **冲突只标记不解决**（P-025 + `conflict.ts`）：标记写进双方条目，等用户在工作台处理。
 *
 * @module humanity/memory/write
 */
import { stripControlChars } from '../text.js'
import { CONTENT_CHAR_LIMIT, DEFAULT_CONFIDENCE, USER_STATED_CONFIDENCE } from './constants.js'
import type { MemoryOrigin, MemoryScope, MemorySensitivity } from './constants.js'
import { conflictsWith, findConflicts, syncConflictMarks } from './conflict.js'
import { attributionIssue } from './identity.js'
import { createMemoryEntry, buildOwnedKey } from './model.js'
import { adoptExisting, findNearDuplicate } from './similar.js'
import type { MemoryStore } from './store.js'
import type { MemoryEntry, MemoryPolicy } from './types.js'
import { describeEntry, SCOPE_LABELS } from './write-text.js'

/** 一次写入请求（由调用方从工具参数/后续管线整理而来）。 */
export interface RememberInput {
  /** 要记的内容（摘要或事实）。 */
  content: string
  /** 作用域。 */
  scope: MemoryScope
  /** 标签。 */
  tags?: string[]
  /** 敏感度：`sensitive` ⇒ 进待确认（P-033）。 */
  sensitivity: MemorySensitivity
  /** 来源：用户明确说出的记满分置信度，Agent 推断的按默认置信度。 */
  origin: MemoryOrigin
  /** 来源会话 id（必填：没有来源的记忆是传闻）。 */
  sessionId: string
  /** 来源工作区（`workspace` 作用域用它归属；拿不到时为空串）。 */
  workspaceId?: string
}

/** 一次写入的结果。失败也是结构化结果（这条路径的读者是模型，"为什么没写"要能进同一段文案）。 */
export interface RememberResult {
  ok: boolean
  /** 面向 Agent/用户的一句话结论。 */
  message: string
  /** 落盘后的条目；失败时不存在。 */
  entry?: MemoryEntry
  /** 检测到的冲突条目（可能矛盾，未解决）。 */
  conflicts: MemoryEntry[]
  /**
   * 正文是否**超上限被截断**（0.1.9 新增）。
   *
   * 为什么要有这个字段：截断以前是**静默**的（硬切到 200 字、回执照旧说"写好了"）；
   * 实测用户库里 33/56 条正好卡在上限上、调用方毫不知情。现在截断必须在**回执**里说清楚，
   * 并给模型一个能行动的说法（拆条 / 走会话检索），而不是让它以为写全了。
   */
  truncated?: boolean
}

/** 规范化结果：正文 + 是否被截断 + 截断前的字符数。 */
export interface NormalizedMemoryContent {
  content: string
  truncated: boolean
  /** 压平空白之后、截断之前的字符数（`truncated` 为真时才有意义）。 */
  originalChars: number
}

/**
 * 规范化记忆正文并**如实报告是否截断**：剥控制字符 → 压平空白 → 截断到上限。
 *
 * **截断而不是拒绝**（P-015：注入路径不硬拒绝）：记忆是摘要，写长了的正确处置是"留下能用的部分"，
 * 而拒绝会让 Agent 的一次记忆尝试彻底失败。**但"不拒绝"不等于"不说"** ——
 * 超限这件事由 {@link remember} 写进回执（`RememberResult.truncated` 与 `message`），
 * 也会进运行记录的注记（自进化那条路，见 `classify.ts` 的 `memoriesTruncated`）。
 *
 * 归一化只用于**比较**（`buildDedupeKey` / 冲突检测），落盘正文保留用户自己的说法 ——
 * 所以这里只压空白、不改标点与大小写。
 * @param raw - 原始内容。
 * @returns 正文 + 截断标记 + 原长度（正文可能为空串，调用方据此拒绝）。
 */
export function normalizeMemoryContentDetailed(raw: string): NormalizedMemoryContent {
  const flattened = stripControlChars(raw).replace(/\s+/g, ' ').trim()
  const truncated = flattened.length > CONTENT_CHAR_LIMIT
  return {
    content: truncated ? flattened.slice(0, CONTENT_CHAR_LIMIT).trim() : flattened,
    truncated,
    originalChars: flattened.length,
  }
}

/**
 * 规范化记忆正文（只取正文，丢弃截断信息）。
 *
 * 保留这个窄签名：它还被**比较/去重**一侧使用（那里只关心正文）。
 * ⚠️ 写入路径请用 {@link normalizeMemoryContentDetailed}，否则又变回"看不见的截断"。
 * @param raw - 原始内容。
 * @returns 可落盘的正文。
 */
export function normalizeMemoryContent(raw: string): string {
  return normalizeMemoryContentDetailed(raw).content
}

/** 作用域归属 id：会话记忆归会话、工作记忆归工作区、长期记忆不归属任何一方。 */
function ownerIdOf(input: RememberInput): string {
  if (input.scope === 'session') return input.sessionId
  if (input.scope === 'workspace') return input.workspaceId ?? ''
  return ''
}

/**
 * 把"安全标记"合并进已存条目：**只能收紧，不能放松**。
 *
 * 为什么需要这一步（真实漏洞，不是防御性编程）：指纹只由作用域 + 正文算出，不含敏感标记。
 * 于是"敏感内容先进待确认"之后，任何一次同内容的普通写入都会把状态刷回 `active`、
 * 并把 `sensitive` 抹成 false —— 用户明确标记的敏感内容就被一次无关的重复写入提升成了生效记忆。
 * 所以：已存条目是敏感的 ⇒ 保持敏感；仍是待确认的 ⇒ 保持待确认（只有用户能确认，见 `confirm.ts`）。
 */
function mergeSafety(next: MemoryEntry, stored: MemoryEntry | undefined): MemoryEntry {
  if (stored === undefined) return next
  return {
    ...next,
    sensitive: next.sensitive || stored.sensitive,
    // 待确认与已归档都是"用户还没点头"的状态：合并/重写都不许把它们放行（P-026 / P-033）。
    status: stored.status === 'active' ? next.status : stored.status,
    confirmedVia: stored.confirmedVia,
    // **归档不许被悄悄复活**（P-026：归档只影响默认检索，回不回来由用户决定）：
    // 用户在卡片上点了「归档」，之后模型再"想起"同一句话不该把它变回活跃 —— 那等于绕过了用户。
    archivedAt: stored.archivedAt,
  }
}

/**
 * 写入前的三道闸：内容非空、自动写入开着、目标作用域开着。
 *
 * 抽出来是为了让 {@link remember} 只讲流程（规范化 → 构造 → 去重 → 冲突 → 落盘）。
 * @param policy - 当前生效策略。
 * @param scope - 目标作用域。
 * @param content - 规范化后的正文。
 * @returns 拒绝理由；可以写时返回 undefined。
 */
function refusalReason(policy: MemoryPolicy, scope: MemoryScope, content: string): string | undefined {
  if (content === '') return '内容是空的（去掉空白与控制字符后没有可记的东西）。'
  if (!policy.autoWrite) return '记忆写入已在当前策略里关闭（模式 off），本次没有写入。'
  if (!policy.scopes[scope]) return `${SCOPE_LABELS[scope]}已在当前策略里关闭，本次没有写入。`
  return undefined
}

/**
 * 一次记忆写入。
 *
 * 失败一律返回结构化结果（不抛）：调用方是 Agent 工具，模型需要看到"为什么没写下来"。
 * @param store - 记忆读写入口（存储未就绪时调用方不该调到这里）。
 * @param policy - 当前生效策略（作用域开关与自动写入开关都读它）。
 * @param input - 写入请求。
 * @returns 写入结果。
 */
export async function remember(
  store: MemoryStore,
  policy: MemoryPolicy,
  input: RememberInput,
): Promise<RememberResult> {
  const normalized = normalizeMemoryContentDetailed(input.content)
  const content = normalized.content
  // 作用域开关、写开关与「区域记忆必须有归属」都在这里收口（归属判定见 identity.ts）。
  const reason =
    refusalReason(policy, input.scope, content) ?? attributionIssue(input.scope, input.workspaceId ?? '')
  if (reason !== undefined) return { ok: false, message: reason, conflicts: [] }


  const existing = store.list()
  const candidate = createMemoryEntry({
    scope: input.scope,
    content,
    origin: input.origin,
    sourceSessionId: input.sessionId,
    tags: input.tags,
    ownerId: ownerIdOf(input),
    sensitive: input.sensitivity === 'sensitive',
    confidence: input.origin === 'user-stated' ? USER_STATED_CONFIDENCE : DEFAULT_CONFIDENCE,
    // 敏感内容只进待确认（P-033）；其余按低风险稳定信息直接生效（P-025）。
    status: input.sensitivity === 'sensitive' ? 'pending' : 'active',
  })

  // 两道去重：先精确指纹，再问一次"是不是同一条事实的另一种说法"。
  // 近似那一档是 2026-09-25 真机加的：同一条"不区分戏内/戏外"的规矩在库里躺了 4 个平行条目。
  // 精确命中前**先看归属**：同一句话在别的会话/工作区里写进来时，绝不能把那条记忆的主人改掉
  // （P-024）。键被别的归属占着时改用一个带归属的备用键，两条各自独立（老键、老数据都不动）。
  const baseKey = candidate.dedupeKey
  const occupant = store.get(baseKey)
  const sameOwner =
    occupant !== undefined &&
    (candidate.scope === 'long-term' || occupant.ownerId === candidate.ownerId || occupant.ownerId === '')
  const key = buildOwnedKey(candidate.scope, candidate.content, candidate.ownerId, occupant, sameOwner)
  // ⚠️ `baseKey` 必须在**改指纹之前**取好（2026-09-26 审计实测：这里曾用改完之后的
  // `candidate.dedupeKey` 去和 `key` 比，两边恒等 ⇒ 永远走 `occupant` 那一支，
  // 备用键从头到尾没被用过：会话 A 写下的那句被会话 B 覆盖，主人也换成 B）。
  const spare = key !== baseKey
  if (spare) candidate.dedupeKey = key
  // 占位者是**别人**的时候，本次命中只可能是"我自己上次写的同内容"（备用键上那条）；
  // 占位者是本人（或不冲突）时，命中的就是这一条本身。
  const storedBefore = spare ? store.get(key) : occupant
  const near = storedBefore === undefined ? findNearDuplicate(candidate, existing) : undefined
  // **矛盾的两条不是"同一种说法"，是相反的两件事**（"喜欢咖啡" vs "不喜欢咖啡" 的 Dice 高达
  // 0.727，必然落在近似阈值之上）。这种必须交给冲突路径标记，绝不能被并掉 —— 并了就是
  // 静默丢掉一方。2026-09-25 由既有的冲突用例抓出来（第一版实现真把这对并了）。
  const twin = near !== undefined && !conflictsWith(candidate, near) ? near : undefined
  const target = storedBefore ?? twin

  // 合并对象自己不该被判成"与候选矛盾"。冲突标记**只在近似并入时继承**：那种情况下
  // 落盘指纹换成已有那条，不继承就会被 syncConflictMarks 当成"不再矛盾"拆掉；而精确命中
  // 那一档照旧逐次重算 —— 那正是"矛盾来源归档后幽灵标记要能拆掉"所依赖的语义。
  const others =
    target === undefined ? existing : existing.filter((item) => item.dedupeKey !== target.dedupeKey)
  const inherited = twin === undefined ? [] : twin.conflictWith
  const conflicts = [...new Set([...findConflicts(candidate, others), ...inherited])]

  const base = target === undefined ? candidate : adoptExisting(target, candidate)
  const merged = mergeSafety({ ...base, conflictWith: conflicts }, target)
  // 用 **put 的返回值**作为结果：存储层还会保留已存记录的创建时间与使用统计，
  // 直接回传本地算出来的 `merged` 会让工具结果与实际落盘的内容不一致（时间差 1ms 也能看出来）。
  const persisted = await store.put(merged)
  await syncConflictMarks(store, persisted.dedupeKey, conflicts, existing)

  const conflicting = existing.filter((item) => conflicts.includes(item.dedupeKey))
  // 0.1.9：截断**必须在回执里说出来**。旧行为是硬切到上限、回执照旧报成功 ——
  // 实测用户库里 33/56 条正好卡在 200 字上，调用方从来不知道自己的话被切掉了尾巴。
  // 这里给的是**能行动**的说法（拆条 / 会话检索），不是一句"注意"。
  const truncationNote = normalized.truncated
    ? `\n⚠️ 正文超过上限（${CONTENT_CHAR_LIMIT} 字），**已截断保存前 ${CONTENT_CHAR_LIMIT} 字**（原始 ${normalized.originalChars} 字）。要保留全文请拆成多条写入，或用会话检索回查原文。`
    : ''
  const message = describeEntry(persisted, target !== undefined, conflicting.length > 0, twin !== undefined) + truncationNote
  return { ok: true, message, entry: persisted, conflicts: conflicting, truncated: normalized.truncated }
}
