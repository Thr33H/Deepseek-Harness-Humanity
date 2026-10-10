/**
 * 记忆条目的存储面：把领域里的一张 KV 表包装成记忆 CRUD。
 *
 * 为什么把表声明成**结构化窄接口**（{@link MemoryTableHandle}）而不是 import
 * storage-domain 的类型：记忆模块只用到 get / entries / put / delete 四个方法，
 * 固化整个存储实现的类型面等于让一个数据模块依赖某个具体后端（本项目已被领域字面类型
 * 擦除坑过两次）。真源仍然是 DSH 的 `storageDomain`（P-027），这里只是它的一扇窄门。
 *
 * 键 = **去重指纹**（`MemoryEntry.dedupeKey`）。用指纹当主键而不是另造 id：去重是记忆的
 * 核心语义（§4.2.4「超阈值触发去重、合并」），键与语义重合时"同一条事实"天然只有一行，
 * 不需要在写入路径上再查一遍全表。
 * @module humanity/memory/store
 */
import type { MemoryScope, MemoryStatus } from './constants.js'
import type { MemoryEntry } from './types.js'

/**
 * 领域表的窄视图（字段含义与 storage-domain 的 `KvTable` 一致）。
 *
 * 记录是**不可变的普通数据**：取出来的对象就是表里那份，不要就地修改，改内容要重新 `put`。
 */
export interface MemoryTableHandle {
  /** 同步读一条；不存在返回 `undefined`。 */
  get(key: string): MemoryEntry | undefined
  /** `[键, 记录]` 的快照迭代器。 */
  entries(): IterableIterator<[string, MemoryEntry]>
  /** 落盘写入/覆盖一条（整体替换，不做部分合并）。 */
  put(key: string, value: MemoryEntry): Promise<void>
  /** 落盘删除；返回删除前是否存在。 */
  delete(key: string): Promise<boolean>
}

/** 记忆读写入口（宿主、工作台与后续管线共用；存储未就绪时不存在，见 `installMemory`）。 */
export interface MemoryStore {
  /**
   * 写入/更新一条记忆（键 = 去重指纹）。
   *
   * 指纹已存在时是**更新**而不是新增：内容、标签、重要度、置信度、状态以入参为准，
   * 但 `createdAt` / `useCount` / `lastUsedAt` 沿用已存记录 —— 同一条事实被重新写一次
   * 不等于它变新，更不等于它被使用过。归档/恢复请走 `archive` / `restore`。
   * @param entry - 完整条目（用 `createMemoryEntry` 造）。
   * @returns 实际落盘的记录。
   */
  put(entry: MemoryEntry): Promise<MemoryEntry>
  /** 按指纹读一条。 */
  get(dedupeKey: string): MemoryEntry | undefined
  /**
   * 按作用域与状态列出（都省略 = 全部）。返回的是**快照**：调用后对存储的改动不会反映进这个数组。
   * 顺序固定为"最近更新在前、id 升序兜底"，好让调用方拿到稳定结果；
   * 检索排序是另一件事（打分在检索层做，不在这里）。
   */
  list(scope?: MemoryScope, status?: MemoryStatus): MemoryEntry[]
  /**
   * 记一次"被使用"（检索命中时调用）：`useCount` +1、`lastUsedAt` 更新。
   *
   * 为什么必须有这个入口：`put` 刻意**保留**已存记录的使用统计（重写不等于被用过），
   * 于是没有任何公开路径能推进它 —— 没有这个方法的 `useCount` 会永远停在 0，
   * 而 P-026 的衰减与检索排序都要用它。次数只影响排序，**不因为高频就注入**（P-031）。
   * @param dedupeKey - 条目指纹。
   * @param at - 使用时刻（ISO 8601）；缺省取当前时间。
   * @returns 更新后的条目；不存在时为 `undefined`。
   */
  markUsed(dedupeKey: string, at?: string): Promise<MemoryEntry | undefined>
  /** 删除一条；返回删除前是否存在。 */
  remove(dedupeKey: string): Promise<boolean>
  /** 归档（改状态，**不删数据**，P-026）；指纹不存在返回 `undefined`。 */
  archive(dedupeKey: string): Promise<MemoryEntry | undefined>
  /** 从归档恢复为生效；未归档或不存在时返回 `undefined`。 */
  restore(dedupeKey: string): Promise<MemoryEntry | undefined>
}

