/**
 * 人格"热读"的测试（2026-09-23 真机反馈第 5 条：在工作台改了固定层，对话里读不到）。
 *
 * 这条反馈指向一个**读取路径**的问题，不是渲染问题：
 * - `renderPersonaPrompt` 本身会把 `identityCard.fields` 里**所有**非空字段（含 `custom: true`）都渲出来；
 * - `PromptSection.text` 是函数，`assemble()` 每次拼装都重算（`dsh-system-prompt/lib/index.js:339`）。
 *
 * 于是唯一可疑的地方是**喂给它的那份文档是不是最新的**。原先 `persona.read()` 读的是
 * `installSection` 回调在**注册那一刻**塞给我们的 sink（`setSource`），而写入走的是
 * `ctx.get('settings').replace(...)` —— 也就是设置服务注册表里**当前**的那一条。两者只要不是同一个
 * 对象，就会"写进新的、读出旧的"。
 *
 * 这里钉两条：
 * 1. **读不能信注册时捕获的 sink**：sink 过时也必须读到命名空间的当前值（用假设置服务精确复现）；
 * 2. **端到端热更新**（真实 `SettingsFile` + 真实 `SystemPrompt`）：像工作台那样写一次，
 *    下一次 assemble 就带上新字段 —— 固定层与可变层一视同仁。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
/**
 * 一次装配里**模型真正会看到的文本**：系统提示词 + 各 section + 动态上下文。
 *
 * 人格与记忆走 `systemPrompt.section`（system role）；`assembly.prompt` 在某些组合下是 undefined，
 * 只看它或只看某一个数组都会得出"没注入"的错误结论。
 */
const seenText = (assembly) =>
  [
    assembly.prompt ?? '',
    ...(assembly.sections ?? []).map((section) => section.text),
    ...(assembly.contexts ?? []).map((entry) => entry.text),
  ].join('\n')

import SettingsFile from '@deepseek-ai/dsh-settings-file'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createLog } from '../lib/log.js'
import { CORE_IDENTITY_KEYS } from '../lib/persona/constants.js'
import { createDefaultPersona } from '../lib/persona/model.js'
import { installPersonaInjection } from '../lib/persona/prompt.js'
import { renderPersonaPrompt } from '../lib/persona/render.js'
import { installPersonaSection, PERSONA_NAMESPACE } from '../lib/persona/section.js'

/** 一份"用户已经填过、并且加了自定义字段"的人格。 */
function personaWithCustomFields() {
  const persona = createDefaultPersona()
  persona.identityCard.fields[0].value = '小安'
  persona.identityCard.fields[1].value = '女'
  persona.identityCard.fields[2].value = '温和、直接'
  persona.identityCard.initializedAt = '2026-09-23T00:00:00.000Z'
  persona.identityCard.sealedAt = '2026-09-23T00:00:00.000Z'
  return persona
}

/** 等到 `ctx.inject` 的回调跑过（依赖就位后是微任务）。 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * 一个"读与写不同步"的假设置服务，专门复现旧实现的那条路径。
 *
 * `installSection` 时交给调用方一份**永不更新**的 sink（旧实现只信它）；而 `get()` 返回的
 * 才是"注册表里当前那一条"（写入落在这里）。真机上两者的分叉来自命名空间被重新注册、
 * 或组合被实例化多次；测试里直接把分叉摆出来。
 * @param initial - 命名空间初始值。
 */
function splitBrainSettings(initial) {
  let live = initial
  let sinkCalls = 0
  return {
    /** 当前值（写入方与 `get()` 看到的那一份）。 */
    get: () => live,
    /** 外部推来一份新值（模拟"工作台把新文档写进了注册表里的那一条"）。 */
    push(next) {
      live = next
    },
    installSection: (_owner, _ns, _schema, entry, hooks) => {
      sinkCalls += 1
      // ⚠️ 刻意**封存一份过时值**：旧实现读的就是它，新实现必须绕开它。
      hooks.setSource(() => entry)
      hooks.onChange()
    },
    get sinkCalls() {
      return sinkCalls
    },
    async replace(_ns, section) {
      live = section
    },
    describe: () => [],
  }
}

