/**
 * 自进化模块的常量：命名空间、命令集、表名、容量上限与运行形态。
 *
 * 与 `memory/constants.ts` 同一约定：**数据契约相关的字面量只在这里出现一次**
 * （表名写进存储、命名空间写进用户设置文件、命令名两端各比对一次——改名等于丢数据）。
 * 调度与预算的**用户默认值**不在这里：它们的唯一真源是 `config.ts` 的 schema（G-004 默认值不漂移），
 * 这里只放"存储侧的容量与保留策略"这类工程上限。
 * @module humanity/evolution/constants
 */

/** 自进化工作台命名空间（视图通道；真源在 storageDomain——G-008 易变层禁令）。 */
export const EVOLUTION_NAMESPACE = 'humanity-evolution'

/** 工作台能发起的命令（与客户端 `evolution-channel.ts` 同一集合，由 bundle 测试比对）。 */
export const EVOLUTION_OPS = [
  'run',
  'rescan',
  'approve',
  'reject',
  'delete',
  // M7 技能编辑：新建 / 修改 / 停用 / 恢复（删除不在其中——官方文件能力里没有删除）。
  'skill-create',
  'skill-update',
  'skill-disable',
  'skill-enable',
] as const

/** 工作台命令名。 */
export type EvolutionOp = (typeof EVOLUTION_OPS)[number]

/** 运行记录表（key = runId）。 */
export const RUNS_TABLE = 'evolution_runs'

/** 提案表（key = proposalId）。 */
export const PROPOSALS_TABLE = 'evolution_proposals'

/** 扫描游标表（key = sessionId）。 */
export const CURSORS_TABLE = 'evolution_cursors'

/** 模块级单值状态表（key 固定 {@link STATE_KEY}）。 */
export const STATE_TABLE = 'evolution_state'

/** 单值状态的固定键。 */
export const STATE_KEY = 'main'

/** 运行形态（P-034：梦境是自进化的运行模式，不是独立引擎）。 */
export const RUN_MODES = ['incremental', 'dream', 'rescan'] as const

/** 触发来源（P-035）。 */
export const RUN_TRIGGERS = ['idle', 'scheduled', 'manual'] as const

/** 运行终态。`skipped` = 条件不满足被跳过（宽限窗外补跑 / defer 超限）。 */
export const RUN_STATUSES = ['running', 'completed', 'failed', 'skipped'] as const

/** 提案类别（P-038；记忆高风险走既有 pending 条目，不重复建类）。 */
export const PROPOSAL_KINDS = ['persona', 'skill', 'route'] as const

/** 提案状态机。 */
export const PROPOSAL_STATUSES = ['pending', 'approved', 'rejected', 'applied'] as const

/** 调度模式（P-035：选定时则空闲自动关）。 */
export const SCHEDULE_MODES = ['idle', 'daily', 'weekly', 'monthly'] as const

/** 运行记录保留上限：超出裁掉最旧（时间线是近期视图，不是审计日志）。 */
export const MAX_RUN_RECORDS = 50

/** 游标记录保留上限：超出按 `lastRunAt` 裁掉最旧（P-037 基线之外的老会话本就不扫）。 */
export const MAX_CURSOR_RECORDS = 500

/** 游标保留天数：超过且未被触碰的会话游标可清理（会话日志本身仍在 DSH 手里，可回扫重建）。 */
export const CURSOR_RETENTION_DAYS = 90

/** 单条提案 payload 的字节上限（超出即拒绝生成：提案是"可审核的短内容"，不是转储）。 */
export const MAX_PROPOSAL_PAYLOAD_BYTES = 65536

/** 提案标题/理由的长度上限（展示字段，防模型输出失控）。 */
export const MAX_PROPOSAL_TEXT_CHARS = 500

/** 定时错过后的补跑宽限窗（毫秒）：超窗记 skipped 不补（P-035「只补一次；超窗标记跳过」）。 */
export const SCHEDULE_GRACE_MS = 6 * 60 * 60 * 1000

/** 空闲检测的 tick 间隔（毫秒）。 */
export const IDLE_TICK_MS = 60 * 1000

/** 触发时 agent 忙碌的重试间隔与次数上限（P-035「有活跃高风险操作时暂停」）。 */
export const DEFER_RETRY_MS = 5 * 60 * 1000
export const DEFER_RETRY_MAX = 6

/** 单次解析调用的墙钟上限（毫秒）。 */
export const ANALYZE_TIMEOUT_MS = 120 * 1000

/** 同一会话连续解析失败达到该次数即熔断：强制推进游标跳过该批（防无限重试烧钱，P-051）。 */
export const MAX_SESSION_FAILURES = 3

/** 定时器单段最长臂长（Node setTimeout 的 32 位上限，与 DSH dsh-schedule 同值）。 */
export const MAX_TIMER_SEGMENT_MS = 2147483647

/** 梦境运行记录里洞察与叙事的展示上限。 */
export const INSIGHTS_CAP = 20
export const NARRATIVE_CAP = 6000

/** P-043 对话内提醒的注入段名与顺位（人格 10、记忆 20、提案 30）。 */
export const PROPOSALS_SECTION_NAME = 'humanity:proposals'
export const PROPOSALS_SECTION_ORDER = 30

/**
 * 人格注入预算的**接近阈值**（0.1.11 · A）：`used / budget ≥ 0.85` 即算"接近上限"，
 * 与"已经超预算"（`truncated`）一样触发"只做整合、禁止追加新条目"。
 *
 * **为什么必须早于 1.0 就刹**（真机实测，2026-10-09T03:20:47Z 那轮）：
 * 台账逐字写着 `已用 1880/2065 字符，预算内（注入 33 条）` —— 0.1.10 的判据只看 `truncated`，
 * 于是它读到"没超"就放行，**追加 3 条之后就超了**。护栏的意义是在**跨线之前**响，
 * 读数等于 1.0 时才动，等于永远晚一步（0.1.10 的洞正是这个）。
 *
 * **为什么是常量而不是配置项**：这是"护栏的松紧"，不是"用户的功能选择"。
 * 做成配置项会出现"写回层与提示词各自读一个阈值"的分叉风险，护栏就形同虚设；
 * 而且阈值语义还会随 `PROMPT_CHAR_BUDGET` 一起变（预算一调，0.85 的含义也变），
 * 它本质上与预算常量是一对。要放宽/收紧改这一个数字即可（0.85 是否合适已提请用户拍板）。
 */
export const PERSONA_BUDGET_GUARD_RATIO = 0.85
