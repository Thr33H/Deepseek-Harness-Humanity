/**
 * 打开套件存储：声明领域 → 打开 → 建首次安装标记 / 跑迁移 → 交回句柄。
 *
 * 为什么从 `store.ts` 拆出来：这是"打开"这一步的全部内容（含两类失败的处理），
 * 而 `store.ts` 只剩"什么时候打开、服务摘除怎么办"的生命周期接线。
 * 常量与 schema 在 `store-schema.ts`。
 * @module humanity/store-open
 */
import { z } from 'zod'

import type { Log } from './log.js'
import { reportBootFailure } from './log.js'
import { createDocumentStore, DOCUMENTS_TABLE, DocumentRecordSchema } from './documents.js'
import { CURSORS_TABLE, PROPOSALS_TABLE, RUNS_TABLE, STATE_TABLE } from './evolution/constants.js'
import { CursorRecordSchema, ProposalRecordSchema, RunRecordSchema, StateRecordSchema } from './evolution/model.js'
import { MEMORY_TABLE } from './memory/constants.js'
import { MemoryEntrySchema } from './memory/model.js'
import { loadOptional } from './optional.js'
import {
  COMPATIBLE_DOMAIN_VERSIONS,
  DOMAIN_NAME,
  DOMAIN_VERSION,
  HISTORY_TABLE,
  META_INITIAL,
  MetaSchema,
  MIGRATIONS,
  PERSONA_DATA_SCHEMA_VERSION,
  PersonaHistorySchema,
  type DefineDomainModule,
  type DomainFacility,
  type DomainMeta,
  type DomainSpec,
  type HumanityStore,
} from './store-schema.js'

/**
 * 元数据存取面。
 *
 * 只声明我们用到的那两个方法，而不是用 `ReturnType<DomainFacility['open']>`：后者会擦掉
 * 领域声明里的字面类型，让 `domain.global` 退化成 `never`（本项目已踩过两次）。
 */
interface MetaAccessor {
  global: {
    get(): DomainMeta
    set(value: DomainMeta): Promise<void>
  }
}

/* ─────────────────────────── F3：一条坏记录不该害死整库 ─────────────────────────── */

/**
 * "这一条读不出来"的标记键。
 *
 * 用带命名空间的长名字而不是 `invalid`：它是**我们自己**在解析失败时注入的哨兵，
 * 必须几乎不可能与任何真实字段撞名（撞名会把好记录误判成坏记录）。
 */
const UNREADABLE_KEY = '__humanityUnreadable'

/**
 * 解析失败时用来**接住**坏记录的哨兵形状。
 *
 * `raw` 是**必有**的：它由 {@link tolerantRecord} 的 `preprocess` 在判定失败时塞进来，
 * 携带原始值。没有它，日志里就只能写 `原始值=undefined`（第一版真的这样，实测抓到）。
 */
const MarkedRecordSchema = z.object({ [UNREADABLE_KEY]: z.literal(true), raw: z.unknown() })

/**
 * 被标记为"读不出来"的记录。
 *
 * `raw` 保留原始值（脱敏只在日志侧做），是为了让排查/人工修复时能知道**到底存了什么**。
 */
interface UnreadableRecord {
  [UNREADABLE_KEY]: true
  raw: unknown
}

/** 这条记录是不是被标记的坏记录。 */
function isUnreadable(value: unknown): value is UnreadableRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)[UNREADABLE_KEY] === true
  )
}

