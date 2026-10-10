/**
 * 记忆的 schema、默认值、工厂与**策略解析**（宿主侧；浏览器不 import 本文件）。
 *
 * 两件事放在一起的理由：它们都以同一组常量与同一个 schema 为真源 ——
 * 拆开只会产生"工厂补一套默认值、schema 再补一套"的分叉。
 * （预设模式与高级开关的解析在 `policy.ts`：那是"开关怎么算出生效行为"，与数据形状无关。）
 *
 * 单一方向的数据流（与人格模块同构，后续步骤照此实现）：
 * `写入方` → `createMemoryEntry`（补齐默认值 + 指纹）→ `MemoryEntrySchema`（契约校验）
 * → 存储 → `status === 'active'` 的条目才参与检索与注入。
 * @module humanity/memory/model
 */
import { z } from 'zod'

import {
  CONTENT_CHAR_LIMIT,
  MEMORY_CONFIRM_SOURCES,
  NOT_CONFIRMED,
  DEFAULT_CONFIDENCE,
  DEFAULT_IMPORTANCE,
  DEFAULT_INJECT_LIMIT,
  DEFAULT_INJECT_TOKEN_BUDGET,
  IMPORTANCE_MAX,
  MAX_INJECT_LIMIT,
  MEMORY_ENTRY_VERSION,
  MEMORY_ORIGINS,
  MEMORY_SCOPES,
  MEMORY_STATUSES,
  NEW_ENTRY_STATUS,
  TAG_LIMIT,
} from './constants.js'
import type { MemoryEntry, MemoryEntryInput } from './types.js'

/**
 * 记忆条目的存储契约。**默认值的唯一真源**。
 *
 * 哪些字段有默认值、哪些必填是有讲究的：`origin`/`sourceSessionId`/`content`/`dedupeKey`
 * 必填 —— 没有来源的记忆是传闻，没有指纹的记忆无法去重，而 `origin` 一旦可省略就会
 * 被自动管线悄悄改写成"用户说的"（P-033）。
 *
 * `status` 的默认值是 `active` 而不是新条目的 `pending`：解析的是**已落库**的数据，
 * 缺这个字段只可能是早期版本写下的生效条目，把它们判成"待确认"等于凭空冻结老数据。
 * 新建条目的初始状态见 {@link createMemoryEntry}。
 */
export const MemoryEntrySchema = z.object({
  id: z.string().min(1),
  scope: z.enum(MEMORY_SCOPES),
  content: z.string().min(1).max(CONTENT_CHAR_LIMIT),
  tags: z.array(z.string()).max(TAG_LIMIT).default([]),
  importance: z.number().int().min(0).max(IMPORTANCE_MAX).default(DEFAULT_IMPORTANCE),
  confidence: z.number().min(0).max(1).default(DEFAULT_CONFIDENCE),
  sensitive: z.boolean().default(false),
  pinned: z.boolean().default(false),
  origin: z.enum(MEMORY_ORIGINS),
  sourceSessionId: z.string().min(1),
  sourceMessageId: z.string().default(''),
  ownerId: z.string().default(''),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  lastUsedAt: z.string().default(''),
  useCount: z.number().int().nonnegative().default(0),
  status: z.enum(MEMORY_STATUSES).default('active'),
  archivedAt: z.string().default(''),
  dedupeKey: z.string().min(1),
  conflictWith: z.array(z.string()).default([]),
  confirmedVia: z.enum(['', ...MEMORY_CONFIRM_SOURCES]).default(NOT_CONFIRMED),
  entryVersion: z.number().int().positive().default(MEMORY_ENTRY_VERSION),
})

/**
 * 归一化正文用于**比较**（去重与冲突检测共用同一把尺子）。
 *
 * 规则：NFKC 折全角、忽略大小写、去掉空白与标点。它只服务于"这两句是不是在说同一件事"，
 * 不改变落盘正文 —— 用户看到的仍然是他自己那句话。
 * @param content - 正文。
 */
export function normalizeMemoryText(content: string): string {
  return content
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
}

/**
 * 生成去重指纹。
 *
 * 加上作用域前缀，是因为同一句话在不同层是**不同**的记忆
 * （会话里的临时约定 vs 长期偏好），跨层去重会把用户明确分开的东西合并掉。
 * @param scope - 作用域。
 * @param content - 正文。
 */
export function buildDedupeKey(scope: MemoryEntryInput['scope'], content: string): string {
  return `${scope}:${normalizeMemoryText(content)}`
}

/**
 * **归属冲突时的备用键**：同一句话在不同会话/工作区里各是各的记忆，但指纹公式里没有 ownerId
 * （它同时是存储主键，改公式就要迁移全部老数据）。所以走这条路：
 *
 * - 基础键空着、或占着它的正是同一位主人 ⇒ 用基础键（老行为一字不变、老数据零迁移）；
 * - 基础键被**别的归属**占着 ⇒ 用带归属后缀的键，两条各自独立。
 *
 * 为什么必须有它（2026-09-26 审计实测）：会话 A 写「这次讨论用中文」、会话 B 再写同一句，
 * 原来会命中同一个键 ⇒ 那条记忆的 ownerId 被改成 B，A 里检索命中 0 条 ——
 * 与 P-024「会话记忆不跨会话」直接矛盾。
 * @param scope - 作用域。
 * @param content - 正文。
 * @param ownerId - 本次写入的归属 id。
 * @param occupant - 基础键上已存的那条（没有则 undefined）。
 * @param sameOwner - 判定"占位者是不是同一位主人"（长期记忆的 ownerId 恒为空串）。
 * @returns 本次应当使用的指纹。
 */
export function buildOwnedKey(
  scope: MemoryEntryInput['scope'],
  content: string,
  ownerId: string,
  occupant: MemoryEntry | undefined,
  sameOwner: boolean,
): string {
  const base = buildDedupeKey(scope, content)
  if (occupant === undefined || sameOwner) return base
  return `${base}#${ownerId}`
}

/**
 * 新建一条记忆：补齐默认值、生成 id 与指纹、并把结果交给 schema 校验。
 *
 * 校验放在这里而不是留给写入方，是为了让"契约不满足"在**构造点**就炸出来，
 * 而不是等到落库或注入时才以一个奇怪的现象出现。
 *
 * id 用 `globalThis.crypto` 而不是 `node:crypto`：本仓库不依赖 `@types/node`，
 * 而 Node ≥22（`engines` 已要求）与浏览器都自带这个全局对象。
 *
 * 时间戳：显式传入就**照用**（导入/迁移/需要历史时刻的场景），省略才取现在 ——
 * 这一条曾经写错过（总是覆盖成现在），代价是"传了时间却被悄悄改掉"，排查时极难看出。
 * @param input - 写入方一定知道的信息。
 */
export function createMemoryEntry(input: MemoryEntryInput): MemoryEntry {
  const content = input.content.trim()
  const at = new Date().toISOString()
  return MemoryEntrySchema.parse({
    ...input,
    id: input.id ?? globalThis.crypto.randomUUID(),
    content,
    dedupeKey: buildDedupeKey(input.scope, content),
    createdAt: input.createdAt ?? at,
    updatedAt: input.updatedAt ?? input.createdAt ?? at,
    status: input.status ?? NEW_ENTRY_STATUS,
  })
}
