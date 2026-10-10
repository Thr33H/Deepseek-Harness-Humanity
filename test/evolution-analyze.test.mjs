/**
 * 解析调用测试：路由缺失、坏输出重试、截断、取消与 token 记账。
 *
 * 假 LlmAccess 按调用次序吐出预设响应——这里钉的是 analyze.ts 的**失败语义**
 * （哪些重试、哪些不重试、钱怎么记账），真模型行为由 TEST 真机验收覆盖。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AnalyzeError, analyzeDigest, extractJson } from '../lib/evolution/analyze.js'

/** 最小合法输出（全默认值也合法——合同允许"没发现"）。 */
const MINIMAL = JSON.stringify({ memories: [], personaSections: [], personaFixed: [], skills: [], insights: [], narrative: '' })

/** 造一个按次序回放的假 LLM 入口（route 显式传 null = 模拟"没有可用路由"）。 */
function fakeLlm(responses, route) {
  const calls = []
  const effective = route === null ? undefined : (route ?? { provider: 'deepseek', model: 'test-model' })
  return {
    calls,
    route: () => effective,
    streamText: async (input) => {
      calls.push(input)
      const next = responses[calls.length - 1]
      if (next instanceof Error) throw next
      return next
    },
  }
}

/** 造一次成功响应的块结果。 */
function ok(text, usage = { inputTokens: 10, outputTokens: 5 }) {
  return { text, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, finishReason: 'stop' }
}

const INPUT = {
  digest: '[user] 我喜欢简短回复',
  mode: 'incremental',
  workspaceLabel: '',
  sectionTitles: ['说话风格'],
  maxOutputTokens: 1000,
  timeoutMs: 5000,
}

test('路由不可用：抛 no-route，一次都不调用（不烧钱）', async () => {
  const llm = fakeLlm([], null)
  await assert.rejects(analyzeDigest({ llm }, INPUT), (error) => error instanceof AnalyzeError && error.code === 'no-route')
  assert.equal(llm.calls.length, 0)
})

test('合法输出：一次通过，token 如实记账', async () => {
  const llm = fakeLlm([ok(MINIMAL, { inputTokens: 120, outputTokens: 30 })])
  const outcome = await analyzeDigest({ llm }, INPUT)

  assert.equal(outcome.attempts, 1)
  assert.equal(outcome.inputTokens, 120)
  assert.equal(outcome.outputTokens, 30)
  assert.deepEqual(outcome.output.memories, [])
  // 合同进了系统段：模式、小标题清单都要在（G-003 的"逐字段"由 prompt.ts 保证，这里钉传递）。
  assert.ok(llm.calls[0].system.includes('增量整理'))
  assert.ok(llm.calls[0].system.includes('说话风格'))
})

test('代码围栏与前后杂讯：extractJson 只取首个 { 到末个 }', () => {
  assert.equal(extractJson('好的！```json\n{"a":1}\n``` 希望有帮助'), '{"a":1}')
  assert.throws(() => extractJson('没有对象'), /没有 JSON 对象/)
})

test('第一次坏 JSON、第二次合法：重试一次成功，token 跨尝试累计', async () => {
  const llm = fakeLlm([ok('我觉得这里应该写一段散文', { inputTokens: 100, outputTokens: 20 }), ok(MINIMAL, { inputTokens: 110, outputTokens: 25 })])
  const outcome = await analyzeDigest({ llm }, INPUT)

  assert.equal(outcome.attempts, 2)
  assert.equal(outcome.inputTokens, 210)
  assert.equal(outcome.outputTokens, 45)
  // 重试必须带纠错句（不改合同，只重申合同）。
  assert.ok(llm.calls[1].text.includes('不是合法的 JSON'))
})

test('两次都坏：抛 bad-output（调用方不推游标）', async () => {
  const llm = fakeLlm([ok('散文一'), ok('散文二')])
  await assert.rejects(analyzeDigest({ llm }, INPUT), (error) => error instanceof AnalyzeError && error.code === 'bad-output')
  assert.equal(llm.calls.length, 2)
})

test('字段超合同上限（记忆 21 条）：校验拒绝 → 重试 → 仍坏则抛', async () => {
  const tooMany = JSON.stringify({ memories: Array.from({ length: 21 }, () => ({ content: 'x', scope: 'long-term' })) })
  const llm = fakeLlm([ok(tooMany), ok(tooMany)])
  await assert.rejects(analyzeDigest({ llm }, INPUT), /合同校验/)
})

