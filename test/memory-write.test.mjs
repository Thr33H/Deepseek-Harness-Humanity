/**
 * 自动写入管线（`remember`）与待确认（`confirm` / `reject`）的行为测试。
 *
 * 用 Map 假表：这一层要钉的是**判断**（敏感进待确认、同指纹算更新、冲突只标记、策略关掉就不写），
 * 与"数据怎么落盘"无关 —— 落盘由 `host-store-migration.test.mjs` 用真实后端覆盖。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CONTENT_CHAR_LIMIT } from '../lib/memory/constants.js'
import { confirmPending, listPending, rejectPending } from '../lib/memory/confirm.js'
import { resolveMemoryPolicy } from '../lib/memory/policy.js'
import { createMemoryStore } from '../lib/memory/store.js'
import { normalizeMemoryContent, remember } from '../lib/memory/write.js'
import { createFakeTable } from './helpers/memory-fake.mjs'

/** 平衡模式的默认策略（正常写入的基线）。 */
const balanced = resolveMemoryPolicy('balanced')

/** 一次最小写入请求；`overrides` 用来钉具体字段。 */
function request(content, overrides = {}) {
  return { content, scope: 'long-term', sensitivity: 'normal', origin: 'user-stated', sessionId: 's1', ...overrides }
}

/** 起一个空存储。 */
function boot() {
  return createMemoryStore(createFakeTable())
}

test('普通内容直接生效（低风险稳定信息自动写入，P-025）', async () => {
  const store = boot()
  const result = await remember(store, balanced, request('用户偏好简短回复', { tags: ['偏好'] }))

  assert.equal(result.ok, true)
  assert.equal(result.entry?.status, 'active')
  assert.equal(result.entry?.sensitive, false)
  assert.equal(result.entry?.confidence, 1, '用户明确说出的记满分置信度')
  assert.deepEqual(result.entry?.tags, ['偏好'])
  assert.equal(store.get(result.entry.dedupeKey)?.content, '用户偏好简短回复')
})

test('敏感内容只进待确认：确认之前不参与检索与注入（P-033）', async () => {
  const store = boot()
  const result = await remember(store, balanced, request('用户的门禁密码', { sensitivity: 'sensitive' }))

  assert.equal(result.ok, true)
  assert.equal(result.entry?.status, 'pending')
  assert.equal(result.entry?.sensitive, true)
  assert.deepEqual(store.list(undefined, 'active'), [], '待确认不算生效')
  assert.equal(listPending(store).length, 1)
})

test('同指纹重复写入是更新，不重复新增，也不重置创建时间与使用统计', async () => {
  const store = boot()
  const first = await remember(store, balanced, request('用户偏好简短回复'))
  const used = await store.markUsed(first.entry.dedupeKey, '2026-09-24T00:00:00.000Z')
  assert.equal(used?.useCount, 1, '使用统计只能由"被用到"推进')

  const again = await remember(store, balanced, request('用户偏好简短回复！'))
  assert.equal(store.list().length, 1, '归一化后同一条事实只留一行')
  assert.equal(again.entry?.content, '用户偏好简短回复！', '内容以新写入为准')
  assert.equal(again.entry?.createdAt, first.entry?.createdAt)
  assert.equal(again.entry?.useCount, 1, '重新写一遍不等于被使用过')
  assert.equal(again.entry?.lastUsedAt, '2026-09-24T00:00:00.000Z')
})

test('待确认条目不会被后来的普通写入提升为生效', async () => {
  const store = boot()
  const sensitive = await remember(store, balanced, request('用户的门禁密码', { sensitivity: 'sensitive' }))

  const plain = await remember(store, balanced, request('用户的门禁密码'))
  assert.equal(plain.entry?.status, 'pending', '指纹相同 ⇒ 安全标记只能收紧，不能放松')
  assert.equal(plain.entry?.sensitive, true, '敏感标记不能被抹掉')
  assert.equal(store.get(sensitive.entry.dedupeKey)?.sensitive, true)
})

