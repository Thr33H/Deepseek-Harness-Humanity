/**
 * 净室排除 guard 的测试（真实工具管线 + 假投影服务）。
 *
 * 用**桩工具**（只借 Humanity 的工具名）而不是真 persona/memory 模块：本 guard 的判据是
 * 「工具名 + 会话 preset」，与工具业务无关；用桩才能把拒绝归因唯一钉到本 guard 上
 * （真工具的函数体与其它 guard 也会产出拒绝文案，归因会糊）。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SettingsFile from '@deepseek-ai/dsh-settings-file'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { CLEAN_ROOM_REASON, installExclusionGuard } from '../lib/exclusion-guard.js'
import { createLog } from '../lib/log.js'
import { PERSONA_UPDATE_TOOL } from '../lib/persona/update.js'

/**
 * 起一套真实工具管线 + 本 guard。
 * @param projected - 假投影服务的读法；传 undefined 表示环境里没有投影服务（回退 meta）。
 */
async function boot(projected) {
  const dir = await mkdtemp(path.join(tmpdir(), 'humanity-exclusion-'))
  const ctx = new Context()
  const log = createLog(ctx, 'test')
  // 与 persona-tools 的 boot 同形态：实测三插件组合下 root ctx 才可见 `tools` 服务属性，
  // 单挂 ToolRuntime 时它永不出现（2026-09-25 探针实证）。
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(SettingsFile, { path: path.join(dir, 'settings.yml') })
  await ctx.plugin(ToolRuntime, {})
  for (let attempt = 0; attempt < 50 && ctx.tools === undefined; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  if (projected !== undefined) {
    ctx.provide('sessionProjections', { stateOf: (session) => projected(session) })
  }
  ctx.tools.register({
    name: PERSONA_UPDATE_TOOL,
    description: 'stub',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'object', properties: {} },
      render: () => ({ type: 'text', text: 'stub-ok' }),
    },
    execute: async () => ({}),
  })
  ctx.tools.register({
    name: 'stub-platform-tool',
    description: 'stub',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'object', properties: {} },
      render: () => ({ type: 'text', text: 'platform-ok' }),
    },
    execute: async () => ({}),
  })
  installExclusionGuard(ctx, log)
  await new Promise((resolve) => setTimeout(resolve, 0))

  return {
    call: (agent) =>
      ctx.tools.execute({
        callId: 'call-exclusion',
        name: PERSONA_UPDATE_TOOL,
        arguments: {},
        signal: new AbortController().signal,
        ...(agent === undefined ? {} : { agent }),
      }),
    callRaw: (agent, name) =>
      ctx.tools.execute({
        callId: `call-${name}`,
        name,
        arguments: {},
        signal: new AbortController().signal,
        ...(agent === undefined ? {} : { agent }),
      }),
    textOf: (result) => result.content.map((block) => block.text ?? '').join('\n'),
    dispose: async () => {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

const minimalAgent = { id: 'a-min', session: { id: 's-min', meta: { agentPreset: 'minimal' } } }
const standardAgent = { id: 'a-std', session: { id: 's-std', meta: { agentPreset: 'standard' } } }
const metaOf = (session) => session.meta?.agentPreset ?? null

test('极简会话：Humanity 工具被 guard 拒绝，理由说清为什么与怎么办', async () => {
  const harness = await boot(metaOf)
  try {
    const result = await harness.call(minimalAgent)
    assert.equal(result.isError, true, '净室会话里 Humanity 工具必须失败')
    assert.ok(harness.textOf(result).includes(CLEAN_ROOM_REASON), '拒绝文案必须来自排除 guard 原文')
  } finally {
    await harness.dispose()
  }
})

test('标准会话：排除 guard 不动作，桩工具照常执行', async () => {
  const harness = await boot(metaOf)
  try {
    const result = await harness.call(standardAgent)
    assert.notEqual(result.isError, true, '丰富预设不得被排除 guard 误伤')
  } finally {
    await harness.dispose()
  }
})

test('切换过的会话以投影为准：meta 仍是 standard、投影为 minimal ⇒ 拒绝（真机 bf59 场景）', async () => {
  const harness = await boot((session) => (session.id === 's-std' ? 'minimal' : metaOf(session)))
  try {
    const result = await harness.call(standardAgent)
    assert.equal(result.isError, true, 'GUI 切换后 meta 不更新，投影才是真源')
    assert.ok(harness.textOf(result).includes(CLEAN_ROOM_REASON))
  } finally {
    await harness.dispose()
  }
})

test('投影服务缺席：回退会话头 meta，guard 仍然工作（G-002 降级不失效）', async () => {
  const harness = await boot(undefined)
  try {
    const denied = await harness.call(minimalAgent)
    assert.equal(denied.isError, true)
    const passed = await harness.call(standardAgent)
    assert.notEqual(passed.isError, true)
  } finally {
    await harness.dispose()
  }
})

test('非 Humanity 工具名：排除 guard 一律放行（不误伤平台工具）', async () => {
  const harness = await boot(metaOf)
  try {
    const result = await harness.callRaw(minimalAgent, 'stub-platform-tool')
    assert.notEqual(result.isError, true, '平台工具在极简会话里不得被本 guard 拒绝')
  } finally {
    await harness.dispose()
  }
})