test('⭐ 读路径不信注册时捕获的 sink：设置表里已经是新值，read() 就必须是新值', async () => {
  const ctx = new Context()
  const before = createDefaultPersona()
  const settings = splitBrainSettings(before)
  ctx.provide('settings', settings)

  const persona = installPersonaSection(ctx, createLog(ctx, 'test'), () => undefined)
  await tick()
  assert.equal(persona.attached, true, '设置服务在场时必须接入')
  assert.equal(settings.sinkCalls, 1)

  // 工作台（或另一个实例）把带自定义字段的新文档写进设置表 —— 但**没人**更新那份 sink。
  const after = personaWithCustomFields()
  after.identityCard.fields.push({ key: '自定义字段A', value: '示例值A', custom: true })
  settings.push(after)

  const read = persona.read()
  assert.ok(
    read.identityCard.fields.some((field) => field.key === '自定义字段A'),
    'read() 必须读到命名空间的当前值，而不是注册那一刻捕获的 sink',
  )
  // 同一份文档直接渲染：自定义字段（custom: true）必须在提示词里。
  const text = renderPersonaPrompt(read, { enabled: true })
  assert.match(text, /自定义字段A（自定义）：示例值A/)

  await ctx.fiber.dispose()
})

test('⭐⭐ 拼装上下文里 ctx.get("settings") 解析不到服务时，仍必须读到新值（21c：优先用注入回调的句柄）', async () => {
  // 这一条钉的是**总管在真机上给出的假设**：提示词拼装发生在 agent loop 的上下文里，
  // 那里 `ctx.get('settings')` 可能返回 undefined（服务在别的上下文/未激活），
  // 于是读路径只能回退到注册那刻的 sink（= 旧值）。
  // 修法：`sctx.settings` 句柄在"服务一定存在"的那一刻拿到，读路径**优先用它**。
  const before = createDefaultPersona()
  const live = personaWithCustomFields()
  live.identityCard.fields.push({ key: '自定义字段A', value: '示例值A', custom: true })

  let sinkCalls = 0
  const fake = {
    // 与真设置服务同形：`get()` 才是"注册表里当前那一条"，`installSection` 交出的 sink 是死的。
    get: () => live,
    installSection: (_owner, _ns, _schema, entry, hooks) => {
      sinkCalls += 1
      hooks.setSource(() => entry) // entry = 空的默认文档（旧值）
      hooks.onChange()
    },
    replace: async () => {},
    describe: () => [],
  }

  /**
   * 一个"解析不到 settings 服务"的宿主上下文：`get()` 永远 undefined，
   * 但 `inject` 仍会像真 cordis 那样把服务交给回调（这正是真机的分叉点）。
   */
  const ctxWithoutLookup = {
    get: () => undefined,
    inject: (_deps, callback) => callback({ settings: fake }),
  }

  const persona = installPersonaSection(ctxWithoutLookup, createLog(ctxWithoutLookup, 'test'), () => undefined)
  assert.equal(sinkCalls, 1)

  const read = persona.read()
  assert.ok(
    read.identityCard.fields.some((field) => field.key === '自定义字段A'),
    'ctx.get 解析不到服务时，必须靠注入回调里捕获的句柄读到当前值（而不是过时的 sink）',
  )
  assert.match(renderPersonaPrompt(read, { enabled: true }), /自定义字段A（自定义）：示例值A/)
  assert.equal(before.identityCard.fields.length, CORE_IDENTITY_KEYS.length)
})

test('Bug A 设置服务尚未就绪时：读到的是空文档、不注入，绝不返回任何旧数据', async () => {
  // 真机现象："重启后第一个打开的旧会话读不到人格"。
  // 方案 3 的保证：就绪之前**只**给空文档（⇒ 渲染成空串 ⇒ 这一轮不注入），
  // 而不是把上一次进程读到的快照注入进去（那比不注入更糟：过时人格会和新人格打架）。
  const ctx = new Context() // 刻意**不挂** settings 服务
  const log = createLog(ctx, 'test')
  const persona = installPersonaSection(ctx, log, () => undefined)
  await tick()

  assert.equal(persona.attached, false, '没有设置服务时不该声称已接入')

  const read = persona.read()
  assert.equal(read.identityCard.fields.every((field) => field.value === ''), true, '必须是中性空文档')
  assert.equal(read.mutableLayer.userDefined.length, 0)

  // 注意：**文档本身**的 `initializedAt` 是空串，所以直接渲染会得到"人格尚未初始化"的引导语；
  // 真正决定"这一轮注不注入"的是注入 provider 的 `ready()` 闸（见下面两条接线用例与
  // prompt.ts 的 `PersonaPromptSource.ready`）—— 空文档不代表用户没初始化过，不能凭它指挥模型。
  assert.match(renderPersonaPrompt(read, { enabled: true }), /人格尚未初始化/)

  await ctx.fiber.dispose()
})

