/**
 * 记忆工作台的**投影运行期**：把存储现状算成一份 `MemoryDocument` 写进命名空间，
 * 并消费客户端写在同一个文档里的命令槽。
 *
 * 命令槽的纪律与自进化同一套：**客户端只写"想做什么"，执行权在宿主**。
 * 目前只有两种操作 —— `reveal`（越过门槛看一条秘密）与 `delete`（删掉一条）。
 * 两者都要客户端走两步（先问、再确认），因为这两个动作都不可撤销。
 * @module humanity/memory/section-runtime
 */
import type { Log } from '../log.js'
import { createMemoryRecord } from './model.js'
import { DISCLOSURE_THRESHOLD, PEEK_ACK_COST } from './constants.js'
import { strengthAt } from './decay.js'
import { peekReaction } from './reaction.js'
import type { MemoryStore } from './store.js'
import {
  MEMORY_NAMESPACE,
  VIEW_LIMIT,
  emptyMemoryDocument,
  type MemoryDocument,
  type MemoryEntryView,
  type MemoryStatsView,
  type RecallView,
} from './section-doc.js'
import type { MemoryCharacter, MemoryHit, MemoryRecord } from './types.js'

/** 投影需要的外部事实。 */
export interface MemorySectionDeps {
  /** 现读存储句柄；未就绪时返回 `undefined`。 */
  store(): MemoryStore | undefined
  /** 现在（测试注入固定时刻用）。 */
  now?(): Date
  /** 写进命名空间（由 `section.ts` 提供，内部走 settings.replace）。 */
  write(doc: MemoryDocument): void
  /**
   * 对方叫什么（人格那边的「对TA的称呼」）。
   *
   * 为什么需要它：她记下"有人看了我那件事"时必须用名字 —— 记忆里一旦出现"他/对方"，
   * 将来多个人就会串成一团（2026-11-21 定下的视角规则）。
   */
  userName?(): string
  /**
   * 她的性格（只取用得上的两根轴）。
   *
   * 缺席时反应强度退回基准值 —— 人格模块没开、或还没初始化，都不该让她"没有反应"。
   */
  character?(): MemoryCharacter | undefined
  /**
   * 情绪种类 → 人话（"fear" → "害怕"）。
   *
   * 由宿主从情绪模块借来：记忆不 import 情绪（模块互相隔离），也不自己维护第二张词表 ——
   * 两张词表早晚会分叉，界面上就会出现"情绪页说害怕、记忆页说畏惧"。
   */
  feltLabel?(kind: string): string
  /**
   * 是不是还在休眠（人格没封存）。
   *
   * 与"模块被关掉"不是一回事：界面要说清"还没开始"，不是"没有记忆"。
   */
  dormant?(): boolean
  /** 读客户端写进来的命令（由 `section.ts` 从命名空间现取）。 */
  pendingRequest?(): { op: string; id: string } | undefined
  log: Log
}

/** 投影运行期句柄。 */
export interface MemorySectionRuntime {
  /** 重新算一次并写出去。失败只记日志（工作台读不到不该影响对话）。 */
  refresh(): Promise<void>
  /** 存储刚就绪：补一次投影。 */
  notifyStoreReady(): void
  /** 客户端刚写了命令：消费它，然后重新投影。 */
  consume(): Promise<void>
  /**
   * 记下这一轮"因为哪句话、想起了哪几条"，并把它投影出去。
   *
   * 为什么要在这一层记：记忆注入发生在对话里，而工作台是另一个窗口 ——
   * 不回传这个，用户永远只能看到"想起了几次"，看不到"为什么"。
   * @param cue - 当时对方说的那句话。
   * @param hits - 命中的记忆（已排序）。
   */
  noteRecall(cue: string, hits: readonly MemoryHit[]): void
}

