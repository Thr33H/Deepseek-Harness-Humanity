/**
 * F1 回归（2026-10-04）：**存储打不开时不得注入「人格尚未初始化」这句假声明**。
 *
 * 事故链条（`reports/persona-inject-flakiness.md` 的裁决 / task-26）：
 * 存储域只要**打不开**（一条记录不符合 schema 就够），`openDomain` 就静默降级为"本次无持久化"
 * （`store-open.ts`）⇒ `state.store` 永不赋值 ⇒ `section.read()` 回落到**空默认文档**，
 * 而空文档的 `initializedAt === ''` ⇒ `renderPersonaPrompt` 走**未初始化分支**、每轮注入
 * `UNINITIALIZED_PROMPT`。**那是一句假话**：用户可能早就初始化过，只是这一轮读不到。
 * 同一根因还让 `humanity_recall` 整场回"存储尚未就绪"。
 *
 * 缺口在 `ready`：它原先只判 `section.attached`（"设置命名空间接上了"），**不判"存储读得到"**。
 *
 * 这里钉**三态**（任务书要求的那三条），并且**走真实的 `installPersona`**（不是只测
 * `renderSectionText` 的入参），这样"`ready` 到底有没有把 store 算进去"是被真跑出来的，
 * 而不是靠读代码相信的：
 *   ① 设置就绪、**存储未就绪** ⇒ 人格段**空串**（不撒谎）
 *   ② 设置就绪、存储就绪、**人格未初始化** ⇒ 注入**引导语**（这时说"未初始化"是真话）
 *   ③ 设置就绪、存储就绪、**人格已初始化** ⇒ 注入**人格段**
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SettingsFile from '@deepseek-ai/dsh-settings-file'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createLog } from '../lib/log.js'
import { createCompatState } from '../lib/preset-compat.js'
import { installPersona } from '../lib/persona/index.js'
import { createDefaultPersona } from '../lib/persona/model.js'
import { PERSONA_NAMESPACE } from '../lib/persona/section.js'

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/** 一次装配里模型真正会看到的文本。 */
const seenText = (assembly) =>
  [assembly.prompt ?? '', ...(assembly.sections ?? []).map((section) => section.text)].join('\n')

/**
 * 起一个真实的最小组合：`SettingsFile` + `SystemPrompt` + 真实的 `installPersona`。
 *
 * 为什么用**真的** `installPersona`：F1 的缺陷恰恰在"`ready` 怎么被接线"这一步，
 * 只喂 `renderSectionText` 一个手写的 `ready` 函数等于把要验的东西假设掉了。
 * @param options.storeReady - `deps.store()` 返回句柄还是 undefined（模拟存储打不开）。
 */
async function boot(options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'humanity-f1-'))
  const ctx = new Context()
  await ctx.plugin(SettingsFile, { path: path.join(dir, 'settings.yml') })
  await ctx.plugin(SystemPrompt, {})
  await settle()

  const handle = installPersona(
    ctx,
    createLog(ctx, 'humanity-test'),
    {
      // 关键的一格：存储打不开时这里是 undefined。
      store: () => (options.storeReady === true ? {} : undefined),
      enabled: () => true,
      independentJudgment: () => true,
    },
    createCompatState(),
    () => {},
  )
  await settle()
  return { ctx, dir, handle, agent: { id: 'f1-agent' } }
}

async function teardown(booted) {
  await booted.handle.dispose()
  await booted.ctx.fiber.dispose()
  await rm(booted.dir, { recursive: true, force: true })
}

/** 读出组装后人格段的文本（没注册或为空串都返回 ''）。 */
async function personaText(booted) {
  const assembly = await booted.ctx.systemPrompt.assemble({ agent: booted.agent, scope: booted.agent })
  const section = (assembly.sections ?? []).find((entry) => entry.name === 'humanity:persona')
  return section?.text ?? ''
}

