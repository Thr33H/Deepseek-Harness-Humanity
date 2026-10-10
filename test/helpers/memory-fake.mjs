/**
 * 记忆测试共用的**假表**（Map 实现，方法签名与领域窄接口一致）。
 *
 * 为什么放在 helpers 里：存储面与写入管线两套测试都需要它；各写一份的话，
 * 有一边改了签名、另一边没改，测试会以"某个字段莫名其妙 undefined"的形式失败。
 */
import { createMemoryStore } from '../../lib/memory/store.js'

/**
 * 造一张 Map 假表。
 * @param seed - 初始 `[键, 记录]` 列表。
 * @returns 假表（含 `records` 以便断言落盘内容）。
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
  }
}

/**
 * 造一个"已打开的套件存储"替身（只含记忆表）。
 * @param seed - 初始记录。
 * @returns `{ table, store }`：底层假表与记忆读写入口。
 */
export function fakeHumanityStore(seed = []) {
  const table = createFakeTable(seed)
  return {
    table,
    store: createMemoryStore(table),
    humanity: {
      installedAt: '2026-01-01T00:00:00.000Z',
      memory: table,
      recordHistory: async () => {},
      historyCount: () => 0,
      close: async () => {},
    },
  }
}
