/**
 * 自进化的存储面：四张领域表的窄包装（运行记录 / 提案 / 游标 / 单值状态）。
 *
 * 与 `memory/store.ts` 同一取舍：只依赖 {@link TableHandle} 结构窄面，不固化 storage-domain
 * 的类型面。记录形状由 `model.ts` 的 schema 在**写入前**把关；读取直接信任表内容
 * （storage-domain 打开与写入时都会按 `domainTable` 的 schema 校验，坏记录进不了表）。
 *
 * 容量纪律（DEV-PLAN §6/§8-R6）：运行记录留 {@link MAX_RUN_RECORDS} 条、游标留
 * {@link MAX_CURSOR_RECORDS} 条且超过保留期的先清——表是"近期视图 + 增量水位"，
 * 不是审计日志（审计在会话日志本身，DSH 手里）。
 * @module humanity/evolution/state
 */
import {
  CURSOR_RETENTION_DAYS,
  MAX_CURSOR_RECORDS,
  MAX_RUN_RECORDS,
  STATE_KEY,
} from './constants.js'
import { STATE_INITIAL, StateRecordSchema } from './model.js'
import type { CursorRecord, ProposalRecord, RunRecord, StateRecord, TableHandle } from './types.js'

/** 四张表的句柄集（由宿主 `store-open.ts` 打开后喂进来）。 */
export interface EvolutionTables {
  runs: TableHandle<RunRecord>
  proposals: TableHandle<ProposalRecord>
  cursors: TableHandle<CursorRecord>
  state: TableHandle<StateRecord>
}

/** 待确认提案的分类计数（P-042 徽标与顶部数量；记忆类由客户端从记忆命名空间合并）。 */
export interface ProposalCounts {
  persona: number
  skill: number
  route: number
  total: number
}

/** 自进化存储入口。 */
export interface EvolutionState {
  /** 运行记录，最新在前。 */
  listRuns(): RunRecord[]
  getRun(id: string): RunRecord | undefined
  /** 写入运行记录并裁剪到上限（裁最旧 `startedAt`）。 */
  putRun(record: RunRecord): Promise<void>
  /** 提案列表，最新在前；给 status 则只列该状态。 */
  listProposals(status?: ProposalRecord['status']): ProposalRecord[]
  getProposal(id: string): ProposalRecord | undefined
  putProposal(record: ProposalRecord): Promise<void>
  removeProposal(id: string): Promise<boolean>
  /** 待确认提案的分类计数。 */
  countPending(): ProposalCounts
  getCursor(sessionId: string): CursorRecord | undefined
  putCursor(record: CursorRecord): Promise<void>
  /** 清理过期与超量的游标；返回删除条数。 */
  pruneCursors(now?: string): Promise<number>
  /** 单值状态；表里没有（或形状坏）时返回出厂值。 */
  readState(): StateRecord
  /**
   * **字段级原子合并**单值状态（storage-domain 的 `update` 是串行队列上的读改写，
   * 并发写永不交错）。
   *
   * ⚠️ 别再提供"读出来改完整个写回"的 writeState：2026-09-25 TEST 真机实证——
   * runner 记账与调度器重排各自读改写同一条记录，后写的用**旧快照**把先写的
   * `nextRunAt` 顶了回去，重启后多补跑一次（花了钱）。多方写同一条记录，
   * 唯一安全形态就是这一个入口。
   *
   * **0.1.9 起它还负责"表里没有这条记录就先建"**（历史缺陷：全库只 `update` 不 `put`
   * ⇒ 表从未被创建 ⇒ 每次运行起手就抛官方 `missing-key`）。调用方语义不变。
   */
  mutateState(patch: Partial<StateRecord> | ((current: StateRecord) => StateRecord)): Promise<void>
}

/** 收集表内容为数组（表是迭代器，排序前先物化）。 */
function collect<V>(table: TableHandle<V>): V[] {
  const all: V[] = []
  for (const [, value] of table.entries()) all.push(value)
  return all
}

/** 时间串降序比较（ISO 8601 字典序 = 时间序；空串排最后）。 */
function byTimeDesc(a: string, b: string): number {
  if (a === b) return 0
  if (a === '') return 1
  if (b === '') return -1
  return a < b ? 1 : -1
}

/** 写入运行记录后裁剪：超过上限就删最旧的，直到回到上限内。 */
async function pruneRuns(table: TableHandle<RunRecord>): Promise<void> {
  const sorted = collect(table).sort((a, b) => byTimeDesc(a.startedAt, b.startedAt))
  if (sorted.length <= MAX_RUN_RECORDS) return
  for (const record of sorted.slice(MAX_RUN_RECORDS)) await table.delete(record.id)
}

