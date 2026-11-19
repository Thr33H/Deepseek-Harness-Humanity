/**
 * 记忆召回的**使用统计去重**。
 *
 * 为什么需要它：`section.text` 每装配一次提示词就调用一次，而一轮多步（工具调用）
 * 会装配多次。不去重的话，同一条记忆在一轮里被记成"用过 N 次"，
 * 而 `lastUsedAt` 被反复刷新 —— 它是衰减评分的"新鲜度"依据，等于让记忆永不衰减。
 *
 * 实测症状：一条记忆创建后 **66 毫秒**就被标记使用过（同一轮的第 2 步命中了它）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { shouldRecordRecall } from '../lib/memory/inject.js'

const T = 1_700_000_000_000

test('第一次一定记', () => {
  assert.equal(shouldRecordRecall({ message: '', at: 0 }, '在吗', T), true)
})

test('同一轮的多步装配（同消息 + 时间很近）只记第一次', () => {
  const state = { message: '在吗', at: T }
  assert.equal(shouldRecordRecall(state, '在吗', T + 50), false, '50ms 后那次是同一轮的第 2 步')
  assert.equal(shouldRecordRecall(state, '在吗', T + 2000), false)
  assert.equal(shouldRecordRecall(state, '在吗', T + 14_999), false)
})

test('超过时间窗就重新记（对方真的又发了同一句话）', () => {
  const state = { message: '嗯', at: T }
  assert.equal(shouldRecordRecall(state, '嗯', T + 15_000), true)
})

test('消息变了就是新的一轮，立刻记', () => {
  const state = { message: '在吗', at: T }
  assert.equal(shouldRecordRecall(state, '你在干嘛', T + 100), true)
})

test('自定义时间窗生效', () => {
  const state = { message: '嗯', at: T }
  assert.equal(shouldRecordRecall(state, '嗯', T + 600, 500), true)
})
