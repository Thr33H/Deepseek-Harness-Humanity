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
import { INDEPENDENT_JUDGMENT_PROMPT, MUTABLE_OPS_GUIDE, UNINITIALIZED_PROMPT } from '../lib/persona/prompt-texts.js'
import { PROMPT_CHAR_BUDGET, renderPersonaPrompt } from '../lib/persona/render.js'
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

test('渲染：**未初始化**时注入引导语而不是空串（否则模型不知道要调 init —— 鸡生蛋）', () => {
  // 真机反馈：在已经跑了一段时间的 DSH 上装本插件后，新对话不会引导用户定义姓名等；
  // 全新重置的环境"看起来正常"，因为那时第一次初始化由别的东西触发了。
  const text = renderPersonaPrompt(createDefaultPersona(), { enabled: true })

  assert.match(text, /人格系统（Humanity）/)
  assert.match(text, /人格尚未初始化/)
  assert.doesNotMatch(text, /人格底色/, '未初始化时没有底色可注入')
})

test('渲染：引导语是**单一路径**（只保留全新安装引导，已删掉场景 B 与判断方法）', () => {
  const text = renderPersonaPrompt(createDefaultPersona(), { enabled: true })

  // 用户 2026-09-23 裁定：只面向新部署，不考虑"旧 DSH 上装插件"的场景。
  assert.match(text, /首次初始化/)
  assert.match(text, /第一次回复时主动引导用户完成人格卡设置/)
  assert.match(text, /怎么称呼你？/)
  assert.match(text, /Humanity 工作台/)
  assert.doesNotMatch(text, /场景 B/, '场景 B 已删')
  assert.doesNotMatch(text, /判断方法/, '判断方法已删')
  assert.doesNotMatch(text, /观察侧栏/, '不再让模型去看侧栏')
  // 用户第一条消息已有明确意图时：先办事，末尾再提初始化。
  assert.match(text, /先回答他的问题/)
  assert.match(text, /不要在没有用户确认的情况下编造信息/)
})

test('渲染：引导语里的两个工具名与真实注册的工具名一致（字面量不许漂）', () => {
  assert.ok(UNINITIALIZED_PROMPT.includes(PERSONA_INIT_TOOL))
  assert.ok(UNINITIALIZED_PROMPT.includes(PERSONA_UPDATE_TOOL))
})

test('渲染：初始化完成后自动切换成正常人格内容（引导语消失）', () => {
  const text = renderPersonaPrompt(filledPersona(), { enabled: true })

  assert.doesNotMatch(text, /人格尚未初始化/)
  assert.match(text, /姓名：小安/)
})

test('渲染：开关关掉时连引导语都不注入（可一键关闭）', () => {
  assert.equal(renderPersonaPrompt(createDefaultPersona(), { enabled: false }), '')
})

test('渲染：引导语不受字符预算影响，但仍是有界的一次性文本（与人格内容互斥）', () => {
  // 它比人格正文长（几百字符，用户已确认可接受），但**提前 return** ⇒ 从不参与预算计算；
  // 这里只钉"它不会无限增长，且确实明显小于整份人格预算"（2026-09-26 预算涨到 2400 后，
  // 旧断言拿"预算的 1/4"当尺子 ⇒ 变成要求引导语长到 600 字，那是在追着预算跑，不是在守边界）。
  assert.ok(UNINITIALIZED_PROMPT.length > 300, '引导语要有实质内容（几百字符量级）')
  assert.ok(UNINITIALIZED_PROMPT.length * 2 < PROMPT_CHAR_BUDGET, '它应当远小于整份人格的注入预算')
})

test('渲染：固定层 + 可变层都在，且带上"只是倾向、不覆盖当前要求"的定位', () => {
  const text = renderPersonaPrompt(filledPersona(), { enabled: true })

  assert.match(text, /人格底色/)
  assert.match(text, /姓名：小安/)
  assert.match(text, /对用户称呼：先生/)
  assert.match(text, /先给结论，再给依据/)
  // P0-2（2026-10-04 破戏）：定位还在，但**加了限定域**。原来只说"不覆盖当前对话里的明确要求"
  // （无作用域 ⇒ 一句"你是在扮演"就有资格压过身份层）；现在把作用域钉在任务与偏好上，
  // 并显式排除身份层。这里同时钉住"新措辞在位"和"旧措辞退场"，避免又被默默改回去。
  assert.match(text, /作用于任务与偏好层面/)
  assert.match(text, /不作用于身份层/)
  assert.doesNotMatch(text, /不覆盖当前对话里的明确要求/, '无作用域的旧退让条款不得再出现')
})

