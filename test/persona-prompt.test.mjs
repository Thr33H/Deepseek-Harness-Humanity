/**
 * 人格注入的测试（T0）。
 *
 * 三层，各钉一件事：
 * 1. **渲染规则**（纯函数）：开关关掉不注入、没内容不注入、只回摘录、有硬上限；
 * 2. **热更新**（真实 `SystemPrompt`）：`text` 用函数形式 ⇒ 每次 assemble 重算 ⇒
 *    改名后**不重新注册**、下一轮就是新的（这正是真机"改了不生效"的那条）；
 * 3. **scope**（真实 `dsh-scope` 的作用域链）：主 Agent 的 scope 里注入真内容，
 *    子 Agent 的 scope 里注册同名空段 —— 最近作用域赢 ⇒ 子代理**看不到**人格（裁决 2）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createCompatState, probeInjectionSurvived } from '../lib/preset-compat.js'
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

import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createLog } from '../lib/log.js'
import { CORE_IDENTITY_KEYS } from '../lib/persona/constants.js'
import { INIT_DESCRIPTION, PERSONA_INIT_TOOL } from '../lib/persona/init.js'
import { createDefaultPersona } from '../lib/persona/model.js'
import { installPersonaInjection, PERSONA_SECTION_NAME, PERSONA_SECTION_ORDER } from '../lib/persona/prompt.js'
import { renderJudgmentText } from '../lib/persona/prompt-render.js'
import { INDEPENDENT_JUDGMENT_PROMPT, MUTABLE_OPS_GUIDE, uninitializedPrompt } from '../lib/persona/prompt-texts.js'
import { renderPersonaPrompt } from '../lib/persona/render.js'

// 未初始化那段开头要写"今天是几号"：测试钉死日期，否则结果随日历漂移。
const FIXED_NOW = new Date(2026, 10, 14)
const INIT_TEXT = uninitializedPrompt('2026-11-14')
import { withSection } from './helpers/persona-fake.mjs'
import { Config } from '../lib/index.js'
import { PERSONA_UPDATE_TOOL } from '../lib/persona/update.js'

/** 一份"用户已经填过"的人格。 */
function filledPersona() {
  const persona = createDefaultPersona()
  persona.identityCard.fields[0].value = '小安'
  persona.identityCard.fields[1].value = '女'
  persona.identityCard.fields[2].value = '温和、直接'
  persona.identityCard.initializedAt = '2026-09-23T00:00:00.000Z'
  persona.identityCard.sealedAt = '2026-09-23T00:00:00.000Z'
  persona.mutableLayer.sections[0].items = ['先生']
  persona.mutableLayer.sections[1].items = ['先给结论，再给依据']
  return persona
}

test('渲染：开关关掉 → 空串（可一键关闭）', () => {
  assert.equal(renderPersonaPrompt(filledPersona(), { enabled: false }), '')
})

