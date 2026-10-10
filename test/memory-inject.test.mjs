/**
 * 记忆注入测试：真实 `SystemPrompt` + 真实的 `agent/inbox/claimed` 事件顺序。
 *
 * 最要紧的一条是**消息从哪儿来**：装配上下文里没有消息，注入靠监听 `agent/inbox/claimed`。
 * 所以这里刻意按 agent loop 的真实顺序演一遍（先 claim、再 assemble），
 * 而不是直接往缓存里塞一句话 —— 后者会把"事件名写错"这类缺陷整片放过。
 */
import assert from 'node:assert/strict'
import { after, mock, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createLog } from '../lib/log.js'
import { BLOCK_TITLE, relativeTimeOf, renderMemoryBlock } from '../lib/memory/render.js'
import { installMemoryInjection, MEMORY_GUIDANCE, MEMORY_SECTION_NAME, MEMORY_SECTION_ORDER } from '../lib/memory/inject.js'
import { createMemoryEntry } from '../lib/memory/model.js'
import { resolveMemoryPolicy } from '../lib/memory/policy.js'
import { createMemoryStore } from '../lib/memory/store.js'
import { createFakeTable } from './helpers/memory-fake.mjs'

const NOW = '2026-09-24T05:00:00.000Z'

/**
 * 时间夹具：把本文件的 `Date` 冻结在 `NOW`（**这里曾经是一枚时间炸弹**）。
 *
 * 产品侧新鲜度是对着**墙钟**线性衰减的（`src/host/memory/scoring.ts` 的 `freshnessScore`：
 * `1 - 距最近一次使用/更新的天数 / DECAY_UNUSED_DAYS`，权重 0.1），检索用的 `now` 也是
 * 现取的墙钟（`src/host/memory/search.ts` 的 `rankMemories`）。而本夹具里"这条记忆是
 * 2026-09-24 写下的"是个常量 —— 于是**测试跑在哪一天**就悄悄变成了一个没被声明的输入：
 *
 * | 跑测试的日期 | P-031 用例那条记忆的总分 | 阈值 0.35 |
 * |---|---|---|
 * | 2026-09-24 | 0.36750 | 过 |
 * | 2026-10-09 | 0.35083 | 过（只剩 0.0008 余量） |
 * | 2026-10-10 | 0.34972 | **不过** → 用例转红，且此后永久红 |
 *
 * 这是**用例把墙钟当输入**造成的，不是产品缺陷：分数本身完全按设计衰减。修在测试侧 ——
 * 让夹具世界里的"现在"恒等于 `NOW`，检索时刻与写入时刻永远同刻，新鲜度恒为 1。
 * 冻结只针对 `Date`（不碰 `setTimeout`/`setImmediate`：下面的异步补记还要真实宏任务）。
 */
mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) })
after(() => mock.timers.reset())

/** 一条进提示词的消息（结构与 `UserMessage` 一致：正文在 text 块里）。 */
function userMessage(text) {
  return { id: 'm1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

/** 造一条记忆并写进存储。 */
async function seed(store, content, overrides = {}) {
  await store.put(
    createMemoryEntry({
      scope: 'long-term',
      content,
      origin: 'agent-derived',
      sourceSessionId: 's1',
      status: 'active',
      tags: [],
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    }),
  )
}

/**
 * 起一套真实环境：系统提示词 + 记忆注入 + 一张 Map 假表。
 * @param options.mode - 预设模式；`options.memoryEnabled` 为假表示配置层总开关关掉。
 */
async function boot(options = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  const store = createMemoryStore(createFakeTable())
  let memoryEnabled = options.memoryEnabled ?? true
  const dispose = installMemoryInjection(ctx, createLog(ctx, 'test'), {
    store: () => store,
    policy: () => resolveMemoryPolicy(options.mode ?? 'balanced'),
    enabled: () => memoryEnabled,
  })
  const main = { id: 'session-1', session: { header: { cwd: '/work/shop' } } }
  const child = { id: 'session-2' }
  ctx.provide('agents', { roots: () => [main], list: () => [main, child] })

  return {
    ctx,
    store,
    main,
    child,
    setMemoryEnabled: (next) => {
      memoryEnabled = next
    },
    /** 按 agent loop 的真实顺序：先 claim（同步 emit），再装配提示词。 */
    turn: async (agent, text) => {
      ctx.emit('agent/inbox/claimed', { agent, message: userMessage(text) })
      const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent })
      return assembly.sections.find((section) => section.name === MEMORY_SECTION_NAME)?.text ?? ''
    },
    dispose: async () => {
      dispose()
      await ctx.fiber.dispose()
    },
  }
}