/** 列出时的稳定顺序：最近更新在前，同一时刻用 id 兜底。 */
function compareEntries(a: MemoryEntry, b: MemoryEntry): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1
  if (a.id === b.id) return 0
  return a.id < b.id ? -1 : 1
}

/** 把表里的记录收集成数组（表本身是迭代器，不能直接排序）。 */
function collect(table: MemoryTableHandle): MemoryEntry[] {
  const all: MemoryEntry[] = []
  for (const [, entry] of table.entries()) all.push(entry)
  return all
}

/**
 * 写入/更新一条：指纹已存在时沿用已存记录的创建时间与使用统计。
 *
 * 同一条事实被重新写一次，不等于它变新，更不等于它被使用过 ——
 * 使用统计只能由"检索命中"来推进，那是检索层的事。
 */
async function putEntry(table: MemoryTableHandle, entry: MemoryEntry): Promise<MemoryEntry> {
  const stored = table.get(entry.dedupeKey)
  const next: MemoryEntry =
    stored === undefined
      ? entry
      : { ...entry, createdAt: stored.createdAt, useCount: stored.useCount, lastUsedAt: stored.lastUsedAt }
  await table.put(next.dedupeKey, next)
  return next
}

/** 按作用域/状态过滤后排序（顺序见 {@link compareEntries}）。 */
function listEntries(table: MemoryTableHandle, scope?: MemoryScope, status?: MemoryStatus): MemoryEntry[] {
  const matched = collect(table).filter(
    (entry) =>
      (scope === undefined || entry.scope === scope) && (status === undefined || entry.status === status),
  )
  return matched.sort(compareEntries)
}

/** 记一次使用：只动使用统计，**不动** `updatedAt`（用过不是内容变更）。 */
async function markUsedEntry(table: MemoryTableHandle, dedupeKey: string, at: string): Promise<MemoryEntry | undefined> {
  const current = table.get(dedupeKey)
  if (current === undefined) return undefined
  const next: MemoryEntry = { ...current, useCount: current.useCount + 1, lastUsedAt: at }
  await table.put(dedupeKey, next)
  return next
}

/** 归档：只盖状态与归档时刻，**不动** `updatedAt`（归档不是内容变更）。 */
async function archiveEntry(table: MemoryTableHandle, dedupeKey: string): Promise<MemoryEntry | undefined> {
  const current = table.get(dedupeKey)
  if (current === undefined) return undefined
  const next: MemoryEntry = { ...current, status: 'archived', archivedAt: new Date().toISOString() }
  await table.put(dedupeKey, next)
  return next
}

/** 从归档恢复为生效；未归档（或不存在）时返回 `undefined`。 */
async function restoreEntry(table: MemoryTableHandle, dedupeKey: string): Promise<MemoryEntry | undefined> {
  const current = table.get(dedupeKey)
  if (current === undefined || current.status !== 'archived') return undefined
  const next: MemoryEntry = { ...current, status: 'active', archivedAt: '' }
  await table.put(dedupeKey, next)
  return next
}

/**
 * 用一张领域表造出记忆 CRUD 句柄。
 *
 * 状态变更只走 `archive` / `restore` 两个入口：把"改状态"和"写内容"分开，
 * 是为了让 `archivedAt` 与 `status` 不会各自为政（`put` 不碰状态语义）。
 * @param table - 领域表窄视图。
 */
export function createMemoryStore(table: MemoryTableHandle): MemoryStore {
  return {
    put: (entry: MemoryEntry) => putEntry(table, entry),
    get: (dedupeKey: string) => table.get(dedupeKey),
    list: (scope?: MemoryScope, status?: MemoryStatus) => listEntries(table, scope, status),
    markUsed: (dedupeKey: string, at?: string) => markUsedEntry(table, dedupeKey, at ?? new Date().toISOString()),
    remove: (dedupeKey: string) => table.delete(dedupeKey),
    archive: (dedupeKey: string) => archiveEntry(table, dedupeKey),
    restore: (dedupeKey: string) => restoreEntry(table, dedupeKey),
  }
}
