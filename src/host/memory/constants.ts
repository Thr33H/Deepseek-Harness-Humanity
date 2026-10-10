/**
 * 记忆数据模型的**常量**（宿主的唯一真源）。
 *
 * 与 `types.ts` 的分工：这里只放"值"（作用域、状态、阈值、预算），由值派生出来的类型
 * （`MemoryScope` / `MemoryStatus` / `MemoryOrigin`）也跟着放这里，免得两处各写一份。
 * 本文件**不 import 任何东西**：它是纯数据契约，将来若要进浏览器 bundle 也不会牵连宿主服务。
 * @module humanity/memory/constants
 */

/**
 * 三层作用域（DEVELOPMENT §4.2.1）。
 *
 * **顺序即工作台展示顺序**（长期 → 工作 → 会话）：从最稳定到最临时，
 * 与用户的心智一致。注意它**不是**检索优先级，那个是 {@link MEMORY_SCOPE_PRIORITY}。
 */
export const MEMORY_SCOPES = ['long-term', 'workspace', 'session'] as const

/** 记忆作用域。 */
export type MemoryScope = (typeof MEMORY_SCOPES)[number]

/**
 * 默认检索优先级：会话 > 工作 > 长期（§4.2.1）。
 *
 * "稳定偏好允许长期优先"是**打分规则**里的例外（长期 + 高重要度 + 稳定来源时给长期加权），
 * 而不是换一张顺序表：把两套顺序都写成常量，早晚会有人改错那一张。
 */
export const MEMORY_SCOPE_PRIORITY = ['session', 'workspace', 'long-term'] as const

/**
 * 条目生命周期状态。
 *
 * - `pending`：待确认（P-025）。它**不是草稿**，而是"可能是模糊/敏感信息"的隔离区：
 *   不参与自动注入，等用户在对话或工作台里点头才转 `active`。
 * - `active`：生效中，参与检索与注入。
 * - `archived`：衰减归档（P-026）。**不删除**、默认不参与检索，可手动调回。
 */
export const MEMORY_STATUSES = ['pending', 'active', 'archived'] as const

/** 记忆状态。 */
export type MemoryStatus = (typeof MEMORY_STATUSES)[number]

/**
 * 写入来源。
 *
 * 为什么来源必须落库：P-033 规定**自动管线不得把内容提升为敏感或长期**，
 * 而要判断"该不该提升"就得知道这条是谁写的。来源一旦可被改写，这条约束就失效，
 * 所以它在 schema 里是**必填**、没有默认值。
 */
export const MEMORY_ORIGINS = ['user-stated', 'agent-derived'] as const

/** 记忆来源。 */
export type MemoryOrigin = (typeof MEMORY_ORIGINS)[number]

/**
 * 条目结构版本（G-004：数据结构版本化）。
 *
 * 与存储领域版本正交：领域版本管"文件能不能读"，这个管"这条记录是哪一代、要不要改造"。
 */
export const MEMORY_ENTRY_VERSION = 1

/**
 * 条目表名。与领域名一样属于数据契约，写进存储后改名等于旧数据找不到。
 *
 * 必须是 `^[a-z][a-z0-9_]*$`（storage-domain 的 `UNIT_NAME_RE`）—— 所以是下划线风格。
 */
export const MEMORY_TABLE = 'memory_entries'

/** 重要度上限（0–5）。自动衰减只降重要度与新鲜度，不改这个刻度。 */
export const IMPORTANCE_MAX = 5

/** 自动写入的初始重要度：低但非零 —— 明确偏好/稳定事实这一档（P-025）。 */
export const DEFAULT_IMPORTANCE = 2

/** 自动写入的初始置信度。**永远小于 1**：1 留给"用户自己说的/明确确认的"。 */
export const DEFAULT_CONFIDENCE = 0.6

/** 用户明确说出的内容记满置信度（P-033：只有用户发话才算确认）。 */
export const USER_STATED_CONFIDENCE = 1

/**
 * 新条目的初始状态：**待确认**（P-025 的保守方向）。
 *
 * 宁可多问一句，也不要把猜测直接塞进提示词；写入方确定是低风险事实时显式传 `active`。
 */
export const NEW_ENTRY_STATUS: MemoryStatus = 'pending'

/**
 * 正文长度上限（字符）。记忆只存**摘要、事实、引用**（P-027）。
 *
 * 超长内容不是记忆而是会话原文；要回查原文请走 DSH 的会话检索，不要把原文复制进记忆。
 *
 * ⚠️ **0.1.9 从 200 提到 2000**（用户报障后改；依据是**生产实测**，不是感觉）：
 * 用户库里 56 条记忆的正文长度分布是 —— **最长 200 / 中位 200 / 恰好 200 的 33 条（59%）/ >200 的 0 条**，
 * 全表合计只有 **9748 字**。中位数**顶在**上限上，说明 200 不是"上限"，而是**绝大多数写入的切割点**：
 * 正常长度的记忆正在被静默切掉尾巴（而且调用方收到的是成功回执）。
 * 取 2000 的理由：
 *  - 它是当前上限的 10 倍，足以容纳"一段带背景的约定/事实"（实测最长记忆 200 字，2000 留足余量）；
 *  - 体积可控：单条 2000 字，整库按 200 条算也只有 ~40 万字符量级的正文（当前 56 条仅 9748 字）；
 *  - 注入侧不会再被它放大：检索**按条**注入且硬上限 `maxInject=3`，`renderMemoryBlock` 另有字符预算，
 *    所以注入成本由"条数 × 预算"决定，不由单条上限决定（拉高上限不会让提示词变长）；
 *  - 与"记忆是摘要"的口径不冲突：超长内容仍会在超出时**被标注**（见 `remember()` 的回执），
 *    而不是被无声切掉。
 */
