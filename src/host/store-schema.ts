/**
 * 套件存储的**常量与 schema**：领域名/版本、迁移链、表名、以及两个 schema。
 *
 * 为什么从 `store.ts` 拆出来：这些是"数据长什么样"的声明（很少改、改动要非常小心），
 * 而 `store.ts` 是"怎么打开、怎么失败降级"的流程。混在一起时，读流程要翻过一百行 schema。
 * @module humanity/store-schema
 */
import type { DomainFacility, DomainSpec, DomainTableSpec } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

import type { EvolutionTables } from './evolution/state.js'
import type { MemoryTableHandle } from './memory/store.js'
import { DOCUMENTS_TABLE, DocumentRecordSchema, type DocumentStore } from './documents.js'

export type { DomainFacility, DomainSpec }

/** 领域名。它写进存储、也出现在日志里，改名等于旧数据找不到（与 PERSONA_NAMESPACE 同一类风险）。 */
export const DOMAIN_NAME = 'humanity'

/**
 * 存储单元的**介质格式**版本。改它等于让老文件打不开，所以要非常小心。
 *
 * ### 为什么加了表却仍然停在 1（实测决定，不是偷懒）
 *
 * 用户裁决 4 要求"领域 v1→v2 迁移骨架"。我按字面做过，**结果破坏了 G-004 的零迁移**：
 *
 * 1. 升到 2：`dsh-storage-json` 的 `single` 布局在 `parse()` 里要求
 *    `unit.version === descriptor.version`（精确相等），旧文件直接被
 *    `version-mismatch` 拒绝 —— 实测报错：`unit 'humanity': stored version 1 != expected 2`。
 *    `compatibleVersions` **不参与**这条判定（它只在 `per-record` 布局里被 `acceptedStamps` 使用）。
 * 2. 改用 `per-record` 布局去吃到 `compatibleVersions`：它的 legacy 引导
 *    （`bootstrapLegacyUnit`）**只逐表搬运记录、不搬 `global`** —— 我们的 `installedAt`
 *    与迁移状态就存在 global 里，换布局等于丢数据。
 * 3. 保持介质版本 1、新增表：`parse()` 对**缺失的表补空表**
 *    （`records === undefined → state.tables.set(table, new Map())`），
 *    于是老文件照常打开、新表从空开始 —— 零迁移成立。
 *
 * 结论：**介质格式没有变**（JSON 形状、校验契约都没动，只是可选表变多了），
 * 所以介质版本不该动。真正的"结构代数"由下面的 {@link PERSONA_DATA_SCHEMA_VERSION} 记在
 * global 里，并由 {@link MIGRATIONS} 负责升级。这条与裁决 4 的字面表述不同，已写入
 * `docs/BLOCKED.md` 待验收方裁定；在裁定前，这里保持实测唯一可行且不丢数据的方案。
 */
export const DOMAIN_VERSION = 1

/**
 * 我们自己的**数据 schema 代数**（存在 global 里，不写进介质头）。
 *
 * 与介质版本正交：介质版本管"文件能不能读"，这个管"读出来的内容是哪一代、要不要改造"。
 * 1 → 2：新增历史表 `persona_history`；2 → 3：新增记忆表 `memory_entries`；
 * 3 → 4：新增自进化四表（`evolution_runs` / `evolution_proposals` / `evolution_cursors` / `evolution_state`）；
 * 4 → 5：新增文档表 `documents`（0.1.7 起 settings 不再承载任意文档，人格文档与开关覆盖改由我们自己落盘）。
 * 四次都是**加表**，对已有记录没有影响，但都要显式写进 {@link MIGRATIONS}（见那里的说明）。
 *
 * 名字里的 `PERSONA_` 是历史包袱（M2 时只有人格数据）。现在它覆盖整个套件的数据代数，
 * 但**不改名**：`docs/handoff/QA-M2.md` 与 `docs/reports/VERIFY-M2.md` 的实读记录引用的
 * 就是这个名字，改名会让那些记录对不上，而功能收益为零。数据里存的是数字，不受影响。
 */