test('有匹配 → 注入记忆块；无匹配 → 只有引导语，没有块（P-028：空着比塞错安全）', async () => {
  const harness = await boot()
  try {
    await seed(harness.store, '用户喜欢喝咖啡', { tags: ['咖啡'] })

    const hit = await harness.turn(harness.main, '今天想喝咖啡')
    assert.match(hit, /相关记忆/)
    assert.match(hit, /- \[长期记忆\] 用户喜欢喝咖啡/)
    assert.match(hit, /重要度 2\/5/)
    assert.ok(hit.startsWith(MEMORY_GUIDANCE), '引导语在前，记忆块在后')

    const miss = await harness.turn(harness.main, '明天几点开会')
    assert.equal(miss, MEMORY_GUIDANCE, '没有相关记忆时只留引导语')
    assert.equal(miss.includes(BLOCK_TITLE), false)
  } finally {
    await harness.dispose()
  }
})

test('空库 → 不注入块，也不出错', async () => {
  const harness = await boot()
  try {
    const text = await harness.turn(harness.main, '今天想喝咖啡')
    assert.equal(text, MEMORY_GUIDANCE)
  } finally {
    await harness.dispose()
  }
})

test('开关关掉 → 整段空串：配置总开关与策略（手动模式不自动注入）都算', async () => {
  const off = await boot({ memoryEnabled: false })
  try {
    await seed(off.store, '用户喜欢喝咖啡')
    assert.equal(await off.turn(off.main, '想喝咖啡'), '')
  } finally {
    await off.dispose()
  }

  const manual = await boot({ mode: 'manual' })
  try {
    await seed(manual.store, '用户喜欢喝咖啡')
    const text = await manual.turn(manual.main, '想喝咖啡')
    assert.equal(text, MEMORY_GUIDANCE, '手动模式：引导语在，但不自动注入记忆（P-030）')
    assert.equal(text.includes(BLOCK_TITLE), false)
  } finally {
    await manual.dispose()
  }
})

test('子代理不注入（裁决 2），也不为它缓存消息', async () => {
  const harness = await boot()
  try {
    await seed(harness.store, '用户喜欢喝咖啡')
    assert.equal(await harness.turn(harness.child, '想喝咖啡'), '')
    // 主 Agent 自己那句话还没被 claim 过，所以即使它有匹配也不注入（不会拿别人的话去检索）。
    const assembly = await harness.ctx.systemPrompt.assemble({ agent: harness.main, scope: harness.main })
    assert.equal(assembly.sections.find((section) => section.name === MEMORY_SECTION_NAME)?.text, MEMORY_GUIDANCE)
  } finally {
    await harness.dispose()
  }
})

test('每轮重算：同一句话在下一轮就能看到刚写下的记忆（函数式 text，无缓存失效问题）', async () => {
  const harness = await boot()
  try {
    assert.equal(await harness.turn(harness.main, '今天想喝咖啡'), MEMORY_GUIDANCE)

    await seed(harness.store, '用户喜欢喝咖啡', { tags: ['咖啡'] })
    const next = await harness.turn(harness.main, '今天想喝咖啡')
    assert.match(next, /用户喜欢喝咖啡/)
  } finally {
    await harness.dispose()
  }
})

test('命中会推进使用统计（异步补记），且注入本身不因为高频而变多（P-031）', async () => {
  const harness = await boot()
  try {
    await seed(harness.store, '用户喜欢喝咖啡')
    await harness.turn(harness.main, '今天想喝咖啡')
    await new Promise((resolve) => setImmediate(resolve))

    const entry = harness.store.list()[0]
    assert.equal(entry.useCount, 1)
    assert.ok(entry.lastUsedAt.length > 0)

    const again = await harness.turn(harness.main, '今天想喝咖啡')
    assert.equal(again.match(/^- /gm)?.length, 1, '条数由检索与上限决定，频率只影响排序')
  } finally {
    await harness.dispose()
  }
})

test('和人格注入共存：两个段都在，人格在前、记忆在后', async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  // 人格注入只声明 systemPrompt；这里不接人格数据，只用它的段名与顺序占位。
  ctx.inject(['systemPrompt'], (sctx) => {
    sctx.systemPrompt.section({ name: 'humanity:persona', order: 10, text: '人格内容' })
  })
  const dispose = installMemoryInjection(ctx, createLog(ctx, 'test'), {
    store: () => createMemoryStore(createFakeTable()),
    policy: () => resolveMemoryPolicy('balanced'),
    enabled: () => true,
  })
  try {
    const main = { id: 'session-1' }
    ctx.provide('agents', { roots: () => [main], list: () => [main] })
    // `ctx.inject` 的回调在服务就绪后异步落地：等一个宏任务，避免测成'注册还没发生'。
    await new Promise((resolve) => setImmediate(resolve))
    const assembly = await ctx.systemPrompt.assemble({ agent: main, scope: main })
    // 只比较本套件的段：DSH 自己还有 harness/deployment 段，顺序不属于本插件的契约。
    const ours = assembly.sections.map((section) => section.name).filter((name) => name.startsWith('humanity:'))
    assert.deepEqual(ours, ['humanity:persona', MEMORY_SECTION_NAME])
    assert.ok(MEMORY_SECTION_ORDER > 10, '记忆排在人格之后')
  } finally {
    dispose()
    await ctx.fiber.dispose()
  }
})

