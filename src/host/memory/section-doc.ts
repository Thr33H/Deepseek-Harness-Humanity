/**
 * 记忆工作台的**投影文档**（`humanity-memory` 命名空间）。
 *
 * 真源在 storageDomain（`memories` 表）；这里只是**一扇窗**：宿主把当前状态投影进来，
 * 客户端读它渲染。客户端不直接碰存储（它拿不到那个服务，也不该拿）。
 *
 * ### 为什么只投影最近若干条
 *
 * settings 文档是给"配置与界面状态"用的，不是数据库。一年几千条全塞进来会让每次
 * 命名空间推送都搬运几十 KB。所以只带**最近 `VIEW_LIMIT` 条**（按发生时间倒序），
 * 并在 `stats` 里如实给出总数 —— 界面能说清"这是最近 200 条，你一共有 2871 条"。
 * @module humanity/memory/section-doc
 */
import Schema from '@deepseek-ai/schemastery'

import { MEMORY_ABOUTS, MEMORY_CERTAINTIES, MEMORY_TIERS } from './constants.js'

/** 命名空间名（客户端按它读；改名等于两边失联）。 */
export const MEMORY_NAMESPACE = 'humanity-memory'

/** 一次投影最多带多少条。 */
export const VIEW_LIMIT = 200

/** 工作台上的一条记忆（只带界面要显示的东西）。 */
export interface MemoryEntryView {
  id: string
  what: string
  when: string
  about: string
  certain: string
  /** 当时的情绪种类与强度（空串 = 没有记录）。 */
  feltKind: string
  /** 情绪种类的人话（"害怕"）；宿主给，客户端不自己维护一张情绪词表。 */
  feltLabel: string
  feltIntensity: number
  /** 此刻的强度（0–1，读的时候算好，客户端不再自己算）。 */
  strength: number
  /** 被想起过几次。 */
  recalled: number
  /** 说出来要付多大代价（0–1）。 */
  cost: number
  /** 为什么贵。 */
  costWhy: string
  tier: string
  /**
   * 这一条是由几件事合成来的（0 = 一件具体的事）。
   *
   * 界面用它说明"这句概括是从哪攒出来的" —— 归拢如果不留痕迹，用户会觉得记忆凭空少了，
   * 或者把一句概括当成一件具体发生的事。
   */
  covers: number
  createdAt: string
}

/** 面板上的统计。 */
export interface MemoryStatsView {
  /** 库里一共有多少条（不受 `VIEW_LIMIT` 影响）。 */
  total: number
  /** 各档的条数。 */
  episode: number
  period: number
  chapter: number
  /** 被想起过的条数（`recalled > 0`）。 */
  recalled: number
}

/** 工作台命令槽（与自进化那套同一写法：客户端只写 `request`，宿主消费后再清空）。 */
export interface MemoryRequestView {
  /** 空串 = 没有命令。目前只有 `reveal`（越过门槛查看一条秘密）。 */
  op: string
  /** 目标记忆 id。 */
  id: string
}

/** 上一次被她想起来的其中一条。 */
export interface RecalledItemView {
  /**
   * 正文；`withheld` 为真时是空串（界面自己说"她不想说"）。
   *
   * 为什么不把秘密的正文塞进来：工作台的"为什么想起"是一扇**没有门槛**的窗，
   * 秘密要看必须走「我要看」那两步。这里泄露一次，那道坎就白设了。
   */
  what: string
  /** 相关度档位（`high` / `mid` / `low`）—— 给人看的说法，不是分数。 */
  match: string
  /** 她想起了这件事，但不想说。 */
  withheld: boolean
}

/** 上一次回忆：因为哪句话、想起了哪几条。 */
export interface RecallView {
  /** 发生时刻（ISO 8601）；空串 = 还没有过。 */
  at: string
  /** 当时对方说的那句话（截断，够看懂是在说什么）。 */
  cue: string
  items: RecalledItemView[]
}

