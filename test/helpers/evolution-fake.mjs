/**
 * 自进化测试共用的**假表与假存储**（Map 实现，签名与 `evolution/types.ts` 的窄接口一致）。
 *
 * 与 `memory-fake.mjs` 同一取舍：单元层钉 CRUD/裁剪/状态机语义，落盘与旧文件兼容
 * 由 `host-store-migration.test.mjs` 用真实后端覆盖，两层不互相冒充。
 */
import { createEvolutionState } from '../../lib/evolution/state.js'

/**
 * 造一张 Map 假表（update 与官方**同语义：记录不存在就抛** —— 见下面的说明）。
 *
 * ⚠️ 2026-10-05 修（0.1.9，缺陷成因之一）：旧实现写成"缺失即补建"，注释还自称"与官方同语义"。
 * **其实相反**：官方 `dsh-storage-domain` 的 `update` 在记录缺失时抛
 * `… table '<t>' has no record '<k>' to update`（README 里叫 `missing-key`）。
 * 于是一个真实存在、且**已在生产上连坏 12 轮**的缺陷（全库只有 `update` 没有 `put`
 * ⇒ `evolution_state` 表从来没被创建）在单测里**结构上不可能**被发现 —— 替身替它把记录建好了。
 * 现在与真后端对齐：**缺失即抛**。修 `lib/evolution/state.js` 的 `mutateState`（先 ensure 再 update）
 * 之后，所有依赖"首次写入"的用例会重新变绿。
 */
export function createFakeTable(seed = []) {
  const records = new Map(seed)
  return {
    records,
    get: (key) => records.get(key),
    entries: () => records.entries(),
    put: async (key, value) => {
      records.set(key, value)
    },
    delete: async (key) => records.delete(key),
    update: async (key, fn) => {
      if (!records.has(key)) {
        throw new Error(`domain 'test' table 'fake' has no record '${key}' to update`)
      }
      const next = fn(records.get(key))
      records.set(key, next)
      return next
    },
  }
}

/** 造一套四表齐备的自进化存储入口（含底层假表引用，便于断言）。 */
export function fakeEvolutionState() {
  const tables = {
    runs: createFakeTable(),
    proposals: createFakeTable(),
    cursors: createFakeTable(),
    state: createFakeTable(),
  }
  return { tables, state: createEvolutionState(tables) }
}

/** 应用会话过滤器子集（AND；列表值 OR；范围含端点——与官方语义一致）。 */
function applySessionFilters(sessions, filters) {
  return sessions.filter((record) =>
    filters.every((filter) => {
      const header = record.header
      if (filter.kind === 'created-at') {
        if (filter.from !== undefined && header.createdAt < filter.from) return false
        if (filter.to !== undefined && header.createdAt > filter.to) return false
        return true
      }
      if (filter.kind === 'cwd') return filter.values.includes(header.cwd ?? null)
      if (filter.kind === 'id') return filter.values.includes(header.id)
      throw new Error(`测试假件不认识过滤器 ${filter.kind}`)
    }),
  )
}

/** 应用事件过滤器子集。 */
function applyEventFilters(events, filters) {
  return events.filter((event) =>
    filters.every((filter) => {
      if (filter.kind === 'seq') {
        if (filter.from !== undefined && event.seq < filter.from) return false
        if (filter.to !== undefined && event.seq > filter.to) return false
        return true
      }
      if (filter.kind === 'surface') return filter.values.includes(event.surface)
      throw new Error(`测试假件不认识过滤器 ${filter.kind}`)
    }),
  )
}

/**
 * 造一个实现了过滤语义的假 sessionQuery（含调用记录，用于断言契约）。
 * @param sessions - 会话记录数组。
 * @param eventsBySession - 会话 id → 语义事件数组。
 */
export function fakeSessionQuery(sessions, eventsBySession) {
  return {
    calls: [],
    async filterSessions(filters) {
      this.calls.push({ method: 'filterSessions', filters })
      return applySessionFilters(sessions, filters)
    },
    async filterEvents(sessionId, filters) {
      this.calls.push({ method: 'filterEvents', sessionId, filters })
      return applyEventFilters(eventsBySession[sessionId] ?? [], filters)
    },
  }
}

/** 造会话记录（createdAt 可控；子会话标记按需给）。 */
export function fakeSession(id, createdAt, extra = {}) {
  return { header: { id, createdAt, ...extra }, live: false, persisted: true }
}

/** 造语义事件。 */
export function fakeEvent(sessionId, seq, type = 'user/message', text = 'hi') {
  return { sessionId, seq, type, time: 0, surface: 'current', text }
}

/** 造一个"已打开的套件存储"替身（记忆表 + 自进化四表；供宿主线测试用）。 */
export function fakeHumanityStoreWithEvolution(memorySeed = []) {
  const memory = createFakeTable(memorySeed)
  const { tables, state } = fakeEvolutionState()
  return {
    memory,
    tables,
    evolution: state,
    humanity: {
      installedAt: '2026-01-01T00:00:00.000Z',
      memory,
      evolution: tables,
      recordHistory: async () => {},
      historyCount: () => 0,
      close: async () => {},
    },
  }
}
