/**
 * `persona_history` 的**保留期策略**：算截止时刻、按截止时刻清理超期记录。
 *
 * 为什么单独一个文件：这是**数据生命周期**（"什么时候可以删"），与"写历史"（`persist.ts`：
 * 每次落盘把被取代的旧内容交出去）是两件事。混在一起时，改保留策略要翻落盘路径，
 * 而那条路径上有校验、历史、并发修订号三件事。
 *
 * ### 用户 2026-10-09 的要求（0.1.13 返工）
 *
 * 「删除的进历史，要有个**保留天数**，而不是永久保留」。所以 P-009 的"历史不删除"按
 * **保留期**收窄为：**保留期内不删，超期才删**。保留天数由
 * `modules.persona.historyRetentionDays` 配置（默认 {@link HISTORY_RETENTION_DAYS}）。
 *
 * ### 三条纪律
 *
 * 1. **`<= 0` = 关闭清理**（永久保留）。这是唯一的"永久保留"入口，必须显式设置；
 *    负数是非法输入，按 0 处理 —— **不**解释成"立刻清空"：误配一个负号就把用户的历史全删掉，
 *    是最坏的方向（宁可留多了，不可误删）。
 * 2. **只动 `persona_history`**：记忆条目、提案、人格本体一个字都不碰（清理范围窄到表级，
 *    判据见 `store-schema.ts` 的 `pruneHistory` —— 它只拿到历史表句柄）。
 * 3. **永不抛**：这条路径挂在落盘之后 / 启动之后，抛出去要么变成未处理的 rejection，
 *    要么影响一次已经成功的保存。清理失败只记一行日志。
 *
 * ### 清理时机（三处，都是"顺带"，不引入定时器）
 *
 * - **落盘之后**：一次写入可能产生多条历史记录，写完**只清理一次**（同一批内的重复调用被合并，
 *   见 `persona/index.ts` 的 sink）；
 * - **存储就绪时**：启动后立刻清一次，避免"长期没人改人格 ⇒ 旧记录永远留着"；
 * - **配置变更时**：保留天数被调小时立刻生效，不必等到下一次写入。
 * @module humanity/persona/history-retention
 */
import type { Log } from '../log.js'
import type { HumanityStore } from '../store.js'

/** 一天的毫秒数。 */
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 算出"这条时刻之前的记录都超期了"的截止时刻。
 *
 * 用 `at < cutoff` 判定（严格小于）：正好落在边界上的那条**保留** —— 边界语义只选一种并写死，
 * 免得"到期当天算不算"变成每次读代码都要重新推一遍的问题。
 * @param retentionDays - 保留天数；`<= 0`（含负数与非有限数）表示**不清理**。
 * @param now - 当前时刻。
 * @returns ISO 截止时刻；不需要清理时返回 `undefined`。
 */
export function historyCutoff(retentionDays: number, now: Date): string | undefined {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return undefined
  return new Date(now.getTime() - retentionDays * DAY_MS).toISOString()
}

/**
 * 造一个**"一批只清理一次"**的调度器（写入路径用）。
 *
 * 为什么需要它：一次落盘会产生**多条**历史记录（每条被取代的旧内容一条），而 sink 是被
 * **同步**逐条调用的。有了这个调度器，同一批里的后续调用只会看到"已经在清理"而直接返回 ——
 * 于是**一批写只扫一遍表**；清理跑完自动复位，下一批照常触发。
 *
 * 三条细节都是有意为之：
 * - 置位是**同步**的（在返回前就 `running = true`），否则同一批的并发调用会各扫一遍；
 * - 复位走 `then(done, done)` 而不是 `finally`：`finally` 会把拒绝**继续抛出去**，
 *   在 `void` 调用点上就是一条未处理的 rejection。清理失败只该"这一批没清成"；
 * - 返回 `void`：调用点在 sink 里，没有等待的语义（清理是维护动作，不阻塞保存）。
 * @param prune - 实际执行清理的函数（约定永不抛；抛了也只当作这一批没清成）。
 * @returns 触发函数：同一批内重复调用只生效一次。
 */
export function createWriteSweeper(prune: () => Promise<number>): () => void {
  let running = false
  return () => {
    if (running) return
    running = true
    const done = (): void => {
      running = false
    }
    prune().then(done, done)
  }
}

/**
 * 按保留期清理超期的历史记录。
 *
 * @param store - 已就绪的存储句柄（未就绪时调用方不该调到这里）。
 * @param retentionDays - 保留天数（语义见 {@link historyCutoff}）。
 * @param now - 当前时刻（注入而不是内部取 `Date.now()`，测试才能钉住边界）。
 * @param log - 日志门面。
 * @returns 实际删除的条数（关闭清理时为 0）；**任何失败都返回 0 并记日志，绝不抛**。
 */
export async function pruneHistoryByRetention(
  store: HumanityStore,
  retentionDays: number,
  now: Date,
  log: Log,
): Promise<number> {
  const cutoff = historyCutoff(retentionDays, now)
  if (cutoff === undefined) return 0

  try {
    const removed = await store.pruneHistory(cutoff)
    if (removed > 0) {
      log.info(
        `人格历史清理：删掉 ${removed} 条超过保留期（${retentionDays} 天）的记录` +
          `（判定：at < ${cutoff}；只动 persona_history 表）。`,
      )
    }
    return removed
  } catch (error) {
    log.warn('人格历史清理失败（记录保留，不影响任何写入）', error)
    return 0
  }
}