test('归档不许被悄悄复活：同一句话再写一遍，仍是归档状态、归档时间原样', async () => {
  // P-026：归档只影响默认检索，回不回来由用户决定。用户在卡片上点了「归档」，之后模型
  // 再"想起"同一句话就把它变回活跃 —— 那等于绕过用户。同指纹重写走的是 mergeSafety 那一档。
  const store = boot()
  const first = await remember(store, balanced, request('用户偏好简短回复'))
  const archived = await store.put({
    ...first.entry,
    status: 'archived',
    archivedAt: '2026-09-20T03:00:00.000Z',
  })

  const again = await remember(store, balanced, request('用户偏好简短回复'))
  assert.equal(again.entry?.status, 'archived', '重写不许把它变回生效')
  assert.equal(again.entry?.archivedAt, '2026-09-20T03:00:00.000Z', '归档时间不许被清空')
  assert.equal(store.get(archived.dedupeKey)?.status, 'archived')
  assert.deepEqual(store.list(undefined, 'active'), [], '归档条目不在生效清单里')
})

test('冲突检测：只标记、不阻断，双方都能看到（P-025）', async () => {
  const store = boot()
  await remember(store, balanced, request('用户喜欢咖啡'))
  const conflict = await remember(store, balanced, request('用户不喜欢咖啡'))

  assert.equal(conflict.ok, true, '矛盾内容照样写入：判断权在用户手里')
  assert.equal(conflict.conflicts.length, 1)
  assert.equal(conflict.entry?.conflictWith.length, 1, '新条目被标记')
  const other = store.get(conflict.conflicts[0].dedupeKey)
  assert.deepEqual(other?.conflictWith, [conflict.entry?.dedupeKey], '旧条目也被标记（双向）')
})

test('冲突标记可撤销：矛盾的来源归档后，重写一次就把幽灵标记拆掉', async () => {
  const store = boot()
  const first = await remember(store, balanced, request('用户喜欢咖啡'))
  const conflict = await remember(store, balanced, request('用户不喜欢咖啡'))

  // 归档其中一方：归档条目不再参与冲突判定（P-026：归档默认不参与检索）。
  await store.archive(first.entry.dedupeKey)
  const again = await remember(store, balanced, request('用户不喜欢咖啡'))

  assert.deepEqual(again.entry?.conflictWith, [], '候选自己的标记被重算清空')
  assert.deepEqual(store.get(first.entry.dedupeKey)?.conflictWith, [], '对方的幽灵标记必须拆掉')
  assert.equal(conflict.entry?.conflictWith.length, 1, '写入当时确实标记过（不是一开始就没标）')
})

test('跨作用域不算矛盾（各层各说各的）', async () => {
  const store = boot()
  await remember(store, balanced, request('这次用中文回答', { scope: 'session' }))
  const result = await remember(store, balanced, request('这次不用中文回答', { scope: 'long-term' }))

  assert.deepEqual(result.entry?.conflictWith, [])
})

test('会话归属隔离（P-024）：两个会话写同一句话各存各的，谁也不改谁的主人', async () => {
  // 2026-09-26 审计实测的真缺陷：`remember` 里先改了候选的指纹、再拿它跟备用键比（两边恒等），
  // 于是备用键从未生效 —— 会话 B 写同一句话会把会话 A 那条覆盖掉、主人也换成 B，
  // A 里再也检索不到自己说过的话，与 P-024「会话记忆不跨会话」直接矛盾。
  const store = boot()
  const session = { scope: 'session', sensitivity: 'normal', origin: 'user-stated' }
  const first = await remember(store, balanced, { ...session, content: '这次讨论用中文', sessionId: 's1' })
  const second = await remember(store, balanced, { ...session, content: '这次讨论用中文', sessionId: 's2' })

  assert.equal(store.list().length, 2, '同一句话在两个会话里是两条独立记忆')
  assert.notEqual(first.entry.dedupeKey, second.entry.dedupeKey, '第二条必须落在带归属的备用键上')
  assert.equal(store.get(first.entry.dedupeKey)?.ownerId, 's1', 'A 那条的主人一个字都不许动')
  assert.equal(store.get(first.entry.dedupeKey)?.content, '这次讨论用中文')
  assert.equal(store.get(second.entry.dedupeKey)?.ownerId, 's2')
})

