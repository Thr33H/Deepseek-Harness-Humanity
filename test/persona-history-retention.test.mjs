/**
 * 人格历史**保留期**的测试（0.1.13 返工点 2；用户 2026-10-09）。
 *
 * 需求原话：「删除的进历史，要有个**保留天数**，而不是永久保留」。三条要钉死的：
 * 1. **超期记录被清掉**（有机械判据，不是"应该会清"）；
 * 2. **未到期的必须保留**（阴性对照：清理不能顺手把新记录也扫了）；
 * 3. **清理范围要窄**：只动 `persona_history`，记忆条目 / 提案 / 人格本体一个字都不能少。
 *
 * 这里从 `openDomain`（真实打开路径）进入，而不是给 `pruneHistory` 喂一个桩：
 * "只删历史表"这件事只有走真实句柄才证得了。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createLog } from '../lib/log.js'
import { Config } from '../lib/index.js'
import { createWriteSweeper, historyCutoff, pruneHistoryByRetention } from '../lib/persona/history-retention.js'
import { MEMORY_TABLE } from '../lib/memory/constants.js'
import { HISTORY_TABLE, PERSONA_DATA_SCHEMA_VERSION } from '../lib/store-schema.js'
import { openDomain } from '../lib/store-open.js'

/** 日志门面（与其它存储用例同一口径：真 ctx + 降级日志，不 mock 日志本身）。 */
const bareLog = () => createLog(new Context())

const DAY = 24 * 60 * 60 * 1000
/** 钉住"现在"：所有用例都相对这个时刻算，跑到哪天结论都一样。 */
const NOW = new Date('2026-10-09T12:00:00.000Z')
const ago = (days) => new Date(NOW.getTime() - days * DAY).toISOString()

/** 一条历史记录（形状与 `PersonaHistorySchema` 一致）。 */
const historyRow = (at, path = 'mutableLayer.sections.经验教训', previous = '别在深夜做决定') => ({
  at,
  source: 'user',
  path,
  previous,
  reason: 'superseded',
})

/**
 * 造一个**够用的**存储领域设施替身：表句柄带 `put` / `size` / `entries` / `delete`
 * （比 `host-store.test.mjs` 那个多后两个 —— 这次要真的遍历与删除）。
 * @param seed - 各表的初始记录 `{ 表名: [[键, 值], …] }`。
 */
function createFacility(seed = {}) {
  const tables = new Map()
  const tableOf = (name) => {
    if (!tables.has(name)) tables.set(name, new Map())
    return tables.get(name)
  }
  for (const [name, rows] of Object.entries(seed)) {
    const table = tableOf(name)
    for (const [key, value] of rows) table.set(key, value)
  }

  return {
    tables,
    rows: (name) => [...tableOf(name).values()],
    size: (name) => tableOf(name).size,
    facility: {
      async open() {
        return {
          global: {
            get: () => ({ installedAt: '2026-09-01T00:00:00.000Z', schemaVersion: PERSONA_DATA_SCHEMA_VERSION }),
            set: async () => {},
          },
          table: (name) => {
            const records = tableOf(name)
            return {
              put: async (key, record) => {
                records.set(key, record)
              },
              get size() {
                return records.size
              },
              entries: () => records.entries(),
              delete: async (key) => {
                records.delete(key)
              },
            }
          },
          close: async () => {},
        }
      },
    },
  }
}

/** 打开一个装好种子的领域。 */
async function bootDomain(seed) {
  const fake = createFacility(seed)
  const store = await openDomain(fake.facility, bareLog())
  assert.ok(store !== undefined, '领域应当能打开（替身设施的最小契约）')
  return { ...fake, store }
}

/* ───────────────────────── 截止时刻的算法 ───────────────────────── */

