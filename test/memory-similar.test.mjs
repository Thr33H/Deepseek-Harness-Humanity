/**
 * 近似去重的单元测试（`src/host/memory/similar.ts`）。
 *
 * 夹具是**合成的等价改写对**（2026-10-10 内容级脱敏：原锚取自真机生产库，现换成同形态的示例文本）。
 * 形态与读数都保持：改写对 Dice 0.944（阈值 0.65 之上），语义确实不同的那条只有 0.083（阈值之下），
 * 阈值 0.65 仍落在这道实测间隙里。这套判据的风险全在"改写形态"上 —— 夹具一旦不再是
 * "同一件事的两种说法"，这条用例就失去意义。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NEAR_DUPLICATE_DICE } from '../lib/memory/constants.js'
import { createMemoryEntry } from '../lib/memory/model.js'
import { adoptExisting, findNearDuplicate, mergeDuplicates, similarity } from '../lib/memory/similar.js'

/** 合成夹具：同一件事的两种说法（脱敏前锚取自真机生产库）。 */
const TWIN_A =
  '用户要求：不区分"线上/线下"，示例实例就是示例实例，配置与记录中不留线上线下分隔；' +
  '只有在用户明确说"线下改设定"时，才以商量规则的方式对话。'
const TWIN_B =
  '用户要求：不区分线上/线下，示例实例就是示例实例，配置与记录里不留线上线下分隔；' +
  '只有在用户明确说「线下改设定」时，才以商量规则的方式对话。'
/** 同一批数据里语义确实不同的一条（实测与上面两条只 0.083）。 */
const DISTINCT =
  '示例实例线剧情进度：相识于示例地点甲 → 示例居所 → 示例场所乙的示例房间。' +
  '当前其正考虑一段时间后申请调去城外的示例机构，尚未决定；用户提出想搬去那边。'

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

test('相似度：同一条事实的两种说法远高于阈值，语义不同的远低于阈值', () => {
  const twin = similarity(TWIN_A, TWIN_B)
  const distinct = similarity(TWIN_A, DISTINCT)
  assert.ok(twin >= NEAR_DUPLICATE_DICE, `真实改写应判为同一件事，实测 ${twin.toFixed(3)}`)
  assert.ok(distinct < NEAR_DUPLICATE_DICE, `不同事实不该被判同，实测 ${distinct.toFixed(3)}`)
  // 阈值必须落在这道实测间隙里，否则要么漏检要么误合（0.65 ← 0.083 | 0.944）
  assert.ok(twin > distinct + 0.3, '真实样本的分离度应当很宽')
})

test('相似度：逐字相同为 1，毫无交集为 0，空文本不与任何东西"像"', () => {
  assert.equal(similarity(TWIN_A, TWIN_A), 1)
  assert.equal(similarity('咖啡', '驴车'), 0)
  assert.equal(similarity('', TWIN_A), 0)
  assert.equal(similarity('', ''), 0)
})

test('近似命中：那一对改写能被认出来', () => {
  const twin = findNearDuplicate(entry({ content: TWIN_B }), [entry({ content: TWIN_A })])
  assert.equal(twin?.content, TWIN_A)
})

test('近似命中：语义不同的不会被合并', () => {
  assert.equal(findNearDuplicate(entry({ content: DISTINCT }), [entry({ content: TWIN_A })]), undefined)
})

test('近似命中：不跨作用域、不跨归属 —— 各层各管各的', () => {
  const session = entry({ scope: 'session', ownerId: 's1', content: TWIN_A })
  const other = entry({ scope: 'workspace', ownerId: 'w1', content: TWIN_B })
  assert.equal(findNearDuplicate(other, [session]), undefined)
  // 同作用域但不同归属（两个会话/两个工作区）同样不该互相并掉
  const otherSession = entry({ scope: 'session', ownerId: 's2', content: TWIN_B })
  assert.equal(findNearDuplicate(otherSession, [session]), undefined)
})

test('近似命中：已归档的不参与（被它并掉等于把新内容丢进归档）', () => {
  const archived = entry({ content: TWIN_A, status: 'archived' })
  assert.equal(findNearDuplicate(entry({ content: TWIN_B }), [archived]), undefined)
})

test('近似命中：同指纹跳过 —— 精确那一档由调用方先处理', () => {
  const same = entry({ content: TWIN_A })
  assert.equal(findNearDuplicate(entry({ content: TWIN_A }), [same]), undefined)
})

test('并入：身份沿用已有的（指纹/id/首次来源不改，否则等于凭空新增一条）', () => {
  const target = entry({ content: TWIN_B, tags: ['旧'], confidence: 0.6 })
  const candidate = entry({ content: TWIN_A, tags: ['新'], confidence: 1 })
  const merged = adoptExisting(target, candidate)
  assert.equal(merged.id, target.id)
  assert.equal(merged.dedupeKey, target.dedupeKey)
  assert.equal(merged.origin, target.origin)
  assert.equal(merged.sourceSessionId, target.sourceSessionId)
  assert.deepEqual(merged.tags, ['旧', '新'])
})

test('并入：信息只增不减 —— 正文取更长、重要度与置信度取大、钉住状态沿用', () => {
  const short = entry({ content: '短', importance: 5, confidence: 0.6 })
  const long = entry({ content: TWIN_A, importance: 1, confidence: 1 })
  const merged = adoptExisting(short, long)
  assert.equal(merged.content, TWIN_A)
  assert.equal(merged.importance, 5)
  assert.equal(merged.confidence, 1)
  assert.equal(adoptExisting(entry({ pinned: true }), entry({ pinned: false })).pinned, true)
})

