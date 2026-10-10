/**
 * 衰减与归档（P-026）：**长期未用 + 低重要度**的记忆降权，降到阈值以下就归档，但**不删除**。
 *
 * ### 为什么不实时计算
 *
 * 每条记忆的"新鲜度"都能现算，但**改重要度**是一次写盘动作：如果在检索路径上顺手改，
 * 一次对话就会写好几条，而且会让"看到的结果"和"库里的内容"在同一个请求里不一致。
 * 所以衰减是一次**批量核算**，由外部在合适的时机调用（本插件不起定时器 —— 一个对话插件
 * 不该自己养一个后台定时任务）。
 *
 * ### 判定顺序（每一步都有决策依据）
 *
 * 1. 只处理 `active`（P-026：归档条目不再参与任何自动动作）；
 * 2. **受保护的不碰**：`pinned`（用户标记）、`confidence ≥ HIGH_CONFIDENCE_PROTECTED`（稳定事实）、
 *    `importance ≥ IMPORTANCE_PROTECTED`（重要）—— 这三类正是 P-026 点名"不衰减"的；
 * 3. 未用时长未达 `decayUnusedDays`（默认 90 天）⇒ 完全不衰减；
 * 4. 达到窗口后按半衰期降权：`next = floor(importance × 0.5^(超出天数 / 半衰期))`；
 * 5. `next < ARCHIVE_IMPORTANCE` ⇒ 先落盘降权后的分值，再 `archive`（归档入口只有这一个，
 *    步 2 定下的"状态变更只走 archive / restore"因此仍然成立）。
 *
 * 数据不删除：归档只是默认不参与检索（步 4 已按 `active` 过滤），用户可在工作台调回（`store.restore`）。
 * @module humanity/memory/decay
 */
import {
  ARCHIVE_IMPORTANCE,
  DECAY_CHECK_INTERVAL_HOURS,
  HIGH_CONFIDENCE_PROTECTED,
  IMPORTANCE_PROTECTED,
} from './constants.js'
import type { MemoryStore } from './store.js'
import type { MemoryEntry, MemoryPolicy } from './types.js'

/** 一次衰减核算的结果（给日志与工作台看："这次动了什么"）。 */
export interface DecayReport {
  /** 参与判定的生效条目数。 */
  scanned: number
  /** 被降权但保留下来的条目数。 */
  decayed: number
  /** 被归档的条目数。 */
  archived: number
  /** 因保护规则跳过（pinned / 稳定 / 重要）的条目数。 */
  protectedCount: number
  /**
   * 未到 `decayUnusedDays` 窗口而**未参与降权**的条目数（0.1.10 新增）。
   *
   * 为什么要单独一档：0.1.9 的报告只有 scanned/protected/decayed/archived，于是
   * 「扫了 98 条、一条都没动」这句话说不清是**都没到期**还是**都被保护**——
   * 自进化每轮把这份报告写进运行记录后，用户看到的必须能区分这两件事。
   */
  skippedFresh: number
}

/**
 * 上一次顺带核算的时刻（进程内）。衰减是**幂等**的，这个时间戳只是省算力：
 * 每轮对话都跑一遍全表核算既没必要，也会让"降权"在一个下午里反复发生。
 */
let lastSweepAt = ''

/**
 * 顺带核算：距上次超过 {@link DECAY_CHECK_INTERVAL_HOURS} 小时才真的跑一次。
 *
 * 给**检索路径**用：检索是高频动作，衰减是低频维护，所以这里"顺便看一眼时间"，
 * 到期才做全表核算。调用方**不要 await**（P-028 的注入路径不能被维护动作拖慢）；
 * 失败只吞掉（没有日志门面可用），因为下一次检索会再试一次。
 * @param store - 记忆读写入口。
 * @param policy - 当前生效策略。
 * @param now - 当前时刻（ISO 8601）。
 * @returns 本次是否真的跑了核算。
 */