test('F1 ①：设置就绪但**存储未就绪** ⇒ 人格段是空串（不注入「人格尚未初始化」假声明）', async () => {
  const booted = await boot({ storeReady: false })
  try {
    const text = await personaText(booted)
    assert.equal(text, '', '存储读不到时这一轮什么都不注入')
    assert.doesNotMatch(text, /人格尚未初始化/, '**不得**宣告"未初始化"——那可能是假话')
    assert.doesNotMatch(text, /人格系统（Humanity）/, '引导语也不得出现')
    assert.doesNotMatch(seenText(await booted.ctx.systemPrompt.assemble({ agent: booted.agent, scope: booted.agent })), /人格尚未初始化/)
  } finally {
    await teardown(booted)
  }
})

test('F1 ②：存储就绪 + 人格未初始化 ⇒ 注入引导语（此时"未初始化"是真话）', async () => {
  const booted = await boot({ storeReady: true })
  try {
    const text = await personaText(booted)
    assert.match(text, /人格尚未初始化/, '真·未初始化时要照常引导')
    assert.match(text, /人格系统（Humanity）/, '引导语正文应在')
    assert.doesNotMatch(text, /# 你是谁（人格底色）/, '未初始化时没有底色可注入')
  } finally {
    await teardown(booted)
  }
})

test('F1 ③：存储就绪 + 人格已初始化 ⇒ 注入人格段（不是引导语）', async () => {
  const booted = await boot({ storeReady: true })
  try {
    // 像用户/工作台那样写一份已初始化的人格进命名空间。
    const persona = createDefaultPersona()
    persona.identityCard.fields[0].value = '小安'
    persona.identityCard.initializedAt = '2026-09-23T00:00:00.000Z'
    persona.identityCard.sealedAt = '2026-09-23T00:00:00.000Z'
    await booted.ctx.settings.replace(PERSONA_NAMESPACE, persona)
    await settle()

    const text = await personaText(booted)
    assert.match(text, /# 你是谁（人格底色）/, '已初始化 ⇒ 应注入人格段')
    assert.match(text, /小安/, '卡里的姓名应在')
    assert.doesNotMatch(text, /人格尚未初始化/, '已初始化时不得再说未初始化')
  } finally {
    await teardown(booted)
  }
})

/**
 * 钉子（不是回归，是**防倒退**）：说明"假声明"这个失败形态长什么样。
 *
 * 为什么必须把它写下来：F1 的做法是"读不到就什么都不注入"。这个修法有个副作用 ——
 * **失败变安静了**。以后若有人觉得"空串奇怪"而把 `ready` 那一格删掉，测试库应该立刻告诉他
 * 删掉之后模型会看到什么。所以这里直接钉住**被绕过 gate 时的输出**。
 */
test('F1 钉子：绕过 gate（直接渲染空默认文档）⇒ 真的会出现「人格尚未初始化」——这就是被修掉的假声明', async () => {
  const { renderPersonaPrompt } = await import('../lib/persona/render.js')
  const text = renderPersonaPrompt(createDefaultPersona(), { enabled: true, independentJudgment: true })
  assert.match(text, /人格尚未初始化/, '空默认文档的渲染结果就是那句假声明（故 gate 不可删）')
  assert.match(renderPersonaPrompt(createDefaultPersona(), { enabled: true, independentJudgment: true }), /人格系统（Humanity）/)
})

test('F1 反向：`ready` 必须把 `section.attached` 也算进去（否则未接设置前会误报未初始化）', async () => {
  // 这一条守的是 F1 的**另一半**：新条件不能只剩 store 判断。
  // 没有设置服务时 `section.attached === false`，那时 `read()` 是空默认文档 ——
  // 如果只看 store，一份"存储有、设置没接上"的组合就会又撒谎。
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await settle()
  const handle = installPersona(
    ctx,
    createLog(ctx, 'humanity-test'),
    { store: () => ({}), enabled: () => true, independentJudgment: () => true }, // 存储"就绪"
    createCompatState(),
    () => {},
  )
  const agent = { id: 'f1-agent-nosettings' }
  try {
    await settle()
    const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent })
    const section = (assembly.sections ?? []).find((entry) => entry.name === 'humanity:persona')
    assert.equal(section?.text ?? '', '', '设置没接上 ⇒ 仍不得注入（read() 是空默认文档）')
  } finally {
    await handle.dispose()
    await ctx.fiber.dispose()
  }
})