test('存量合并：同一条事实的多个活跃条目并成一条，身份落在最早那条上', () => {
  const first = entry({ content: TWIN_A, createdAt: '2026-09-25T14:40:13.204Z' })
  const second = entry({ content: TWIN_B, createdAt: '2026-09-25T14:40:25.524Z' })
  const { kept, absorbed } = mergeDuplicates([second, first])

  assert.equal(kept.length, 1)
  assert.equal(kept[0].dedupeKey, first.dedupeKey, '身份落在先来的那条')
  assert.equal(absorbed.length, 1)
  assert.deepEqual(absorbed[0], { from: second.dedupeKey, into: first.dedupeKey })
})

test('存量合并：归档条目不参与 —— 既不并别人，也不被别人并（动它只是删数据）', () => {
  const archived = entry({ content: TWIN_A, status: 'archived', createdAt: '2026-09-25T12:20:36.536Z' })
  const active = entry({ content: TWIN_B, createdAt: '2026-09-25T14:40:25.524Z' })
  const { kept, absorbed } = mergeDuplicates([archived, active])

  assert.equal(kept.length, 2, '归档那条原样留着')
  assert.equal(absorbed.length, 0, '活跃那条不该被归档的吃掉')
})

test('存量合并：与冲突判据互斥 —— 相反的事实绝不被并掉', () => {
  const like = entry({ content: '用户喜欢咖啡', createdAt: '2026-09-25T10:00:00.000Z' })
  const dislike = entry({ content: '用户不喜欢咖啡', createdAt: '2026-09-25T11:00:00.000Z' })
  const { kept, absorbed } = mergeDuplicates([like, dislike])

  assert.equal(kept.length, 2)
  assert.equal(absorbed.length, 0)
})

test('存量合并：语义不同的各留各的', () => {
  const a = entry({ content: TWIN_A, createdAt: '2026-09-25T10:00:00.000Z' })
  const b = entry({ content: DISTINCT, createdAt: '2026-09-25T11:00:00.000Z' })
  const { kept } = mergeDuplicates([a, b])
  assert.equal(kept.length, 2)
})

test('并入：createdAt 与使用统计沿用已有的（2026-09-25 数据级清理暴露的缺陷钉）', () => {
  // 在线写入路径有 `store.put` 兜着看不出问题；但 `mergeDuplicates` 直接改存档、不经过 put，
  // 于是幸存者的创建时间会漂成后来那条 —— 时间是新鲜度打分的输入，漂了就是错的。
  const early = entry({
    content: '短',
    createdAt: '2026-09-25T14:40:13.204Z',
    useCount: 7,
    lastUsedAt: '2026-09-25T20:00:00.000Z',
  })
  const late = entry({
    content: TWIN_A,
    createdAt: '2026-09-25T14:40:25.524Z',
    useCount: 0,
    lastUsedAt: '',
  })
  const merged = adoptExisting(early, late)

  assert.equal(merged.createdAt, early.createdAt, '创建时间不许漂')
  assert.equal(merged.useCount, 7, '重写不等于被用过')
  assert.equal(merged.lastUsedAt, early.lastUsedAt)
  assert.equal(merged.content, TWIN_A, '正文仍取更长的')
})

test('存量合并：幸存者的创建时间取自最早那条（清理结果与逐条写入一致）', () => {
  const first = entry({ content: TWIN_A, createdAt: '2026-09-25T14:40:13.204Z' })
  const second = entry({ content: TWIN_B, createdAt: '2026-09-25T14:40:25.524Z' })
  const { kept } = mergeDuplicates([second, first])
  assert.equal(kept[0].createdAt, first.createdAt)
})

test('存量合并：待确认的敏感条目被同义条目吸收后仍是待确认 + 敏感（P-033 红线）', () => {
  // 2026-09-26 审计抓到的真缺陷：`adoptExisting` 原来用 `...candidate` 一路覆盖，
  // 于是一条**用户还没点过确认**的敏感记忆被同义的 active 条目并掉之后直接生效、
  // 敏感标记也没了 —— 合并是存量清理，它没有权力放行任何用户没点头的东西。
  const pendingSensitive = entry({
    content: TWIN_A,
    status: 'pending',
    sensitive: true,
    createdAt: '2026-09-25T14:40:13.204Z',
  })
  const plainActive = entry({ content: TWIN_B, createdAt: '2026-09-25T14:40:25.524Z' })
  const { kept, absorbed } = mergeDuplicates([pendingSensitive, plainActive])

  assert.equal(absorbed.length, 1, '两条确实是同一条事实（该并就并）')
  assert.equal(kept.length, 1)
  assert.equal(kept[0].status, 'pending', '合并不许把待确认放行')
  assert.equal(kept[0].sensitive, true, '敏感标记只收紧、不放宽')
  assert.equal(kept[0].confirmedVia, '', '没确认过的条目不该带着别人的确认凭证')
})

test('并入：确认凭证不会平白继承 —— 待确认那条永远是空的', () => {
  const pending = entry({ status: 'pending', sensitive: true, confirmedVia: '' })
  const active = entry({ content: TWIN_B, confirmedVia: 'chat' })
  assert.equal(adoptExisting(pending, active).confirmedVia, '', '状态还是待确认 ⇒ 凭证必须是空')
  const activeTarget = entry({ status: 'active', confirmedVia: '' })
  assert.equal(adoptExisting(activeTarget, active).confirmedVia, 'chat', '生效条目可以继承确认来源')
})