export const PERSONA_DATA_SCHEMA_VERSION = 5

/**
 * 声明"当前 schema 也接受这些旧版本的已存数据"。
 *
 * 现在是**空**的：介质版本还停在 1，而 `defineDomain` 要求每一项都严格小于当前版本
 * （`compat >= spec.version` 直接抛错），所以此刻不可能有合法取值。
 * 将来介质格式真的不兼容、需要升 {@link DOMAIN_VERSION} 时再填旧版本号；
 * 注意 `single` 布局不消费它（见上面对 `DOMAIN_VERSION` 的说明）——
 * 别以为把它填上老文件就能读。
 */
export const COMPATIBLE_DOMAIN_VERSIONS: readonly number[] = []

/**
 * 套件级元数据。
 *
 * 演进规则：新版本只能**新增**字段并给出默认值，不能改变已有字段的含义——
 * 否则老数据在新版本里读不出来，就变成了强制迁移。
 */
export const MetaSchema = z.object({
  /** 首次成功建立存储的时间，ISO 8601 UTC。空串是「从未写入过」的唯一判据。 */
  installedAt: z.string(),
  /**
   * 写入时的数据 schema 代数。
   * `default(1)` 是给第一代老文件用的：它们没有这个字段，解析时按 1 补齐，
   * 迁移链于是能认出"这是从第 1 代来的"。
   */
  schemaVersion: z.number().int().nonnegative().default(1),
})

/** 未写入时后端返回的初值。 */
export const META_INITIAL = { installedAt: '', schemaVersion: PERSONA_DATA_SCHEMA_VERSION }

/**
 * 历史/审计记录：一条被当前有效值取代的旧内容（P-009）。
 *
 * 为什么单独一张表而不是塞进人格文档：历史**不参与人格注入**，混进生效文档就会跟着进 prompt；
 * 而且它是 append-only 的，读写模式与"当前快照"完全不同。
 *
 * ⚠️ **0.1.13 起 P-009 的"不删除"按保留期收窄**（用户 2026-10-09：「删除的进历史，要有个保留天数，
 * 而不是永久保留」）：保留期内一条不删，超期由 `persona/history-retention.ts` 清理。
 * 表结构没变，改的只是生命周期。
 */
export const PersonaHistorySchema = z.object({
  /** 记录时刻，ISO 8601 UTC。 */
  at: z.string(),
  /** 谁触发的这次取代。 */
  source: z.enum(['user', 'agent']),
  /** 文档内的位置，例如 `identityCard.fields.姓名`、`mutableLayer.sections.说话风格`。 */
  path: z.string(),
  /** 被取代的旧内容原文。 */
  previous: z.string(),
  /** 取代原因（机器码），例如 `superseded`。 */
  reason: z.string(),
})

/** 历史记录。 */
export interface PersonaHistoryEntry {
  at: string
  source: 'user' | 'agent'
  path: string
  previous: string
  reason: string
}

/**
 * 历史表名。与领域名一样是数据契约的一部分，不要改。
 *
 * 名字必须是 `^[a-z][a-z0-9_]*$`（storage-domain 的 `UNIT_NAME_RE` 校验）——
 * 所以是下划线风格而不是驼峰。这条很容易踩：名字写错时 `defineDomain` 在**声明阶段**就抛，
 * 而抛出点在我们的 try/catch 里，会被降级成"存储不可用"，症状与"环境有问题"一模一样。
 */
export const HISTORY_TABLE = 'persona_history'

/** 套件级元数据。 */
export interface DomainMeta {
  installedAt: string
  schemaVersion: number
}