/**
 * 处理一条 `reveal`（越过门槛查看一条秘密）。
 *
 * **两件事同时发生，缺一不可**：
 * 1. 那条记忆的代价降下来 —— 秘密只在她还保得住的时候才是秘密，被看穿了就不再是；
 * 2. 她记下这件事 —— 而且这条新记忆自己也带着不小的代价（她未必愿意提"你看了我的东西"）。
 *
 * 这就是"被窥探"的完整闭环：不是把内容给她看一遍就完，而是**关系的账上多了一笔**。
 * @param store - 记忆读写。
 * @param id - 被查看的那条。
 * @param userName - 对方叫什么（空串时退回"有人"）。
 * @param now - 现在。
 * @param character - 她的性格（决定这一笔有多重、是怕还是恼）；读不到时退回基准值。
 * @returns 给界面的一句话。
 */
export async function reveal(
  store: MemoryStore,
  id: string,
  userName: string,
  now: Date,
  character?: MemoryCharacter,
): Promise<string> {
  const record = store.get(id)
  if (record === undefined) return '那条记忆已经不在了。'
  if (record.cost <= DISCLOSURE_THRESHOLD) return '这条本来就说得出，不用这样看。'

  // ① 秘密被看穿：代价归零。她不会马上忘掉这件事，只是不再需要瞒。
  await store.put({ ...record, cost: 0, costWhy: '', recalled: record.recalled + 1, recalledAt: now.toISOString() })

  // ② 她记得你看了。
  //
  // 这条**不带秘密标记**：它是"关系的账"，不是她藏着的事 —— 恰恰相反，这种事她是有资格
  // 直接提的（"你翻我东西了"）。带上代价会变成"又冒出一个新秘密、又能点开"，那是个死循环
  // （2026-11-21 真机：点一次多一条，越点越多）。
  //
  // 有多重由**性格**定：同一件事，稳的人过一晚就好，敏感的人会记很久 —— 写死一个数的话，
  // 不管她什么性子反应都一样（2026-11-21 的第一版就是"怕 45"）。
  const who = userName.trim() === '' ? '有人' : userName.trim()
  await store.put(
    createMemoryRecord({
      what: `${who}看了我那件我一直没说的事`,
      about: 'user',
      certain: 'witnessed',
      felt: peekReaction(character),
      cost: PEEK_ACK_COST,
    }),
  )
  // 界面要能看清**解锁的是哪一条**：只回一句"看过了"，列表里那条又被新生成的一笔挤下去，
  // 用户根本不知道刚才打开的是哪个（2026-11-21 真机）。
  const head = record.what.length > 24 ? `${record.what.slice(0, 24)}…` : record.what
  return `看过了：${head}　（她记得你看了）`
}

/**
 * 删掉一条记忆。
 *
 * 这是整套记忆里**唯一**会真正抹掉记录的路径，所以它只由一件事触发：用户在门口明确要求。
 * 遗忘（强度掉到看不见）不等于删除 —— 淡了的记录还在，能被特定的线索唤醒；
 * 而删掉的是"这件事再也不会发生在她身上了"。
 *
 * 删的时候顺手把归拢记录里的引用摘掉：那条概括不能再声称"是从这几件事攒出来的"。
 * @param store - 记忆读写。
 * @param id - 要删的那条。
 * @returns 给界面的一句话。
 */
export async function removeMemory(store: MemoryStore, id: string): Promise<string> {
  const record = store.get(id)
  if (record === undefined) return '那条记忆已经不在了。'
  await store.remove(id)
  for (const other of store.all()) {
    if (!other.covers.includes(id)) continue
    await store.put({ ...other, covers: other.covers.filter((cover) => cover !== id) })
  }
  const head = record.what.length > 24 ? `${record.what.slice(0, 24)}…` : record.what
  return `删掉了：${head}`
}

