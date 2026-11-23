/**
 * 记忆的 schema、默认值与工厂（**默认值的唯一真源**）。
 *
 * 单一方向：`写入方` → {@link createMemoryRecord}（补默认值 + 算初始强度）→ zod 校验 → 存储。
 * @module humanity/memory/model
 */
import { z } from 'zod'

import {
  AROUSAL_WEIGHT,
  DEFAULT_DISCLOSURE_COST,
  DETAIL_CHAR_LIMIT,
  MEMORY_ABOUTS,
  MEMORY_CERTAINTIES,
  MEMORY_ENTRY_VERSION,
  MEMORY_TIERS,
  SELF_WEIGHT,
  STRENGTH_BASE,
  WHAT_CHAR_LIMIT,
} from './constants.js'
import type { MemoryAbout } from './constants.js'
import type { MemoryFeeling, MemoryInput, MemoryRecord } from './types.js'
/**
 * 感觉的契约。
 *
 * `kind` 用宽松字符串而不是枚举：取值要与情绪模块的 `EMOTION_KINDS` 对齐，但记忆模块
 * **不 import 情绪模块**（模块互相隔离）。加一种情绪却忘了这里时，最坏结果只是这一条
 * 感觉渲染不出词，不该让整段记忆解析失败。
 */
export const MemoryFeelingSchema = z.object({
  kind: z.string().default(''),
  intensity: z.number().min(0).max(100).default(0),
})

/**
 * 一条记忆的存储契约。
 *
 * 旧字段（`scope` / `status` / `tags` / `importance` / `dedupeKey` / `pinned` / `sensitive`）
 * **全部不再存在** —— 它们属于"待办清单式的记忆"。这一版换成
 * `about`（关于谁）、`tier`（哪一档）、`cost`（说出来的代价）、`strength`（多牢）。
 *
 * `what` 必填且非空：没有要点的记忆是一条不知道是什么的记录。
 */
export const MemoryRecordSchema = z.object({
  id: z.string().min(1),
  what: z.string().min(1).max(WHAT_CHAR_LIMIT),
  detail: z.string().max(DETAIL_CHAR_LIMIT).default(''),
  when: z.string().default(''),
  about: z.enum(MEMORY_ABOUTS),
  felt: MemoryFeelingSchema.default({ kind: '', intensity: 0 }),
  certain: z.enum(MEMORY_CERTAINTIES),
  strength: z.number().min(0).max(1),
  recalled: z.number().int().nonnegative().default(0),
  recalledAt: z.string().default(''),
  cost: z.number().min(0).max(1).default(DEFAULT_DISCLOSURE_COST),
  costWhy: z.string().default(''),
  tier: z.enum(MEMORY_TIERS).default('episode'),
  createdAt: z.string().min(1),
  covers: z.array(z.string()).default([]),
  version: z.number().int().positive().default(MEMORY_ENTRY_VERSION),
})

/**
 * 「这件事跟我自己有多大关系」（0–1）。
 *
 * 自我参照效应是记忆心理学里最稳的效应之一 —— 判成"关于我"的信息，记得明显更牢。
 * 所以 `about` 不只是分类，它直接参与初始强度。
 * @param about - 这件事关于谁。
 * @returns 自我相关权重。
 */
export function selfRelevanceOf(about: MemoryAbout): number {
  switch (about) {
    case 'self':
      return 1
    case 'us':
      return 0.8
    case 'user':
      return 0.4
    default:
      return 0.2
  }
}

/**
 * 算一条记忆的初始强度。
 *
 * 只有两项加权：**当时情绪多强**、**这事跟我自己多大关系**。
 * 刻意不加"重要性打分"：那是绝对值，而"重要"是相对的，模型打分的方差会漂。
 * @param feeling - 当时的感觉。
 * @param about - 关于谁。
 * @returns 0–1 的初始强度。
 */
export function initialStrength(feeling: MemoryFeeling | undefined, about: MemoryAbout): number {
  const arousal = Math.min(1, Math.max(0, (feeling?.intensity ?? 0) / 100))
  const raw = STRENGTH_BASE + AROUSAL_WEIGHT * arousal + SELF_WEIGHT * selfRelevanceOf(about)
  return Math.min(1, raw)
}

/**
 * 把情绪指纹收成落库的形状：种类去空白、强度取整并夹到 0–100。
 *
 * 为什么要取整：情绪模块给的是浮点（`5.9888371532538835`），落进记忆后就是一条脏数据 ——
 * 记忆只按整数展示、只按百分制参与权重，多出来的小数位除了让库变丑没有任何用处。
 * @param input - 写入方给的感觉（可能没有）。
 * @returns 干净的感觉。
 */
function feelingOf(input: MemoryFeeling | undefined): MemoryFeeling {
  return {
    kind: (input?.kind ?? '').trim(),
    intensity: Math.round(Math.min(100, Math.max(0, input?.intensity ?? 0))),
  }
}

/**
 * 造一条记忆：补默认值、算初始强度、交给 schema 校验。
 *
 * 校验放在构造点而不是落库点：契约不满足要在**写下它的时候**就炸，而不是等到某一天注入时才
 * 以一个奇怪的现象冒出来。
 * @param input - 写入方一定知道的信息。
 * @returns 可落盘的记录。
 */
export function createMemoryRecord(input: MemoryInput): MemoryRecord {
  const now = new Date().toISOString()
  const what = (input.what ?? '').trim()
  const felt = feelingOf(input.felt)
  return MemoryRecordSchema.parse({
    id: globalThis.crypto.randomUUID(),
    what,
    detail: (input.detail ?? '').trim(),
    // `when` 省略时取现在：绝大多数记忆都是"刚刚发生的"。补记旧事时才显式传。
    when: input.when ?? now,
    about: input.about,
    felt,
    certain: input.certain,
    // 强度用**落库那份**感觉算：否则会出现"显示 6 分、按 5.98 加权"的错位。
    strength: input.strength ?? initialStrength(felt, input.about),
    cost: input.cost ?? DEFAULT_DISCLOSURE_COST,
    costWhy: (input.costWhy ?? '').trim(),
    tier: input.tier ?? 'episode',
    createdAt: now,
    covers: input.covers ?? [],
    version: MEMORY_ENTRY_VERSION,
  })
}