/**
 * 数据 schema 的迁移链：键是**来源**代数，值把该代数据升到下一代。
 *
 * 1 → 2（加历史表）、2 → 3（加记忆表）、3 → 4（加自进化四表）与 4 → 5（加文档表）都是空操作：
 * 新增的表在旧文件里不存在，打开时由 storage-domain 自动补成空表
 * （`records === undefined → 空 Map`），对已有记录没有任何影响。
 * 但**必须显式写出来**：迁移链的意义是让每一次代数跳跃都有人负责；
 * 缺一步就应当在打开时报错，而不是默许一个没人担保的数据形状继续跑。
 * （链条也不能跳代：将来若要做真转换，第 2 代的老文件正是靠这几步走过来的。）
 */
export const MIGRATIONS: ReadonlyMap<number, (meta: DomainMeta) => DomainMeta> = new Map([
  [1, (meta: DomainMeta): DomainMeta => ({ ...meta, schemaVersion: 2 })],
  [2, (meta: DomainMeta): DomainMeta => ({ ...meta, schemaVersion: 3 })],
  [3, (meta: DomainMeta): DomainMeta => ({ ...meta, schemaVersion: 4 })],
  [4, (meta: DomainMeta): DomainMeta => ({ ...meta, schemaVersion: 5 })],
])

/** 已打开的套件存储。 */
export interface HumanityStore {
  /** 本套件第一次建立持久化存储的时间（ISO 8601 UTC）。 */
  readonly installedAt: string
  /** 记忆条目表（键 = 去重指纹）。记忆模块只通过它读写条目。 */
  readonly memory: MemoryTableHandle
  /** 自进化四表（运行记录 / 提案 / 游标 / 单值状态）。自进化模块只通过它读写。 */
  readonly evolution: EvolutionTables
  /**
   * 文档表（0.1.7 起承载人格文档与开关覆盖；键 = 命名空间名）。
   *
   * 为什么在这里而不是让数据面自己去开领域：领域只能开一次，句柄必须与其余表同源；
   * 数据面拿到的是同一个 `HumanityStore`（见 `index.ts` 的接线）。
   */
  readonly documents: DocumentStore
  /**
   * 把一条被取代的旧内容追加进历史表。
   *
   * 保留期由配置决定（`modules.persona.historyRetentionDays`，默认 30 天）：
   * 写入时**不做**任何裁剪，超期记录的清理是 {@link HumanityStore.pruneHistory} 的事。
   * @param entry - 历史记录。
   */
  recordHistory(entry: PersonaHistoryEntry): Promise<void>
  /**
   * 删掉 `at` **早于** `cutoff` 的历史记录，返回删除条数。
   *
   * ⚠️ **范围窄到表级**：只遍历 / 删除 `persona_history`，记忆条目、提案、游标、人格本体文档
   * 一个都不碰（实现里只拿到历史表句柄，见 `store-open.ts`）。
   * @param cutoff - ISO 8601 UTC 截止时刻；`at < cutoff` 的记录被删（边界上的那条保留）。
   */
  pruneHistory(cutoff: string): Promise<number>
  /** 当前历史条数（工作台与测试用；不再返回整表，避免把大对象带出去）。 */
  historyCount(): number
  /** 释放领域。不释放会一直占住领域名，直到进程结束（facility 的说明如此）。 */
  close(): Promise<void>
}

/** 我们只从 `storage-domain` 用到两个函数，因此按结构取用，不固化它的类型面。 */
export interface DefineDomainModule {
  defineDomain<S extends DomainSpec>(spec: S): S
  /**
   * 声明一张表。
   *
   * 返回类型必须保留 schema 推出的值类型（`DomainTableSpec<string, V>`）：
   * 早先这里写的是 `DomainSpec['tables'][string]`（= `DomainTableSpec<string, unknown>`），
   * 于是 `defineDomain` 推出来的 spec 把每张表的值类型都擦成 `unknown`，
   * `domain.table(...)` 读出来的记录也就丢光了类型（本步骤踩到：记忆条目读回变 unknown）。
   */
  domainTable<V>(schema: z.ZodType<V>): DomainTableSpec<string, V>
}