test('historyCutoff：30 天 ⇒ 截止时刻是"现在 − 30 天"；<=0 / 非法值 ⇒ 不清理（undefined）', () => {
  assert.equal(historyCutoff(30, NOW), ago(30))
  assert.equal(historyCutoff(1, NOW), ago(1))
  // 0 与负数 = 关闭清理（唯一的"永久保留"入口；负数按 0 处理，**不**解释成"立刻清空"）。
  assert.equal(historyCutoff(0, NOW), undefined)
  assert.equal(historyCutoff(-5, NOW), undefined)
  assert.equal(historyCutoff(Number.NaN, NOW), undefined)
  assert.equal(historyCutoff(Number.POSITIVE_INFINITY, NOW), undefined)
})

/* ───────────────────────── 真实打开路径：删历史、留其余 ───────────────────────── */

test('pruneHistory（真实领域句柄）：超期记录被删、未到期保留、**其它表一条不动**', async () => {
  const { store, rows, size } = await bootDomain({
    [HISTORY_TABLE]: [
      [`${ago(40)}#a`, historyRow(ago(40), 'mutableLayer.sections.经验教训', '四十天前的教训')],
      [`${ago(31)}#b`, historyRow(ago(31), 'mutableLayer.sections.经验教训', '三十一天前的教训')],
      [`${ago(30)}#c`, historyRow(ago(30), 'mutableLayer.sections.经验教训', '整三十天（边界）')],
      [`${ago(1)}#d`, historyRow(ago(1), 'mutableLayer.sections.经验教训', '昨天的教训')],
    ],
    // 这三张表是"绝不能被连带清掉"的对照组。
    [MEMORY_TABLE]: [['fp1', { text: '一条记忆' }], ['fp2', { text: '另一条记忆' }]],
    evolution_proposals: [['p1', { kind: 'persona' }]],
    documents: [['humanity-persona', { revision: 3 }]],
  })

  assert.equal(store.historyCount(), 4, '起点：四条历史')

  const removed = await store.pruneHistory(historyCutoff(30, NOW))

  assert.equal(removed, 2, '只有 40 天前与 31 天前那两条超期')
  const left = rows(HISTORY_TABLE).map((row) => row.previous)
  assert.deepEqual(left.sort(), ['昨天的教训', '整三十天（边界）'].sort(), '边界那条与昨天的都留着')
  // **阴性对照**：未到期的记录必须原样在。
  assert.equal(left.includes('昨天的教训'), true)
  assert.equal(left.includes('整三十天（边界）'), true, '边界判定是 at < cutoff（正好等于截止时刻的那条保留）')
  // **范围窄**：其它表逐张点数。
  assert.equal(size(MEMORY_TABLE), 2, '记忆条目一条不少')
  assert.equal(size('evolution_proposals'), 1, '提案一条不少')
  assert.equal(size('documents'), 1, '人格本体文档一条不少')
})

test('pruneHistory：能力缺失的句柄（无 entries/delete）⇒ 返回 0，不抛（最小设施也不该被清理弄崩）', async () => {
  const tables = new Map([[HISTORY_TABLE, new Map([[`${ago(99)}#x`, historyRow(ago(99))]])]])
  const minimal = {
    async open() {
      return {
        global: { get: () => ({ installedAt: '', schemaVersion: PERSONA_DATA_SCHEMA_VERSION }), set: async () => {} },
        table: (name) => {
          const records = tables.get(name) ?? new Map()
          tables.set(name, records)
          return { put: async (key, record) => records.set(key, record), get size() { return records.size } }
        },
        close: async () => {},
      }
    },
  }
  const store = await openDomain(minimal, bareLog())
  assert.ok(store !== undefined)
  assert.equal(await store.pruneHistory(historyCutoff(1, NOW)), 0, '没有能力就"这次不清"，绝不抛')
})

/* ───────────────────────── 保留期策略（含阴性对照）───────────────────────── */

