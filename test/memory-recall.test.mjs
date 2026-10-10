/**
 * `humanity_recall` 的端到端测试：真实 `dsh-tools` 管线 + 真实检索/存储。
 *
 * 与自动注入的差别是这一轮的重点（浅层 vs 深层、0–3 条 vs 最多 10 条），
 * 所以除了"能查到"，还要钉住"自动注入挡掉的那条，recall 能查到"。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createLog } from '../lib/log.js'
import { createMemoryEntry } from '../lib/memory/model.js'
import { canRemember, resolveMemoryPolicy } from '../lib/memory/policy.js'
import { searchMemory } from '../lib/memory/search.js'
import { createMemoryStore } from '../lib/memory/store.js'
import { installMemoryTools } from '../lib/memory/tools.js'
import { MEMORY_RECALL_TOOL, RECALL_DESCRIPTION, RECALL_MAX_LIMIT } from '../lib/memory/tools-recall.js'
import { MEMORY_REMEMBER_TOOL } from '../lib/memory/tools-remember.js'
import { createFakeTable } from './helpers/memory-fake.mjs'

// 时间戳必须相对真实时钟：age 标签由工具内的真实 now 计算，钉死日期会在跨过
// 「钉死值 + 24h」那一刻把『今天』变成『昨天』（2026-09-25 真机时间炸弹）。
const NOW = new Date().toISOString()
const SESSION = 'recall-session'
const agent = { id: SESSION, session: { header: { cwd: '/work/shop' } } }

/** 起一套真实环境：工具管线 + 两个记忆工具。 */
async function boot(options = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  const store = createMemoryStore(createFakeTable())
  const policy = () => resolveMemoryPolicy(options.mode ?? 'balanced')
  const tools = installMemoryTools(ctx, createLog(ctx, 'test'), { store: () => store, policy })
  await settle(ctx)

  return {
    ctx,
    store,
    tools,
    seed: (content, overrides = {}) =>
      store.put(
        createMemoryEntry({
          scope: 'long-term',
          content,
          origin: 'agent-derived',
          sourceSessionId: SESSION,
          status: 'active',
          createdAt: NOW,
          updatedAt: NOW,
          ...overrides,
        }),
      ),
    call: (args) =>
      ctx.tools.execute({
        callId: 'call-recall',
        name: MEMORY_RECALL_TOOL,
        arguments: args,
        signal: new AbortController().signal,
        agent,
      }),
    textOf: (result) => result.content.map((block) => block.text ?? '').join('\n'),
    dispose: () => ctx.fiber.dispose(),
  }
}

/** 等两个工具都注册进模型可见集合。 */
async function settle(ctx) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const names = ctx.tools.schemas().map((schema) => schema.name)
    if (names.includes(MEMORY_RECALL_TOOL) && names.includes(MEMORY_REMEMBER_TOOL)) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('记忆工具没有在预期时间内注册')
}

test('基本搜索：命中的条目按可读文本回到模型，结构化字段也齐全', async () => {
  const harness = await boot()
  try {
    await harness.seed('用户喜欢喝咖啡', { tags: ['饮品'], importance: 4 })

    const result = await harness.call({ query: '今天想喝咖啡' })
    assert.equal(result.value === undefined, false, '工具应当返回结构化值')
    assert.equal(result.value.ok, true)
    assert.equal(result.value.count, 1)
    assert.deepEqual(result.value.entries[0].tags, ['饮品'])
    assert.equal(result.value.entries[0].importance, 4)
    assert.equal(result.value.entries[0].age, '今天')

    const text = harness.textOf(result)
    assert.match(text, /找到 1 条相关记忆/)
    assert.match(text, /- \[长期记忆\] 用户喜欢喝咖啡/)
    assert.match(text, /标签：饮品/)
  } finally {
    await harness.dispose()
  }
})

test('scope 过滤：只返回指定作用域', async () => {
  const harness = await boot()
  try {
    await harness.seed('用户喜欢喝咖啡')
    await harness.seed('这次讨论点咖啡', { scope: 'session', ownerId: SESSION })

    const all = await harness.call({ query: '咖啡' })
    assert.equal(all.value.count, 2, '不传 scope 时两层都能查到')

    const sessionOnly = await harness.call({ query: '咖啡', scope: 'session' })
    assert.equal(sessionOnly.value.count, 1)
    assert.equal(sessionOnly.value.entries[0].scope, 'session')
  } finally {
    await harness.dispose()
  }
})