/**
 * 把一条记录 schema 包成**逐记录容错**的版本（F3 的核心）。
 *
 * 为什么必须这么做，而不是让 `storage-domain` 自己跳过：
 * 官方确实提供了 `spec.invalidRecords = 'backup-and-skip'`，**但它在本部署里是空操作** ——
 * 该选项要求后端实现 `KvUnit.backupRecord`（把坏记录的**文档**挪走），而我们的 JSON 后端是
 * **`single` 布局**（整库一个 `humanity.json`，见 `documents.ts:14-16` 的实测结论），
 * `single` 布局的单元类**没有** `backupRecord` 方法（`dsh-storage-json/lib/index.js` 里
 * 只有 `per-record` 单元实现了它）。框架因此在 `open` 时报
 * `invalid-records requires a backend with per-record documents` 并**降级为"整域拒绝"** ——
 * 也就是"一条坏记录害死整库"本身。**实测确认：单布局下这个开关帮不上忙。**
 *
 * 所以我们自己接住：`.catch()` 让失败的记录**解析成哨兵**而不是抛错 ⇒ 领域照常打开、
 * 好记录照常加载；哨兵随后在 {@link purgeUnreadable} 里被摘掉并点名报告。
 *
 * ⚠️ 代价（必须写在明处）：坏记录**不会**被物理挪走（single 布局没有"挪走一条"的介质操作），
 * 它仍留在盘上，只是在内存里被替换成哨兵、之后再被删除。**数据不丢**（原始值已进 stderr），
 * 但盘上那份要人工清理。这个取舍好过"整库打不开"。
 * @param schema - 该表的正常记录 schema。
 * @returns 容错后的 schema（好记录原样通过，坏记录变成哨兵）。
 */
function tolerantRecord<V>(schema: z.ZodType<V>): z.ZodType<V | UnreadableRecord> {
  // ⚠️ 为什么用 `preprocess` 而不是 `z.union([schema, Marked.catch(…)])`：
  // `catch` 只能用**静态**兜底值，拿不到"哪一条解析失败了"的原始输入；而 `union` 里
  // `MarkedRecordSchema` 是 `$strip` 对象，会把 `raw` 一起剥掉 —— 实测结果是
  // 日志里写 `原始值=undefined`，等于把"这一条到底存了什么"这条最重要的线索丢了。
  // `preprocess` 能同时看到输入**和**失败事实，所以原始值能一起带出来。
  const tolerant = z.preprocess(
    (raw) => (schema.safeParse(raw).success ? raw : { [UNREADABLE_KEY]: true, raw }),
    z.union([schema, MarkedRecordSchema]),
  ) as unknown as z.ZodType<V | UnreadableRecord>
  return tolerant
}

/** 只保留能安全进日志的那部分：字符串截断，控制字符去掉。 */
function preview(value: unknown): string {
  let text: string
  try {
    text = JSON.stringify(value) ?? String(value)
  } catch {
    text = '[无法序列化]'
  }
  // 控制字符与 ANSI 一律抹掉：这段文本会直写 stderr，不能被日志注入带偏。
  return text.replace(/[\u0000-\u001f\u007f\u001b]/g, ' ').slice(0, 400)
}

/**
 * 摘掉坏记录并**直写 stderr** 点名报告（F3）。
 *
 * 为什么直写而不只走日志门面：部署容器的 `ctx.logger` 输出不进 `docker logs`
 * （见 `log.ts` 的实测记录）。而"哪几条记录读不出来"是**必须能从容器外看见**的事实 ——
 * F1/F2 已经让"为什么坏"可见，这里补的是"坏了哪几条"。
 * @param domain - 已打开的领域。
 * @param log - 日志门面。
 * @returns 被摘掉的条数（0 表示这次没有坏记录）。
 */
async function purgeUnreadable(domain: { table(name: string): unknown }, log: Log): Promise<number> {
  let purged = 0
  for (const table of ALL_TABLES) {
    let handle: { entries?: () => IterableIterator<[string, unknown]>; delete?: (key: string) => Promise<boolean> }
    try {
      handle = domain.table(table) as typeof handle
    } catch {
      continue // 表缺席（旧库还没有这张表）不是错误。
    }
    // ⚠️ 能力探测而不是直接调用：`entries()` 是**可选**能力（`store.ts:34-35` 逐字写着
    // "`entries` 是可选能力：假设施与最小句柄可能没有"）。隔离是**加固**，不是打开的前置条件 ——
    // 拿不到枚举能力时应当"这次不扫描"，绝不能因此把整个领域打不开
    // （真机教训：第一版写了 `handle.entries()`，`host-store.test.mjs` 的假设施立刻炸了三条）。
    if (typeof handle.entries !== 'function') continue

    const bad: Array<[string, unknown]> = []
    for (const [key, record] of handle.entries()) if (isUnreadable(record)) bad.push([key, record.raw])
    if (bad.length === 0) continue

    for (const [key, raw] of bad) {
      purged += 1
      reportBootFailure(
        log,
        `存储表 '${table}' 里有一条记录读不出来，已隔离并删除（其余记录照常加载）。` +
          `键='${key}'；原始值=${preview(raw)}；` +
          `⚠️ 原始值只在本行日志里，介质上没有备份，需要保留请从这行复制。`,
        new Error('record failed schema validation'),
      )
      if (typeof handle.delete !== 'function') {
        reportBootFailure(log, `句柄没有 delete 能力：记录 '${key}' 只从内存里摘掉，盘上那份仍在`, new Error('no delete capability'))
        continue
      }
      try {
        await handle.delete(key)
      } catch (error) {
        // 删不掉（只读介质 / 后端限制）不该让整库打不开：内存里已经摘掉，功能不受影响。
        reportBootFailure(log, `隔离记录 '${key}' 的删除失败（内存里已摘掉，功能不受影响）`, error)
      }
    }
  }
  return purged
}