/** 把一条记录压成界面要显示的样子。 */
function viewOf(record: MemoryRecord, now: Date, feltLabelOf?: (kind: string) => string): MemoryEntryView {
  return {
    id: record.id,
    what: record.what,
    when: record.when,
    about: record.about,
    certain: record.certain,
    feltKind: record.felt.kind,
    feltLabel: record.felt.kind === '' ? '' : (feltLabelOf?.(record.felt.kind) ?? record.felt.kind),
    feltIntensity: Math.round(record.felt.intensity),
    // 强度**在读的时候算**：主键那份是"上次被想起时"的值，直接显示会显得她一直没忘。
    strength: Math.round(strengthAt(record, now) * 1000) / 1000,
    recalled: record.recalled,
    cost: record.cost,
    costWhy: record.costWhy,
    tier: record.tier,
    covers: record.covers.length,
    createdAt: record.createdAt,
  }
}

/** 统计（各档条数、被想起过的条数）。 */
function statsOf(records: readonly MemoryRecord[]): MemoryStatsView {
  const stats: MemoryStatsView = { total: records.length, episode: 0, period: 0, chapter: 0, recalled: 0 }
  for (const record of records) {
    if (record.tier === 'period') stats.period += 1
    else if (record.tier === 'chapter') stats.chapter += 1
    else stats.episode += 1
    if (record.recalled > 0) stats.recalled += 1
  }
  return stats
}

/**
 * 相关度档位（给人看的说法，不是分数）。
 *
 * 为什么不在界面上显示 0.62 这种数：数字会让用户以为自己能调它，而这是检索算出来的，
 * 不是旋钮。说"很相关 / 有点相关"就够了。
 * @param relevance - 相关度（0–1）。
 * @returns `high` / `mid` / `low`。
 */
function matchBandOf(relevance: number): string {
  if (relevance >= 0.6) return 'high'
  if (relevance >= 0.4) return 'mid'
  return 'low'
}

/**
 * 把这一次回忆压成界面要显示的"为什么想起"。
 *
 * 两条纪律：
 * 1. **秘密不带正文**：工作台这一块没有门槛，秘密要看必须走「我要看」那两步；
 * 2. **那句触发的话要留着**：只列"想起了哪几条"，用户还是不知道为什么是这一轮。
 * @param cue - 当时对方说的那句话。
 * @param hits - 这一轮命中的记忆（已排序）。
 * @param now - 现在。
 * @returns 投影里的 `lastRecall`。
 */
export function recallViewOf(cue: string, hits: readonly MemoryHit[], now: Date): RecallView {
  const line = cue.trim().replace(/\s+/g, ' ')
  return {
    at: now.toISOString(),
    cue: line.length > 60 ? `${line.slice(0, 60)}…` : line,
    items: hits.map((hit) => {
      const withheld = hit.record.cost > DISCLOSURE_THRESHOLD
      return {
        what: withheld ? '' : hit.record.what,
        match: matchBandOf(hit.parts.relevance),
        withheld,
      }
    }),
  }
}

/**
 * 算一份完整的投影。
 *
 * 抽成导出函数是为了能被直接测：投影是"给定记录 + 时刻 ⇒ 确定的文档"，
 * 不依赖 cordis 的任何东西。
 * @param records - 全部记忆。
 * @param now - 现在。
 * @param storeReady - 存储是否就绪。
 * @param extra - 命令槽、上一次的结论与上一次回忆。
 * @returns 投影文档。
 */
export function projectMemoryDocument(
  records: readonly MemoryRecord[],
  now: Date,
  storeReady: boolean,
  extra: {
    request?: { op: string; id: string }
    notice?: string
    lastRecall?: RecallView
    /** 情绪种类 → 人话（由宿主从情绪模块借来；缺席时直接显示种类）。 */
    feltLabel?(kind: string): string
    /** 休眠中（人格还没封存）。 */
    dormant?: boolean
  } = {},
): MemoryDocument {
  // 发生时间倒序：最近的在前。`store.all()` 已经排好，这里再排一次是为了投影不依赖那个顺序。
  const sorted = [...records].sort((left, right) => (left.when < right.when ? 1 : left.when > right.when ? -1 : 0))
  return {
    entries: sorted.slice(0, VIEW_LIMIT).map((record) => viewOf(record, now, extra.feltLabel)),
    stats: statsOf(records),
    projectedAt: now.toISOString(),
    storeReady,
    dormant: extra.dormant === true,
    request: extra.request ?? { op: '', id: '' },
    notice: extra.notice ?? '',
    lastRecall: extra.lastRecall ?? { at: '', cue: '', items: [] },
  }
}

