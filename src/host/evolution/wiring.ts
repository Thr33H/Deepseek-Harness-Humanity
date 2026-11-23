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

/**
 * 待确认事实：**只剩提案**。
 *
 * 2026-11-20：记忆侧的待确认区随记忆重构删除。那条路把"可能是模糊/敏感的信息"隔离起来
 * 等对方点头；新设计里这件事变成了 `cost`（说出来要付多大代价）——由**她自己**决定说不说，
 * 而不是排队等审核。所以这里不再需要跨模块汇合。
 */
export function pendingFacts(readState: () => EvolutionState | undefined): () => PendingFacts | undefined {
  return () => {
    const state = readState()
    if (state === undefined) return undefined
    return {
      proposalIds: () => state.listProposals('pending').map((record) => record.id),
      counts: () => state.countPending(),
    }
  }
}
