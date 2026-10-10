/**
 * 人格 Agent 工具与封存的测试（真实工具管线 + 真实设置服务）。
 *
 * 为什么用**真实** `dsh-tools` / `dsh-system-prompt` / `dsh-settings-file` 而不是替身：
 * 这一层要证明的恰恰是"DSH 的管线真的执行了我们的判定"——
 * - `defineTool` 真的把参数 schema 编译成了模型可见契约；
 * - `ctx.tools.guard()` 真的在**函数体之前**拦住了越权调用（替身测不到"先于函数体"）；
 * - 封存写进的是真的设置文档，而不是内存里的一份副本。
 * 假货会把上面三条全部替换掉，于是测试全绿但线上仍然能被改。
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
import { createLog } from '../lib/log.js'
import { STANDARD_SECTION_TITLES } from '../lib/persona/constants.js'
import { PERSONA_INIT_TOOL } from '../lib/persona/init.js'
import { installPersonaSection, PERSONA_NAMESPACE } from '../lib/persona/section.js'
import { installPersonaTools } from '../lib/persona/tools.js'
import { NOT_INITIALIZED_REASON, SEALED_REASON } from '../lib/persona/tool-helpers.js'
import { PERSONA_UPDATE_TOOL } from '../lib/persona/update.js'

/**
 * 起一套真实宿主：系统提示 + 设置文件 + 工具管线，再挂上人格与它的工具。
 * @param options - `approval`：给定则挂一个**假审批服务**并记录每次请求；缺省表示环境里没有审批 seam。
 * @param options.agent - 调用工具时携带的 agent（审批流需要它）；缺省不带。
 */
