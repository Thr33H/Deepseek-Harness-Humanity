/**
 * 0.1.9 修②的钉子：**记忆正文不许再被静默截断**。
 *
 * 生产实测（用户报障那一轮）：`memory/write.js` 把正文硬切到 200 字、**不报错也不标注**，
 * 调用方收到的是成功回执。用户库里 56 条记忆的分布是 —— 最长 200 / 中位 200 /
 * **恰好 200 的 33 条（59%）** / >200 的 0 条 ⇒ 200 不是"上限"，而是**绝大多数写入的切割点**。
 *
 * 本文件钉三件事：
 * 1. 上限本身（2000）与它的理由（防有人改回 200）；
 * 2. **超限必须被说出来**（回执里带原始字数与处置建议；结构化位 `truncated` 也在）；
 * 3. **没超限不许无事生非**（不能给正常写入挂一句"已截断"）。
 *
 * ⚠️ 不碰历史数据：这里只测**新写入**的行为；用户库里那 33 条已存正文一个字都不动。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CONTENT_CHAR_LIMIT } from '../lib/memory/constants.js'
import { resolveMemoryPolicy } from '../lib/memory/policy.js'
import { createMemoryStore } from '../lib/memory/store.js'
import { RESULT_SCHEMA, toValue } from '../lib/memory/tool-result.js'
import { normalizeMemoryContentDetailed, remember } from '../lib/memory/write.js'
import { createFakeTable } from './helpers/memory-fake.mjs'

const balanced = resolveMemoryPolicy('balanced')
const boot = () => createMemoryStore(createFakeTable())
const request = (content, overrides = {}) => ({
  content,
  scope: 'long-term',
  sensitivity: 'normal',
  origin: 'user-stated',
  sessionId: 's1',
  ...overrides,
})

test('0.1.9 修②：上限已从 200 提到 2000（钉住值，防止被悄悄改回去）', () => {
  assert.equal(CONTENT_CHAR_LIMIT, 2000, '上限必须是 2000（依据见 constants.ts 的实测分布）')
})

test('0.1.9 修②：旧的切割长度（223 / 272 字）现在**不再截断**（0.1.8 的真实症状）', async () => {
  for (const length of [201, 223, 272, 1999]) {
    const store = boot()
    const result = await remember(store, balanced, request('阿'.repeat(length)))
    assert.equal(result.ok, true)
    assert.ok(!result.truncated, `${length} 字不该被标成截断`)
    assert.equal(result.entry?.content.length, length, `${length} 字应当原样落盘`)
    assert.doesNotMatch(result.message, /已截断/, `${length} 字的回执不该出现"已截断"`)
  }
})

test('0.1.9 修②：超限**必须被说出来**（回执带原始字数 + 结构化位 + 能行动的处置建议）', async () => {
  const store = boot()
  const original = 2345
  const result = await remember(store, balanced, request('阿'.repeat(original)))

  assert.equal(result.ok, true, '仍然写入（P-015：注入路径不硬拒绝）')
  assert.equal(result.truncated, true, '必须带结构化标记')
  assert.equal(result.entry?.content.length, CONTENT_CHAR_LIMIT, `落盘正文截到 ${CONTENT_CHAR_LIMIT}`)
  assert.match(result.message, /已截断/, '回执必须写明截断')
  assert.match(result.message, new RegExp(String(original)), '回执必须给出原始字数')
  assert.match(result.message, /拆成多条|会话检索/, '要给出**能行动**的建议，而不只是一句"注意"')
})

test('0.1.9 修②：恰好压线不截断、超一个字符就截断（边界）', async () => {
  const at = await remember(boot(), balanced, request('阿'.repeat(CONTENT_CHAR_LIMIT)))
  assert.ok(!at.truncated, '恰好等于上限不算截断')
  assert.equal(at.entry?.content.length, CONTENT_CHAR_LIMIT)

  const over = await remember(boot(), balanced, request('阿'.repeat(CONTENT_CHAR_LIMIT + 1)))
  assert.equal(over.truncated, true, '超一个字符就要标出来')
  assert.equal(over.entry?.content.length, CONTENT_CHAR_LIMIT)
})

test('0.1.9 修②：normalizeMemoryContentDetailed 如实报告（压平空白后再判长度）', () => {
  const plain = normalizeMemoryContentDetailed('  用户偏好简短回复  ')
  assert.equal(plain.truncated, false)
  assert.equal(plain.content, '用户偏好简短回复')
  assert.equal(plain.originalChars, 8)

  // 空白压平会把多个空格折成一个 ⇒ 判定用的是"压平后"的长度（与落盘一致）
  const spaced = normalizeMemoryContentDetailed('阿  阿  阿')
  assert.equal(spaced.content, '阿 阿 阿')
  assert.equal(spaced.originalChars, 5)

  const huge = normalizeMemoryContentDetailed('阿'.repeat(CONTENT_CHAR_LIMIT + 50))
  assert.equal(huge.truncated, true)
  assert.equal(huge.originalChars, CONTENT_CHAR_LIMIT + 50)
  assert.equal(huge.content.length, CONTENT_CHAR_LIMIT)
})

test('0.1.9 修②：工具回执层也带上这个位（模型/调用方都能读到）', async () => {
  const store = boot()
  const truncated = toValue(await remember(store, balanced, request('阿'.repeat(CONTENT_CHAR_LIMIT + 10))))
  assert.equal(truncated.ok, true)
  assert.equal(truncated.truncated, true, '工具返回值必须带 truncated 位')
  assert.match(truncated.message, /已截断/, '工具回执的正文里也要有说法')

  const plain = toValue(await remember(boot(), balanced, request('用户偏好简短回复')))
  assert.equal(plain.truncated, false, '正常写入的位必须是 false，不许含糊')

  // 输出 schema 必须也承认这个字段（additionalProperties: false ⇒ 不登记就会被判非法）
  assert.equal(RESULT_SCHEMA.properties.truncated?.type, 'boolean')
  assert.equal(RESULT_SCHEMA.properties.truncated?.required, true)
})

test('0.1.9 修②：自进化那条路把"截断过"写进**运行记录**（不只是回执）', async () => {
  const { finalizeRun } = await import('../lib/evolution/run-loop.js')
  const { createRunRecord } = await import('../lib/evolution/model.js')
  const { fakeEvolutionState } = await import('./helpers/evolution-fake.mjs')

  const make = (truncatedMemories) => ({
    record: createRunRecord('incremental', 'idle', '2026-10-05T00:00:00.000Z'),
    notes: [],
    insights: [],
    narratives: [],
    callsToday: 0,
    failedSessions: 0,
    capStopped: false,
    truncatedMemories,
  })

  const { state } = fakeEvolutionState()
  const deps = { state, now: () => '2026-10-05T00:00:10.000Z' }
  const withTruncation = await finalizeRun(deps, make(2))
  assert.match(withTruncation.error, /2 条记忆.*截断/, '运行记录里必须留下"有 2 条被截断"的痕迹')
  assert.equal(withTruncation.status, 'completed', '截断是信息性注记，不改终态')

  const { state: clean } = fakeEvolutionState()
  const cleanRecord = await finalizeRun({ state: clean, now: () => '2026-10-05T00:00:10.000Z' }, make(0))
  assert.doesNotMatch(cleanRecord.error, /截断/, '没有截断就不许挂这句话（不能无事生非）')
})