test('pruneHistoryByRetention：30 天清掉 40 天前的、**留下** 3 天前的（阴性对照）', async () => {
  const { store, rows } = await bootDomain({
    [HISTORY_TABLE]: [
      [`${ago(40)}#old`, historyRow(ago(40), 'mutableLayer.sections.经验教训', '早该清的')],
      [`${ago(3)}#new`, historyRow(ago(3), 'mutableLayer.sections.经验教训', '刚删的，要留着')],
    ],
  })

  const removed = await pruneHistoryByRetention(store, 30, NOW, bareLog())

  assert.equal(removed, 1)
  assert.deepEqual(rows(HISTORY_TABLE).map((row) => row.previous), ['刚删的，要留着'])
})

test('pruneHistoryByRetention：保留期 0（关闭清理）⇒ 一条都不删；保留期 60 天 ⇒ 同理不动', async () => {
  const seed = {
    [HISTORY_TABLE]: [
      [`${ago(40)}#a`, historyRow(ago(40), 'mutableLayer.sections.经验教训', '四十天前')],
      [`${ago(90)}#b`, historyRow(ago(90), 'mutableLayer.sections.经验教训', '九十天前')],
    ],
  }
  const off = await bootDomain(seed)
  assert.equal(await pruneHistoryByRetention(off.store, 0, NOW, bareLog()), 0, '0 = 永久保留（不清理）')
  assert.equal(off.store.historyCount(), 2)

  const long = await bootDomain(seed)
  assert.equal(await pruneHistoryByRetention(long.store, 60, NOW, bareLog()), 1, '保留期 60 天：只有 90 天前那条超期')
  assert.deepEqual(
    long.rows(HISTORY_TABLE).map((row) => row.previous),
    ['四十天前'],
    '40 天前的仍在保留期内 ⇒ 必须留下（同一条规则的阴性对照）',
  )
})

test('pruneHistoryByRetention：存储侧抛错 ⇒ 返回 0 且不抛（清理是维护动作，不该影响任何写入）', async () => {
  const exploding = {
    pruneHistory: async () => {
      throw new Error('磁盘只读')
    },
  }
  assert.equal(await pruneHistoryByRetention(exploding, 30, NOW, bareLog()), 0)
})

/* ───────────────────────── 写入路径的触发时机 ───────────────────────── */

test('createWriteSweeper：同一批写入只清理一次；这一批跑完后下一批照常触发', async () => {
  let calls = 0
  const sweep = createWriteSweeper(async () => {
    calls += 1
    return 0
  })

  // 一次落盘里的 5 条历史记录（sink 被同步调用 5 次）。
  for (let i = 0; i < 5; i += 1) sweep()
  assert.equal(calls, 1, '同一批只扫一遍表')

  await new Promise((resolve) => setImmediate(resolve))
  sweep()
  assert.equal(calls, 2, '下一批（清理已跑完）照常触发')
})

test('createWriteSweeper：清理函数抛错也会复位，不会把后续批次永久卡住', async () => {
  let calls = 0
  const sweep = createWriteSweeper(async () => {
    calls += 1
    throw new Error('boom')
  })
  sweep()
  await new Promise((resolve) => setImmediate(resolve))
  sweep()
  assert.equal(calls, 2, '失败不该让调度器永久停在"正在清理"')
})

/* ───────────────────────── 配置项（默认值真源）───────────────────────── */

test('配置：historyRetentionDays 默认 30、可覆盖、接受 0 与负数（0/负 = 永久保留）', () => {
  assert.equal(Config({}).modules.persona.historyRetentionDays, 30)
  assert.equal(Config({ modules: { persona: { historyRetentionDays: 7 } } }).modules.persona.historyRetentionDays, 7)
  assert.equal(Config({ modules: { persona: { historyRetentionDays: 0 } } }).modules.persona.historyRetentionDays, 0)
  assert.equal(Config({ modules: { persona: { historyRetentionDays: -1 } } }).modules.persona.historyRetentionDays, -1)
  // 非数字一律被 schema 拒绝（配置面不接受"看得懂但算不出来"的值）。
  assert.throws(() => Config({ modules: { persona: { historyRetentionDays: '三十天' } } }))
})