export async function maybeRunDecay(store: MemoryStore, policy: MemoryPolicy, now: string): Promise<boolean> {
  if (!policy.decay) return false
  const elapsedMs = Date.parse(now) - Date.parse(lastSweepAt)
  if (lastSweepAt !== '' && Number.isFinite(elapsedMs) && elapsedMs < DECAY_CHECK_INTERVAL_HOURS * 3_600_000) {
    return false
  }
  lastSweepAt = now
  try {
    await runDecayCycle(store, policy, now)
  } catch {
    // 维护动作失败不该影响检索；把时间戳回退，让下一次检索再试。
    lastSweepAt = ''
  }
  return true
}

/** 仅供测试：清掉"上次核算时刻"，让下一次 {@link maybeRunDecay} 一定执行。 */
export function resetDecaySweepForTest(): void {
  lastSweepAt = ''
}

/** 空报告（策略关闭或没有可处理条目时）。 */
function emptyReport(): DecayReport {
  return { scanned: 0, decayed: 0, archived: 0, protectedCount: 0, skippedFresh: 0 }
}

/** 受保护的三类：用户标记、稳定事实、重要记忆（P-026）。 */
function isProtected(entry: MemoryEntry): boolean {
  return (
    entry.pinned ||
    entry.confidence >= HIGH_CONFIDENCE_PROTECTED ||
    entry.importance >= IMPORTANCE_PROTECTED
  )
}

/** 距离最近一次使用（没用过就看更新时刻）多少天。时间戳不可解析时按 0 处理（= 不衰减）。 */
function unusedDaysOf(entry: MemoryEntry, now: string): number {
  const stamp = entry.lastUsedAt === '' ? entry.updatedAt : entry.lastUsedAt
  const ageMs = Date.parse(now) - Date.parse(stamp)
  if (!Number.isFinite(ageMs)) return 0
  return Math.max(0, ageMs) / 86_400_000
}

/**
 * 衰减后的重要度。
 *
 * 注意从 `decayUnusedDays` **之后**才开始计时：窗口内是"还没到长期未用"，不是"衰减了 0 天"。
 * @param entry - 待衰减条目。
 * @param policy - 当前生效策略（提供窗口与半衰期）。
 * @param unusedDays - 已多久未用（天）。
 * @returns 新的重要度（0–当前值）。
 */
function decayedImportance(entry: MemoryEntry, policy: MemoryPolicy, unusedDays: number): number {
  const effectiveDays = Math.max(0, unusedDays - policy.decayUnusedDays)
  const factor = 0.5 ** (effectiveDays / policy.decayHalfLifeDays)
  return Math.max(0, Math.floor(entry.importance * factor))
}

/**
 * 跑一次衰减核算：降权 + 归档（不删除）。
 *
 * 幂等且可反复调用：已经降过的条目在下一轮不会重复降（除非又过了一个窗口），归档过的不再参与。
 * @param store - 记忆读写入口。
 * @param policy - 当前生效策略（`decay` 关闭时什么都不做）。
 * @param now - 当前时刻（ISO 8601）；缺省取现在 —— 显式传入时本函数是确定的，便于测试。
 * @returns 本次核算的报告。
 */
export async function runDecayCycle(
  store: MemoryStore,
  policy: MemoryPolicy,
  now: string = new Date().toISOString(),
): Promise<DecayReport> {
  const report = emptyReport()
  if (!policy.decay) return report

  for (const entry of store.list(undefined, 'active')) {
    report.scanned += 1
    if (isProtected(entry)) {
      report.protectedCount += 1
      continue
    }

    const unusedDays = unusedDaysOf(entry, now)
    if (unusedDays < policy.decayUnusedDays) {
      // 窗口内：如实记一档"未到期"（否则报告里看不出"扫了但都没动"的原因）。
      report.skippedFresh += 1
      continue
    }

    const next = decayedImportance(entry, policy, unusedDays)
    if (next >= entry.importance) continue

    // 先落下降权后的分值，再走归档入口 —— 归档记录因此带着降权后的分值，而不是原分值。
    await store.put({ ...entry, importance: next })
    if (next < ARCHIVE_IMPORTANCE) {
      await store.archive(entry.dedupeKey)
      report.archived += 1
      continue
    }
    report.decayed += 1
  }

  return report
}
