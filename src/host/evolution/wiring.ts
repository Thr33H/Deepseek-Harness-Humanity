/**
 * 自进化模块的**接线读取器**（从 `index.ts` 拆出：那边回答"谁装配谁"，这里回答"事实从哪读"）。
 *
 * 三个读取器共享同一条纪律：现读不缓存、结构探测、缺席降级——
 * `ctx.get` 是快照语义（服务后挂载也读得到），探测缺方法就当缺席（宁可降级，不半信半疑地调用）。
 * @module humanity/evolution/wiring
 */
import type { Context } from '@deepseek-ai/cordis'

import type { MemoryStore } from '../memory/store.js'
import type { PendingFacts } from './notify.js'
import type { EvolutionState } from './state.js'
import { createEvolutionState } from './state.js'
import type { SessionQueryLike } from './types.js'
import type { EvolutionTables } from './state.js'

/** 存储面：套件存储就绪后包装出自进化存储入口；未就绪 `undefined`。 */
export function stateReader(store: () => { evolution: EvolutionTables } | undefined): () => EvolutionState | undefined {
  return () => {
    const opened = store()
    return opened === undefined ? undefined : createEvolutionState(opened.evolution)
  }
}

/** sessionQuery 的结构探测（缺任一方法就当缺席：扫描层整体降级）。 */
export function sessionQueryReader(ctx: Context): () => SessionQueryLike | undefined {
  return () => {
    const query = ctx.get('sessionQuery') as SessionQueryLike | undefined
    if (query === undefined || typeof query.filterSessions !== 'function' || typeof query.filterEvents !== 'function') {
      return undefined
    }
    return query
  }
}

/** 待确认事实（提案在自进化存储，记忆 pending 在记忆存储；两模块的计数在这里汇合）。 */
export function pendingFacts(
  readState: () => EvolutionState | undefined,
  memoryStore: () => MemoryStore | undefined,
): () => PendingFacts | undefined {
  return () => {
    const state = readState()
    if (state === undefined) return undefined
    const memoryPending = (): string[] => (memoryStore()?.list(undefined, 'pending') ?? []).map((entry) => entry.dedupeKey)
    return {
      proposalIds: () => state.listProposals('pending').map((record) => record.id),
      memoryFingerprints: memoryPending,
      counts: () => {
        const counts = state.countPending()
        const memory = memoryPending().length
        return { ...counts, memory, total: counts.total + memory }
      },
    }
  }
}
