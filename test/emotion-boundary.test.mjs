/**
 * 情绪评估的**边界与失败路径**。
 *
 * 这一组测的不是"正常情况算得对不对"（那在 appraise 测试里），
 * 而是"不正常的时候会不会静默坏掉"。这些路径的共同特征是**失败的样子和成功一样**：
 * 情绪没变、对话照常，只有日志知道出过事。所以每一条都要显式钉住。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { appraiseMessage } from '../lib/emotion/appraise.js'
import { createInitialEmotionState } from '../lib/emotion/model.js'

const T0 = '2026-01-01T00:00:00.000Z'

/** 造一个假 LLM：记录最后一次收到的提示词，并按 `reply` 回答。 */
function fakeLlm(reply, finishReason = 'stop') {
  const seen = []
  return {
    seen,
    llm: {
      route: () => ({ provider: 'test', model: 'test' }),
      streamText: async (input) => {
        seen.push(input)
        if (reply instanceof Error) throw reply
        return { text: reply, finishReason }
      },
    },
  }
}

const state = () => createInitialEmotionState(T0)

test('超长消息被压短，而且头尾都留着', async () => {
  const { seen, llm } = fakeLlm('{"shifts":[],"warmth":0}')
  const head = '开'.repeat(500)
  const tail = '尾'.repeat(500)
  const long = `${head}${'中'.repeat(2000)}${tail}`

  await appraiseMessage(llm, { message: long, state: state() })

  const text = seen[0].text
  assert.ok(text.length < long.length, '整段话不该原样塞进去')
  assert.ok(text.includes('开'), '开头的线索要留')
  assert.ok(text.includes('尾'), '结尾的线索也要留')
  assert.ok(text.includes('……'), '中间应该被省略，并且看得出来被省略了')
})

test('短消息原样送进去（不该被动过）', async () => {
  const { seen, llm } = fakeLlm('{"shifts":[],"warmth":0}')
  await appraiseMessage(llm, { message: '  今天好累  ', state: state() })
  assert.ok(seen[0].text.includes('今天好累'))
  assert.equal(seen[0].text.includes('……'), false)
})

test('空消息直接返回，不花一次模型调用', async () => {
  const { seen, llm } = fakeLlm('{"shifts":[],"warmth":0}')
  const result = await appraiseMessage(llm, { message: '   \n  ', state: state() })
  assert.equal(result, undefined)
  assert.equal(seen.length, 0, '空消息不该发起调用')
})

test('模型调用抛错：返回 undefined 并报警，不把异常抛给调用方', async () => {
  const warnings = []
  const { llm } = fakeLlm(new Error('网络断了'))
  const result = await appraiseMessage(llm, { message: '你好', state: state() }, {
    onWarn: (message) => warnings.push(message),
  })
  assert.equal(result, undefined)
  assert.equal(warnings.length, 1)
  assert.ok(warnings[0].includes('调用失败'))
})

test('输出被截断（finishReason=length）：明确报"被截断"，而不是含糊的"没影响"', async () => {
  const warnings = []
  const { llm } = fakeLlm('{"shifts":[{"kind":"anger","delta":20}', 'length')
  const result = await appraiseMessage(llm, { message: '你好', state: state() }, {
    onWarn: (message) => warnings.push(message),
  })
  assert.equal(result, undefined)
  assert.ok(warnings[0].includes('截断'))
})

test('输出是乱码：返回 undefined 并带出片段，方便定位', async () => {
  const warnings = []
  const { llm } = fakeLlm('我今天不想说话')
  const result = await appraiseMessage(llm, { message: '你好', state: state() }, {
    onWarn: (message) => warnings.push(message),
  })
  assert.equal(result, undefined)
  assert.ok(warnings[0].includes('无法使用'))
})

test('模型没给任何情绪变化（空 shifts + warmth 0）：返回 undefined，上层不写盘', async () => {
  const { llm } = fakeLlm('{"shifts":[],"warmth":0,"warmthCause":"","perceived":""}')
  const result = await appraiseMessage(llm, { message: '嗯', state: state() })
  assert.equal(result, undefined)
})

test('模型给了观察但没给情绪：仍然返回脉冲（观察本身是有用的）', async () => {
  const { llm } = fakeLlm('{"shifts":[],"warmth":0,"perceived":"对方有点累"}')
  const result = await appraiseMessage(llm, { message: '嗯', state: state() })
  assert.notEqual(result, undefined)
  assert.equal(result.perceived, '对方有点累')
})
