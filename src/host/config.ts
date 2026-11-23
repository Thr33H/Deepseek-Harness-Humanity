import Schema from '@deepseek-ai/schemastery'

import { SCHEDULE_MODES } from './evolution/constants.js'
import { HUMANITY_PRESET_ID } from './presets.js'
import { HISTORY_RETENTION_DAYS } from './persona/constants.js'

/** 自进化的调度模式（P-035：空闲自动为默认；选定时则空闲关）。 */
export type ScheduleMode = (typeof SCHEDULE_MODES)[number]

/** 模块标识。数组顺序即工作台的展示顺序。 */
export const MODULE_IDS = ['persona', 'emotion', 'memory', 'evolution', 'dream'] as const

/** 模块标识。 */
export type ModuleId = (typeof MODULE_IDS)[number]

/**
 * 记忆的高级开关（P-030 的细项）。
 *
 * `customized` 是这一组的总闸：**false = 完全跟随预设模式**（下面的值不参与解析，
 * 因此"切到 session-only"不会被上一轮的旧值拖住），true = 对方显式调过，按下面的值覆盖预设。
 * 这样"预设模式切换时自动给出默认值"与"对方单独覆盖某一项"两件事不会互相打架 ——
 * 代价只是多一个显式标记，比让每个字段可选（schemas 里更绕）清楚得多。
 */
export interface MemorySettings {
  /** 记忆模块总开关。关掉后不再写、不再注入，已有记忆一律保留。 */
  enabled: boolean
  /** 每轮最多带进对话几条（0–3）。 */
  maxInject: number
  /** 遗忘：关掉后强度不再随时间下降（只在调试时用）。 */
  decay: boolean
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
    /** 记忆：长期 / 工作区 / 会话三层，按模式预设 + 可选的高级开关。 */
    memory: MemorySettings
    /** 自进化：会话整理管线，含梦境模式。调度/扫描/预算都是对方可编辑项（P-035/P-036/P-051）。 */
    evolution: {
      enabled: boolean
      schedule: {
        /** idle = 空闲自动；daily/weekly/monthly = 定时（选定时空闲自动关，P-035）。 */
        mode: ScheduleMode
        /** 空闲阈值（分钟）：无活跃对话多久后触发增量整理。 */
        idleMinutes: number
        /** 定时触发时刻（本地时间 HH:MM）。 */
        timeOfDay: string
        /** 每周模式：周几（1=周一 … 7=周日）。 */
        weekday: number
        /** 每月模式：几号（1–28，避开大小月差异）。 */
        monthDay: number
        /**
         * 时区**自动跟随浏览器**（默认开）。
         *
         * 开：Humanity 把浏览器报的时区校准到整个 Node 进程，定时任务随之跟随系统时区
         * （= 校准后的进程时区）。关：用下面的 `timezone` 固定一个，不再跟对话变。
         */
        autoTimeZone: boolean
        /** IANA 时区名；只在 `autoTimeZone` 关掉时生效。空串 = 跟随系统时区（P-035 对方在工作台确认）。 */
        timezone: string
      }
      scan: {
        /** 是否把子代理/workflow 会话纳入扫描（默认否，P-036）。 */
        includeSubSessions: boolean
      }
      budget: {
        /** 单轮最多消化的会话数。 */
        maxSessionsPerRun: number
        /** 单会话单轮最多消化的事件数。 */
        maxEventsPerSession: number
        /** 单次模型调用的输入字节上限。 */
        maxInputBytesPerCall: number
        /** 单次模型调用的输出 token 上限。 */
        maxOutputTokensPerCall: number
        /** 每日模型调用次数上限：到了只警告并停止，不偷偷烧（P-051）。 */
        dailyCallCap: number
      }
    }
    /** 梦境：自进化的长窗口运行模式，不是独立引擎（P-034）。 */
    dream: { enabled: boolean }
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
      enabled: Schema.boolean().default(true).description('自进化模块：空闲与手动整理'),
      schedule: Schema.object({
        mode: Schema.union(SCHEDULE_MODES)
          .default('idle')
          .description('调度模式：idle 空闲自动 / daily 每日 / weekly 每周 / monthly 每月（定时开启后空闲自动关闭）'),
        idleMinutes: Schema.number().default(30).description('空闲阈值（分钟）：无活跃对话多久后自动整理'),
        timeOfDay: Schema.string().default('03:00').description('定时触发时刻（HH:MM，按下面的时区）'),
        weekday: Schema.number().default(1).description('每周模式：周几触发（1=周一 … 7=周日）'),
        monthDay: Schema.number().default(1).description('每月模式：几号触发（1–28）'),
        autoTimeZone: Schema.boolean()
          .default(true)
          .description('时区自动跟随浏览器：开=每次对话自动校准（推荐）；关=用下面填的固定时区'),
        timezone: Schema.string().default('').description('固定时区（IANA 名，例如 Asia/Shanghai）；只在自动跟随关掉时生效'),
      }),
      scan: Schema.object({
        includeSubSessions: Schema.boolean().default(false).description('把子代理/工作流会话纳入扫描（默认只扫主会话）'),
      }),
      budget: Schema.object({
        maxSessionsPerRun: Schema.number().default(5).description('单轮最多消化的会话数'),
        maxEventsPerSession: Schema.number().default(200).description('单会话单轮最多消化的事件数'),
        maxInputBytesPerCall: Schema.number().default(32768).description('单次模型调用的输入字节上限'),
        maxOutputTokensPerCall: Schema.number()
          .default(4000)
          .description('单次模型调用的输出 token 上限'),
        dailyCallCap: Schema.number().default(20).description('每日模型调用次数上限（超出只警告并停止）'),
      }),
    }),
    dream: Schema.object({
      enabled: Schema.boolean().default(true).description('梦境模式：自进化的长窗口运行模式'),
    }),
  }),
})