test('渲染：**未初始化**时注入"第一次见面"而不是空串（否则模型不知道要调 init —— 鸡生蛋）', () => {
  // 真机反馈：在已经跑了一段时间的 DSH 上装本插件后，新对话不会引导用户定义姓名等；
  // 全新重置的环境"看起来正常"，因为那时第一次初始化由别的东西触发了。
  const text = renderPersonaPrompt(createDefaultPersona(), { enabled: true })

  assert.match(text, /# 第一次见面/)
  assert.match(text, /你还没有名字/)
  assert.doesNotMatch(text, /姓名：/, '未初始化时没有可注入的身份字段')
})

test('渲染：见面这段只写"做什么"，不写成一步步的流程说明（用户 2026-11-14 定）', () => {
  const text = renderPersonaPrompt(createDefaultPersona(), { enabled: true })

  assert.match(text, /把它们分成两类/, '问题清单不写死：让模型看工具能收什么再自己分类')
  assert.match(text, /一次问完/, '用户 2026-11-14：一次问全，不要挤牙膏')
  assert.match(text, /你替他定一个合理的/, '没问到的由模型补全，不逐项确认')
  assert.match(text, /Humanity 工作台/)
  assert.match(text, /先回应/, '对方先说别的事：先回应，再自然提起')
  assert.match(text, /不要承诺任何你现在做不到的事/)
  assert.doesNotMatch(text, /场景 B/, '场景 B 已删')
  assert.doesNotMatch(text, /判断方法/, '判断方法已删')
  assert.doesNotMatch(text, /观察侧栏/, '不再让模型去看侧栏')
  assert.doesNotMatch(text, /^\d\. /m, '不写编号步骤：那读起来像说明书')
})

test('渲染：引导语里的两个工具名与真实注册的工具名一致（字面量不许漂）', () => {
  assert.ok(INIT_TEXT.includes(PERSONA_INIT_TOOL))
  assert.ok(INIT_TEXT.includes(PERSONA_UPDATE_TOOL))
  assert.equal(INIT_TEXT.includes('humanity_remember'), false, '第一次见面的引导语也不教记忆（2026-11-22 拆开）')
})

test('渲染：初始化完成后自动切换成正常人格内容（引导语消失）', () => {
  const text = renderPersonaPrompt(filledPersona(), { enabled: true })

  assert.doesNotMatch(text, /你还没有名字/)
  assert.match(text, /姓名：小安/)
})

test('渲染：开关关掉时连引导语都不注入（可一键关闭）', () => {
  assert.equal(renderPersonaPrompt(createDefaultPersona(), { enabled: false }), '')
})

test('渲染：标题是「你是{姓名}」，底色字段与信息小节都在', () => {
  const text = renderPersonaPrompt(filledPersona(), { enabled: true })

  assert.match(text, /^## 你是/m, '标题正面陈述身份，不再铺元说明')
  assert.match(text, /姓名：小安/)
  assert.match(text, /对TA的称呼：先生/)
  assert.match(text, /先给结论，再给依据/)
  // 2026-11-15（用户裁定）：三段"身份腔"元说明已删除 —— 它们没说明身份，
  // 反而反复强调"我是一个 AI"，等于把客服/帮手的自我认知按回模型身上。
  assert.doesNotMatch(text, /人格底色/)
  assert.doesNotMatch(text, /运行在 DeepSeek Harness/)
  assert.doesNotMatch(text, /扮演/)
})

test('热更新（真实 SystemPrompt）：text 是函数 ⇒ 改内容后**不重新注册**，下一次 assemble 就是新的', async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})

  let current = filledPersona()
  const dispose = ctx.systemPrompt.context({
    name: PERSONA_SECTION_NAME,
    order: PERSONA_SECTION_ORDER,
    text: () => renderPersonaPrompt(current, { enabled: true }),
  })

  const before = await ctx.systemPrompt.assemble()
  assert.match(seenText(before), /对TA的称呼：先生/)

  // 模拟"用户在后台把称呼改成 老板"：只换数据，**不碰注册**。
  current = filledPersona()
  current.mutableLayer.sections[0].items = ['老板']

  const after = await ctx.systemPrompt.assemble()
  const text = seenText(after)
  assert.match(text, /对TA的称呼：老板/)
  assert.doesNotMatch(text, /对TA的称呼：先生/)

  dispose()
  await ctx.fiber.dispose()
})