test('同一会话里重复写同一句话仍然只留一条（备用键不许把去重弄丢）', async () => {
  const store = boot()
  const session = { scope: 'session', sensitivity: 'normal', origin: 'user-stated', sessionId: 's1' }
  await remember(store, balanced, { ...session, content: '这次讨论用中文' })
  const other = await remember(store, balanced, { ...session, content: '这次用中文讨论' })
  const again = await remember(store, balanced, { ...session, content: '这次讨论用中文' })

  assert.equal(store.list().length, 1, '同归属的重复写入仍走更新，不新增')
  assert.equal(again.entry?.dedupeKey, other.entry?.dedupeKey)
  assert.equal(store.list()[0].ownerId, 's1')
})

test('工作区归属隔离：不同工作区的同名事实互不覆盖，同工作区照旧去重', async () => {
  const store = boot()
  const base = { scope: 'workspace', sensitivity: 'normal', origin: 'user-stated', sessionId: 's1' }
  const a = await remember(store, balanced, { ...base, content: '本工作区用 pnpm', workspaceId: 'wa' })
  const b = await remember(store, balanced, { ...base, content: '本工作区用 pnpm', workspaceId: 'wb' })
  const a2 = await remember(store, balanced, { ...base, content: '本工作区用 pnpm', workspaceId: 'wa' })

  assert.equal(store.list().length, 2, '两个工作区各留一条')
  assert.equal(store.get(a.entry.dedupeKey)?.ownerId, 'wa')
  assert.equal(store.get(b.entry.dedupeKey)?.ownerId, 'wb')
  assert.equal(a2.entry?.dedupeKey, a.entry?.dedupeKey, '同工作区再写还是更新原来那条')
})

test('策略关掉就不写：模式 off、或该作用域被关（开关即时生效的落点）', async () => {
  const store = boot()
  const off = await remember(store, resolveMemoryPolicy('off'), request('用户偏好简短回复'))
  assert.equal(off.ok, false)
  assert.equal(store.list().length, 0)

  const noLongTerm = resolveMemoryPolicy('balanced', { scopes: { 'long-term': false } })
  const refused = await remember(store, noLongTerm, request('用户偏好简短回复'))
  assert.equal(refused.ok, false)
  assert.match(refused.message, /长期记忆/)
  assert.equal(store.list().length, 0)
})

test('规范化：控制字符与 ANSI 被剥掉，空白压平，超长截断而不是拒绝', async () => {
  assert.equal(normalizeMemoryContent('a\u0000b\u001b[31mc'), 'abc')
  assert.equal(normalizeMemoryContent('  多  行\n内容\t'), '多 行 内容')
  assert.equal(normalizeMemoryContent('x'.repeat(CONTENT_CHAR_LIMIT + 50)).length, CONTENT_CHAR_LIMIT)

  const store = boot()
  const result = await remember(store, balanced, request('\u001b[31m用户偏好简短回复\u0007'))
  assert.equal(result.entry?.content, '用户偏好简短回复')
})

test('空内容被拒绝，不会写下一条没有内容的记忆', async () => {
  const store = boot()
  const result = await remember(store, balanced, request('   \n\u0000  '))

  assert.equal(result.ok, false)
  assert.equal(store.list().length, 0)
})

