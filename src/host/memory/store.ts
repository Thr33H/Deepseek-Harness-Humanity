/**
 * 记忆的存储面：把领域里的一张 KV 表包成记忆 CRUD。
 *
 * 与旧版最大的不同：**主键从"去重指纹"换成了 id**。
 *
 * 为什么不是指纹：指纹的语义是"同一条事实只有一行"，那是资料库的假设 ——
 * 一段经历和另一段经历可以用同一句话概括，但它们不是同一件事
 * （"他说他会来"和"他说他会来"发生在两个不同的晚上，各自都有当时的情绪）。
 * 去重该发生在**归拢**那一层（`period` 吸收同类 `episode`），而不是在主键上。
 * @module humanity/memory/store
 */
import type { MemoryRecord } from './types.js'

/**
 * 领域表的窄视图（字段含义与 storage-domain 的 `KvTable` 一致）。
 *
 * 记录是**不可变的普通数据**：取出来的对象就是表里那份，改内容要重新 `put`。
 */
export interface MemoryTableHandle {
  get(key: string): MemoryRecord | undefined
  entries(): IterableIterator<[string, MemoryRecord]>
  put(key: string, value: MemoryRecord): Promise<void>
  delete(key: string): Promise<boolean>
}

/** 记忆读写入口（宿主、检索与工作台共用；存储未就绪时不存在）。 */
export interface MemoryStore {
  /** 写入/覆盖一条。 */
  put(record: MemoryRecord): Promise<MemoryRecord>
  /** 按 id 读一条。 */
  get(id: string): MemoryRecord | undefined
  /**
   * 全部记忆的**快照**（顺序固定：最近发生在前，id 兜底）。
   *
   * 返回快照而不是迭代器：调用方要排序、要过滤，而表本身是迭代器。
   */
  all(): MemoryRecord[]
  /** 删除一条；返回删除前是否存在。 */
  remove(id: string): Promise<boolean>
  /**
   * 记一次"被想起"：强度回升、次数 +1、时间刷新。
   *
   * 为什么单独一个入口：`put` 是整体替换，每次回忆都先读再写会把"读"和"写"的语义
   * 混在一起；而这条路径需要**原子地**在旧值上做一次边际递减的加固。
   * @param id - 条目 id。
   * @param at - 想起的时刻（ISO 8601）。
   * @param reinforce - 每次加固的增量（边际递减：`strength += 增量 × (1 − strength)`）。
   * @returns 更新后的记录；不存在时 `undefined`。
   */
  touch(id: string, at: string, reinforce: number): Promise<MemoryRecord | undefined>
}

/** 列出时的稳定顺序：事情发生得越近越靠前，同一时刻用 id 兜底。 */
function compareRecords(a: MemoryRecord, b: MemoryRecord): number {
  if (a.when !== b.when) return a.when < b.when ? 1 : -1
  if (a.id === b.id) return 0
  return a.id < b.id ? -1 : 1
}

/** 用一张领域表造出记忆 CRUD 句柄。 */
export function createMemoryStore(table: MemoryTableHandle): MemoryStore {
  return {
    async put(record: MemoryRecord): Promise<MemoryRecord> {
      await table.put(record.id, record)
      return record
    },
    get(id: string): MemoryRecord | undefined {
      return table.get(id)
    },
    all(): MemoryRecord[] {
      const list: MemoryRecord[] = []
      for (const [, record] of table.entries()) list.push(record)
      return list.sort(compareRecords)
    },
    remove(id: string): Promise<boolean> {
      return table.delete(id)
    },
    async touch(id: string, at: string, reinforce: number): Promise<MemoryRecord | undefined> {
      const current = table.get(id)
      if (current === undefined) return undefined
      const next: MemoryRecord = {
        ...current,
        strength: Math.min(1, current.strength + reinforce * (1 - current.strength)),
        recalled: current.recalled + 1,
        recalledAt: at,
      }
      await table.put(id, next)
      return next
    },
  }
}