test('limit：按参数截断，且硬上限是 10（工具参数只能调小）', async () => {
  const harness = await boot()
  try {
    for (let index = 0; index < RECALL_MAX_LIMIT + 2; index += 1) {
      await harness.seed(`用户喜欢喝咖啡（第${index}条）`)
    }

    assert.equal((await harness.call({ query: '咖啡', limit: 3 })).value.count, 3)
    assert.equal((await harness.call({ query: '咖啡', limit: 99 })).value.count, RECALL_MAX_LIMIT)
    assert.equal((await harness.call({ query: '咖啡' })).value.count, 5, '缺省 5 条')
  } finally {
    await harness.dispose()
  }
})

test('空结果：成功执行 + 友好提示（不编造，也不报错）', async () => {
  const harness = await boot()
  try {
    await harness.seed('用户喜欢喝咖啡')

    const result = await harness.call({ query: '明天的日程安排' })
    assert.equal(result.value.ok, true)
    assert.equal(result.value.count, 0)
    assert.match(result.value.message, /没有找到相关记忆/)
    assert.match(harness.textOf(result), /换个说法/)
  } finally {
    await harness.dispose()
  }
})

test('归档记忆不被召回（P-026：默认不参与检索）', async () => {
  const harness = await boot()
  try {
    const entry = await harness.seed('用户喜欢喝咖啡')
    await harness.store.archive(entry.dedupeKey)

    assert.equal((await harness.call({ query: '咖啡' })).value.count, 0)
  } finally {
    await harness.dispose()
  }
})

test('深层 vs 浅层：自动注入挡掉的弱命中，recall 查得到', async () => {
  const harness = await boot()
  try {
    // 五个记号里只命中一个 ⇒ 相关度落在 0.15–0.35 之间。
    await harness.seed('用户偏好 pnpm')

    const shallow = await searchMemory(harness.store, resolveMemoryPolicy('balanced'), {
      message: 'pnpm 怎么装依赖',
      sessionId: SESSION,
      workspaceId: '/work/shop',
    })
    assert.deepEqual(shallow, [], '自动注入的阈值（0.35）宁缺毋滥')

    const deep = await harness.call({ query: 'pnpm 怎么装依赖' })
    assert.equal(deep.value.count, 1, 'recall 的阈值更低，由 Agent 自己判断')
  } finally {
    await harness.dispose()
  }
})

test('被关掉的作用域：如实拒绝，而不是假装"没找到"', async () => {
  const harness = await boot({ mode: 'session' })
  try {
    await harness.seed('用户喜欢喝咖啡')

    const result = await harness.call({ query: '咖啡', scope: 'long-term' })
    assert.equal(result.value.ok, false)
    assert.match(result.value.message, /已在当前策略里关闭/)
    assert.equal(result.value.count, 0)
  } finally {
    await harness.dispose()
  }
})

test('两个工具共存，且开关语义一致（off 模式连工具都不注册）', async () => {
  const harness = await boot()
  try {
    const names = harness.ctx.tools.schemas().map((schema) => schema.name)
    assert.ok(names.includes(MEMORY_REMEMBER_TOOL))
    assert.ok(names.includes(MEMORY_RECALL_TOOL))
  } finally {
    await harness.dispose()
  }

  const off = await boot({ mode: 'off' })
  try {
    // 与 `installMemory` 里的接线同一句：开关 + 策略一起决定工具在不在。
    assert.equal(canRemember(resolveMemoryPolicy('off')), false)
    off.tools.setEnabled(canRemember(resolveMemoryPolicy('off')))
    assert.deepEqual(off.ctx.tools.schemas().map((schema) => schema.name), [])
  } finally {
    await off.dispose()
  }
})

test('工具描述不得再带「上下文里没有时」这个自毁条件（2026-09-25 真机事故回归钉 · round 51）', () => {
  // 事故形态：注入块永远存在 ⇒ 条件恒不成立 ⇒ 模型永不调用；用户在扮演里问旧事时，
  // 模型演了一段"闭眼翻找"的动作并声称查不到，全程 0 次 tool/call。
  assert.doesNotMatch(RECALL_DESCRIPTION, /上下文里没有时/)
  assert.match(RECALL_DESCRIPTION, /先调用本工具检索再回答/)
  assert.match(RECALL_DESCRIPTION, /不等于库里已经有/)
  assert.match(RECALL_DESCRIPTION, /叙述性动作代替真正的检索/)
})