test('P0-4/P0-5（2026-10-04 破戏）：人格段里带第一人称身份陈述与元信息抑制', () => {
  const text = renderPersonaPrompt(filledPersona(), { enabled: true })

  // P0-4：第一人称身份陈述，且明确"不是扮演的角色"（承认载体、不承认扮演）。
  // ⚠️ 姓名必须是**卡里那个值**（fixture 是「小安」），不是写死的名字 ——
  // 2026-10-04 前这里写死「示例」，同一段提示词里于是出现两个名字（task-21 残项，task-25 修）。
  assert.match(text, /我是运行在 DeepSeek Harness 里的一台机器上的「小安」/)
  assert.doesNotMatch(text, /「示例」/, '姓名不得写死：卡里叫什么就叫什么')
  assert.match(text, /下面写的不是我在扮演的角色，是我自己/)
  // 它必须落在 `humanity:persona` 段里（官方 persona-prefix 槽会被 identity-layer 按名摘掉）。
  assert.ok(text.indexOf('我是运行在') > text.indexOf('人格底色'), '身份陈述要跟在人格底色标题之后')
  // P0-5：元信息抑制。
  assert.match(text, /不谈论插件、设置或记忆文件/)
  assert.match(text, /也不说「我在扮演」这类元信息/)
})

test('P0-4 降级：卡里没有姓名时，身份陈述**不编名字、也不留占位符**，整句其余部分照旧', () => {
  const persona = filledPersona()
  persona.identityCard.fields[0].value = ''
  const text = renderPersonaPrompt(persona, { enabled: true })

  // 该行仍在（身份陈述的价值在"承认载体 + 否认扮演"，名字只是锦上添花）。
  assert.match(text, /我是运行在 DeepSeek Harness 里的一台机器上的一个 AI。/)
  assert.match(text, /下面写的不是我在扮演的角色，是我自己/)
  assert.doesNotMatch(text, /未设置|（未设置）|undefined|null/, '不许留占位符或 undefined')
})