test('Bug A（接线）：设置未就绪（ready=false）时，连"尚未初始化"的引导语都不注入', async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  const agent = { id: 'main' }

  const dispose = installPersonaInjection(ctx, createLog(ctx, 'test'), {
    // 读取路径在设置未就绪时给空默认文档 —— 它的 initializedAt 也是空串，
    // 若不加 ready 闸，就会在启动窗口里向模型宣告"人格尚未初始化"（而用户其实早就初始化过）。
    read: () => createDefaultPersona(),
    ready: () => false,
    enabled: () => true,
  })
  await tick()

  const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent })
  const text = seenText(assembly)
  assert.doesNotMatch(text, /人格尚未初始化/, '未就绪 ⇒ 什么都不注入')
  assert.equal(assembly.sections.find((section) => section.name === 'humanity:persona')?.text, '')

  dispose()
  await ctx.fiber.dispose()
})

test('Bug A（接线）：已就绪且确实未初始化时才注入引导语', async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  const agent = { id: 'main' }

  const dispose = installPersonaInjection(ctx, createLog(ctx, 'test'), {
    read: () => createDefaultPersona(),
    ready: () => true,
    enabled: () => true,
  })
  await tick()

  const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent })
  const text = seenText(assembly)
  assert.match(text, /humanity_persona_init/)

  dispose()
  await ctx.fiber.dispose()
})

test('⭐ 端到端热更新：像工作台那样写一次固定层，下一次 assemble 就带上新字段', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'humanity-hot-'))
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(SettingsFile, { path: path.join(dir, 'settings.yml') })
    const log = createLog(ctx, 'test')

    const persona = installPersonaSection(ctx, log, () => undefined)
    const disposeInjection = installPersonaInjection(ctx, log, {
      read: () => persona.read(),
      enabled: () => true,
    })
    await tick()

    // 装配主体 = agent 本身（`assembleContextFor` 的语义）；这里不提供 agents 注册表，
    // 于是走"有 agent 就注入"的那一支（与本条反馈无关，见 prompt.ts 的三级判定）。
    const agent = { id: 'main' }
    const assembled = async () => {
      const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent })
      return seenText(assembly)
    }

    // 还没写过任何内容时：注入的是**初始化引导语**（而不是空串 —— 否则模型永远不知道要调 init）。
    const beforeAnyWrite = await assembled()
    assert.match(beforeAnyWrite, /humanity_persona_init/)
    assert.doesNotMatch(beforeAnyWrite, /人格底色/)

    // ① 用户在工作台保存第一版（含固定层核心字段）—— 走的就是 `settings.replace` 这条路。
    const first = personaWithCustomFields()
    await ctx.get('settings').replace(PERSONA_NAMESPACE, first)
    assert.match(await assembled(), /姓名：小安/)

    // ② 用户又加了自定义字段（自定义字段A/B/C）并保存：**不重开会话、不重新注册**。
    const second = personaWithCustomFields()
    second.identityCard.fields.push({ key: '自定义字段A', value: '示例值A', custom: true })
    second.identityCard.fields.push({ key: '自定义字段B', value: '示例值B', custom: true })
    second.mutableLayer.sections[0].items = ['先生']
    await ctx.get('settings').replace(PERSONA_NAMESPACE, second)

    const text = await assembled()
    assert.match(text, /自定义字段A（自定义）：示例值A/, '固定层的新字段必须在**下一轮**就出现')
    assert.match(text, /自定义字段B（自定义）：示例值B/)
    assert.match(text, /对用户称呼：先生/, '可变层同一轮写入也要生效（两层一视同仁）')

    disposeInjection()
  } finally {
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('⭐ 固定层自定义字段确实被渲染（含顺序：核心三段式在前，自定义在后）', () => {
  const persona = personaWithCustomFields()
  persona.identityCard.fields.push({ key: '自定义字段A', value: '示例值A', custom: true })
  persona.identityCard.fields.push({ key: '归属地', value: '示例城市', custom: true })

  const text = renderPersonaPrompt(persona, { enabled: true })
  const lines = text.split('\n')

  assert.ok(lines.includes('- 姓名：小安'), '核心字段**不加**「（自定义）」标记')
  assert.ok(lines.includes('- 自定义字段A（自定义）：示例值A'))
  assert.ok(lines.includes('- 归属地（自定义）：示例城市'))
  assert.ok(
    lines.indexOf('- 姓名：小安') < lines.indexOf('- 自定义字段A（自定义）：示例值A'),
    '自定义字段跟随在身份卡字段列表之后（顺序来自文档本身，渲染不重排）',
  )
})

test('⭐ 空值的自定义字段不注入（只写名字没写内容不该进提示词）', () => {
  const persona = personaWithCustomFields()
  persona.identityCard.fields.push({ key: '自定义字段A', value: '   ', custom: true })

  assert.doesNotMatch(renderPersonaPrompt(persona, { enabled: true }), /自定义字段A/)
})
