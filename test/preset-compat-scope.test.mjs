/**
 * 兼容性探测的**作用域**回归测试（审计补充：round 45 的探测范围漏洞）。
 *
 * 为什么必须有这一条：极简 preset 的 `complete: true` 段注册在 **agent 作用域**里
 * （`dsh-agent-presets/presets/minimal/agent.cordis.yml` → `dsh-persona` 在 preset 组合中
 * apply；作用域 key 由 `createScope(loopCtx, this)` 定为 agent 本身 —— 见
 * `packages/core/agent-loop/src/agent.ts:129`）。
 *
 * 而 `systemPrompt.assemble()` **不带 scope 时只看全局层**
 * （`ScopedLayers.chainLayers(undefined)` → 空；见 `packages/core/scope/src/store.ts:192-199`）。
 * 所以"注册后立刻全局装配一次"永远看不到别人注册在 agent 作用域里的 complete 段
 * ⇒ round 45 的警告条在真机极简模式下根本不会出现。探测必须用**同一个 agent 作用域**。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createLog } from '../lib/log.js'
import { createCompatState, probeInjectionSurvived } from '../lib/preset-compat.js'
import { installPersonaInjection } from '../lib/persona/prompt.js'

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * 起一个"我们的全局段 + 别人注册在 agent 作用域里的 complete 段"的组合。
 * @param options.complete - 是否在 agent 作用域里再放一个 complete 段（模拟极简 preset）。
 */
async function boot(options = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  // 我们的段：全局层（真实插件就是这么注册的）。
  ctx.inject(['systemPrompt'], (s) => {
    s.systemPrompt.section({ name: 'humanity:persona', order: 10, text: '人格' })
  })
  await settle()

  // agent 作用域：key 就是 agent 对象本身（与 `createScope(loopCtx, this)` 一致）。
  const agent = { id: 'agent-scope-1' }
  const scope = createScope(ctx, agent)
  if (options.complete === true) {
    scope.ctx.inject(['systemPrompt'], (s) => {
      s.systemPrompt.section({ name: 'minimal:persona', order: 0, text: '极简完整提示词', complete: true })
    })
  }
  await settle()
  return { ctx, agent, scope }
}

test('agent 作用域里的 complete 段：不带 scope 的探测看不到（这正是 round 45 的漏洞）', async () => {
  const { ctx, agent, scope } = await boot({ complete: true })
  try {
    // 前提事实：真实 agent 装配里，我们的段确实被 complete 替换掉了。
    const scoped = await ctx.systemPrompt.assemble({ agent, scope: agent })
    assert.deepEqual(
      scoped.sections.map((section) => section.name),
      ['minimal:persona'],
      'complete 段在 agent 作用域里生效，全局段被替换',
    )

    // 旧行为的证据：全局装配看不到 agent 作用域的 complete 段。
    const globalOnly = await ctx.systemPrompt.assemble()
    assert.ok(globalOnly.sections.some((section) => section.name === 'humanity:persona'),
      '全局装配只看全局层：我们的段在，complete 段不在')
  } finally {
    await scope.dispose()
    await ctx.fiber.dispose()
  }
})

test('带 scope 的探测：极简模式判为 blocked，标准模式判为正常', async () => {
  // 极简：agent 作用域有 complete 段 ⇒ 我们的段会被丢弃。
  const minimal = await boot({ complete: true })
  try {
    const state = createCompatState()
    await probeInjectionSurvived(minimal.ctx.systemPrompt, 'humanity:persona', state, minimal.agent)
    assert.deepEqual(state, { blocked: true, probed: true })
  } finally {
    await minimal.scope.dispose()
    await minimal.ctx.fiber.dispose()
  }

  // 标准：agent 作用域没有 complete 段 ⇒ 我们的段保留。
  const standard = await boot({ complete: false })
  try {
    const state = createCompatState()
    await probeInjectionSurvived(standard.ctx.systemPrompt, 'humanity:persona', state, standard.agent)
    assert.deepEqual(state, { blocked: false, probed: true })
  } finally {
    await standard.scope.dispose()
    await standard.ctx.fiber.dispose()
  }
})

test('注入接线：首次主 Agent 装配会用该 agent 作用域触发探测，并在完成后回调', async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  const agent = { id: 'agent-probe-1' }
  const scope = createScope(ctx, agent)
  scope.ctx.inject(['systemPrompt'], (s) => {
    s.systemPrompt.section({ name: 'minimal:persona', order: 0, text: '极简完整提示词', complete: true })
  })
  await settle()

  const state = createCompatState()
  let notified = 0
  ctx.provide('agents', { roots: () => [agent], list: () => [agent] })
  const dispose = installPersonaInjection(
    ctx,
    createLog(ctx, 'test'),
    {
      read: () => ({ identityCard: { fields: [] }, mutableLayer: { sections: [], userDefined: [] } }),
      enabled: () => true,
      independentJudgment: () => false,
    },
    state,
    () => {
      notified += 1
    },
  )
  await settle()

  // 真实装配（agent loop 就是带 scope 调的）：探测在 `text` 里触发。
  await ctx.systemPrompt.assemble({ agent, scope: agent })
  await settle()
  await settle()

  assert.equal(state.probed, true, '首次主 Agent 装配必须触发探测')
  assert.equal(state.blocked, true, 'agent 作用域的 complete 段必须被判为 blocked')
  assert.ok(notified >= 1, '探测完成必须回调通知，否则工作台的警告条不会刷新')

  dispose()
  await scope.dispose()
  await ctx.fiber.dispose()
})