/** 宿主与浏览器之间的完整契约。 */
export interface MemoryDocument {
  /** 最近若干条（发生时间倒序）。 */
  entries: MemoryEntryView[]
  stats: MemoryStatsView
  /** 这份投影是什么时候生成的（ISO 8601）。 */
  projectedAt: string
  /** 存储是否就绪；没就绪时 `entries` 一定是空的，界面据此说"读不到"而不是"没有记忆"。 */
  storeReady: boolean
  /**
   * 休眠中：人格还没封存，humanity 还没正式启动（用户 2026-11-22 定）。
   *
   * 界面要凭它说"还没开始"——否则一页空列表看起来像"坏了"。
   */
  dormant: boolean
  /** 客户端写入的命令（宿主消费后清空）。 */
  request: MemoryRequestView
  /** 上一次动作的结论（给界面显示"看过了"或"没看成"）。 */
  notice: string
  /**
   * 上一次回忆（"她为什么想起这条"）。
   *
   * 这是设计里最容易被省掉、但价值最高的一块：没有它，用户永远只看到结果，
   * 学不会和这套记忆相处 —— 也不知道某条记忆到底是因为话里提到、还是因为太牢。
   */
  lastRecall: RecallView
}

/**
 * 投影文档的 schema。
 *
 * `entries` 刻意**不设上限校验**：多一条少一条不该让整份文档解析失败
 * （坏一条害死整库的教训见 `store-open.ts`）。
 */
export const MemoryDocSchema = Schema.object({
  entries: Schema.array(
    Schema.object({
      id: Schema.string().default(''),
      what: Schema.string().default(''),
      when: Schema.string().default(''),
      about: Schema.string().default('world'),
      certain: Schema.string().default('inferred'),
      feltKind: Schema.string().default(''),
      feltLabel: Schema.string().default(''),
      feltIntensity: Schema.number().default(0),
      strength: Schema.number().default(0),
      recalled: Schema.number().default(0),
      cost: Schema.number().default(0),
      costWhy: Schema.string().default(''),
      tier: Schema.string().default('episode'),
      covers: Schema.number().default(0),
      createdAt: Schema.string().default(''),
    }),
  ).default([]),
  stats: Schema.object({
    total: Schema.number().default(0),
    episode: Schema.number().default(0),
    period: Schema.number().default(0),
    chapter: Schema.number().default(0),
    recalled: Schema.number().default(0),
  }),
  projectedAt: Schema.string().default(''),
  storeReady: Schema.boolean().default(false),
  dormant: Schema.boolean().default(false),
  // ⚠️ 命令槽**只做最小形状检查**（注册时也会跑一次 validate）：旧数据形状问题不该让命名空间注册失败。
  request: Schema.object({
    op: Schema.string().default(''),
    id: Schema.string().default(''),
  }),
  notice: Schema.string().default(''),
  lastRecall: Schema.object({
    at: Schema.string().default(''),
    cue: Schema.string().default(''),
    items: Schema.array(
      Schema.object({
        what: Schema.string().default(''),
        match: Schema.string().default(''),
        withheld: Schema.boolean().default(false),
      }),
    ).default([]),
  }).default({ at: '', cue: '', items: [] }),
})

/** 空投影（命名空间刚注册、还没刷过一次时用它）。 */
export function emptyMemoryDocument(): MemoryDocument {
  return {
    ...(MemoryDocSchema({}) as Omit<MemoryDocument, 'request' | 'notice' | 'lastRecall'>),
    request: { op: '', id: '' },
    notice: '',
    lastRecall: { at: '', cue: '', items: [] },
  } as MemoryDocument
}

/** 词表转出去给客户端做校验用（客户端不 import 宿主的 store）。 */
export const MEMORY_VOCAB = {
  about: MEMORY_ABOUTS,
  certain: MEMORY_CERTAINTIES,
  tier: MEMORY_TIERS,
} as const