/** 游标清理两段：先删超过保留期未触碰的，再删超量的（都按 `lastRunAt` 从旧到新）。 */
async function pruneCursors(table: TableHandle<CursorRecord>, now: string): Promise<number> {
  const nowMs = Date.parse(now)
  const deadline = nowMs - CURSOR_RETENTION_DAYS * 24 * 60 * 60 * 1000
  // 最新触碰在前：裁剪时 `slice(MAX)` 留下的尾巴才是要删的最旧一批（方向写反会裁掉活水位）。
  const all = collect(table).sort((a, b) => byTimeDesc(a.lastRunAt, b.lastRunAt))
  let removed = 0
  for (const record of all) {
    const expired = record.lastRunAt !== '' && Date.parse(record.lastRunAt) < deadline
    if (!expired) continue
    await table.delete(record.sessionId)
    removed += 1
  }
  const rest = all.filter((record) => table.get(record.sessionId) !== undefined)
  for (const record of rest.slice(MAX_CURSOR_RECORDS)) {
    await table.delete(record.sessionId)
    removed += 1
  }
  return removed
}

/**
 * 造四张领域表之上的自进化存储入口。
 * @param tables - 表句柄集。
 */
export function createEvolutionState(tables: EvolutionTables): EvolutionState {
  const { runs, proposals, cursors, state } = tables

  /**
   * **确保单值状态记录存在**（2026-10-05 修，0.1.9）。
   *
   * 为什么需要它（生产实测，不是防御性编程）：本模块**全库只有 `update`、没有 `put`**，
   * 而 `update` 的语义是"记录必须已存在"（官方 `dsh-storage-domain` 的 `missing-key`）
   * ⇒ `evolution_state` 表**从来没被创建过** ⇒ 每一轮整理的**第一次状态写入**就抛
   * `domain 'humanity' table 'evolution_state' has no record 'main' to update`：
   * 生产上 12 轮 `evolution_runs` **全部**如此失败（26–101 ms、`calls=0`、扫描与记忆全 0），
   * 而读侧有出厂值兜底（见 `readState`）⇒ **症状被掩盖**，工作台只看得出"失败"。
   *
   * 为什么是"先 ensure、再 update"，而不是"先 put 出厂值、再拿同一个 patch 去 update"：
   * 后者会把**函数式 patch 算两次**（`dailyCalls + 1` 落盘成 +2）—— 那是看不出来的双计，
   * 尤其会污染每日配额账本。这里 put 的只是**出厂值**，patch 仍然只由 `update` 应用一次。
   *
   * 为什么记忆化（只做一次）：并发写入（调度器的 `nextRunAt` 与运行中的记账）不该各自
   * 去建一遍；共享同一个 promise ⇒ 建档恰好一次，且所有 update 都排在它之后。
   * **失败不缓存**：一次瞬时存储故障不该把状态写入永久卡死（下次调用重试）。
   */
  let ensured: Promise<void> | undefined
  const ensureStateRecord = (): Promise<void> => {
    if (ensured !== undefined) return ensured
    const pending = (async () => {
      if (state.get(STATE_KEY) !== undefined) return
      await state.put(STATE_KEY, STATE_INITIAL)
    })()
    ensured = pending
    // 失败要把 memo 清掉（否则一次故障之后再也写不进状态）；这里另挂一个处理器只为清理，
    // 真正的错误仍由调用方 await 到。
    void pending.catch(() => {
      if (ensured === pending) ensured = undefined
    })
    return pending
  }

  return {
    listRuns: () => collect(runs).sort((a, b) => byTimeDesc(a.startedAt, b.startedAt)),
    getRun: (id) => runs.get(id),
    putRun: async (record) => {
      await runs.put(record.id, record)
      await pruneRuns(runs)
    },
    listProposals: (status) =>
      collect(proposals)
        .filter((record) => status === undefined || record.status === status)
        .sort((a, b) => byTimeDesc(a.createdAt, b.createdAt)),
    getProposal: (id) => proposals.get(id),
    putProposal: (record) => proposals.put(record.id, record),
    removeProposal: (id) => proposals.delete(id),
    countPending: () => {
      const counts: ProposalCounts = { persona: 0, skill: 0, route: 0, total: 0 }
      for (const record of proposals.entries()) {
        const [, proposal] = record
        if (proposal.status !== 'pending') continue
        counts[proposal.kind] += 1
        counts.total += 1
      }
      return counts
    },
    getCursor: (sessionId) => cursors.get(sessionId),
    putCursor: (record) => cursors.put(record.sessionId, record),
    pruneCursors: (now) => pruneCursors(cursors, now ?? new Date().toISOString()),
    // 读取兜底回出厂值而不是抛：这条路径在调度器与投影里，坏一条状态不该停模块（G-002）。
    readState: () => {
      const result = StateRecordSchema.safeParse(state.get(STATE_KEY))
      return result.success ? result.data : STATE_INITIAL
    },
    mutateState: async (patch) => {
      // 0.1.9：表为空时**先建** main 记录（出厂值），再照旧字段级原子合并。
      // 没有这一步，下面这行 `update` 在"表从未被创建"的库上必然抛 —— 生产 12 轮就是这么坏的。
      await ensureStateRecord()
      await state.update(STATE_KEY, (current) => {
        const base = StateRecordSchema.safeParse(current)
        const merged = base.success ? base.data : STATE_INITIAL
        return typeof patch === 'function' ? patch(merged) : { ...merged, ...patch }
      })
    },
  }
}