test('max-tokens 截断：视同失败并重试；仍截断抛 truncated', async () => {
  const llm = fakeLlm([
    { text: '{"memories": [', inputTokens: 90, outputTokens: 1000, finishReason: 'max-tokens' },
    { text: '{"memories": []', inputTokens: 90, outputTokens: 1000, finishReason: 'max-tokens' },
  ])
  await assert.rejects(analyzeDigest({ llm }, INPUT), (error) => error instanceof AnalyzeError && error.code === 'truncated')
})

test('调用层失败（网络/适配器）：收敛成 llm-failed 且**不重试**（重试风暴=烧钱）', async () => {
  const llm = fakeLlm([new Error('adapter exploded')])
  await assert.rejects(analyzeDigest({ llm }, INPUT), (error) => error instanceof AnalyzeError && error.code === 'llm-failed')
  assert.equal(llm.calls.length, 1)
})

test('外部取消：不重试，原样抛出', async () => {
  const controller = new AbortController()
  controller.abort()
  const llm = fakeLlm([ok('散文'), ok(MINIMAL)])
  await assert.rejects(
    analyzeDigest({ llm }, { ...INPUT, signal: controller.signal }),
    (error) => error instanceof AnalyzeError,
  )
  assert.equal(llm.calls.length, 1)
})

// ---------- 路由解析（createLlmAccess.route，2026-09-25 TEST 真机根因的回归钉） ----------

const { createLlmAccess } = await import('../lib/evolution/llm.js')
const { createLog } = await import('../lib/log.js')
const { Context } = await import('@deepseek-ai/cordis')

/** 造假 ctx：按名字回服务。 */
function fakeCtx(services) {
  return { get: (name) => services[name] }
}

test('route：默认模型 + provider 已注册（listProviders 的键是 id！）→ 返回路由', () => {
  const access = createLlmAccess(
    fakeCtx({
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) },
      llm: { listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }], stream: () => ({}) },
    }),
    createLog(new Context(), 'test'),
  )
  assert.deepEqual(access.route(), { provider: 'deepseek-official', model: 'deepseek-flash' })
})

test('route：provider 未在适配器目录 → undefined（不乱选）；服务缺席/抛错同样降级', () => {
  const log = createLog(new Context(), 'test')
  const unregistered = createLlmAccess(
    fakeCtx({
      agentDefaultModel: { currentSelection: () => ({ provider: 'nope', model: 'x' }) },
      llm: { listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }], stream: () => ({}) },
    }),
    log,
  )
  assert.equal(unregistered.route(), undefined)

  const noDefaults = createLlmAccess(fakeCtx({ llm: { listProviders: () => [], stream: () => ({}) } }), log)
  assert.equal(noDefaults.route(), undefined)

  const throwing = createLlmAccess(
    fakeCtx({
      agentDefaultModel: {
        currentSelection: () => {
          throw new Error('boom')
        },
      },
      llm: { listProviders: () => [], stream: () => ({}) },
    }),
    log,
  )
  assert.equal(throwing.route(), undefined, '读取抛错=没配置，降级不抛')
})

test('运行时依赖钉：@deepseek-ai/dsh-llm 可解析且提供 createUserMessage（真机前科：依赖缺失 → 解析运行全灭）', async () => {
  // 2026-09-25 TEST 真机：llm.ts 经 loadOptional 动态 import 该包，而它当时不在依赖里，
  // 从插件目录向上解析不到 ⇒ 每次解析运行以 llm-failed 收场（调度准点、扫描正常、调用必炸）。
  // 这条测试把"包在、工厂函数在"钉死在本仓库的解析路径上。
  const module = await import('@deepseek-ai/dsh-llm')
  assert.equal(typeof module.createUserMessage, 'function')
  const message = module.createUserMessage({
    content: [{ type: 'text', text: 'x' }],
    source: { kind: 'plugin', plugin: 'deepseek-harness-humanity' },
  })
  assert.equal(message.role, 'user')
  assert.ok(typeof message.id === 'string' && message.id.length > 0, '工厂必须赋消息 id（手搓消息会被适配器拒）')
})
