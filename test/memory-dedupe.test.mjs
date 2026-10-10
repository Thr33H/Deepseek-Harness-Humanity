/**
 * 「清理重复条目」与「撤销上次合并」两条工作台命令的测试（`dedupe-ops.ts` + `ops.ts`）。
 *
 * 为什么单独一个文件、为什么正文用**同一件事的两种说法**：这是对用户数据的写操作，代价不对称——
 * 漏合只是库里多一条（现状即如此），误合是**丢信息**。所以这里钉的全是"不许发生的事"：
 * 矛盾不并、归档不并、语义不同不并、撤销要逐字段还原。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMemoryEntry } from '../lib/memory/model.js'
import { applyMemoryRequest } from '../lib/memory/ops.js'
import { resolveMemoryPolicy } from '../lib/memory/policy.js'
import { createMemoryStore } from '../lib/memory/store.js'
import { createFakeTable } from './helpers/memory-fake.mjs'

/** 合成夹具：同一件事的两种说法（Dice 0.944）。 */
const TWIN_A =
  '用户要求：不区分"线上/线下"，示例实例就是示例实例，配置与记录中不留线上线下分隔；' +
  '只有在用户明确说"线下改设定"时，才以商量规则的方式对话。'
const TWIN_B =
  '用户要求：不区分线上/线下，示例实例就是示例实例，配置与记录里不留线上线下分隔；' +
  '只有在用户明确说「线下改设定」时，才以商量规则的方式对话。'
/** 语义确实不同的一条（实测与上面只 0.083）。 */
const DISTINCT = '示例实例线剧情进度：相识于示例地点甲 → 示例居所 → 示例场所乙的示例房间。'

const POLICY = resolveMemoryPolicy('balanced')
const FIRST = '2026-09-25T14:40:13.204Z'
const SECOND = '2026-09-25T14:40:25.524Z'

/** 造一条记忆；只覆盖本用例关心的字段。 */
function entry(overrides = {}) {
  return createMemoryEntry({
    scope: 'long-term',
    content: TWIN_A,
    origin: 'agent-derived',
    sourceSessionId: 's1',
    tags: [],
    ownerId: '',
    sensitive: false,
    confidence: 0.6,
    status: 'active',
    ...overrides,
  })
}

/** 造一个装好条目的库。 */
function storeWith(entries) {
  const table = createFakeTable(entries.map((item) => [item.dedupeKey, item]))
  return createMemoryStore(table)
}

/** 发一条命令（工作台走的就是这条路径）。 */
function send(store, op, undo = {}) {
  return applyMemoryRequest(store, POLICY, { op, fingerprint: '' }, undo)
}

test('清理重复：同一条事实的两种说法并成一条，身份落最早那条并如实报告', async () => {
  const first = entry({ content: TWIN_A, createdAt: FIRST, useCount: 32 })
  const second = entry({ content: TWIN_B, createdAt: SECOND })
  const store = storeWith([second, first])

  const notice = await send(store, 'dedupe')

  assert.match(notice, /已合并 1 对/)
  assert.match(notice, /可以撤销/)
  assert.equal(store.list().length, 1)
  const survivor = store.list()[0]
  assert.equal(survivor.dedupeKey, first.dedupeKey, '身份落在先来的那条')
  assert.equal(survivor.createdAt, FIRST, '创建时间不许漂')
  assert.equal(survivor.useCount, 32, '使用次数不许漂')
})

test('清理重复：没有重复时零改动，如实说"没有发现"（不假装做了事）', async () => {
  const store = storeWith([entry({ content: DISTINCT, createdAt: FIRST })])
  const before = store.list()

  const notice = await send(store, 'dedupe')

  assert.match(notice, /没有发现/)
  assert.deepEqual(store.list(), before)
})

test('清理重复：归档条目不参与，也不被并（动它只是删数据）', async () => {
  const archived = entry({ content: TWIN_A, status: 'archived', archivedAt: SECOND, createdAt: FIRST })
  const active = entry({ content: TWIN_B, createdAt: SECOND })
  const store = storeWith([archived, active])

  const notice = await send(store, 'dedupe')

  assert.match(notice, /没有发现/)
  assert.equal(store.list().length, 2)
})

test('清理重复：语义不同的各留各的（只有"同一件事的另一种说法"才并）', async () => {
  const store = storeWith([
    entry({ content: TWIN_A, createdAt: FIRST }),
    entry({ content: DISTINCT, createdAt: SECOND }),
  ])

  await send(store, 'dedupe')

  assert.equal(store.list().length, 2)
})

test('清理重复：相反的事实绝不并（"喜欢咖啡" vs "不喜欢咖啡"，Dice 高达 0.727）', async () => {
  const store = storeWith([
    entry({ content: '用户喜欢咖啡', createdAt: FIRST }),
    entry({ content: '用户不喜欢咖啡', createdAt: SECOND }),
  ])

  await send(store, 'dedupe')

  assert.equal(store.list().length, 2, '误合就是静默丢掉一方')
})

test('撤销：把库还原成合并前逐字段相同（含被并掉那条的正文）', async () => {
  const store = storeWith([
    entry({ content: TWIN_A, createdAt: FIRST, useCount: 32 }),
    entry({ content: TWIN_B, createdAt: SECOND }),
  ])
  const before = store.list()
  const undo = {}

  await send(store, 'dedupe', undo)
  assert.equal(store.list().length, 1, '先确认真的合并了')

  const notice = await send(store, 'undo-dedupe', undo)

  assert.match(notice, /已撤销/)
  assert.deepEqual(store.list(), before, '逐字段还原：正文、创建时间、使用次数一个都不许漂')
})

test('撤销：没有快照时给中性文案（重启后就是这种状态）', async () => {
  const store = storeWith([entry({ createdAt: FIRST })])
  const notice = await send(store, 'undo-dedupe', {})
  assert.match(notice, /没有可撤销的合并/)
})

test('撤销只能撤最近一次：撤过之后再撤没有内容（不做多级撤销）', async () => {
  const store = storeWith([
    entry({ content: TWIN_A, createdAt: FIRST }),
    entry({ content: TWIN_B, createdAt: SECOND }),
  ])
  const undo = {}

  await send(store, 'dedupe', undo)
  await send(store, 'undo-dedupe', undo)

  assert.match(await send(store, 'undo-dedupe', undo), /没有可撤销的合并/)
})
