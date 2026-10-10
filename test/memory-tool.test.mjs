/**
 * `humanity_remember` 的端到端测试：**真实** `dsh-tools` 管线 + 真实的记忆存储面。
 *
 * 为什么用真工具运行时而不是替身：要验证的正是"工具真的注册进了模型可见集合"、
 * "调用方会话身份真的被带进记忆来源"、"工具结果真的以文本回到模型"这三件事 ——
 * 替身会把它们全替换掉，只剩一句"函数被调用了"。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createLog } from '../lib/log.js'
import { DEFAULT_CONFIDENCE } from '../lib/memory/constants.js'
import { resolveMemoryPolicy } from '../lib/memory/policy.js'
import { installMemoryTools } from '../lib/memory/tools.js'
import { MEMORY_REMEMBER_TOOL } from '../lib/memory/tools-remember.js'
import { createMemoryStore } from '../lib/memory/store.js'
import { createFakeTable } from './helpers/memory-fake.mjs'

/** 调用工具时携带的 agent 替身：会话身份与工作区（`cwd`）都从这里读。 */
const agent = { id: 'session-9', session: { header: { cwd: '/work/shop' } } }

/**
 * 起一套真实宿主：工具管线 + 记忆工具 + 一张 Map 假表。
 * @param options.mode - 预设模式；`options.noStore` 为真时模拟"存储尚未就绪"。
 */
async function boot(options = {}) {
  const ctx = new Context()
  const log = createLog(ctx, 'test')
  // ToolRuntime 声明了 `static inject = ['systemPrompt']`：不先挂系统提示词，工具服务不会激活。
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  const table = createFakeTable()
  const store = createMemoryStore(table)
  const tools = installMemoryTools(ctx, log, {
    store: () => (options.noStore === true ? undefined : store),
    policy: () => resolveMemoryPolicy(options.mode ?? 'balanced'),
    ...(options.onChanged === undefined ? {} : { changed: options.onChanged }),
  })
  await settle(ctx)

  return {
    ctx,
    table,
    store,
    tools,
    call: (args, withAgent = true) =>
      ctx.tools.execute({
        callId: 'call-remember',
        name: MEMORY_REMEMBER_TOOL,
        arguments: args,
        signal: new AbortController().signal,
        ...(withAgent ? { agent } : {}),
      }),
    textOf: (result) => result.content.map((block) => block.text ?? '').join('\n'),
    dispose: () => ctx.fiber.dispose(),
  }
}

/** 等工具真的注册进模型可见集合（`defineTool` 走动态 import，注册是异步落地的）。 */
async function settle(ctx) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (ctx.tools.schemas().some((schema) => schema.name === MEMORY_REMEMBER_TOOL)) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('记忆工具没有在预期时间内注册')
}

test('工具注册进模型可见集合；调用后内容落进记忆，并带上调用方会话身份', async () => {
  const harness = await boot()
  try {
    const text = harness.textOf(await harness.call({ content: '用户偏好简短回复' }))
    assert.match(text, /已写入长期记忆/)

    const entries = harness.store.list()
    assert.equal(entries.length, 1)
    assert.equal(entries[0].content, '用户偏好简短回复')
    assert.equal(entries[0].sourceSessionId, 'session-9', '记忆必须记录来源会话')
    assert.equal(entries[0].confidence, DEFAULT_CONFIDENCE, '默认按 Agent 推断记录（置信度不满分）')
    assert.equal(entries[0].origin, 'agent-derived')
    assert.equal(entries[0].status, 'active')
  } finally {
    await harness.dispose()
  }
})

test('origin=user-stated 时置信度记满，并落到参数指定的作用域与工作区', async () => {
  const harness = await boot()
  try {
    await harness.call({
      content: '用户偏好简短回复',
      scope: 'workspace',
      origin: 'user-stated',
      tags: ['偏好'],
    })

    const entry = harness.store.list()[0]
    assert.equal(entry.origin, 'user-stated')
    assert.equal(entry.confidence, 1)
    assert.equal(entry.scope, 'workspace')
    assert.equal(entry.ownerId, '/work/shop', '工作记忆归到调用方所在工作区')
    assert.deepEqual(entry.tags, ['偏好'])
  } finally {
    await harness.dispose()
  }
})