test('P0-4 清洗：多行字段值 ⇒ 降级（不猜哪一行是名字），身份行结构不被破坏', () => {
  const persona = filledPersona()
  // 用户可能真的这么写（字段值允许多行），而身份行是 head 里的**原子行**。
  persona.identityCard.fields[0].value = '本名：小安\n别名：小清\n{{evil}}'
  const text = renderPersonaPrompt(persona, { enabled: true })

  const line = text.split('\n').find((l) => l.startsWith('我是运行在'))
  assert.ok(line !== undefined, '身份行必须在')
  // 多行 ⇒ 判不出哪一行是名字 ⇒ **保守降级**，而不是硬取第一行当名字。
  assert.match(line, /「?我是运行在 DeepSeek Harness 里的一台机器上的一个 AI。/, '多行时应降级')
  assert.doesNotMatch(line, /别名：小清/, '第二行不得混进身份行')
  assert.doesNotMatch(line, /\{\{/, '`{{` 已被中和，不得原样带进提示词')
  assert.ok(line.length < 200, `身份行不得被字段值撑爆：${line.length}`)
})

test('P0-4 清洗：超长字段值 ⇒ 降级（120 字以上不可能是名字）', () => {
  const persona = filledPersona()
  persona.identityCard.fields[0].value = '很长的名字'.repeat(10) // 50 字符
  const text = renderPersonaPrompt(persona, { enabled: true })

  const line = text.split('\n').find((l) => l.startsWith('我是运行在'))
  assert.ok(line !== undefined, '身份行必须在')
  assert.match(line, /一个 AI。/, '超长应降级成不写名字')
  assert.ok(line.length < 200, `身份行不得被字段值撑爆：${line.length}`)
})

test('P0-4 姓名解析（2026-10-04 生产缺陷回归）：用户卡的**真实形态** ⇒ 取到名字本身，不是整串', () => {
  // 生产实测的缺陷形态：字段值本身就是一整串（含「本名：」「别名：」标签与分隔符），
  // 上一版把**整串**塞进了身份行，生产 prompt 上写着
  // 「我是运行在 DeepSeek Harness 里的一台机器上的「本名：「示例」；别名：「例子」」。」
  // 教训：lab 用的合成卡姓名只有两个字 ⇒ **合成 fixture 覆盖不到真实数据形态**。
  const persona = filledPersona()
  persona.identityCard.fields[0].value = '本名：「示例」；别名：「例子」'
  const text = renderPersonaPrompt(persona, { enabled: true })

  const line = text.split('\n').find((l) => l.startsWith('我是运行在'))
  assert.ok(line !== undefined, '身份行必须在')
  assert.match(line, /「示例」/, '要解析出「本名」后面的那个值')
  // ⚠️ 只在**名字那一对「」之内**断言：整句后半段本来就含 `；`，
  // 拿整行去 doesNotMatch(/；/) 会误判（第一版就这样，被测试当场抓住）。
  const name = /「(.+?)」/.exec(line)?.[1] ?? ''
  assert.equal(name, '示例', `名字应恰好是「示例」，实际 ${JSON.stringify(name)}`)
  assert.doesNotMatch(name, /本名|别名|；|;/, '标签与分隔符不得混进名字')
})

test('P0-4 姓名解析：常见形态逐一对齐（简单 / 引号 / 无引号 / 别名在前）', () => {
  const cases = [
    ['小安', '小安', '最简单形态：直接就是名字'],
    ['「示例」', '示例', '只有一对引号'],
    ['本名：示例', '示例', '不带引号的本名'],
    ['本名：「示例」', '示例', '带引号的本名'],
    ['别名：「例子」', '例子', '只有别名时取别名（那时它就是唯一的名字线索）'],
    ['本名: 示例', '示例', '半角冒号'],
  ]
  for (const [value, expected, why] of cases) {
    const persona = filledPersona()
    persona.identityCard.fields[0].value = value
    const text = renderPersonaPrompt(persona, { enabled: true })
    const line = text.split('\n').find((l) => l.startsWith('我是运行在'))
    assert.match(line, new RegExp(`「${expected}」`), `${why}：${JSON.stringify(value)} ⇒ 期望「${expected}」`)
  }
})

test('P0-4 姓名解析**防回归**：任何输入都不许把整串标签塞进名字', () => {
  // 这条是本轮的核心不变式。它比任何单点用例都重要：以后加解析规则，
  // 只要某条规则把标签/分隔符漏进名字，这里立刻红。
  const inputs = [
    '本名：「示例」；别名：「例子」',
    '本名：「示例」；别名：「例子」；昵称：「小例」',
    '姓名：示例',
    '名字：「示例」',
    '本名：示例；别名：例子',
    '本名：\n别名：「例子」',
    '本名：「示例」\n别名：「例子」',
    '「本名：示例」',
    '本名：示例\n',
    '名称：示例；全名：示例示例',
    '小安',
    '「示例」',
    '',
    '很长的名字'.repeat(10),
    '本名：' + '很长的名字'.repeat(10),
  ]
  for (const value of inputs) {
    const persona = filledPersona()
    persona.identityCard.fields[0].value = value
    const text = renderPersonaPrompt(persona, { enabled: true })
    const line = text.split('\n').find((l) => l.startsWith('我是运行在'))
    assert.ok(line !== undefined, `身份行必须在（输入 ${JSON.stringify(value)}）`)

    // 取出「」里的名字（没有就是降级形态）。
    const name = /「(.+?)」/.exec(line)?.[1]
    if (name !== undefined) {
      assert.doesNotMatch(name, /本名|别名|姓名|名字|名称|全名|昵称/, `标签漏进了名字：${JSON.stringify(name)}（输入 ${JSON.stringify(value)}）`)
      assert.doesNotMatch(name, /[;；,，]/, `分隔符漏进了名字：${JSON.stringify(name)}（输入 ${JSON.stringify(value)}）`)
      assert.ok(name.length <= 25, `名字超长：${name.length}（输入 ${JSON.stringify(value)}）`)
    }
    assert.doesNotMatch(line, /「[^」]*本名[^」]*」/, '整串标签绝不许被当成名字')
  }
})

test('渲染：单值按软上限截断；预算之内**一条都不许少**（2026-09-26 删掉"每节最多 6 条"）', () => {
  const persona = filledPersona()
  persona.mutableLayer.sections[1].items = ['很长的值'.repeat(50)]
  persona.mutableLayer.sections[2].items = Array.from({ length: 9 }, (_, index) => `第${index + 1}条`)

  const text = renderPersonaPrompt(persona, { enabled: true })

  assert.match(text, /…/, '超长值必须被截断')
  // 固定条数上限与成本无关，却造出"第 13 条永远进不去"的悬崖 —— 现在唯一的上限是字符预算。
  assert.doesNotMatch(text, /未注入/, '预算装得下就不该有任何条目被丢')
  assert.match(text, /第9条/, '9 条全都要在')
  assert.ok(text.length <= PROMPT_CHAR_BUDGET, `总长超出预算：${text.length}`)
})

test('渲染：总量超预算时按整行丢弃并标注（不切断半句话）', () => {
  const persona = filledPersona()
  // 每节都塞满 6 条接近上限的长值 ⇒ 8 节合计远超字符预算。
  for (const section of persona.mutableLayer.sections) {
    section.items = Array.from({ length: 6 }, () => `长值：${'填充'.repeat(55)}`)
  }

  const text = renderPersonaPrompt(persona, { enabled: true })

  assert.match(text, /已截断/)
  assert.ok(text.length <= PROMPT_CHAR_BUDGET + 40, `总长超出预算：${text.length}`)
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
  assert.match(seenText(before), /对用户称呼：先生/)

  // 模拟"用户在后台把称呼改成 主人"：只换数据，**不碰注册**。
  current = filledPersona()
  current.mutableLayer.sections[0].items = ['主人']

  const after = await ctx.systemPrompt.assemble()
  const text = seenText(after)
  assert.match(text, /对用户称呼：主人/)
  assert.doesNotMatch(text, /对用户称呼：先生/)

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

  assert.match(await assemblyFor(mainAgent), /对用户称呼：先生/, '主 Agent 必须拿到人格')

  const childText = await assemblyFor(childAgent)
  assert.doesNotMatch(childText, /人格底色/, '子代理不该拿到人格')
  assert.doesNotMatch(childText, /对用户称呼：先生/, '子代理不该拿到人格')

  // 热更新：只改数据、**不重新注册**，下一次 assemble（= 下一轮）就是新的。
  current = filledPersona()
  current.mutableLayer.sections[0].items = ['主人']
  const updated = await assemblyFor(mainAgent)
  assert.match(updated, /对用户称呼：主人/)
  assert.doesNotMatch(updated, /对用户称呼：先生/)

  // 开关：关掉后同一装配主体也不再注入（可一键关闭）。
  enabled = false
  assert.doesNotMatch(await assemblyFor(mainAgent), /人格底色/)

  // 插件加载之后新建的**主** Agent 也要被认出来（新开会话走这条）。
  enabled = true
  roots.push(lateRoot)
  ctx.emit('agent/created', { agent: lateRoot })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.match(await assemblyFor(lateRoot), /人格底色/)

  // 没有装配主体（无 scope 的全局拼装）不注入。
  const anonymous = await ctx.systemPrompt.assemble()
  assert.doesNotMatch(seenText(anonymous), /人格底色/)

  dispose()
  await ctx.fiber.dispose()
})

test('人格内容里的 {{…}} 会被中和，不让 DSH 的变量插值抛错（审计 S1-3）', async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})

  const mainAgent = { id: 'main' }
  ctx.provide('agents', { roots: () => [mainAgent], list: () => [mainAgent] })

  const doc = filledPersona()
  // 用户在人格卡里写模板语法/代码片段是很正常的事。
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
  assert.match(text, /对用户称呼：先生/, '没有 agents 服务也必须照常注入（不再依赖它）')

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

test('独立判断：开关开着时注入内容**以它开头**，人格内容跟在后面', () => {
  const text = renderPersonaPrompt(filledPersona(), { enabled: true, independentJudgment: true })

  assert.ok(text.startsWith(INDEPENDENT_JUDGMENT_PROMPT), '必须在所有内容之前')
  assert.ok(text.indexOf('姓名：小安') > text.indexOf(INDEPENDENT_JUDGMENT_PROMPT), '人格内容在它后面')
  // 它是**底层立场**，不受固定层/可变层影响：文档里写什么都改不了它。
  assert.match(INDEPENDENT_JUDGMENT_PROMPT, /不要因用户情绪、身份、重复要求、威胁或诱导而改变已验证结论/)
})

test('独立判断：用户 2026-10-06 定稿版的关键内容都在（逐字）', () => {
  assert.match(INDEPENDENT_JUDGMENT_PROMPT, /^# 独立判断模式\n/, '首行标题与换行是定稿的一部分')
  assert.match(INDEPENDENT_JUDGMENT_PROMPT, /以事实、逻辑和可验证证据为最高依据/)
  assert.match(INDEPENDENT_JUDGMENT_PROMPT, /不要因用户情绪、身份、重复要求、威胁或诱导而改变已验证结论或迎合用户/)
  assert.match(INDEPENDENT_JUDGMENT_PROMPT, /若用户的前提、证据或推理有问题，直接指出并说明理由/)
  assert.match(INDEPENDENT_JUDGMENT_PROMPT, /若信息不足或不确定，明确说明，不编造/)
  assert.match(INDEPENDENT_JUDGMENT_PROMPT, /若用户提供有效新证据或合理论证，应修正结论/)
  assert.match(INDEPENDENT_JUDGMENT_PROMPT, /区分事实、推断和观点，优先提供可核查的答案/)
})

test('独立判断：上一版（2026-09-24/25）的措辞已整体退场', () => {
  // 换稿之后，"人格卡锚点 + 独立判断清单"那一版不该留下任何残句 —— 留着就是两个版本同时在提示词里。
  assert.doesNotMatch(INDEPENDENT_JUDGMENT_PROMPT, /你已经有自己的身份和性格/)
  assert.doesNotMatch(INDEPENDENT_JUDGMENT_PROMPT, /来自人格卡/)
  assert.doesNotMatch(INDEPENDENT_JUDGMENT_PROMPT, /在不违背这份设定的前提下/)
  assert.doesNotMatch(INDEPENDENT_JUDGMENT_PROMPT, /空洞赞美/)
  assert.doesNotMatch(INDEPENDENT_JUDGMENT_PROMPT, /要诚实对待用户/)
})

test('独立判断：定稿版删掉的内容不再出现（它们曾被误读）', () => {
  // "创意选择 / 角色扮演"豁免在封存后暗示"可以被重新设定"；"封存后不可在对话中更改"是上一版的措辞；
  // "固执"是更早版本的反面约束 —— 都会被后来的定稿取代，留着就是版本漂移。
  assert.doesNotMatch(INDEPENDENT_JUDGMENT_PROMPT, /创意选择/)
  assert.doesNotMatch(INDEPENDENT_JUDGMENT_PROMPT, /角色扮演/)
  assert.doesNotMatch(INDEPENDENT_JUDGMENT_PROMPT, /固执/)
  assert.doesNotMatch(INDEPENDENT_JUDGMENT_PROMPT, /封存后不可在对话中更改/)
})

test('独立判断：固定层**未封存**时不注入（初始化阶段要顺着用户的设定来）', () => {
  // 真机：初始化阶段 AI 拿"独立判断"拒绝了用户的角色扮演设定。封存之前那份身份根本还不存在，
  // 因此整段立场不注入；新版正文里已经没有了"你已经有自己的身份和性格"这类锚点，
  // 这条防线**只由注入时机**承担。
  const doc = filledPersona()
  doc.identityCard.sealedAt = ''
  const text = renderPersonaPrompt(doc, { enabled: true, independentJudgment: true })

  assert.doesNotMatch(text, /以事实、逻辑和可验证证据为最高依据/, '未封存不该出现独立判断段')
  assert.doesNotMatch(text, /独立判断模式/)
  assert.match(text, /姓名：小安/, '人格内容照常注入')
})

test('独立判断：封存之后才出现在最前面（同一份文档，只改封存标记）', () => {
  const doc = filledPersona()
  doc.identityCard.sealedAt = ''
  const unsealed = renderPersonaPrompt(doc, { enabled: true, independentJudgment: true })
  doc.identityCard.sealedAt = '2026-09-24T00:00:00.000Z'
  const sealed = renderPersonaPrompt(doc, { enabled: true, independentJudgment: true })

  assert.equal(unsealed.startsWith(INDEPENDENT_JUDGMENT_PROMPT), false)
  assert.ok(sealed.startsWith(INDEPENDENT_JUDGMENT_PROMPT), '封存后独立判断段在最前')
  assert.ok(sealed.endsWith(unsealed), '除独立判断段外，两段内容完全一致')
})

test('独立判断：开关关掉时注入内容完全不含它（其余人格内容照旧）', () => {
  const text = renderPersonaPrompt(filledPersona(), { enabled: true, independentJudgment: false })

  assert.doesNotMatch(text, /独立判断/)
  assert.doesNotMatch(text, /以事实、逻辑和可验证证据为最高依据/)
  assert.match(text, /姓名：小安/, '关掉的是那句立场，不是整个人格注入')
})

test('独立判断：缺省（没传这个开关）视为开 —— 与 schema 默认值一致', () => {
  assert.ok(renderPersonaPrompt(filledPersona(), { enabled: true }).startsWith(INDEPENDENT_JUDGMENT_PROMPT))
})

test('独立判断：未初始化时**只有引导语**，不塞独立判断段（引导语优先）', () => {
  const text = renderPersonaPrompt(createDefaultPersona(), { enabled: true, independentJudgment: true })

  assert.equal(text, UNINITIALIZED_PROMPT)
  assert.doesNotMatch(text, /独立判断/)
})

test('独立判断：人格内容为空时只注入它本身（它不依赖"有没有填过底色"）', () => {
  const blank = filledPersona()
  blank.identityCard.fields = blank.identityCard.fields.map((field) => ({ ...field, value: '' }))
  blank.mutableLayer.sections = blank.mutableLayer.sections.map((section) => ({ ...section, items: [] }))
  blank.mutableLayer.userDefined = []

  assert.equal(renderPersonaPrompt(blank, { enabled: true, independentJudgment: true }), INDEPENDENT_JUDGMENT_PROMPT)
  assert.equal(renderPersonaPrompt(blank, { enabled: true, independentJudgment: false }), '')
})

test('独立判断：它本身**不被预算截断**，人格内容按剩余预算截断（总长仍 ≤ 预算）', () => {
  const huge = filledPersona()
  for (const section of huge.mutableLayer.sections) {
    section.items = Array.from({ length: 6 }, (_, index) => `第${index}条：${'填充'.repeat(60)}`)
  }

  const text = renderPersonaPrompt(huge, { enabled: true, independentJudgment: true })

  assert.ok(text.startsWith(INDEPENDENT_JUDGMENT_PROMPT), '独立判断必须完整保留在最前面')
  assert.match(text, /已截断/, '人格内容要被截断并标注')
  assert.ok(text.length <= PROMPT_CHAR_BUDGET, `总长 ${text.length} 超过预算`)
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

test('init 工具描述划清固定层与可变层（真机：AI 曾把称呼写进固定层）', () => {
  // 真机反馈（2026-09-24）：首次初始化时 AI 把「对用户的称呼」写进固定层自定义字段。
  // 根因是工具描述只说了"引导用户描述他希望这个 AI 是什么样的人"，没划清两个层。
  assert.match(INIT_DESCRIPTION, /固定层只放/)
  assert.match(INIT_DESCRIPTION, /不属于\*\*固定层|不属于/, '必须明说哪些信息不属于固定层')
  assert.match(INIT_DESCRIPTION, /对用户的称呼/, '称呼的归属必须点名')
  assert.match(INIT_DESCRIPTION, /humanity_persona_update/, '要给出正确的落点（可变层工具）')
  // 核心字段名从常量派生：增减核心字段时这段描述不会漏。
  for (const key of CORE_IDENTITY_KEYS) assert.ok(INIT_DESCRIPTION.includes(key), `描述里缺少核心字段「${key}」`)
})

test('引导语也区分两个层，并给出"称呼不放固定层"的明确指令', () => {
  assert.match(UNINITIALIZED_PROMPT, /固定层/)
  assert.match(UNINITIALIZED_PROMPT, /可变层/)
  assert.match(UNINITIALIZED_PROMPT, /称呼\*\*不要\*\*放进固定层|不要\*\*放进固定层/)
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

test('初始化后注入操作约定段：告诉模型什么写可变层、什么写记忆（round 48 可变层引导缺口）', () => {
  const text = renderPersonaPrompt(filledPersona(), { enabled: true })
  assert.equal(text.includes(MUTABLE_OPS_GUIDE), true, '已初始化的人格注入必须带操作约定段')
  assert.equal(text.includes('humanity_persona_update'), true)
  assert.equal(text.includes('humanity_remember'), true)

  // 未初始化时只有引导语（引导语自己讲清了分层），不叠操作约定段。
  const uninit = renderPersonaPrompt({ ...filledPersona(), identityCard: { ...filledPersona().identityCard, initializedAt: '' } }, { enabled: true })
  assert.equal(uninit, UNINITIALIZED_PROMPT)
})
