/**
 * 后台调用的思考档测试（2026-11-22）。
 *
 * 真机事故：归拢一次都没成，`finish: max-tokens, 正文 0 字` —— 请求没写思考档，
 * 适配器按模型默认值 `high` 补齐，思考把输出预算吃光。所以后台调用必须显式要**最低档**；
 * 查不到就什么都不指定（宁可回到旧行为，也不能编一个不被支持的档位把调用打死）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { lowestEffortOf } from '../lib/llm.js'

/** 只提供 resolveModelInfo 的最小替身。 */
const llmWith = (resolveModelInfo) => ({ stream: () => {}, listProviders: () => [], resolveModelInfo })

test('后台调用取最低一档思考（目录是从低到高排的）', async () => {
  const llm = llmWith(async () => ({
    reasoning: { efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }] },
  }))
  assert.equal(await lowestEffortOf(llm, { provider: 'p', model: 'm' }), 'off')
})

test('宿主没有这个查询口时不指定档位（回到旧行为）', async () => {
  const legacy = { stream: () => {}, listProviders: () => [] }
  assert.equal(await lowestEffortOf(legacy, { provider: 'p', model: 'm' }), undefined)
})

test('模型不报档位、或查询抛错时也不指定（绝不编一个档位名）', async () => {
  assert.equal(await lowestEffortOf(llmWith(async () => ({})), { provider: 'p', model: 'm' }), undefined)
  assert.equal(await lowestEffortOf(llmWith(async () => ({ reasoning: { efforts: [] } })), { provider: 'p', model: 'm' }), undefined)
  const boom = llmWith(async () => {
    throw new Error('不支持')
  })
  assert.equal(await lowestEffortOf(boom, { provider: 'p', model: 'm' }), undefined)
})