async function boot(options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'humanity-tools-'))
  const ctx = new Context()
  const log = createLog(ctx, 'test')
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(SettingsFile, { path: path.join(dir, 'settings.yml') })
  await ctx.plugin(ToolRuntime, {})
  if (options.approval !== undefined) {
    await ctx.plugin({
      name: 'fake-approval',
      apply(c) {
        c.provide('approval', {
          request: async (req) => {
            options.approval.seen.push(req)
            return options.approval.outcome
          },
        })
      },
    })
  }

  const history = []
  const persona = installPersonaSection(ctx, log, () => (entry) => history.push(entry))
  const tools = installPersonaTools(ctx, log, persona)
  // `defineTool` 走的是动态 import，注册是异步落地的，等它把工具挂上去。
  await settle(ctx)

  return {
    ctx,
    persona,
    tools,
    history,
    call: (name, args) =>
      ctx.tools.execute({
        callId: `call-${name}`,
        name,
        arguments: args,
        signal: new AbortController().signal,
        ...(options.agent === undefined ? {} : { agent: options.agent }),
      }),
    textOf: (result) => result.content.map((block) => block.text ?? '').join('\n'),
    dispose: async () => {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

/** 等到 `humanity_persona_init` 真的出现在工具表里（最多 50 个宏任务）。 */
async function settle(ctx) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (ctx.tools.schemas().some((schema) => schema.name === PERSONA_INIT_TOOL)) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('人格工具没有在预期时间内注册')
}

/** 按标题取小节的条目（0.1.14：位置下标会随"原生项个数"漂移，标题才稳）。 */
function itemsOf(persona, title) {
  return persona.mutableLayer.sections.find((section) => section.title === title)?.items
}

/** 一份完整的可变层快照（4 个原生小节都在）+ 显式点名的自定义小节。 */
function mutableSnapshot(overrides = {}) {
  const native = STANDARD_SECTION_TITLES.map((title) => ({
    title,
    items: overrides[title] ?? [],
  }))
  // 0.1.14：非原生标题（如「经验教训」「情绪」「未结修正」）不在 `STANDARD_SECTION_TITLES` 里 ——
  // 它们现在是**自定义项**，夹具里要它们就得显式出现在快照里（"其余都一样待遇"）。
  const extra = Object.keys(overrides)
    .filter((title) => !STANDARD_SECTION_TITLES.includes(title))
    .map((title) => ({ title, items: overrides[title] }))
  return [...native, ...extra]
}

const initArgs = {
  fields: [
    { key: '姓名', value: '小安' },
    { key: '性别', value: '女' },
    { key: '人格偏好', value: '温和、直接' },
    { key: '主语言', value: '中文' },
  ],
}

test('两个工具都注册进了真实工具表，且参数契约对模型可见', async () => {
  const harness = await boot()
  try {
    const schemas = harness.ctx.tools.schemas()
    const init = schemas.find((schema) => schema.name === PERSONA_INIT_TOOL)
    const update = schemas.find((schema) => schema.name === PERSONA_UPDATE_TOOL)

    assert.ok(init, 'humanity_persona_init 没有注册')
    assert.ok(update, 'humanity_persona_update 没有注册')
    // 参数 schema 是模型可见的部分，必须真的带上身份卡字段定义。
    assert.ok(JSON.stringify(init.parameters).includes('人格偏好'))
    assert.ok(JSON.stringify(update.parameters).includes('用户定义'))
  } finally {
    await harness.dispose()
  }
})

test('聊天初始化：写入固定层、升起 initializedAt/sealedAt，并把封存说明给到模型', async () => {
  const harness = await boot()
  try {
    const result = await harness.call(PERSONA_INIT_TOOL, initArgs)
    assert.equal(result.isError, false)

    const card = harness.persona.read().identityCard
    assert.deepEqual(
      card.fields.map((field) => [field.key, field.value]),
      [
        ['姓名', '小安'],
        ['性别', '女'],
        ['人格偏好', '温和、直接'],
        ['主语言', '中文'],
      ],
    )
    // P-002：初始化与封存是**独立标记**，不靠内容比对。
    assert.notEqual(card.initializedAt, '')
    assert.notEqual(card.sealedAt, '')

    const text = harness.textOf(result)
    assert.match(text, /已对 Agent 封存/)
    assert.match(text, /Humanity 工作台/)
    assert.match(text, /小安/)
  } finally {
    await harness.dispose()
  }
})

test('封存之后再次初始化被拒（guard 在函数体之前拦下，且没写进去）', async () => {
  const harness = await boot()
  try {
    await harness.call(PERSONA_INIT_TOOL, initArgs)
    const sealedAt = harness.persona.read().identityCard.sealedAt

    const second = await harness.call(PERSONA_INIT_TOOL, {
      fields: [{ key: '姓名', value: '别人' }, { key: '性别', value: '男' }, { key: '人格偏好', value: '冷' }],
    })

    assert.equal(second.isError, true, '第二次初始化必须失败')
    // 钉到 guard 的**原文**：函数体与存储层也会说“封存”，只匹配 /封存/ 无法唯一归因到 guard。
    assert.ok(harness.textOf(second).includes(SEALED_REASON), '这次拒绝必须来自 guard 的封存理由原文')
    // 关键：被拒之后生效文档一个字都没变。
    assert.equal(harness.persona.read().identityCard.fields[0].value, '小安')
    assert.equal(harness.persona.read().identityCard.sealedAt, sealedAt)
  } finally {
    await harness.dispose()
  }
})

test('未初始化时 update 被拒，提示先走聊天初始化', async () => {
  const harness = await boot()
  try {
    const result = await harness.call(PERSONA_UPDATE_TOOL, {
      sections: mutableSnapshot({ 对用户称呼: ['主人'] }),
      userDefined: [],
    })

    assert.equal(result.isError, true)
    assert.ok(harness.textOf(result).includes(NOT_INITIALIZED_REASON), '必须来自 guard 的未初始化理由原文')
  } finally {
    await harness.dispose()
  }
})

test('update 只改可变层：固定层原样保留，快照会被补齐标准小标题', async () => {
  const harness = await boot()
  try {
    await harness.call(PERSONA_INIT_TOOL, initArgs)

    const result = await harness.call(PERSONA_UPDATE_TOOL, {
      // 只给一个小标题：其余标准小标题应当被补成空项，而不是从文档里消失（P-020）。
      sections: [{ title: '说话风格', items: ['先给结论，再给依据'] }],
      userDefined: [{ key: '时区', value: 'CST' }],
    })
    assert.equal(result.isError, false)

    const doc = harness.persona.read()
    assert.equal(doc.identityCard.fields[0].value, '小安')
    assert.deepEqual(doc.mutableLayer.sections.map((section) => section.title), [...STANDARD_SECTION_TITLES])
    assert.deepEqual(itemsOf(doc, '说话风格'), ['先给结论，再给依据'])
    assert.deepEqual(doc.mutableLayer.userDefined, [{ key: '时区', value: 'CST' }])

    const text = harness.textOf(result)
    assert.match(text, /固定层保持不变/)
  } finally {
    await harness.dispose()
  }
})

test('⑤ 漏传有内容的小标题 = 不动它：内容原样保留，成功、不弹确认（真机反馈缺陷 5）', async () => {
  const harness = await boot()
  try {
    await harness.call(PERSONA_INIT_TOOL, initArgs)
    await harness.call(PERSONA_UPDATE_TOOL, {
      sections: mutableSnapshot({ 经验教训: ['不要在深夜改配置'] }),
      userDefined: [],
    })

    // 整节漏传（不是传空数组）：语义是"不动这一节"，不是"删掉它"。
    const omitted = await harness.call(PERSONA_UPDATE_TOOL, {
      sections: mutableSnapshot({ 说话风格: ['少用形容词'] }).filter(
        (section) => section.title !== '经验教训',
      ),
      userDefined: [],
    })

    assert.equal(omitted.isError, false)
    assert.equal(omitted.value.ok, true, '漏传不再是一次拒绝')
    // 漏传的那一节内容还在；同时这一轮真正改了的节也生效了。
    assert.deepEqual(itemsOf(harness.persona.read(), '经验教训'), ['不要在深夜改配置'])
    assert.deepEqual(itemsOf(harness.persona.read(), '说话风格'), ['少用形容词'])
  } finally {
    await harness.dispose()
  }
})

test('⑤ 只给一个小标题就能更新，其它节全部原样保留（不是"必须回传完整快照"）', async () => {
  const harness = await boot()
  try {
    await harness.call(PERSONA_INIT_TOOL, initArgs)
    await harness.call(PERSONA_UPDATE_TOOL, {
      sections: mutableSnapshot({ 对用户称呼: ['主人'], 经验教训: ['不要在深夜改配置'] }),
      userDefined: [{ key: '时区', value: 'CST' }],
    })

    const changed = await harness.call(PERSONA_UPDATE_TOOL, {
      sections: [{ title: '说话风格', items: ['先给结论'] }],
      userDefined: [{ key: '时区', value: 'CST' }],
    })

    assert.equal(changed.value.ok, true)
    const doc = harness.persona.read()
    assert.deepEqual(itemsOf(doc, '对用户称呼'), ['主人'], '没传的节必须原样保留')
    assert.deepEqual(itemsOf(doc, '经验教训'), ['不要在深夜改配置'])
    assert.deepEqual(itemsOf(doc, '说话风格'), ['先给结论'])
  } finally {
    await harness.dispose()
  }
})

test('⑤ 非标准小标题漏传但有内容时也原样带回（同一句"漏传 = 不动"）', async () => {
  const harness = await boot()
  try {
    await harness.call(PERSONA_INIT_TOOL, initArgs)
    await harness.call(PERSONA_UPDATE_TOOL, {
      sections: [{ title: '健康情况', items: ['对花生过敏'] }],
      userDefined: [],
    })

    const changed = await harness.call(PERSONA_UPDATE_TOOL, {
      sections: [{ title: '说话风格', items: ['先给结论'] }],
      userDefined: [],
    })

    assert.equal(changed.value.ok, true)
    const titles = harness.persona.read().mutableLayer.sections.map((section) => section.title)
    assert.ok(titles.includes('健康情况'), '非标准标题漏传也要保留')
    assert.deepEqual(
      harness.persona.read().mutableLayer.sections.find((section) => section.title === '健康情况').items,
      ['对花生过敏'],
    )
  } finally {
    await harness.dispose()
  }
})

test('① 「用户定义」同名键被拒，且一个字都没写进去（不静默丢数据）', async () => {
  const harness = await boot()
  try {
    await harness.call(PERSONA_INIT_TOOL, initArgs)
    await harness.call(PERSONA_UPDATE_TOOL, {
      sections: mutableSnapshot(),
      userDefined: [{ key: '口味', value: '清淡' }],
    })

    const dup = await harness.call(PERSONA_UPDATE_TOOL, {
      sections: mutableSnapshot(),
      userDefined: [
        { key: '口味', value: '清淡' },
        { key: '口味', value: '嗜辣' },
      ],
    })

    assert.equal(dup.value.ok, false)
    assert.ok(dup.value.issues.some((issue) => issue.code === 'mutable.user-defined-duplicate'))
    assert.deepEqual(harness.persona.read().mutableLayer.userDefined, [{ key: '口味', value: '清淡' }])
  } finally {
    await harness.dispose()
  }
})

test('② 固定层字段名当小标题 / 当「用户定义」的键都会被工具拒绝', async () => {
  const harness = await boot()
  try {
    await harness.call(PERSONA_INIT_TOOL, initArgs)

    const shadowSection = await harness.call(PERSONA_UPDATE_TOOL, {
      sections: [...mutableSnapshot(), { title: '姓名', items: ['冒牌'] }],
      userDefined: [],
    })
    assert.equal(shadowSection.value.ok, false)
    assert.ok(shadowSection.value.issues.some((issue) => issue.code === 'mutable.core-key-shadowed'))

    const shadowKey = await harness.call(PERSONA_UPDATE_TOOL, {
      sections: mutableSnapshot(),
      userDefined: [{ key: '人格偏好', value: '天真烂漫' }],
    })
    assert.equal(shadowKey.value.ok, false)
    assert.ok(shadowKey.value.issues.some((issue) => issue.code === 'mutable.core-key-shadowed'))

    // 固定层本身没被这些失败尝试动过。
    assert.equal(harness.persona.read().identityCard.fields[0].value, '小安')
  } finally {
    await harness.dispose()
  }
})

test('④ 控制字符落盘前被剥掉（工具路径也是同一套规范化）', async () => {
  const harness = await boot()
  try {
    await harness.call(PERSONA_INIT_TOOL, initArgs)

    const written = await harness.call(PERSONA_UPDATE_TOOL, {
      sections: mutableSnapshot({ 经验教训: ['不要在深夜改配置\u0000', '按\u001b[31m键\u0007前先备份'] }),
      userDefined: [{ key: '时\u0000区', value: 'CST\u001b' }],
    })

    assert.equal(written.value.ok, true)
    const doc = harness.persona.read()
    assert.deepEqual(itemsOf(doc, '经验教训'), ['不要在深夜改配置', '按键前先备份'])
    assert.deepEqual(doc.mutableLayer.userDefined, [{ key: '时区', value: 'CST' }])
    // 落盘前必须干干净净：NUL / BEL / ESC 一个都不许留。
    assert.equal(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(JSON.stringify(doc)), false)
  } finally {
    await harness.dispose()
  }
})

test('⑤ 显式清空有内容的一节：用户在对话里点确认 → 真的落盘，旧条目进历史', async () => {
  const approval = { outcome: 'allowed-once', seen: [] }
  const harness = await boot({ approval, agent: { id: 'test-agent' } })
  try {
    await harness.call(PERSONA_INIT_TOOL, initArgs)
    await harness.call(PERSONA_UPDATE_TOOL, {
      sections: mutableSnapshot({ 经验教训: ['不要在深夜改配置'] }),
      userDefined: [],
    })

    const cleared = await harness.call(PERSONA_UPDATE_TOOL, {
      sections: mutableSnapshot({ 经验教训: [] }),
      userDefined: [],
    })

    assert.equal(approval.seen.length, 1, '必须恰好问一次')
    assert.match(approval.seen[0].reason, /删掉用户已有的内容/)
    assert.equal(approval.seen[0].toolName, PERSONA_UPDATE_TOOL)
    assert.equal(cleared.value.ok, true, '用户确认后应当写入成功')
    // 0.1.14：「经验教训」是非原生项 ⇒ 清空即删除（生效口径里整节消失，不留空壳）。
    assert.equal(itemsOf(harness.persona.read(), '经验教训'), undefined, '自定义节清空 = 整节删掉')
    assert.deepEqual(
      harness.history.map((entry) => [entry.path, entry.previous]).filter(([path]) => path.endsWith('经验教训')),
      [['mutableLayer.sections.经验教训', '不要在深夜改配置']],
      '删内容不等于丢内容：旧条目必须进历史',
    )
  } finally {
    await harness.dispose()
  }
})

test('⑤ 显式清空：用户拒绝 → 不写，且说明是"用户拒绝"而不是"去工作台"', async () => {
  const approval = { outcome: 'rejected', seen: [] }
  const harness = await boot({ approval, agent: { id: 'test-agent' } })
  try {
    await harness.call(PERSONA_INIT_TOOL, initArgs)
    await harness.call(PERSONA_UPDATE_TOOL, {
      sections: mutableSnapshot({ 经验教训: ['不要在深夜改配置'] }),
      userDefined: [],
    })

    const cleared = await harness.call(PERSONA_UPDATE_TOOL, {
      sections: mutableSnapshot({ 经验教训: [] }),
      userDefined: [],
    })

    assert.equal(approval.seen.length, 1)
    assert.equal(cleared.value.ok, false)
    assert.match(harness.textOf(cleared), /拒绝了这次改动/)
    assert.doesNotMatch(harness.textOf(cleared), /工作台/)
    assert.deepEqual(itemsOf(harness.persona.read(), '经验教训'), ['不要在深夜改配置'])
  } finally {
    await harness.dispose()
  }
})

test('⑤ 显式清空：没有确认入口时 fail closed，不写、不指页面', async () => {
  const approval = { outcome: 'unavailable', seen: [] }
  const harness = await boot({ approval, agent: { id: 'test-agent' } })
  try {
    await harness.call(PERSONA_INIT_TOOL, initArgs)
    await harness.call(PERSONA_UPDATE_TOOL, {
      sections: mutableSnapshot({ 经验教训: ['不要在深夜改配置'] }),
      userDefined: [],
    })

    const cleared = await harness.call(PERSONA_UPDATE_TOOL, {
      sections: mutableSnapshot({ 经验教训: [] }),
      userDefined: [],
    })

    assert.equal(cleared.value.ok, false)
    assert.match(harness.textOf(cleared), /没有可用的确认入口/)
    assert.deepEqual(itemsOf(harness.persona.read(), '经验教训'), ['不要在深夜改配置'])
  } finally {
    await harness.dispose()
  }
})

test('⑤ 环境里根本没有审批 seam 时，显式清空也只能返回"没有可用的确认入口"', async () => {
  const harness = await boot()
  try {
    await harness.call(PERSONA_INIT_TOOL, initArgs)
    await harness.call(PERSONA_UPDATE_TOOL, {
      sections: mutableSnapshot({ 经验教训: ['不要在深夜改配置'] }),
      userDefined: [],
    })

    const cleared = await harness.call(PERSONA_UPDATE_TOOL, {
      sections: mutableSnapshot({ 经验教训: [] }),
      userDefined: [],
    })

    assert.equal(cleared.value.ok, false)
    assert.match(harness.textOf(cleared), /没有可用的确认入口/)
    assert.doesNotMatch(harness.textOf(cleared), /工作台确认/)
    assert.deepEqual(itemsOf(harness.persona.read(), '经验教训'), ['不要在深夜改配置'])
  } finally {
    await harness.dispose()
  }
})

test('⑤ 纯结构错误（同名键）不会被误判成"可确认的删内容"：不去打扰用户', async () => {
  const approval = { outcome: 'allowed-once', seen: [] }
  const harness = await boot({ approval, agent: { id: 'test-agent' } })
  try {
    await harness.call(PERSONA_INIT_TOOL, initArgs)

    const bad = await harness.call(PERSONA_UPDATE_TOOL, {
      sections: mutableSnapshot(),
      userDefined: [
        { key: '口味', value: '清淡' },
        { key: '口味', value: '嗜辣' },
      ],
    })

    assert.equal(bad.value.ok, false)
    assert.equal(approval.seen.length, 0, '不可确认项不该弹确认框')
  } finally {
    await harness.dispose()
  }
})

test('改称呼现在直接成功，不再要求任何确认（真机反馈的正面用例）', async () => {
  const harness = await boot()
  try {
    await harness.call(PERSONA_INIT_TOOL, initArgs)
    await harness.call(PERSONA_UPDATE_TOOL, { sections: mutableSnapshot({ 对用户称呼: ['主人'] }), userDefined: [] })

    const changed = await harness.call(PERSONA_UPDATE_TOOL, {
      sections: mutableSnapshot({ 对用户称呼: ['先生'] }),
      userDefined: [],
    })

    assert.equal(changed.value.ok, true, '改称呼必须是普通写入')
    assert.deepEqual(itemsOf(harness.persona.read(), '对用户称呼'), ['先生'])
  } finally {
    await harness.dispose()
  }
})

test('R1/R2/R4 复现用例：写完「回归测试节」再传 items: []，**不得**报 section-dropped，确认后真的删掉', async () => {
  // 小明真机复现的两步（原文）：① 写入 {title:回归测试节, items:[回归测试内容]} → 成功；
  // ② 写入 {title:回归测试节, items:[]} → ❌ 报 mutable.section-dropped，文案还劝"要清空请传 items: []"
  //    ⇒ 传了也被拦，两条路都走不通（R2）。现在第②步是"显式清空自定义节 = 删除它"的正门。
  // ②A 先看"用户拒绝"那次：这时工具会把校验结论原样报出来，正是 R1 里被误报成 section-dropped 的地方。
  const rejecting = { outcome: 'rejected', seen: [] }
  const harnessA = await boot({ approval: rejecting, agent: { id: 'test-agent' } })
  try {
    await harnessA.call(PERSONA_INIT_TOOL, initArgs)
    await harnessA.call(PERSONA_UPDATE_TOOL, {
      sections: [{ title: '回归测试节', items: ['回归测试内容'] }],
      userDefined: [],
    })

    const refused = await harnessA.call(PERSONA_UPDATE_TOOL, {
      sections: [{ title: '回归测试节', items: [] }],
      userDefined: [],
    })

    const codes = refused.value.issues.map((issue) => issue.code)
    assert.equal(codes.includes('mutable.section-dropped'), false, 'R1：显式传 items: [] 不能被判成"整节不见了"')
    assert.ok(codes.includes('mutable.section-cleared'), '应当报"显式清空（自定义节 = 删除）"')
    assert.equal(rejecting.seen.length, 1, '删用户内容要先在对话里确认一次')
    assert.equal(refused.value.ok, false, '用户拒绝 ⇒ 不写')
    assert.equal(
      harnessA.persona.read().mutableLayer.sections.some((section) => section.title === '回归测试节'),
      true,
      '被拒之后内容必须还在',
    )
  } finally {
    await harnessA.dispose()
  }

  // ②B 用户点确认 ⇒ 这一节真的消失（R2 的正门），内容进历史（P-009）。
  const approval = { outcome: 'allowed-once', seen: [] }
  const harness = await boot({ approval, agent: { id: 'test-agent' } })
  try {
    await harness.call(PERSONA_INIT_TOOL, initArgs)
    await harness.call(PERSONA_UPDATE_TOOL, {
      sections: [{ title: '回归测试节', items: ['回归测试内容'] }],
      userDefined: [],
    })

    const second = await harness.call(PERSONA_UPDATE_TOOL, {
      sections: [{ title: '回归测试节', items: [] }],
      userDefined: [],
    })

    assert.equal(approval.seen.length, 1)
    assert.equal(second.value.ok, true, '用户确认后必须成功')
    assert.equal(
      harness.persona.read().mutableLayer.sections.some((section) => section.title === '回归测试节'),
      false,
      'R2：确认后这一节真的消失了（不是留个删不掉空壳）',
    )
    assert.deepEqual(
      harness.history.map((entry) => entry.previous).filter((text) => text === '回归测试内容'),
      ['回归测试内容'],
      '被删掉的内容必须进历史',
    )
  } finally {
    await harness.dispose()
  }
})

test('R2 历史遗留的空壳自定义节：读取时不再显示，写入时被清掉，且不需要确认', async () => {
  const approval = { outcome: 'allowed-once', seen: [] }
  const harness = await boot({ approval, agent: { id: 'test-agent' } })
  try {
    await harness.call(PERSONA_INIT_TOOL, initArgs)
    // 直接塞一个空的自定义节（模拟上一版留下的僵尸空壳）。
    const current = harness.persona.read()
    await harness.persona.write(
      {
        ...current,
        mutableLayer: {
          ...current.mutableLayer,
          sections: [...current.mutableLayer.sections, { title: '回归测试节', items: [] }],
        },
      },
      'user',
    )
    assert.equal(
      harness.persona.read().mutableLayer.sections.some((section) => section.title === '回归测试节'),
      false,
      '读取路径不再显示空壳（等于它不存在）',
    )

    const cleaned = await harness.call(PERSONA_UPDATE_TOOL, {
      sections: [{ title: '回归测试节', items: [] }],
      userDefined: [],
    })
    assert.equal(cleaned.value.ok, true)
    assert.equal(approval.seen.length, 0, '空壳没有内容可删，不该打扰用户')
  } finally {
    await harness.dispose()
  }
})

test('Bug B 自定义节用 items: [] 表达"删除"：有内容要先确认，确认后整节消失（不留空壳）', async () => {
  const approval = { outcome: 'allowed-once', seen: [] }
  const harness = await boot({ approval, agent: { id: 'test-agent' } })
  try {
    await harness.call(PERSONA_INIT_TOOL, initArgs)
    const added = await harness.call(PERSONA_UPDATE_TOOL, {
      sections: [{ title: '小明专属节', items: ['只有一条'] }],
      userDefined: [],
    })
    assert.equal(added.value.ok, true)
    // 0.1.14：任何自定义标题（原生 4 个之外）都**不再**产出"非标准"提示 —— 没有标准这一说。
    assert.equal(
      added.value.issues.some((issue) => issue.code === 'mutable.section-non-standard'),
      false,
      '自定义标题不该再被标成"非标准"',
    )

    const removed = await harness.call(PERSONA_UPDATE_TOOL, {
      sections: [{ title: '小明专属节', items: [] }],
      userDefined: [],
    })

    assert.equal(approval.seen.length, 1, '删掉有内容的自定义节要先问一次')
    assert.equal(removed.value.ok, true)
    const titles = harness.persona.read().mutableLayer.sections.map((section) => section.title)
    assert.equal(titles.includes('小明专属节'), false, '必须真的删掉，不能留下删不掉空壳')
    assert.deepEqual(titles, [...STANDARD_SECTION_TITLES], '标准节一个都不能少')
  } finally {
    await harness.dispose()
  }
})

test('Bug B 空壳状态的自定义节不会再变成僵尸：后续任何一次写入都不留它', async () => {
  const approval = { outcome: 'allowed-once', seen: [] }
  const harness = await boot({ approval, agent: { id: 'test-agent' } })
  try {
    await harness.call(PERSONA_INIT_TOOL, initArgs)
    await harness.call(PERSONA_UPDATE_TOOL, {
      sections: [{ title: '小明专属节', items: ['只有一条'] }],
      userDefined: [],
    })
    // 清空（删内容）→ 确认一次 → 节消失。
    await harness.call(PERSONA_UPDATE_TOOL, {
      sections: [{ title: '小明专属节', items: [] }],
      userDefined: [],
    })
    assert.equal(approval.seen.length, 1)

    // 再写一次别的节：不该再有这个自定义节，也不该再问一次。
    const later = await harness.call(PERSONA_UPDATE_TOOL, {
      sections: [{ title: '说话风格', items: ['少用形容词'] }],
      userDefined: [],
    })
    assert.equal(approval.seen.length, 1, '空壳早已不存在，不该再触发确认')
    assert.equal(later.value.ok, true)
    assert.equal(
      harness.persona.read().mutableLayer.sections.some((section) => section.title === '小明专属节'),
      false,
    )
  } finally {
    await harness.dispose()
  }
})

test('Bug B 用户清空自定义节的正文（工作台路径）也能删掉它，且不触发确认', async () => {
  const harness = await boot()
  try {
    await harness.call(PERSONA_INIT_TOOL, initArgs)
    await harness.call(PERSONA_UPDATE_TOOL, {
      sections: [{ title: '小明专属节', items: ['只有一条'] }],
      userDefined: [],
    })

    const current = harness.persona.read()
    await harness.persona.write(
      {
        ...current,
        mutableLayer: {
          ...current.mutableLayer,
          sections: current.mutableLayer.sections.map((section) =>
            section.title === '小明专属节' ? { title: section.title, items: [] } : section,
          ),
        },
      },
      'user',
    )

    const titles = harness.persona.read().mutableLayer.sections.map((section) => section.title)
    assert.equal(titles.includes('小明专属节'), false)
  } finally {
    await harness.dispose()
  }
})

test('⑤ 清空一个本来就没内容的节不需要确认，直接成功（没有内容可删）', async () => {
  const approval = { outcome: 'allowed-once', seen: [] }
  const harness = await boot({ approval, agent: { id: 'test-agent' } })
  try {
    await harness.call(PERSONA_INIT_TOOL, initArgs)
    await harness.call(PERSONA_UPDATE_TOOL, {
      sections: mutableSnapshot({ 经验教训: ['不要在深夜改配置'] }),
      userDefined: [],
    })

    // 只显式清空一个空节：不该打扰用户。
    const emptied = await harness.call(PERSONA_UPDATE_TOOL, {
      sections: [{ title: '未结修正', items: [] }],
      userDefined: [],
    })

    assert.equal(emptied.value.ok, true)
    assert.equal(approval.seen.length, 0, '没有内容可删就不该弹确认')
    assert.deepEqual(harness.history, [], '空节被清空不算"被取代的旧内容"')
    // 漏传的「经验教训」原样保留。
    assert.deepEqual(itemsOf(harness.persona.read(), '经验教训'), ['不要在深夜改配置'])
  } finally {
    await harness.dispose()
  }
})

test('夹带固定层字段的 update 被 guard 拦下（不依赖参数 schema 是否写了它）', async () => {
  const harness = await boot()
  try {
    await harness.call(PERSONA_INIT_TOOL, initArgs)

    const sneaky = await harness.call(PERSONA_UPDATE_TOOL, {
      sections: mutableSnapshot(),
      userDefined: [],
      identityCard: { fields: [{ key: '姓名', value: '偷偷改掉' }] },
    })

    assert.equal(sneaky.isError, true)
    assert.ok(harness.textOf(sneaky).includes(SEALED_REASON), '必须来自 guard 的封存理由原文')
    assert.equal(harness.persona.read().identityCard.fields[0].value, '小安')
  } finally {
    await harness.dispose()
  }
})

test('被取代的旧内容进历史，没变的条目不会进（P-009/P-019）', async () => {
  const harness = await boot()
  try {
    await harness.call(PERSONA_INIT_TOOL, initArgs)
    await harness.call(PERSONA_UPDATE_TOOL, {
      sections: mutableSnapshot({ 说话风格: ['先给结论，再给依据'] }),
      userDefined: [],
    })
    harness.history.length = 0

    await harness.call(PERSONA_UPDATE_TOOL, {
      sections: mutableSnapshot({ 说话风格: ['先给结论，再给依据', '少用形容词'] }),
      userDefined: [],
    })

    assert.deepEqual(
      harness.history.map((entry) => [entry.path, entry.previous, entry.source]),
      [],
      '新增条目不是"被取代"，不该进历史',
    )

    await harness.call(PERSONA_UPDATE_TOOL, {
      sections: mutableSnapshot({ 说话风格: ['少用形容词'] }),
      userDefined: [],
    })

    assert.deepEqual(
      harness.history.map((entry) => [entry.path, entry.previous, entry.source]),
      [['mutableLayer.sections.说话风格', '先给结论，再给依据', 'agent']],
      '被取代的旧条目必须进历史（这是"不静默删除"的机制）',
    )
    assert.equal(itemsOf(harness.persona.read(), '说话风格').includes('先给结论，再给依据'), false)
  } finally {
    await harness.dispose()
  }
})

test('开关关掉后工具从模型可见集合里消失，再打开能恢复（P-006/P-030）', async () => {
  const harness = await boot()
  try {
    harness.tools.setEnabled(false)
    assert.equal(harness.ctx.tools.schemas().some((schema) => schema.name === PERSONA_INIT_TOOL), false)

    harness.tools.setEnabled(true)
    await settle(harness.ctx)
    assert.equal(harness.ctx.tools.schemas().some((schema) => schema.name === PERSONA_INIT_TOOL), true)
  } finally {
    await harness.dispose()
  }
})

test('固定层封存后，设置文档里也确实带着封存标记（写的是真存储）', async () => {
  const harness = await boot()
  try {
    await harness.call(PERSONA_INIT_TOOL, initArgs)

    const descriptor = harness.ctx
      .get('settings')
      .describe({ redactSecrets: true })
      .find((entry) => entry.ns === PERSONA_NAMESPACE)
    assert.ok(descriptor)
    assert.notEqual(descriptor.value.identityCard.sealedAt, '')
    assert.equal(descriptor.value.identityCard.fields[0].value, '小安')
  } finally {
    await harness.dispose()
  }
})

test('封存后 init 工具整体下线：模型可见集合里不再有它（引导泄漏的根因修复，round 48）', async () => {
  const harness = await boot()
  try {
    assert.equal(harness.ctx.tools.schemas().some((schema) => schema.name === PERSONA_INIT_TOOL), true)

    await harness.call(PERSONA_INIT_TOOL, initArgs)
    // 重注册由「写入成功」通知触发，与 setEnabled 同样是异步落地：等 init 从工具表消失。
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (!harness.ctx.tools.schemas().some((schema) => schema.name === PERSONA_INIT_TOOL)) break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(
      harness.ctx.tools.schemas().some((schema) => schema.name === PERSONA_INIT_TOOL),
      false,
      '封存后 init 不应再出现在模型可见集合（看不见才模仿不了）',
    )
    assert.equal(
      harness.ctx.tools.schemas().some((schema) => schema.name === PERSONA_UPDATE_TOOL),
      true,
      'update 不受封存影响，仍可用',
    )
  } finally {
    await harness.dispose()
  }
})
