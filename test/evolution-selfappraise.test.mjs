/**
 * 自评（她自己的见闻 → 情绪）的回归钉。
 *
 * 两件事必须钉死：
 * 1. **只产出"对事 / 对自己"的情绪** —— 对方不在场，模型偶尔会写成"对方让我生气"，
 *    那条必须被滤掉，否则她的独处会莫名其妙地改变她跟人的关系；
 * 2. **不收她自己说的话** —— 只从工具结果里取"她看到的内容"，否则就是自己喂自己。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { appraiseOwnExperience } from '../lib/emotion/appraise.js'
import { toolTextOf } from '../lib/evolution/index.js'

/** 她此刻的状态（空状态就够：评估器只需要一个起点）。 */
const STATE = {
  version: 2,
  charges: [],
  warmth: 60,
  energy: 70,
  settledAt: '2026-11-23T10:00:00.000Z',
  sensitivities: [],
  lastShifts: [],
}

/**
 * 一个假的后台模型口。
 * @param reply - 它要回的那段 JSON。
 * @returns 假 LlmAccess（同时记下调用参数）。
 */
function fakeLlm(reply) {
  const calls = []
  return {
    calls,
    route: () => ({ provider: 'p', model: 'm' }),
    async streamText(input) {
      calls.push(input)
      return { text: reply, finishReason: 'stop' }
    },
  }
}

test('自评：模型若给出"冲对方"的情绪，必须被滤掉', async () => {
  const llm = fakeLlm(
    JSON.stringify({
      shifts: [
        { kind: 'anger', target: 'user', delta: 8, cause: '帖子里的作者真讨厌' },
        { kind: 'anger', target: 'world', delta: 6, cause: '看不惯这种事' },
        { kind: 'sadness', target: 'self', delta: 3, cause: '想到自己也这样' },
      ],
      warmth: -3,
      perceived: '对方很烦躁',
    }),
  )
  const pulse = await appraiseOwnExperience(llm, { text: '一篇讲某地事故的帖子', state: STATE })
  assert.ok(pulse !== undefined)
  assert.deepEqual(
    pulse.shifts.map((shift) => shift.target),
    ['world', 'self'],
    '冲对方的条目要滤掉，只留事与自己',
  )
  assert.equal(pulse.warmth, undefined, '关系温度不因她看了一篇文章而变')
  assert.equal(pulse.perceived, undefined, '对方不在场，不该有"对方此刻"的判断')
})

test('自评：只有"冲对方"的条目时，等于没有情绪', async () => {
  const llm = fakeLlm(JSON.stringify({ shifts: [{ kind: 'joy', target: 'user', delta: 5, cause: '他夸我' }] }))
  const pulse = await appraiseOwnExperience(llm, { text: '一条不相干的推文', state: STATE })
  assert.equal(pulse, undefined)
})

test('自评：输入为空或模型没接上时什么都不做（不报错、不编情绪）', async () => {
  const llm = fakeLlm(JSON.stringify({ shifts: [] }))
  assert.equal(await appraiseOwnExperience(llm, { text: '   ', state: STATE }), undefined)
  assert.equal(llm.calls.length, 0, '空输入不该调用模型')

  const broken = { route: () => undefined, streamText: async () => ({ text: '', finishReason: 'stop' }) }
  assert.equal(await appraiseOwnExperience(broken, { text: '有内容', state: STATE }), undefined)
})

test('自评：提示词里必须写清"这不是对方说的话"', async () => {
  const llm = fakeLlm(JSON.stringify({ shifts: [] }))
  await appraiseOwnExperience(llm, { text: '一段她读到的东西', state: STATE })
  const call = llm.calls[0]
  assert.match(call.system, /不是对方说的话/, '系统提示要否掉"对方来了"的误解')
  assert.match(call.system, /target 只能是/, '要限制情绪对象')
  assert.match(call.system, /world/, '允许"对事"')
  assert.match(call.system, /self/, '允许"对自己"')
})

test('自评内容只从工具结果里取：她说的话不算"看到的"', () => {
  // 两种常见形状都要认。
  assert.equal(
    toolTextOf({ data: { message: { content: [{ type: 'text', text: '网页正文' }] } } }),
    '网页正文',
  )
  assert.equal(toolTextOf({ data: { result: '命令输出' } }), '命令输出')
  assert.match(toolTextOf({ data: { content: { hits: 3 } } }), /hits/, '结构化载荷串起来也算')
  // 没有内容的（例如只带错误码）返回空串：不猜。
  assert.equal(toolTextOf({ data: { callId: 'x' } }), '')
  assert.equal(toolTextOf({}), '')
})
