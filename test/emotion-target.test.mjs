/**
 * 情绪**对象**（OCC 的归因）的回归测试。
 *
 * 这一层补的是"这股情绪冲谁"。它最容易坏在两个地方：
 * 1. 两种完全不同对象的同一种情绪被并成一条（"对TA生气"和"对自己生气"混了）；
 * 2. 对冲不分对象（对TA的火把对事的快乐一起吃掉）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseAppraisal } from '../lib/emotion/appraise.js'
import { createInitialEmotionState } from '../lib/emotion/model.js'
import { apply, settle } from '../lib/emotion/state.js'
import { reconcile } from '../lib/emotion/dynamics.js'

const T0 = '2026-01-01T00:00:00.000Z'

test('同一情绪不同对象是两条，不会并成一条', () => {
  const state = apply(
    createInitialEmotionState(T0),
    {
      shifts: [
        { kind: 'anger', target: 'user', delta: 40, cause: '被否定' },
        { kind: 'anger', target: 'self', delta: 30, cause: '答应的事没做到' },
      ],
    },
    T0,
  )
  assert.equal(state.charges.length, 2)
  assert.deepEqual(
    state.charges.map((charge) => [charge.kind, charge.target]).sort(),
    [
      ['anger', 'self'],
      ['anger', 'user'],
    ],
  )
})

test('同一情绪同一对象才叠加', () => {
  const state = apply(
    createInitialEmotionState(T0),
    {
      shifts: [
        { kind: 'anger', target: 'user', delta: 40 },
        { kind: 'anger', target: 'user', delta: 20 },
      ],
    },
    T0,
  )
  assert.equal(state.charges.length, 1)
  // 走饱和：40 + 20×(1−40/100) = 52（不是 60）。
  assert.equal(Math.round(state.charges[0]?.intensity ?? 0), 52)
})

test('target 省略时按 world（对事）处理', () => {
  const state = apply(createInitialEmotionState(T0), { shifts: [{ kind: 'joy', delta: 30 }] }, T0)
  assert.equal(state.charges[0]?.target, 'world')
})

test('对冲只在同一对象内：对TA的火吃不掉对事的高兴', () => {
  const charges = [
    { kind: 'joy', target: 'world', intensity: 60, cause: '', since: T0 },
    { kind: 'anger', target: 'user', intensity: 80, cause: '', since: T0 },
  ]
  const result = reconcile(charges)
  // 喜悦 60（对事）不该被对TA的愤怒压下去。
  assert.equal(result.find((charge) => charge.kind === 'joy')?.intensity, 60)
})

test('同对象内照常对冲', () => {
  const charges = [
    { kind: 'joy', target: 'user', intensity: 60, cause: '', since: T0 },
    { kind: 'anger', target: 'user', intensity: 80, cause: '', since: T0 },
  ]
  const result = reconcile(charges)
  assert.ok((result.find((charge) => charge.kind === 'joy')?.intensity ?? 0) < 60)
})

test('解析：模型给了 target 就照用', () => {
  const pulse = parseAppraisal('{"shifts":[{"kind":"anger","target":"self","delta":20}],"warmth":0}')
  assert.equal(pulse?.shifts[0]?.target, 'self')
})

test('解析：没给或不认识的 target 一律按 world（最中性）', () => {
  const missing = parseAppraisal('{"shifts":[{"kind":"anger","delta":20}],"warmth":0}')
  assert.equal(missing?.shifts[0]?.target, 'world')

  const bogus = parseAppraisal('{"shifts":[{"kind":"anger","target":"them","delta":20}],"warmth":0}')
  assert.equal(bogus?.shifts[0]?.target, 'world')
})

test('旧条目没有 target 字段：读成"对事"而不是解析失败', () => {
  const legacy = {
    version: 2,
    charges: [{ kind: 'joy', intensity: 20, cause: '旧数据', since: T0 }],
    warmth: 50,
    warmthCause: '',
    energy: 80,
    settledAt: T0,
    perceived: '',
    perceivedAt: '',
    updatedAt: T0,
  }
  const next = settle(legacy, T0)
  assert.equal(next.charges[0]?.kind, 'joy')
})