test('接线（真实 SystemPrompt + 假 agents 注册表）：主 Agent 有、子代理没有、热更新与开关都生效（裁决 2）', async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})

  // 装配主体 = agent 本身（`assembleContextFor` 的语义），这里用带 id 的普通对象代表 agent。
  const mainAgent = { id: 'main' }
  const childAgent = { id: 'child' }
  const lateRoot = { id: 'late-root' }
  const roots = [mainAgent]

  ctx.provide('agents', {
    roots: () => roots,
    list: () => [...roots, childAgent],
  })

  let current = filledPersona()
  let enabled = true
  const dispose = installPersonaInjection(ctx, createLog(ctx, 'test'), {
    read: () => current,
    enabled: () => enabled,
  })
  // `ctx.inject` 的回调在依赖就位后的微任务里跑，等一拍再断言。
  await new Promise((resolve) => setTimeout(resolve, 0))

  const assemblyFor = async (agent) => {
    const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent })
    return seenText(assembly)
  }

  assert.match(await assemblyFor(mainAgent), /对TA的称呼：先生/, '主 Agent 必须拿到人格')

  const childText = await assemblyFor(childAgent)
  assert.doesNotMatch(childText, /## 你是/, '子代理不该拿到人格')
  assert.doesNotMatch(childText, /对TA的称呼：先生/, '子代理不该拿到人格')

  // 热更新：只改数据、**不重新注册**，下一次 assemble（= 下一轮）就是新的。
  current = filledPersona()
  current.mutableLayer.sections[0].items = ['老板']
  const updated = await assemblyFor(mainAgent)
  assert.match(updated, /对TA的称呼：老板/)
  assert.doesNotMatch(updated, /对TA的称呼：先生/)

  // 开关：关掉后同一装配主体也不再注入（可一键关闭）。
  enabled = false
  assert.doesNotMatch(await assemblyFor(mainAgent), /## 你是/)

  // 插件加载之后新建的**主** Agent 也要被认出来（新开会话走这条）。
  enabled = true
  roots.push(lateRoot)
  ctx.emit('agent/created', { agent: lateRoot })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.match(await assemblyFor(lateRoot), /## 你是/)

  // 没有装配主体（无 scope 的全局拼装）不注入。
  const anonymous = await ctx.systemPrompt.assemble()
  assert.doesNotMatch(seenText(anonymous), /## 你是/)

  dispose()
  await ctx.fiber.dispose()
})

test('人格内容里的 {{…}} 会被中和，不让 DSH 的变量插值抛错（审计 S1-3）', async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})

  const mainAgent = { id: 'main' }
  ctx.provide('agents', { roots: () => [mainAgent], list: () => [mainAgent] })

  const doc = filledPersona()
  // 用户在信息里写模板语法/代码片段是很正常的事。
  doc.mutableLayer.sections[0].items = ['交付模板用 {{answer}} 占位']
  const dispose = installPersonaInjection(ctx, createLog(ctx, 'test'), {
    read: () => doc,
    enabled: () => true,
    independentJudgment: () => false,
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  try {
    // 关键：assemble 不抛（没有兜底，抛一次就毁掉整轮 pre-step），且 `{{` 被拆开。
    const text = seenText(await ctx.systemPrompt.assemble({ agent: mainAgent, scope: mainAgent }))
    assert.match(text, /\{ \{answer\}\} 占位/)
    assert.equal(text.includes('{{'), false, '注入文本里不能再出现连续的 `{{`')
  } finally {
    dispose()
    await ctx.fiber.dispose()
  }
})

test('渲染函数对"形状残缺"的文档也不抛（提示词路径上的输入不受我们控制）', () => {
  // 这条钉的是 2026-09-23 的真机事故：`assemble()` 调用 section provider 时**没有 try/catch**
  // （dsh-system-prompt/lib/index.js:339），我们抛一次就毁掉整轮 pre-step。
  const cases = [
    undefined,
    null,
    {},
    { identityCard: {} },
    { mutableLayer: {} },
    { identityCard: { fields: [{ key: '姓名' }] }, mutableLayer: { sections: [{}] } },
  ]
  for (const doc of cases) {
    const text = renderPersonaPrompt(doc, { enabled: true })
    // 残缺文档**不许出人格内容**：要么空串，要么只剩底部那句独立判断立场（它与文档无关），
    // 绝不能出现姓名/小节之类的"凭空事实"。
    assert.ok(text === '' || text === INDEPENDENT_JUDGMENT_PROMPT, `不该渲染出人格内容：${text}`)
    // 关掉独立判断之后，残缺文档必须**完全**是空串（也就是"低于阈值不注入"的老行为）。
    assert.equal(renderPersonaPrompt(doc, { enabled: true, independentJudgment: false }), '')
  }
})

test('注入接线：读人格时抛错也只会"这轮不注入"，不会让 assemble 失败', async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})

  const mainAgent = { id: 'main' }
  ctx.provide('agents', { roots: () => [mainAgent], list: () => [mainAgent] })

  const dispose = installPersonaInjection(ctx, createLog(ctx, 'test'), {
    read: () => {
      throw new Error('设置服务在读取途中掉了')
    },
    enabled: () => true,
  })
  await new Promise((resolve) => setTimeout(resolve, 0))

  // 关键：assemble 必须**正常返回**（它的 provider 调用没有 try/catch，抛出去就是 pre-step 失败）。
  const assembly = await ctx.systemPrompt.assemble({ agent: mainAgent, scope: mainAgent })
  assert.doesNotMatch(seenText(assembly), /人格底色/)
  assert.equal(assembly.sections.find((section) => section.name === PERSONA_SECTION_NAME)?.text, '')

  dispose()
  await ctx.fiber.dispose()
})