test('确认：chat 与 workbench 两端确认同一条记录，各自留下证据（T2 双端同源）', async () => {
  const store = boot()
  const pending = await remember(store, balanced, request('用户的门禁密码', { sensitivity: 'sensitive' }))
  const key = pending.entry.dedupeKey

  const confirmed = await confirmPending(store, key, 'chat')
  assert.equal(confirmed?.status, 'active')
  assert.equal(confirmed?.confirmedVia, 'chat')
  assert.equal(store.get(key)?.confirmedVia, 'chat')
  // 另一端再确认一次不该产生第二次写入（重复落盘正是双端同源要防的）。
  assert.equal(await confirmPending(store, key, 'workbench'), undefined)

  const second = await remember(store, balanced, request('用户的支付密码', { sensitivity: 'sensitive' }))
  const viaWorkbench = await confirmPending(store, second.entry.dedupeKey, 'workbench')
  assert.equal(viaWorkbench?.confirmedVia, 'workbench')
})

test('拒绝：直接删除；不存在的或已生效的条目拒绝无效', async () => {
  const store = boot()
  const pending = await remember(store, balanced, request('用户的门禁密码', { sensitivity: 'sensitive' }))
  const plain = await remember(store, balanced, request('用户偏好简短回复'))

  assert.equal(await rejectPending(store, plain.entry.dedupeKey), false, '生效中的条目不走拒绝路径')
  assert.equal(await rejectPending(store, pending.entry.dedupeKey), true)
  assert.equal(store.get(pending.entry.dedupeKey), undefined)
  assert.equal(await rejectPending(store, 'long-term:不存在'), false)
})

test('pending 不会因等待而自动通过或消失（刻意没有超时逻辑）', async () => {
  const store = boot()
  const pending = await remember(store, balanced, request('用户的门禁密码', { sensitivity: 'sensitive' }))

  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(store.get(pending.entry.dedupeKey)?.status, 'pending')
  assert.equal(listPending(store).length, 1)
})

// 近似去重（2026-09-25 真机：同一条"不区分线上/线下"的规矩在库里躺了 4 个平行条目）。
// 夹具是**合成的等价改写对**（2026-10-10 内容级脱敏）—— 这套判据的风险全在"改写形态"上。
const TWIN_A =
  '用户要求：不区分"线上/线下"，示例实例就是示例实例，配置与记录中不留线上线下分隔；' +
  '只有在用户明确说"线下改设定"时，才以商量规则的方式对话。'
const TWIN_B =
  '用户要求：不区分线上/线下，示例实例就是示例实例，配置与记录里不留线上线下分隔；' +
  '只有在用户明确说「线下改设定」时，才以商量规则的方式对话。'

test('同一条事实的另一种说法被并入，不新增平行条目（2026-09-25 真机回归钉）', async () => {
  const store = boot()
  const first = await remember(store, balanced, request(TWIN_A))
  const again = await remember(store, balanced, request(TWIN_B))

  assert.equal(store.list().length, 1, '改了说法的同一件事不该再占一条')
  assert.equal(again.entry?.dedupeKey, first.entry?.dedupeKey, '身份沿用已有的指纹（否则等于新增）')
  assert.match(again.message, /并入/)
})

test('语义不同的事实各存一条 —— 并入不能误伤', async () => {
  const store = boot()
  await remember(store, balanced, request(TWIN_A))
  await remember(store, balanced, request('用户喜欢在周末骑车去城郊'))
  assert.equal(store.list().length, 2)
})

test('并入不放宽安全标记：待确认的敏感条目不会被一次普通改写提升成生效', async () => {
  const store = boot()
  const sensitive = await remember(store, balanced, request(TWIN_A, { sensitivity: 'sensitive' }))
  assert.equal(sensitive.entry?.status, 'pending')

  const plain = await remember(store, balanced, request(TWIN_B))
  assert.equal(plain.entry?.status, 'pending', '既有漏洞的近重复变体：必须同样只收紧不放松')
  assert.equal(plain.entry?.sensitive, true)
  assert.equal(store.list().length, 1)
})
