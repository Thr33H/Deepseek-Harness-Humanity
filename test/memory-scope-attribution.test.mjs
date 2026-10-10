/**
 * 「区域记忆的归属」回归钉（2026-09-26 真机 bug）。
 *
 * **真机事实**：TEST 库里 29 条活跃记忆有 22 条是区域级，其中 2 条**归属为空**。
 * 根因是身份读取的字段路径写错——我们读 `agent.session.meta.cwd`，而**官方工具**读的是
 * `agent.session.header.cwd`（`dsh-tool-fs/lib/index.js:241` 的 `sessionCwd`）。
 * 测试此前用的是**同样错**的假对象（`session: { meta: { cwd } }`），所以一路全绿。
 *
 * 后果要说准（不夸大）：区域分只占 15%（`WEIGHTS.scope`），所以它不是"完全看不见"，
 * 而是**每一条区域记忆都白丢 0.15 分**、更容易被 0.35 的相关性阈值刷掉；
 * 归属本身为空的那 2 条更彻底——修好身份之后仍然拿不到这 0.15。
 *
 * 本文件钉四件事：
 * 1. 身份读官方路径；只有 meta 时回退；都没有就是空串（不猜）；
 * 2. 区域分只在归属与当前工作区一致时给满；
 * 3. 端到端：官方形状的 agent ⇒ 身份给出 cwd ⇒ 区域记忆拿到区域分（这个 bug 的两头）；
 * 4. 写区域记忆时没有归属 ⇒ **不写**（宁可不写、等补录；不降级为长期以免跨区泄露）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { memoryIdentityOf } from '../lib/memory/identity.js'
import { createMemoryEntry } from '../lib/memory/model.js'
import { resolveMemoryPolicy } from '../lib/memory/policy.js'
import { breakdownOf, WEIGHTS } from '../lib/memory/scoring.js'
import { createMemoryStore } from '../lib/memory/store.js'
import { tokenize } from '../lib/memory/tokenize.js'
import { remember } from '../lib/memory/write.js'
import { createFakeTable } from './helpers/memory-fake.mjs'

const POLICY = resolveMemoryPolicy('balanced')
const CWD = '/home/user/project'
const NOW = '2026-09-26T00:00:00.000Z'

/** 造一条区域记忆（归属 = 指定的工作目录）。 */
function regionEntry(ownerId) {
  return createMemoryEntry({
    scope: 'workspace',
    content: '与「小梅」的修女角色扮演设定发生在教堂',
    origin: 'user-stated',
    sourceSessionId: 's1',
    tags: [],
    ownerId,
    sensitive: false,
    confidence: 0.6,
    status: 'active',
  })
}

test('身份：工作目录读 session.header.cwd（与官方工具同一路径）；只有 meta 时回退；都无则空串', () => {
  assert.deepEqual(memoryIdentityOf({ id: 's1', session: { header: { cwd: CWD } } }), {
    sessionId: 's1',
    workspaceId: CWD,
  })
  assert.equal(
    memoryIdentityOf({ id: 's1', session: { meta: { cwd: '/legacy' } } }).workspaceId,
    '/legacy',
    '旧形状作为回退仍可用',
  )
  assert.equal(memoryIdentityOf({ id: 's1', session: {} }).workspaceId, '', '读不到就是空串，不许猜')
  assert.equal(memoryIdentityOf(undefined).sessionId, '')
})

test('区域分：只在归属与当前工作区一致时给满；空归属与别的工作区都是 0', () => {
  const entry = regionEntry(CWD)
  const parts = (workspaceId) =>
    breakdownOf({ entry, queryTokens: tokenize('小梅'), context: { sessionId: 's1', workspaceId }, now: NOW })
  assert.equal(parts(CWD).scope, WEIGHTS.scope, '归属一致 ⇒ 满额区域分')
  assert.equal(parts('').scope, 0, '没有工作区上下文 ⇒ 区域记忆白丢这 0.15')
  assert.equal(parts('/other/place').scope, 0, '别的工作区 ⇒ 0（这条也保证不跨区泄露）')

  const orphan = regionEntry('')
  const orphanParts = breakdownOf({
    entry: orphan,
    queryTokens: tokenize('小梅'),
    context: { sessionId: 's1', workspaceId: CWD },
    now: NOW,
  })
  assert.equal(orphanParts.scope, 0, '归属为空的条目：修好身份也救不回来（所以那种记录该删、该防）')
})

test('端到端：官方形状的 agent ⇒ 身份给出 cwd ⇒ 区域记忆拿到区域分（这个 bug 的两头）', () => {
  const identity = memoryIdentityOf({ id: 's1', session: { header: { cwd: CWD } } })
  const parts = breakdownOf({
    entry: regionEntry(CWD),
    queryTokens: tokenize('小梅'),
    context: { sessionId: identity.sessionId, workspaceId: identity.workspaceId },
    now: NOW,
  })
  assert.equal(parts.scope, WEIGHTS.scope, '身份读对了，区域记忆才吃得到这 0.15')
})

test('写入防线：区域记忆读不到工作目录 ⇒ 不写（一条永远匹配不上的记录不该入库）', async () => {
  const store = createMemoryStore(createFakeTable())
  const result = await remember(store, POLICY, {
    content: '示例实例线剧情进度：相识于示例地点甲',
    scope: 'workspace',
    sensitivity: 'normal',
    origin: 'user-stated',
    sessionId: 's1',
    workspaceId: '',
  })
  assert.equal(result.ok, false)
  assert.match(result.message, /读不到会话的工作目录/)
  assert.match(result.message, /下次在会话里再说一次/, '要告诉模型/用户怎么补救')
  assert.deepEqual(store.list(), [], '没写就是没写')
})

test('写入正常路径：有归属 ⇒ 落盘，ownerId 就是那个工作目录', async () => {
  const store = createMemoryStore(createFakeTable())
  const result = await remember(store, POLICY, {
    content: '与「小梅」的修女角色扮演设定发生在教堂',
    scope: 'workspace',
    sensitivity: 'normal',
    origin: 'user-stated',
    sessionId: 's1',
    workspaceId: CWD,
  })
  assert.equal(result.ok, true)
  assert.equal(store.list()[0].ownerId, CWD)
})
