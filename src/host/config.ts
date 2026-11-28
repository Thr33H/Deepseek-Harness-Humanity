import Schema from '@deepseek-ai/schemastery'

import { HISTORY_RETENTION_DAYS } from './persona/constants.js'

/** 模块标识。数组顺序即工作台的展示顺序。 */
export const MODULE_IDS = ['persona', 'emotion', 'memory', 'evolution'] as const

/** 模块标识。 */
export type ModuleId = (typeof MODULE_IDS)[number]

/** 记忆的高级开关（P-030 的细项）。 */
export interface MemorySettings {
  /** 记忆模块总开关。关掉后不再写、不再注入，已有记忆一律保留。 */
  enabled: boolean
  /** 每轮最多带进对话几条（0–3）。 */
  maxInject: number
  /** 遗忘：关掉后强度不再随时间下降（只在调试时用）。 */
  decay: boolean
}

/** 自进化：她自己的时间（醒着 / 睡觉 / 睡前收账）。 */
export interface EvolutionSettings {
  /** 自进化模块总开关。关掉 = 她不醒来、不写日记，已有日记与记忆一律保留。 */
  enabled: boolean
  /**
   * 一天最多醒几次。**这是上限，不是配额**：累了就少醒，绝不会为了凑数而醒来。
   * 0 = 不主动醒（只能手动叫醒，调试用）。
   */
  maxWakesPerDay: number
  /** 两次醒来之间的最短间隔（分钟）。 */
  minGapMinutes: number
  /** 两次醒来之间的最长间隔（分钟）；实际值在这条线和 `minGapMinutes` 之间随机取。 */
  maxGapMinutes: number
  /**
   * 她的房间放在哪（她自己的那块地方，日记副本、材料、待办都在里面）。
   *
   * 三种填法，按同一个规则理解：
   * - 空串 = 还在老位置 `$DSH_HOME/humanity/room`（不搬家，不建工作区）；
   * - 不带斜杠的名字 = `$DSH_HOME/humanity/rooms/<名字>`；
   * - 以 `/` 开头（或 Windows 盘符）的绝对路径 = 就用这一条。
   *
   * 填了就会把这个目录登记成 DSH 的工作区，并把她的会话挂进去（侧栏里能看见）。
   * 改这一项等于搬家：旧会话留在原处，新会话在新目录里开。
   */
  room: string
}

/** Humanity 套件的全部对方可编辑开关。 */
export interface HumanityConfig {
  /** 套件总开关。关闭后不注入、不写数据、不跑后台任务；已有数据一律保留（P-006、P-048）。 */
  enabled: boolean
  /**
   * 独立判断底层指令（对方 2026-09-23 定）：注入最前面的一句硬编码立场，
   * 不受底色/信息覆盖。默认开；关掉后 AI 可能更倾向于讨好。
   * 它与 modules.persona.enabled 同级：都是"人格怎么被注入"的开关，而不是某个模块的内容。
   */
  independentJudgment: boolean
  /**
   * 时间基准（2026-11-23 从自进化调度里搬出来）。
   *
   * 为什么独立成一项：它是**整套共用的事实**（情绪算清晨、记忆算"昨天"、日记算"今天"、
   * 她的作息），不属于任何一个模块。原来挤在 `modules.evolution.schedule` 下面，把"自进化"
   * 和"现在几点"绑成了一件事。
   */
  timeZone: {
    /** 自动跟随浏览器（默认开）。 */
    auto: boolean
    /** IANA 时区名；只在 `auto` 关掉时生效。空串 = 跟随系统时区。 */
    fixed: string
  }
  modules: {
    /** 人格：固定底色层 + 信息，以及首次唤醒引导。 */
    persona: {
      enabled: boolean
      /**
       * `persona_history`（被取代/被删内容的审计表）的**保留天数**（对方 2026-10-09）。
       *
       * `<= 0` = 关闭清理（永久保留）；负数按 0 处理。语义与"清理时机"见 `history-retention.ts`。
       */
      historyRetentionDays: number
    }
    /** 情绪：它此刻怎么样。只在沉浸模式生效，功能模式完全不介入（用户 2026-11-17 定）。 */
    emotion: {
      enabled: boolean
    }
    /** 记忆：她自己的经历账。 */
    memory: MemorySettings
    /** 自进化：她自己的时间。 */
    evolution: EvolutionSettings
  }
}

/**
 * 开关 schema。
 *
 * 这里是全部默认值的唯一真源：`cordis.patch.yml` 刻意不写 `config:`，否则同一份默认值
 * 会存在两处，某次升级只改一处就会让老对方的默认行为悄悄漂移（G-004 默认值不漂移）。
 *
 * 命名与 DECISIONS P-048 的收敛值逐项对齐，避免以后为了改名再动一次数据结构。
 */
export const Config: Schema<HumanityConfig> = Schema.object({
  enabled: Schema.boolean().default(true).description('Humanity 套件总开关'),
  independentJudgment: Schema.boolean()
    .default(true)
    .description('独立判断底层指令：以事实、逻辑和可验证证据为准，不迎合、不编造。关闭后 AI 可能更倾向于迎合对方。'),
  timeZone: Schema.object({
    auto: Schema.boolean()
      .default(true)
      .description('时区自动跟随浏览器：开=每次对话自动校准（推荐）；关=用下面填的固定时区'),
    fixed: Schema.string().default('').description('固定时区（IANA 名，例如 Asia/Shanghai）；只在自动跟随关掉时生效'),
  }),
  modules: Schema.object({
    persona: Schema.object({
      enabled: Schema.boolean().default(true).description('人格模块：注入与首次唤醒引导'),
      historyRetentionDays: Schema.number()
        .default(HISTORY_RETENTION_DAYS)
        .description(
          '人格历史的保留天数（默认 30）：超期的「被取代 / 被删内容」记录会被清理；'
            + '0 或负数 = 关闭清理（永久保留）。',
        ),
    }),
    emotion: Schema.object({
      enabled: Schema.boolean()
        .default(true)
        .description(
          '情绪模块：它此刻的心情。只在「Humanity 沉浸」里生效，功能模式完全不读不写不算；'
            + '关掉后不再记录、不再注入，已有状态保留。',
        ),
    }),
    memory: Schema.object({
      enabled: Schema.boolean()
        .default(true)
        .description('记忆模块：关掉后不再写、不再注入，已有记忆一律保留'),
      maxInject: Schema.number().default(3).description('每轮最多带进对话几条（0–3）'),
      decay: Schema.boolean().default(true).description('遗忘：关掉后强度不再随时间下降（只在调试时用）'),
    }),
    evolution: Schema.object({
      enabled: Schema.boolean()
        .default(true)
        .description('自进化模块：她自己的时间。关掉后她不醒来、不写日记，已有日记与记忆保留'),
      maxWakesPerDay: Schema.number()
        .default(8)
        .description('一天最多醒几次（上限，不是配额：累了就少醒；0 = 只能手动叫醒）'),
      minGapMinutes: Schema.number().default(40).description('两次醒来之间的最短间隔（分钟）'),
      maxGapMinutes: Schema.number().default(150).description('两次醒来之间的最长间隔（分钟）；实际值在这两条线之间随机取'),
      room: Schema.string()
        .default('')
        .description(
          '她的房间放在哪：空=老位置（数据目录下 humanity/room）；'
            + '填名字=建在数据目录的 humanity/rooms/<名字>；填完整路径=就用那条路径。'
            + '填了会登记成工作区（侧栏可见）；改了等于搬家，旧会话留在原处。',
        ),
    }),
  }),
})
