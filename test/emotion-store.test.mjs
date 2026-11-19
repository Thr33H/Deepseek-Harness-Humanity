/**
 * 情绪**存储层**的回归测试。
 *
 * 这层只有一个职责：把磁盘上的东西变成一份能用的状态，或者**明确地**换成初始状态。
 * 它最容易出的问题是"读出半份旧数据"——情绪种类换了一代之后，旧记录里的
 * `kind` 已经不存在了，如果不整体重置，渲染端会读到不认识的种类。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { EMOTION_STATE_VERSION } from '../lib/emotion/constants.js'
import { createEmotionStore } from '../lib/emotion/store.js'

const T0 = '2026-01-01T00:00:00.000Z'

/** 造一个只读的假表；`put` 记录写入以便断言。 */
function fakeTable(initial) {
  let stored = initial
  const writes = []
  return {
    table: {
      get: () => stored,
      put: async (_key, value) => {
        stored = value
        writes.push(value)
      },
    },
    writes,
  }
}

test('表是空的：给出初始状态（不写盘）', () => {
  const { table, writes } = fakeTable(undefined)
  const store = createEmotionStore(table)
  const state = store.load(T0)
  assert.equal(state.version, EMOTION_STATE_VERSION)
  assert.deepEqual(state.charges, [])
  assert.equal(state.settledAt, T0)
  assert.equal(writes.length, 0, '读不该产生写')
})

test('版本对得上：原样读回', () => {
  const stored = {
    version: EMOTION_STATE_VERSION,
    charges: [{ kind: 'anger', target: 'user', intensity: 40, cause: '被否定', since: T0 }],
    warmth: 30,
    warmthCause: '',
    energy: 70,
    settledAt: T0,
    perceived: '',
    perceivedAt: '',
    updatedAt: T0,
  }
  const { table } = fakeTable(stored)
  const state = createEmotionStore(table).load(T0)
  assert.equal(state.charges.length, 1)
  assert.equal(state.charges[0].kind, 'anger')
})

test('版本对不上（换了模型）：整体重置，不做逐条映射', () => {
  const old = {
    version: EMOTION_STATE_VERSION - 1,
    charges: [{ kind: 'excitement', intensity: 40, cause: '旧模型里的种类', since: T0 }],
    warmth: 20,
    warmthCause: '',
    energy: 10,
    settledAt: T0,
    perceived: '旧的观察',
    perceivedAt: T0,
    updatedAt: T0,
  }
  const { table } = fakeTable(old)
  const state = createEmotionStore(table).load(T0)
  assert.deepEqual(state.charges, [], '旧种类的情绪必须被清掉')
  assert.equal(state.perceived, '', '旧的观察也一起清')
})

test('记录坏了（认不出的种类名）：退回初始状态而不是抛错', () => {
  const corrupted = {
    version: EMOTION_STATE_VERSION,
    charges: [{ kind: '这不存在的种类', intensity: 40, since: T0 }],
    warmth: 50,
    settledAt: T0,
  }
  const { table } = fakeTable(corrupted)
  const state = createEmotionStore(table).load(T0)
  assert.deepEqual(state.charges, [])
  assert.equal(state.version, EMOTION_STATE_VERSION)
})

test('旧条目缺 target 字段：读成对事，不丢这条', () => {
  const legacy = {
    version: EMOTION_STATE_VERSION,
    charges: [{ kind: 'joy', intensity: 25, cause: '旧数据', since: T0 }],
    warmth: 50,
    warmthCause: '',
    energy: 80,
    settledAt: T0,
    perceived: '',
    perceivedAt: '',
    updatedAt: T0,
  }
  const { table } = fakeTable(legacy)
  const state = createEmotionStore(table).load(T0)
  assert.equal(state.charges.length, 1)
  assert.equal(state.charges[0].target, 'world')
})

test('store.save 会落到表里', async () => {
  const { table, writes } = fakeTable(undefined)
  const store = createEmotionStore(table)
  const state = store.load(T0)
  await store.save(state)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].version, EMOTION_STATE_VERSION)
})
