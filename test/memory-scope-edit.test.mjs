/**
 * 「改归属」命令的测试（`memory/ops.ts` 的 `rescope`；用户 2026-09-26 令）。
 *
 * 为什么这条命令值得单独钉：它一次要动对**三处** —— 指纹（`scope:正文`，改了作用域就换了键）、
 * 归属（区域的"户口"）、身份与使用统计（新键无从沿用，不显式带上就被清零）。
 * 少做一处就是脏数据：幽灵条目、飘掉的创建时间、或一条永远只在某个区域生效的记忆。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildDedupeKey, createMemoryEntry } from '../lib/memory/model.js'
import { applyMemoryRequest } from '../lib/memory/ops.js'
import { resolveMemoryPolicy } from '../lib/memory/policy.js'
import { createMemoryStore } from '../lib/memory/store.js'
import { createFakeTable } from './helpers/memory-fake.mjs'

const POLICY = resolveMemoryPolicy('balanced')
const CWD = '/home/user/project'
const CONTENT = '与「小梅」的修女角色扮演设定发生在教堂'

/** 造一条记忆。 */
function entry(overrides = {}) {
  return createMemoryEntry({
    scope: 'long-term',
    content: CONTENT,
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

/** 发一条改归属命令（工作台走的就是这条路径）。 */
function send(store, fingerprint, scope, ownerId) {
  return applyMemoryRequest(store, POLICY, { op: 'rescope', fingerprint, scope, ownerId })
}

test('长期 → 区域：指纹跟着作用域迁移，创建时间与使用次数原样保留', async () => {
  const first = { ...entry({ createdAt: '2026-09-25T12:00:00.000Z' }), useCount: 7, lastUsedAt: '2026-09-26T01:00:00.000Z' }
  const store = storeWith([first])

  const notice = await send(store, first.dedupeKey, 'workspace', CWD)

  assert.match(notice, /已改为「区域记忆」/)
  assert.equal(store.get(first.dedupeKey), undefined, '旧指纹必须消失（否则留下一条幽灵条目）')
  const moved = store.list()[0]
  assert.equal(moved.scope, 'workspace')
  assert.equal(moved.ownerId, CWD, '归属要落到用户选的那个区域')
  assert.equal(moved.dedupeKey, buildDedupeKey('workspace', CONTENT), '指纹随作用域重算')
  assert.equal(moved.createdAt, first.createdAt, '创建时间不许漂')
  assert.equal(moved.useCount, 7, '使用次数不许漂')
  assert.equal(moved.lastUsedAt, first.lastUsedAt)
})

test('区域 → 长期：归属清空（否则它会带着旧户口、永远只在那个区域生效）', async () => {
  const only = entry({ scope: 'workspace', ownerId: CWD })
  const store = storeWith([only])

  const notice = await send(store, only.dedupeKey, 'long-term', '')

  assert.match(notice, /已改为「长期记忆」/)
  const moved = store.list()[0]
  assert.equal(moved.scope, 'long-term')
  assert.equal(moved.ownerId, '', '长期记忆不归属任何区域')
})

test('目标归属已有同内容条目 ⇒ 如实拒绝，不合并也不覆盖', async () => {
  const long = entry({ createdAt: '2026-09-25T10:00:00.000Z' })
  const region = entry({ scope: 'workspace', ownerId: '/ws', createdAt: '2026-09-25T11:00:00.000Z' })
  const store = storeWith([long, region])

  const notice = await send(store, region.dedupeKey, 'long-term', '')

  assert.match(notice, /已经有一条内容相同的记忆/)
  assert.equal(store.list().length, 2, '两条都还在，一条都没被并掉')
})

test('只接受「长期/区域」两档；区域必须给出归属；不存在的条目与"没变化"都如实说', async () => {
  const only = entry()
  const store = storeWith([only])

  assert.match(await send(store, only.dedupeKey, 'session', ''), /只能改成/)
  assert.match(await send(store, only.dedupeKey, 'workspace', ''), /需要指定/)
  assert.match(await send(store, 'nope', 'long-term', ''), /已经不存在/)
  assert.match(await send(store, only.dedupeKey, 'long-term', ''), /没有改动/)
  assert.equal(store.list()[0].scope, 'long-term', '被拒的命令不许留下任何改动')
})
