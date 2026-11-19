/**
 * 记忆回声与情绪指纹的回归测试。
 *
 * 两件事各自都有"静默坏掉"的风险，所以分开钉：
 * 1. **回声**：折算错了会让情绪被自己的记忆反复点着（聊什么都烦躁），
 *    或者永远不响（记忆白白带了温度却没人用）；
 * 2. **指纹默认值**：旧记忆没有这个字段，读错会让整张记忆表解析失败 ——
 *    那是"升级一次，记忆全没了"级别的事故。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildEcho } from '../lib/emotion/echo.js'
import { createInitialEmotionState } from '../lib/emotion/model.js'
import { apply } from '../lib/emotion/state.js'
import { EMOTION_KINDS } from '../lib/emotion/constants.js'
import { EMPTY_AFFECT, MemoryEntrySchema } from '../lib/memory/model.js'
import { MOOD_TONE } from '../lib/memory/constants.js'

/* ───────────────────────────── 回声 ───────────────────────────── */

/** 造一条"带着情绪写下的记忆"。`target` 必须给：回声靠它加回同一条情绪。 */
const withAffect = (kind, intensity, content = '他说这个方案不行', target = 'user') => ({
  content,
  affect: { kind, target, intensity, warmth: 40 },
})

test('回声：平静写下的记忆不响（当时就没情绪，没什么可带回的）', () => {
  assert.deepEqual(buildEcho([withAffect('', 0)]), [])
})

test('回声：指纹太弱（<20）的记忆不响，免得无关话题上无端浮动', () => {
  assert.deepEqual(buildEcho([withAffect('anger', 19)]), [])
})

test('回声：按指纹强度的 8% 折算，并夹在 2–6 之间', () => {
  // 60 * 0.08 = 4.8 → 5
  assert.equal(buildEcho([withAffect('anger', 60)])[0]?.delta, 5)
  // 20 * 0.08 = 1.6 → 2，抬到下限
  assert.equal(buildEcho([withAffect('anger', 20)])[0]?.delta, 2)
  // 100 * 0.08 = 8，压到上限 6
  assert.equal(buildEcho([withAffect('anger', 100)])[0]?.delta, 6)
})

test('回声：一次最多取两条（多了会把心情整个改写）', () => {
  const echo = buildEcho([
    withAffect('anger', 80, 'a'),
    withAffect('disgust', 80, 'b'),
    withAffect('sadness', 80, 'c'),
  ])
  assert.equal(echo.length, 2)
})

test('回声：不认识的种类直接忽略（旧数据/手改数据不该让回声乱来）', () => {
  assert.deepEqual(buildEcho([withAffect('boredom', 80)]), [])
})

test('回声：原因写成"想起「…」"，正文截断到 16 字', () => {
  const long = '那天他说我根本没用而且一点长进都没有，我记了很久很久'
  const echo = buildEcho([withAffect('anger', 60, long)])
  assert.equal(echo[0]?.cause, `想起「${long.slice(0, 16)}」`)
})

/* ───────────────────────── 指纹默认值（旧数据） ───────────────────────── */

test('旧记忆没有 affect 字段：读出来是"平静"，不是解析失败', () => {
  const legacy = {
    id: 'm1',
    scope: 'long-term',
    content: '主人叫伊瑟',
    origin: 'user-stated',
    sourceSessionId: 's1',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    dedupeKey: 'long-term:主人叫伊瑟',
  }
  const parsed = MemoryEntrySchema.safeParse(legacy)
  assert.equal(parsed.success, true)
  assert.deepEqual(parsed.data?.affect, EMPTY_AFFECT)
})

test('记忆侧的情绪极性表与情绪种类一一对应（漏一种 = 心境一致静默失效）', () => {
  assert.deepEqual(Object.keys(MOOD_TONE).sort(), [...EMOTION_KINDS].sort())
  // 极性划分沿用 Plutchik 的轮：正面半圈三种、负面半圈四种、惊讶在正中间（中性）。
  assert.deepEqual(
    Object.entries(MOOD_TONE).filter(([, tone]) => tone === 1).map(([kind]) => kind).sort(),
    ['anticipation', 'joy', 'trust'],
  )
  assert.deepEqual(
    Object.entries(MOOD_TONE).filter(([, tone]) => tone === 0).map(([kind]) => kind),
    ['surprise'],
  )
})
test('回声只加强度，不顶掉这一轮真正的原因', () => {
  const T0 = '2026-01-01T00:00:00.000Z'
  // 先有一轮真实事件（评估给出的原因），再叠一次回声：原因必须保持是前者。
  let state = apply(
    createInitialEmotionState(T0),
    { shifts: [{ kind: 'trust', target: 'user', delta: 40, cause: '对方说信我' }] },
    T0,
  )
  const before = state.charges[0].intensity
  state = apply(state, { shifts: buildEcho([withAffect('trust', 60, '她说过信我')]) }, T0)
  assert.equal(state.charges[0].cause, '对方说信我', '回声不该覆盖真实原因')
  assert.ok(state.charges[0].intensity > before, '但强度要照常涨')
})

test('那条情绪本来没有原因时，回声的原因会补上', () => {
  const T0 = '2026-01-01T00:00:00.000Z'
  let state = apply(
    createInitialEmotionState(T0),
    { shifts: [{ kind: 'trust', target: 'user', delta: 40 }] },
    T0,
  )
  assert.equal(state.charges[0].cause, '')
  state = apply(state, { shifts: buildEcho([withAffect('trust', 60, '她说过信我')]) }, T0)
  assert.ok(state.charges[0].cause.startsWith('想起「'), '没有别的解释时，就用"想起"')
})
