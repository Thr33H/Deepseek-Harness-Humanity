/**
 * 文档落盘：把"对方长期持有的内容"存进**我们自己的存储域**。
 *
 * ### 为什么必须自己存（0.1.7 的硬事实）
 *
 * 0.1.7 的 `dsh-settings` 已被重构成**配置表单**服务：命名空间 = Loader 条目 id，
 * 值 = 该条目 Config schema 的投影，`installSection / get / setSource` 全被删除。
 * 我们原先借它当"任意文档存储"（`humanity-persona` 的整份人格文档就存在那里），
 * 升级时官方只把 `settings.yaml` 改名为 `settings.yaml.imported`，**被拒的段落留在里面**。
 * 因此 0.1.7 起这份内容只能由我们自己落盘 —— 就是这张表。
 *
 * ### 表怎么放（沿用存储域既有的"加表零迁移"结论）
 *
 * `store-schema.ts` 已经实测确认：介质版本停在 1、新增表时旧文件照常打开、新表从空开始
 * （`dsh-storage-json` 的 `single` 布局对缺失表补空表）。所以加这张表**不需要改介质版本**，
 * 也不会碰任何既有记录 —— 六张表的数据零丢失由构造保证。
 *
 * ### 修订号
 *
 * 每条记录带 `revision`，客户端读走多少、写回就带多少；对不上就拒绝本次写入。
 * 这是原来 settings 服务的乐观并发语义，工作台的两段式写入依赖它（旧值不算数，宁可让对方重读）。
 * @module humanity/documents
 */
import { z } from 'zod'

/** 文档表名。与领域名一样是数据契约的一部分，改名 = 老数据读不到。 */
export const DOCUMENTS_TABLE = 'documents'

/** 一条文档记录：值 + 修订号 + 落盘时刻。 */
export const DocumentRecordSchema = z.object({
  value: z.unknown(),
  revision: z.number().int().nonnegative(),
  updatedAt: z.string(),
})

/** 文档记录。 */
export interface DocumentRecord {
  value: unknown
  revision: number
  updatedAt: string
}

/** 领域表的窄视图（与 `storage-domain` 的 `KvTable` 同形，字段含义见 `memory/store.ts` 的同类声明）。 */
export interface DocumentTableHandle {
  get(key: string): DocumentRecord | undefined
  entries(): IterableIterator<[string, DocumentRecord]>
  put(key: string, value: DocumentRecord): Promise<void>
  delete(key: string): Promise<boolean>
}

/** 文档读写入口（宿主与数据面共用）。 */
export interface DocumentStore {
  /** 读一份；没写过返回 `undefined`（不等于"空文档"）。 */
  read(ns: string): DocumentRecord | undefined
  /** 列出所有已写过的命名空间（顺序稳定：字典序）。 */
  list(): Array<{ ns: string; record: DocumentRecord }>
  /** 整份替换（`replace` 语义）。 */
  write(ns: string, value: unknown): Promise<DocumentRecord>
  /** 深合并补丁（`update` 语义：没提到的字段保持原样）。 */
  merge(ns: string, patch: Record<string, unknown>): Promise<DocumentRecord>
  /**
   * 关掉这个入口（卸载时调）。
   *
   * 关掉之后的写入**静默成功但什么也没写**：卸载途中还有游离的写入在路上，
   * 让它们撞上已关闭的存储领域只会把异常扔进卸载流程（真机与用例里都偶发出现过）。
   */
  close?(): void
}

/** 是不是"普通对象"（深合并只对普通对象递归，数组整体替换）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** 深合并：`patch` 里出现的字段覆盖 `base`，两边都是普通对象时递归。 */
export function mergeDocument(base: unknown, patch: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = isPlainObject(base) ? { ...base } : {}
  for (const [key, value] of Object.entries(patch)) {
    result[key] = isPlainObject(value) && isPlainObject(result[key]) ? mergeDocument(result[key], value) : value
  }
  return result
}

/**
 * 造一个文档存储。
 *
 * `now` 可注入：测试要断言 `updatedAt` 的形状，而不是让它随真实时钟漂。
 * @param table - 领域表句柄。
 * @param now - 时间源。
 * @returns 文档读写入口。
 */
export function createDocumentStore(table: DocumentTableHandle, now: () => string = () => new Date().toISOString()): DocumentStore {
  const read = (ns: string): DocumentRecord | undefined => table.get(ns)
  /**
   * 这个入口是不是已经关了。
   *
   * 为什么需要：插件卸载时会释放存储领域，而我们这边还有很多**游离的写入**
   * （`void saveState(...)`、串行队列里的材料、投递之后的回写）。它们比卸载晚一步落地，
   * 就会撞上 `domain 'humanity' is closed`（真机与用例里都偶发出现过）。
   * 关掉之后的写入**当作成功但什么也不做** —— 卸载途中丢一条状态，比把异常扔到卸载流程里好。
   */
  let closed = false

  const persist = async (ns: string, value: unknown, revision: number): Promise<DocumentRecord> => {
    if (closed) return { value, revision, updatedAt: now() }
    const record: DocumentRecord = { value, revision, updatedAt: now() }
    try {
      await table.put(ns, record)
      return record
    } catch (error) {
      // 竞态兜底：判断与写入之间领域可能刚被关掉。卸载途中的失败不值得炸掉整条链。
      if (closed) return record
      throw error
    }
  }

  return {
    read,
    list: () =>
      [...table.entries()]
        .map(([ns, record]) => ({ ns, record }))
        .sort((left, right) => left.ns.localeCompare(right.ns)),
    write: (ns, value) => persist(ns, value, (read(ns)?.revision ?? 0) + 1),
    merge: (ns, patch) => persist(ns, mergeDocument(read(ns)?.value, patch), (read(ns)?.revision ?? 0) + 1),
    close: () => {
      closed = true
    },
  }
}