test('记忆正文里的 {{…}} 会被中和，不让 DSH 的变量插值抛错（审计 S1-3）', async () => {
  // DSH 的 `interpolate()` 遇到解析不了的 `{{…}}` 会抛，而装配路径没有兜底 ——
  // 用户/模型写进记忆的模板语法或代码片段必须在这里被拆开，否则整轮 pre-step 直接没了。
  const harness = await boot()
  try {
    await seed(harness.store, '部署命令是 {{deploy}} 的样子', { tags: ['部署'] })
    const text = await harness.turn(harness.main, '部署命令是什么')
    assert.match(text, /部署命令是 \{ \{deploy\}\} 的样子/, '`{{` 被拆成 `{ {`（只有开头的两字符序列需要拆）')
    assert.equal(text.includes('{{'), false, '注入文本里不能再出现连续的 `{{`')
  } finally {
    await harness.dispose()
  }
})

test('三连/四连花括号也要中和干净（2026-09-26 审计 P7：旧实现漏了 `{{{`）', async () => {
  // 旧实现是 `replaceAll('{{', '{ {')`，而非重叠替换会把 `{{{` 变成 `{ {{` —— 里面**还有一个 `{{`**。
  // 最坏组合是 Handlebars 的 `{{{x}}}`（同时有 `{{` 与 `}}`）：`interpolate()` 会拿 `{{x}}`
  // 去查变量表，查不到就抛 `unknown prompt variable`，整轮 pre-step 直接失败。
  const harness = await boot()
  try {
    await seed(harness.store, '模板写成 {{{raw}}} / {{{{too}}}} 这样', { tags: ['模板'] })
    const text = await harness.turn(harness.main, '模板怎么写')
    assert.equal(text.includes('{{'), false, '三连、四连也不许留下任何 `{{`（那正是会抛错的那个序列）')
  } finally {
    await harness.dispose()
  }
})

test('渲染是纯函数：超预算整条丢弃、放不下一条就返回空串、相对时间可复现', async () => {
  const store = createMemoryStore(createFakeTable())
  await seed(store, '用户喜欢喝咖啡')
  await seed(store, '用户偏好简短回复')
  const entries = store.list()

  const full = renderMemoryBlock(entries, 1000, NOW)
  assert.ok(full.startsWith(BLOCK_TITLE))
  assert.equal(full.split('\n').length, 3)

  // 只放得下一条：第二条整条丢掉，不会出现半句话。
  const oneLine = full.split('\n').slice(0, 2).join('\n')
  const tight = renderMemoryBlock(entries, oneLine.length, NOW)
  assert.equal(tight, oneLine)

  assert.equal(renderMemoryBlock(entries, 5, NOW), '', '连标题都放不下 → 不注入')
  assert.equal(renderMemoryBlock([], 1000, NOW), '', '没有条目 → 不注入')

  assert.equal(relativeTimeOf(NOW, NOW), '今天')
  assert.equal(relativeTimeOf('2026-09-23T05:00:00.000Z', NOW), '昨天')
  assert.equal(relativeTimeOf('2026-09-21T05:00:00.000Z', NOW), '3天前')
  assert.equal(relativeTimeOf('2026-06-24T05:00:00.000Z', NOW), '3个月前')
  assert.equal(relativeTimeOf('2025-09-24T05:00:00.000Z', NOW), '1年前')
})

test('引导语含召回义务（2026-09-25 真机事故回归钉：注入块被当成记忆库全部 → 即兴冒充记忆）', () => {
  // 事故形态：用户问回忆类问题，模型拿自动注入的一两条当全库，即兴补细节并以"我记得"陈述。
  // 义务必须写在每轮注入的引导语里（工具描述的触发条件会被注入块满足而永不触发）。
  assert.match(MEMORY_GUIDANCE, /humanity_recall/)
  assert.match(MEMORY_GUIDANCE, /不是记忆库全部/)
  assert.match(MEMORY_GUIDANCE, /先调用/)
  assert.match(MEMORY_GUIDANCE, /不得把即兴发挥、推测或本会话临时铺陈的内容当作记忆陈述/)
})

test('P0-1（2026-10-04 破戏）：引导语里不再出现"扮演"这类元信息措辞', () => {
  // 破戏根因之一是提示词自己教模型"你在扮演"：原句是
  // 「扮演场景里即兴新细节是允许的，但被问起出处时如实说明它不在记忆里。」
  // 它一边要求"如实说明不在记忆里"，一边把整件事称作"扮演场景"。
  // 现在只保留前半段语义（已由上面"不得把即兴…当作记忆陈述"承担），元信息措辞整体退场。
  // 钉住它，免得下次有人"顺手补回来"。
  assert.doesNotMatch(MEMORY_GUIDANCE, /扮演/, '记忆引导语里不得再出现"扮演"字样')
  assert.doesNotMatch(MEMORY_GUIDANCE, /扮演场景/)
})