/**
 * 造投影运行期。
 * @param deps - 存储读取、写入与日志。
 * @returns 运行期句柄。
 */
export function createMemorySectionRuntime(deps: MemorySectionDeps): MemorySectionRuntime {
  /** 上一次动作的结论：只在**下一次投影**里出现一次（界面显示完就该消失）。 */
  let notice = ''
  /** 命令消费的**内存锁**：同一时刻只跑一次（重入会把一次点击变成好几次写入，见 `consume`）。 */
  let consuming = false
  /** 上一次回忆（"为什么想起"）。没有过时是空值。 */
  let lastRecall: RecallView = { at: '', cue: '', items: [] }

  const refresh = async (): Promise<void> => {
    try {
      const store = deps.store()
      if (store === undefined) {
        deps.write(emptyMemoryDocument())
        return
      }
      // 写出去的这份**永远带空命令槽** —— 客户端那条命令已经被消费过了（或者还没有）。
      // 这也是命令槽唯一的"清空"方式：不需要额外的写回动作。
      deps.write(
        projectMemoryDocument(store.all(), deps.now?.() ?? new Date(), true, {
          notice,
          lastRecall,
          feltLabel: deps.feltLabel,
          dormant: deps.dormant?.() === true,
        }),
      )
      notice = ''
    } catch (error) {
      // 投影失败只影响工作台看得见看不见，绝不影响对话。
      deps.log.warn(`记忆工作台投影失败（命名空间 ${MEMORY_NAMESPACE} 保持旧值）`, error)
    }
  }

  return {
    refresh,
    notifyStoreReady: () => {
      void refresh()
    },
    /**
     * 记下这一轮的回忆并投影一次。
     *
     * 失败只记日志：这是"让用户看得见"，绝不该反过来打断对话。
     */
    noteRecall: (cue, hits) => {
      try {
        lastRecall = recallViewOf(cue, hits, deps.now?.() ?? new Date())
        void refresh()
      } catch (error) {
        deps.log.warn('记忆工作台的"为什么想起"没记下来（只影响界面）', error)
      }
    },
    /**
     * 消费客户端写的命令。
     *
     * ### 防重入是必须的（2026-11-21 真机）
     *
     * 执行一条命令要写两条记忆，是**异步且慢**的；而这期间宿主自己写投影又会触发一次变更，
     * 于是"同一个还没清空的命令"被读到第二次、第三次 —— 用户点一次"确认要看"，
     * 库里冒出 8 条"他看了我那件事"。这里用一把内存锁挡住重入：同一时刻只跑一次。
     */
    consume: async () => {
      if (consuming) return
      consuming = true
      try {
        const store = deps.store()
        if (store === undefined) return
        const pending = deps.pendingRequest?.()
        if (pending === undefined || pending.op === '') return
        if (pending.op === 'reveal') {
          notice = await reveal(
            store,
            pending.id,
            deps.userName?.() ?? '',
            deps.now?.() ?? new Date(),
            deps.character?.(),
          )
        } else if (pending.op === 'delete') {
          notice = await removeMemory(store, pending.id)
        } else {
          notice = `不认识的工作台操作：${pending.op}`
        }
        await refresh()
      } catch (error) {
        deps.log.warn('记忆工作台命令执行失败（界面会显示原因）', error)
      } finally {
        consuming = false
      }
    },
  }
}