test('⛔ 真机事故回归：注入**不声明 agents 依赖** —— 没有 agents 服务时也照常注册并注入', async () => {
  // 2026-09-23 真机：`ctx.inject(['agents','systemPrompt'], …)` 把 agents 声明成本插件 fiber 的依赖，
  // 会让组合失活 —— 每个会话都创建失败：
  //   `cannot get required service "agents" in inactive context`
  // 这条测试钉住修复：**只声明 systemPrompt**，agents 用不声明依赖的只读查找（读不到就安全退化）。
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  // 刻意**不提供** agents 服务：老实现下 inject 回调根本不会跑（一段都不注册）。
  assert.equal(ctx.get('agents'), undefined)

  const mainAgent = { id: 'main' }
  const dispose = installPersonaInjection(ctx, createLog(ctx, 'test'), {
    read: () => filledPersona(),
    enabled: () => true,
  })
  await new Promise((resolve) => setTimeout(resolve, 0))

  const assembly = await ctx.systemPrompt.assemble({ agent: mainAgent, scope: mainAgent })
  const text = seenText(assembly)
  assert.match(text, /对TA的称呼：先生/, '没有 agents 服务也必须照常注入（不再依赖它）')

  dispose()
  await ctx.fiber.dispose()
})

test('真机事故回归：子代理判定优先看 agent 上的归属标记（前瞻），注册表读不到时不抛', async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})

  // 带归属标记的主体：即使读得到注册表，也必须判定为"非主 Agent"。
  const ownedAgent = { id: 'child', parentAgent: { id: 'parent' } }
  ctx.provide('agents', { roots: () => [ownedAgent], list: () => [ownedAgent] })

  const dispose = installPersonaInjection(ctx, createLog(ctx, 'test'), {
    read: () => filledPersona(),
    enabled: () => true,
  })
  await new Promise((resolve) => setTimeout(resolve, 0))

  const assembly = await ctx.systemPrompt.assemble({ agent: ownedAgent, scope: ownedAgent })
  assert.doesNotMatch(seenText(assembly), /人格底色/)

  dispose()
  await ctx.fiber.dispose()
})

/* ---------------------------------------------------------------------------
 * 2026-09-23 数据模型调整后的注入表现
 * ------------------------------------------------------------------------- */

test('渲染：新增的核心字段「主语言」以核心字段身份出现（不带「（自定义）」标记）', () => {
  const persona = filledPersona()
  persona.identityCard.fields.push({ key: '主语言', value: '中文', custom: false })

  const text = renderPersonaPrompt(persona, { enabled: true })

  assert.match(text, /- 主语言：中文/)
  assert.doesNotMatch(text, /主语言（自定义）/, '核心字段不该被当成自定义字段')
})