/** 领域里的全部表（坏记录扫描要逐表走一遍）。 */
const ALL_TABLES = [
  HISTORY_TABLE,
  MEMORY_TABLE,
  RUNS_TABLE,
  PROPOSALS_TABLE,
  CURSORS_TABLE,
  STATE_TABLE,
  DOCUMENTS_TABLE,
] as const

/**
 * 历史表句柄里 `pruneHistory` 用到的**那一小片能力**。
 *
 * 两个方法都是**可选能力**（与 `purgeUnreadable` 同一纪律：假设施与最小句柄可能没有），
 * 所以先探测再调用，缺能力就"这次不清"，绝不让清理把"读人格"带崩。
 */
interface HistoryPruneAccessor {
  entries?(): Iterable<[string, unknown]>
  delete?(key: string): Promise<void>
}

/**
 * 删掉历史表里 `at` **早于** `cutoff` 的记录，返回删除条数（0.1.13，用户要求的历史保留期）。
 *
 * 三条边界：
 * - **只碰历史表**：这个函数只拿到历史表句柄，清理范围窄到表级（记忆 / 提案 / 人格本体不可能被误伤）；
 * - **按时刻比较而不是字典序**：`at` 由我们写成 `Date#toISOString()`，但历史里可能有别的写入方留下的
 *   形状（schema 只约定是字符串）。`Date.parse` 解析不出来的记录**跳过不删**（宁可留多了，不可误删）；
 * - **坏记录不动**：`isUnreadable` 的哨兵留给启动扫描那条路径（它会连原始值一起点名），
 *   这里删掉等于把唯一的线索抹了。
 * @param table - 历史表句柄。
 * @param cutoff - ISO 8601 截止时刻；`at < cutoff` 的记录被删。
 * @returns 删除条数。
 */
async function pruneHistoryTable(table: unknown, cutoff: string): Promise<number> {
  const handle = table as HistoryPruneAccessor
  if (typeof handle.entries !== 'function' || typeof handle.delete !== 'function') return 0

  const limit = Date.parse(cutoff)
  if (Number.isNaN(limit)) return 0

  const doomed: string[] = []
  for (const [key, record] of handle.entries()) {
    if (isUnreadable(record)) continue
    const at = (record as { at?: unknown } | null)?.at
    if (typeof at !== 'string') continue
    const stamp = Date.parse(at)
    if (Number.isNaN(stamp)) continue
    if (stamp < limit) doomed.push(key)
  }

  let removed = 0
  for (const key of doomed) {
    await handle.delete(key)
    removed += 1
  }
  return removed
}

/**
 * 打开领域，跑迁移，必要时建立首次安装标记。
 *
 * 两条失败路径刻意分开：
 * - **声明非法**（名字不合规、版本号非法…）是**我们自己的缺陷**，单独记一条明确的日志；
 * - **打开失败**（版本不认识、后端不可用、数据损坏）是环境问题，降级为"本次无持久化"。
 * 混成一个错误会让症状变成"存储就是不可用"，排查时找不到真因（踩过：表名写成驼峰 →
 * `defineDomain` 抛错 → 静默降级）。
 * @param facility - 已就位的存储领域设施。
 * @param log - 日志门面。
 * @returns 存储句柄；打开失败时为 `undefined`（已记日志，不抛）。
 */
