/**
 * 摘要层测试：角色标注、噪声过滤、单事件截断、总字节预算与截断标记。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildDigest, PER_EVENT_CHAR_LIMIT } from '../lib/evolution/digest.js'

/** 造语义事件。 */
function event(seq, type, text) {
  return { sessionId: 's1', seq, type, time: 0, surface: 'current', text }
}

test('对话两类事件进摘要并带角色标注；空白被压平', () => {
  const result = buildDigest(
    [
      event(1, 'user/message', '  帮我看看\n\n这个方案  '),
      event(2, 'assistant/message', '方案可行'),
    ],
    4096,
  )

  assert.equal(result.text, '[user] 帮我看看 这个方案\n[assistant] 方案可行')
  assert.equal(result.eventCount, 2)
  assert.equal(result.truncated, false)
})

test('工具调用/结果等噪声类型与空正文不进摘要', () => {
  const result = buildDigest(
    [
      event(1, 'tool/call', 'bash {...}'),
      event(2, 'tool/result', 'exit 0'),
      event(3, 'todo/write', '[]'),
      event(4, 'user/message', ''),
      event(5, 'user/message', '   '),
      event(6, 'assistant/message', '收到'),
    ],
    4096,
  )

  assert.equal(result.text, '[assistant] 收到')
  assert.equal(result.eventCount, 1)
})

test(`单事件超过 ${PER_EVENT_CHAR_LIMIT} 字符被截断并留省略号`, () => {
  const long = 'x'.repeat(PER_EVENT_CHAR_LIMIT + 500)
  const result = buildDigest([event(1, 'user/message', long)], 65536)

  const body = result.text.slice('[user] '.length)
  assert.equal(body.length, PER_EVENT_CHAR_LIMIT + 1)
  assert.ok(body.endsWith('…'))
})

test('总字节预算：输出永不超 maxBytes，截断时带显式标记', () => {
  const events = Array.from({ length: 50 }, (_, index) => event(index + 1, 'user/message', `第${index + 1}条内容`))
  const maxBytes = 300
  const result = buildDigest(events, maxBytes)

  assert.ok(new TextEncoder().encode(result.text).byteLength <= maxBytes)
  assert.equal(result.truncated, true)
  assert.ok(result.text.endsWith('[…earlier-or-longer content truncated by budget…]'))
  assert.ok(result.eventCount > 0 && result.eventCount < 50)
})

test('预算装得下全部事件时不截断、无标记', () => {
  const result = buildDigest([event(1, 'user/message', '短'), event(2, 'assistant/message', '好')], 4096)
  assert.equal(result.truncated, false)
  assert.ok(!result.text.includes('truncated by budget'))
})

test('没有任何可消化事件：空串（调用方据此跳过模型调用，成本为零）', () => {
  const result = buildDigest([event(1, 'tool/call', 'x')], 4096)
  assert.equal(result.text, '')
  assert.equal(result.eventCount, 0)
  assert.equal(result.truncated, false)
})

test('截断时 lastSeq 停在"真正看过的最后一条"：没进摘要的事件不许被永久跳过', () => {
  // 2026-09-26 审计抓到的真缺陷：预算不够时循环 break，而调用方原来把游标推到**整批末尾** ——
  // 那些没进摘要的事件就此永久跳过，与"宁可下轮重看，不可永久丢"完全相反。
  const events = Array.from({ length: 50 }, (_, index) => event(index + 1, 'user/message', `第${index + 1}条内容`))
  const result = buildDigest(events, 300)

  assert.equal(result.truncated, true)
  assert.equal(result.lastSeq, result.eventCount, '事件 1..N 都进了摘要 ⇒ 安全推进点就是 N')
  assert.ok(result.lastSeq < 50, '后面那些**没进摘要**的事件不能被算作看过')
})

test('噪声与空正文也算"看过"：游标可以越过它们，不必下轮重读', () => {
  const events = [
    event(1, 'user/message', '正文一'),
    event(2, 'tool/call', 'bash {...}'),
    event(3, 'tool/result', 'exit 0'),
    event(4, 'user/message', ''),
    event(5, 'assistant/message', '正文二'),
  ]
  const result = buildDigest(events, 4096)

  assert.equal(result.truncated, false)
  assert.equal(result.eventCount, 2, '只有两句正文进摘要')
  assert.equal(result.lastSeq, 5, '安全推进点是最后一条被考虑过的事件，含噪声')
})

test('一条都放不下时 lastSeq 是 0：游标原地不动，下一轮从同一条重新开始', () => {
  const result = buildDigest([event(7, 'user/message', 'x'.repeat(200))], 40)

  assert.equal(result.truncated, true)
  assert.equal(result.eventCount, 0)
  assert.equal(result.lastSeq, 0, '没看过任何一条 ⇒ 不许推进（否则这条事件永远丢）')
})