test('渲染：非原生小节（如「情绪」）照样进提示词；旧标题「当前状态」不出现在渲染里', () => {
  const persona = filledPersona()
  // 0.1.14：默认文档只有 4 个原生小节 —— 「情绪」现在是**自定义项**，夹具显式加上；
  // 它进提示词的待遇与以前完全相同（"其余都一样待遇"）。
  withSection(persona, '情绪', ['今天有点累，回复简短些'])

  const text = renderPersonaPrompt(persona, { enabled: true })

  assert.match(text, /- 情绪：今天有点累，回复简短些/)
  assert.doesNotMatch(text, /当前状态/)
})

/* ---------------------------------------------------------------------------
 * 独立判断底层指令（用户 2026-09-23 定）：硬编码、不显示、不被覆盖、可开关
 * ------------------------------------------------------------------------- */

// ───────────── 独立判断：2026-11-15 起是独立段（order 25），不再拼在人格段里 ─────────────

/** 造一个假的人格源 + 运行时，只测"该不该注入、注入什么"。 */
const judgmentOf = ({ sealed = true, enabled = true, flag = true, main = true } = {}) => {
  const doc = filledPersona()
  doc.identityCard.sealedAt = sealed ? '2026-09-23T00:00:00.000Z' : ''
  return renderJudgmentText(
    { agent: { id: 'main' } },
    {
      source: { read: () => doc, enabled: () => enabled, independentJudgment: () => flag },
      isMainAgent: () => main,
      probe: () => {},
      log: { info() {}, warn() {}, error() {}, debug() {} },
    },
  )
}

