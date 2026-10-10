/**
 * 身份层的测试：第一方身份前缀在装配里被按名摘除，开关关掉时原样保留。
 *
 * 为什么用真实 `dsh-system-prompt`：要证明的是「DSH 自己的装配流水线里，我们的 waterfall
 * 监听真的能摘掉那段前缀」——替身装配测不到平台顺序与 complete 恢复语义。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { PERSONA_PREFIX_SECTION, PERSONA_SUFFIX_SECTION } from '@deepseek-ai/dsh-system-prompt'
import { createLog } from '../lib/log.js'
import { installIdentityLayer } from '../lib/persona/identity-layer.js'

/** 起一套真实系统提示词装配 + 身份层。 */
async function boot(enabled) {
  const ctx = new Context()
  const log = createLog(ctx, 'test')
  await ctx.plugin(SystemPrompt, {
    personaPrefix: 'You are a coding agent powered by the {{model}} model.',
    personaSuffix: 'Your working directory is {{cwd}}.',
  })
  installIdentityLayer(ctx, log, enabled)
  await new Promise((resolve) => setTimeout(resolve, 0))
  return ctx
}

/** 一次全局装配里各段的名字。 */
async function sectionNames(ctx) {
  const assembly = await ctx.systemPrompt.assemble()
  return assembly.sections.map((section) => section.name)
}

test('身份层开启：第一方身份前缀被摘除，suffix（工作目录事实）保留', async () => {
  const ctx = await boot(() => true)
  try {
    const names = await sectionNames(ctx)
    assert.equal(names.includes(PERSONA_PREFIX_SECTION), false, '身份前缀必须被摘除（双重身份声明会把人格卡降格成角色扮演）')
    assert.ok(names.includes(PERSONA_SUFFIX_SECTION), '工作目录是事实不是身份，必须保留')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('身份层关闭（Humanity 总开关 off）：第一方身份原样保留', async () => {
  const ctx = await boot(() => false)
  try {
    const names = await sectionNames(ctx)
    assert.ok(names.includes(PERSONA_PREFIX_SECTION), 'Humanity 关掉时不代管部署的身份')
  } finally {
    await ctx.fiber.dispose()
  }
})