export async function openDomain(facility: DomainFacility, log: Log): Promise<HumanityStore | undefined> {
  const module = await loadOptional<DefineDomainModule>('@deepseek-ai/dsh-storage-domain', log)
  if (module === undefined) return undefined

  // 用不标注返回类型的立即执行函数而不是 `let spec: DomainSpec`：宽类型标注会擦掉 `global`
  // 的字面类型，让 `domain.global` 退化成 never（同一坑已踩过两次，故写在这里）。
  const spec = (() => {
    try {
      return module.defineDomain({
        name: DOMAIN_NAME,
        version: DOMAIN_VERSION,
        compatibleVersions: [...COMPATIBLE_DOMAIN_VERSIONS],
        global: { schema: MetaSchema, initial: META_INITIAL },
        tables: {
          [HISTORY_TABLE]: module.domainTable(tolerantRecord(PersonaHistorySchema)),
          [MEMORY_TABLE]: module.domainTable(tolerantRecord(MemoryEntrySchema)),
          [RUNS_TABLE]: module.domainTable(tolerantRecord(RunRecordSchema)),
          [PROPOSALS_TABLE]: module.domainTable(tolerantRecord(ProposalRecordSchema)),
          [CURSORS_TABLE]: module.domainTable(tolerantRecord(CursorRecordSchema)),
          [STATE_TABLE]: module.domainTable(tolerantRecord(StateRecordSchema)),
          [DOCUMENTS_TABLE]: module.domainTable(tolerantRecord(DocumentRecordSchema)),
        },
      } satisfies DomainSpec)
    } catch (error) {
      // F2（2026-10-04 修）：改走 `reportBootFailure` —— 它**除了**日志门面，还直写 stderr。
      //
      // 为什么必须直写：部署容器的 `ctx.logger` 输出**不进 `docker logs`**（`log.ts:44-48` 有实测记录）。
      // 于是"存储域声明非法"这条**插件自身缺陷**的日志，在真实部署里**一个字都看不到** ——
      // 故障表现为"每轮说人格未初始化 + recall 整场失效"，而容器日志干干净净。
      // 这条路径同时也是 F1 的配套：F1 不再撒谎之后，故障会变安静，必须由这里补回可观测性。
      reportBootFailure(log, `存储领域 ${DOMAIN_NAME} 的声明非法（这是插件缺陷，不是环境问题），已停用持久化`, error)
      return undefined
    }
  })()
  if (spec === undefined) return undefined

  try {
    const domain = await facility.open(spec)
    // F3：先摘掉读不出来的记录（逐条点名 + 直写 stderr），再交回句柄。
    // 放在这里而不是"打开失败后补救"：因为容错 schema 已经让 open 成功了，
    // 这一步只负责把哨兵换成"不存在"，让上层永远看不到坏记录。
    const purged = await purgeUnreadable(domain as unknown as { table(name: string): unknown }, log)
    if (purged > 0) {
      reportBootFailure(
        log,
        `本次共隔离 ${purged} 条读不出来的记录；其余记录照常加载（记忆检索与人格注入不受影响）。`,
        new Error('invalid records isolated'),
      )
    }
    // ⚠️ 下面这些 `as` 是 F3 的必要代价，不是偷懒：
    // `tolerantRecord()` 让领域表的**类型**带上 `UnreadableRecord`（刻意的 —— 类型系统因此
    // 逼着我们记住"表里可能混着坏记录"）。而 `purgeUnreadable` 刚刚把那些哨兵**全部删除**，
    // 所以此刻起句柄里绝无哨兵，`HumanityStore` 的窄接口描述是准确的。
    // 类型系统看不到"上一个 await 已经把坏数据清干净了"，只能用断言补上。
    // 断言的安全性由三件事兜住：① 每种 schema 都过了 `tolerantRecord()`；
    // ② 每张表都在 `ALL_TABLES` 里；③ `purgeUnreadable` 覆盖 `ALL_TABLES` 的每一张
    //（`test/store-invalid-records.test.mjs` 逐表验证）。
    const history = domain.table(HISTORY_TABLE)
    const memory = domain.table(MEMORY_TABLE) as unknown as HumanityStore['memory']
    const evolution: HumanityStore['evolution'] = {
      runs: domain.table(RUNS_TABLE) as unknown as HumanityStore['evolution']['runs'],
      proposals: domain.table(PROPOSALS_TABLE) as unknown as HumanityStore['evolution']['proposals'],
      cursors: domain.table(CURSORS_TABLE) as unknown as HumanityStore['evolution']['cursors'],
      state: domain.table(STATE_TABLE) as unknown as HumanityStore['evolution']['state'],
    }
    const documents = domain.table(DOCUMENTS_TABLE) as unknown as Parameters<typeof createDocumentStore>[0]
    const settled = await settleMeta(domain, log)
    return {
      installedAt: settled.installedAt,
      memory,
      evolution,
      recordHistory: (entry) => history.put(`${entry.at}#${entry.path}`, entry),
      pruneHistory: (cutoff) => pruneHistoryTable(history, cutoff),
      historyCount: () => history.size,
      documents: createDocumentStore(documents),
      close: () => domain.close(),
    }
  } catch (error) {
    // 存储是派生能力：打不开不应该连带停掉对话和其余模块（G-002）。原始原因照原样进日志。
    // F2（2026-10-04 修）：同上一处，改走 `reportBootFailure` 直写 stderr —— 这是**最常见**
    // 的失败路径（一条记录不符合 schema 就会走到这里），过去它在容器日志里完全不可见。
    reportBootFailure(log, `存储领域 ${DOMAIN_NAME} 打开失败，本次以无持久化方式运行`, error)
    return undefined
  }
}