test('独立判断：标题是「## 保持你的独立」，且只在**底色封存之后**注入', () => {
  assert.match(judgmentOf({ sealed: true }), /^## 保持你的独立/)
  assert.equal(judgmentOf({ sealed: false }), '', '未封存时注入会让模型拿它拒绝对方刚设定的设定')
})

test('独立判断：开关关掉、或装配主体不是主 Agent 时不注入', () => {
  assert.equal(judgmentOf({ flag: false }), '')
  assert.equal(judgmentOf({ main: false }), '')
  assert.equal(judgmentOf({ enabled: false }), '')
})

test('独立判断：正文仍是 2026-10-06 定稿版（不是空标题、也不是旧措辞）', () => {
  const text = judgmentOf()
  assert.ok(text.length > 150, '正文要有实质内容（定稿版约 160 字）')
  assert.doesNotMatch(text, /不覆盖当前对话里的明确要求/, '无作用域的旧退让条款不得回来')
})

test('独立判断：开关在设置命名空间里可见且有默认值（工作台只露开关，不显示正文）', () => {
  assert.equal(Config({}).independentJudgment, true)
  assert.equal(Config({ independentJudgment: false }).independentJudgment, false)
})

test('独立判断：配置键就是 independentJudgment（2026-10-06 改名，旧键 antiSycophancy 不再读）', () => {
  // 键名是**对外契约**（设置界面/API/用户配置文件都按它写），改名是一次有意的破坏性变更：
  // 钉住新键生效、旧键不再被 schema 接受，免得以后有人"顺手"把旧键加回来做兼容而没人知道。
  assert.equal(Config({ independentJudgment: false }).independentJudgment, false)
  assert.equal('antiSycophancy' in Config({}), false, '旧键不该留在生效配置里')
  assert.equal(Config({ antiSycophancy: false }).independentJudgment, true, '旧键不再影响开关（回落到默认开）')
})

test('init 工具描述划清底色与信息（真机：AI 曾把称呼写进底色）', () => {
  // 真机反馈（2026-09-24）：首次初始化时 AI 把"称呼"写进底色自定义字段。
  // 根因是工具描述只说了"引导用户描述他希望这个 AI 是什么样的人"，没划清两个层。
  assert.match(INIT_DESCRIPTION, /底色只放/)
  assert.match(INIT_DESCRIPTION, /不属于\*\*底色|不属于/, '必须明说哪些信息不属于底色')
  assert.match(INIT_DESCRIPTION, /对TA的称呼/, '称呼的归属必须点名')
  assert.match(INIT_DESCRIPTION, /humanity_persona_update/, '要给出正确的落点（信息工具）')
  // 核心字段名从常量派生：增减核心字段时这段描述不会漏。
  for (const key of CORE_IDENTITY_KEYS) assert.ok(INIT_DESCRIPTION.includes(key), `描述里缺少核心字段「${key}」`)
})

test('引导语也区分两个层，并给出"称呼不放底色"的明确指令', () => {
  assert.match(INIT_TEXT, /底色/)
  assert.match(INIT_TEXT, /信息/)
  assert.match(INIT_TEXT, /称呼\*\*不要\*\*放进底色|不要\*\*放进底色/)
})

test('平台限制（已接受）：极简模式的 complete section 会吞掉我们注入的段', async () => {
  // 真机：极简模式（preset 的 persona section 带 complete: true）下，人格与记忆的注入**整段消失**。
  // 根因在 DSH 的装配：存在 complete section 时 `sections: [completeSection]` —— 其余 section 全被替换掉。
  // 我们试过改走 `context` 绕开，但那会把注入降到 user role（模型遵从度更低），
  // 因此**标准模式坚持用 section、极简模式不注入**，并在此把这条平台行为钉住。
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  ctx.systemPrompt.section({ name: 'minimal:persona', order: 0, text: '极简模式的人格', complete: true })
  ctx.systemPrompt.section({ name: 'humanity:persona', order: 10, text: '人格内容' })
  ctx.systemPrompt.section({ name: 'humanity:memory', order: 20, text: '记忆内容' })
  await new Promise((resolve) => setTimeout(resolve, 0))

  const assembly = await ctx.systemPrompt.assemble()
  assert.deepEqual(
    assembly.sections.map((section) => section.name),
    ['minimal:persona'],
    'complete section 会把其它 sections 全部替换掉（这正是"极简模式不注入"的机制）',
  )

  await ctx.fiber.dispose()
})

test('兼容性探测：complete section 在场时判定为"注入被丢弃"，正常时判定为正常', async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})

  // 正常组合：注册自己的段 → 探测看得到它。
  const normal = createCompatState()
  ctx.inject(['systemPrompt'], (s) => {
    s.systemPrompt.section({ name: 'humanity:persona', order: 10, text: '人格' })
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  await probeInjectionSurvived(ctx.systemPrompt, 'humanity:persona', normal)
  assert.deepEqual(normal, { blocked: false, probed: true })

  // 极简模式：多一个 complete section ⇒ 自己的段被替换掉。
  const blocked = createCompatState()
  ctx.systemPrompt.section({ name: 'minimal:persona', order: 0, text: '极简', complete: true })
  await probeInjectionSurvived(ctx.systemPrompt, 'humanity:persona', blocked)
  assert.deepEqual(blocked, { blocked: true, probed: true })

  await ctx.fiber.dispose()
})

test('初始化后注入操作约定段：只讲人格自己的用法，不教记忆（2026-11-22 拆开）', () => {
  const text = renderPersonaPrompt(filledPersona(), { enabled: true })
  assert.equal(text.includes(MUTABLE_OPS_GUIDE), true, '已初始化的人格注入必须带操作约定段')
  assert.equal(text.includes('humanity_persona_update'), true)
  assert.equal(text.includes('humanity_remember'), false, '记忆的用法归记忆自己，系统提示词里不再出现')

  // 未初始化时只有引导语（引导语自己讲清了分层），不叠操作约定段。
  const uninit = renderPersonaPrompt({ ...filledPersona(), identityCard: { ...filledPersona().identityCard, initializedAt: '' } }, { enabled: true, now: FIXED_NOW })
  assert.equal(uninit, INIT_TEXT)
})