export const CONTENT_CHAR_LIMIT = 2000

/** 单条记忆的标签上限。标签是本地检索的主信号，太多等于没有信号。 */
export const TAG_LIMIT = 8

/**
 * 自动注入条数上限：**硬上限 3**（P-028）。
 *
 * 高级开关可以把它调小，调不大 —— 上限本身是决策，不是默认值。
 */
export const MAX_INJECT_LIMIT = 3

/** 平衡模式下的自动注入条数（0–3）。 */
export const DEFAULT_INJECT_LIMIT = 3

/**
 * 自动注入的硬 token 上限（P-028）。
 *
 * 与条数上限同时生效：两条约束里**先到的那条**截断，因为"3 条很长的记忆"照样能吃掉上下文。
 */
export const DEFAULT_INJECT_TOKEN_BUDGET = 300

/**
 * 相关度阈值：低于它宁可不注入（P-028）。空着比塞错更安全。
 *
 * 0.35 是**按评分刻度校准**出来的，不是拍脑袋：七个信号满分合计 1.0，而一条与当前话题
 * 毫无关键词交集的记忆仍会拿到重要度 + 新鲜度 + 置信度 ≈ 0.19–0.25 分（见 `scoring.ts` 的权重表）。
 * 阈值必须明显高于这个"无关底噪"，否则每一次注入都会塞进一条不相关的记忆。
 */
export const RELEVANCE_THRESHOLD = 0.35

/** 近似去重阈值：Dice ≥ 此值判为"同一条事实的另一种说法"。0.65 由生产库实测标定（真近重复
 *  ≥0.697、不同事实 ≤0.580，中间是干净间隙）；偏保守是因为漏检只多一条重复、误合会丢信息。 */
export const NEAR_DUPLICATE_DICE = 0.65

/**
 * 使用频率的饱和点：用到这个次数即拿满 0.05 权重，再多也不额外加权（P-031）。
 *
 * 为什么要饱和：频率是**排序信号之一**，不是"越常用越该注入"。没有上限时最常用的那条
 * 会永远压在真正相关的那条前面。
 */
export const USE_COUNT_SATURATION = 5

/** 多久没用过算"长期未用"（天），达到后进入降权（P-026）。 */
export const DECAY_UNUSED_DAYS = 90

/** 重要度低于此值的条目在衰减时归档；重要/稳定/用户标记的条目不衰减（P-026）。 */
export const ARCHIVE_IMPORTANCE = 2

/**
 * 重要度的半衰期（天）：**长期未用**的条目每过这么多天，重要度减半。
 *
 * 与 {@link DECAY_UNUSED_DAYS} 的分工：那个是"多久没算长期未用"的**窗口**（90 天，窗口内完全不衰减），
 * 这个是窗口之后权重掉得多快。两者都做成策略字段，用户可以按自己的节奏调。
 */
export const DECAY_HALF_LIFE_DAYS = 30

/** 顺带核算的最小间隔（小时）：检索路径上不会更频繁地做全表维护。 */
export const DECAY_CHECK_INTERVAL_HOURS = 24

/**
 * 重要度**受保护**的门槛：达到它的记忆不衰减（P-026「重要……的记忆不衰减」）。
 *
 * 4–5 分是"用户明确表达过的长期偏好/固定约定"这一档；把它们按时间衰减掉，
 * 等于用"最近没提起"推断"不再成立"，而记忆的价值恰恰在于记住没再提的事。
 */
export const IMPORTANCE_PROTECTED = 4

/**
 * 置信度**受保护**的门槛：达到它的记忆不衰减（P-026「稳定」）。
 *
 * 0.9 以上意味着"用户自己说的"（用户明确说出的记满 1）：这类稳定事实不该因为没被提起而消失。
 */
export const HIGH_CONFIDENCE_PROTECTED = 0.9

/**
 * 活跃条目规模阈值。超过它触发去重、合并、归档（§4.2.4）。
 *
 * 记忆的价值来自"小而准"：无限增长只会让检索变成另一种上下文噪声。
 */
export const ACTIVE_ENTRY_LIMIT = 500

/**
 * 敏感度（写入时的口径；落库后是 `MemoryEntry.sensitive`）。
 *
 * 为什么不直接收 boolean：模型看到的是"普通 / 敏感"这种能读懂的说法，而敏感的真实后果
 * （进待确认、工作台可见可删）写在参数说明里才讲得清。
 */
export const MEMORY_SENSITIVITIES = ['normal', 'sensitive'] as const

/** 敏感度。 */
export type MemorySensitivity = (typeof MEMORY_SENSITIVITIES)[number]

/**
 * 待确认条目的**确认入口**。
 *
 * T2 补充（`docs/handoff/TASK-PERSONA-ADDRESS.md`）要求"聊天里确认"与"工作台确认"是**同一份**
 * pending 记录的两端：任一端确认后另一端同步消失。所以要记下是哪一端确认的 ——
 * 这是两端同源的审计依据，不是装饰字段。工作台端在 M3 步骤 8 接上。
 */
export const MEMORY_CONFIRM_SOURCES = ['chat', 'workbench'] as const

/** 确认入口。 */
export type MemoryConfirmSource = (typeof MEMORY_CONFIRM_SOURCES)[number]

/** 条目从未经过"待确认 → 生效"这一步时的 `confirmedVia` 取值。 */
export const NOT_CONFIRMED = ''