test('sensitive 只进待确认，工具结果如实说明"确认前不生效"', async () => {
  const harness = await boot()
  try {
    const text = harness.textOf(await harness.call({ content: '用户的门禁密码', sensitivity: 'sensitive' }))

    assert.match(text, /待确认/)
    assert.equal(harness.store.list(undefined, 'pending').length, 1)
    assert.equal(harness.store.list(undefined, 'active').length, 0)
    assert.equal(harness.store.list()[0].sensitive, true)
  } finally {
    await harness.dispose()
  }
})

test('冲突内容照样写入，工具结果提示"已标记、等用户处理"', async () => {
  const harness = await boot()
  try {
    await harness.call({ content: '用户喜欢咖啡' })
    const text = harness.textOf(await harness.call({ content: '用户不喜欢咖啡' }))

    assert.match(text, /可能矛盾/)
    assert.equal(harness.store.list().length, 2)
    assert.equal(harness.store.list()[0].conflictWith.length + harness.store.list()[1].conflictWith.length, 2)
  } finally {
    await harness.dispose()
  }
})

test('拿不到会话身份就不写：来源是记忆的必备信息，不编一个', async () => {
  const harness = await boot()
  try {
    const text = harness.textOf(await harness.call({ content: '用户偏好简短回复' }, false))

    assert.match(text, /读不到当前会话身份/)
    assert.equal(harness.store.list().length, 0)
  } finally {
    await harness.dispose()
  }
})

test('存储未就绪时工具拒绝写入并说明原因（G-002 降级，不抛）', async () => {
  const harness = await boot({ noStore: true })
  try {
    const text = harness.textOf(await harness.call({ content: '用户偏好简短回复' }))

    assert.match(text, /存储尚未就绪/)
    assert.equal(harness.table.records.size, 0)
  } finally {
    await harness.dispose()
  }
})

test('模式 off：开关一关，工具立刻从模型可见集合里消失（P-030 即时生效）', async () => {
  const harness = await boot()
  try {
    assert.equal(harness.ctx.tools.schemas().some((schema) => schema.name === MEMORY_REMEMBER_TOOL), true)

    harness.tools.setEnabled(false)
    assert.equal(harness.ctx.tools.schemas().some((schema) => schema.name === MEMORY_REMEMBER_TOOL), false)

    harness.tools.setEnabled(true)
    assert.equal(harness.ctx.tools.schemas().some((schema) => schema.name === MEMORY_REMEMBER_TOOL), true)
  } finally {
    await harness.dispose()
  }
})

test('写入成功就通知工作台重新投影；被拒时一个字都不发', async () => {
  // 真机症状：`humanity_remember` 写进了存储，工作台的 `entries` 还是空的 ——
  // 因为投影只在命令路径上刷新，工具直写没人通知。这条把通知契约钉住。
  let notifications = 0
  const harness = await boot({ onChanged: () => { notifications += 1 } })
  try {
    await harness.call({ content: '用户偏好简短回复' })
    assert.equal(notifications, 1, '成功写入必须通知一次')

    // 敏感内容也真的落盘（进待确认）⇒ 同样要通知：工作台的待确认队列要能看见它。
    await harness.call({ content: '用户的门禁密码是 1234', sensitivity: 'sensitive' })
    assert.equal(notifications, 2, '进待确认也是写入，必须通知')
  } finally {
    await harness.dispose()
  }

  // 存储未就绪 ⇒ 拒绝写入 ⇒ 不该产生任何投影动作（否则会把空列表盖上去）。
  let refused = 0
  const offline = await boot({ noStore: true, onChanged: () => { refused += 1 } })
  try {
    await offline.call({ content: '用户偏好简短回复' })
    assert.equal(refused, 0, '拒绝写入时不得通知')
  } finally {
    await offline.dispose()
  }
})