/**
 * 建立首次安装标记，或沿迁移链升级已存元数据。
 *
 * 全新安装直接写初值、**不跑迁移链**：新装的数据本来就是当前代，
 * 让它"从第 1 代迁移到第 2 代"纯属自欺，还会多写一次盘。
 * @param domain - 已打开的领域。
 * @param log - 日志门面。
 * @returns 生效的元数据。
 */
async function settleMeta(domain: MetaAccessor, log: Log): Promise<DomainMeta> {
  const meta: DomainMeta = domain.global.get()
  if (meta.installedAt !== '') return migrateMeta(meta, domain, log)

  const installedAt = new Date().toISOString()
  const initial: DomainMeta = { installedAt, schemaVersion: PERSONA_DATA_SCHEMA_VERSION }
  await domain.global.set(initial)
  log.info(`已建立持久化存储（领域 ${DOMAIN_NAME} v${DOMAIN_VERSION}，首次安装 ${installedAt}）`)
  return initial
}

/**
 * 把已存元数据沿迁移链升到当前版本，并落盘。
 *
 * 缺任何一步就**抛错**，由 `openDomain` 统一降级为"本次无持久化"：
 * 迁移链断掉意味着我们看不懂这份数据，此时继续用它是危险的 ——
 * 但也不该把整个 DSH 拖下水，所以是降级而不是崩溃。
 * @param meta - 已存元数据（旧文件缺 `schemaVersion` 时解析结果已按 1 补齐）。
 * @param domain - 已打开的领域，用于落盘升级后的元数据。
 * @param log - 日志门面。
 * @returns 升级后的元数据；无需升级时原样返回。
 */
async function migrateMeta(meta: DomainMeta, domain: MetaAccessor, log: Log): Promise<DomainMeta> {
  if (meta.schemaVersion >= PERSONA_DATA_SCHEMA_VERSION) return meta

  const from = meta.schemaVersion
  let current = meta
  while (current.schemaVersion < PERSONA_DATA_SCHEMA_VERSION) {
    const step = MIGRATIONS.get(current.schemaVersion)
    if (step === undefined) {
      throw new Error(`缺少从 v${current.schemaVersion} 到 v${current.schemaVersion + 1} 的迁移步骤`)
    }
    current = step(current)
  }

  await domain.global.set(current)
  log.info(`存储数据已从第 ${from} 代迁移到第 ${current.schemaVersion} 代（旧数据保留）`)
  return current
}
