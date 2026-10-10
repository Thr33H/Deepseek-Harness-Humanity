/**
 * 记忆命名空间（工作台数据层）的宿主侧测试：**真实设置服务** + 假存储表。
 *
 * 用真设置服务而不是替身：要证的正是"浏览器写命令 → 钩子真的被调用 → 命令真的落到存储 →
 * 投影真的被写回"这条链路，以及"注册期 validate 不会因为投影数据而把命名空间打挂"（步 1 的教训）。
 * 存储用假表（记忆 CRUD 的语义在 `memory-store.test.mjs` 已单独测过）。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SettingsFile from '@deepseek-ai/dsh-settings-file'
import { createLog } from '../lib/log.js'
import { createMemoryEntry } from '../lib/memory/model.js'
import { overridesOf, resolveMemoryPolicy } from '../lib/memory/policy.js'
import { installMemorySection, MEMORY_NAMESPACE } from '../lib/memory/section.js'
import { createMemoryStore } from '../lib/memory/store.js'
import { createFakeTable } from './helpers/memory-fake.mjs'

const NOW = '2026-09-24T00:00:00.000Z'

/** 让已排队的微任务跑完（`ctx.inject` 回调与 `onChange` 的异步消费都靠它落地）。 */
const flush = () => new Promise((resolve) => setImmediate(resolve))

/** 等到条件成立（按时间轮询，理由同 `send`）。 */
async function waitUntil(check, description, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`等待超时：${description}`)
}

/** 起一套真实设置服务 + 记忆命名空间。 */
async function boot(options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'humanity-memory-ns-'))
  const ctx = new Context()
  await ctx.plugin(SettingsFile, { path: path.join(dir, 'settings.yml') })
  const store = createMemoryStore(createFakeTable())
  const advanced = options.advanced ?? {
    customized: false,
    longTerm: true,
    work: true,
    session: true,
    maxInject: 3,
    decay: true,
    vector: false,
  }
  const section = installMemorySection(ctx, createLog(ctx, 'test'), {
    store: () => store,
    policy: () => resolveMemoryPolicy('balanced', overridesOf(advanced) ?? {}),
    advanced: () => advanced,
  })
  await flush()

  const seed = (content, overrides = {}) =>
    store.put(
      createMemoryEntry({
        scope: 'long-term',
        content,
        origin: 'agent-derived',
        sourceSessionId: 's1',
        status: 'active',
        createdAt: NOW,
        updatedAt: NOW,
        ...overrides,
      }),
    )
  const view = () => ctx.settings.get(MEMORY_NAMESPACE)
  /**
   * 发一条命令并等它被**消费完**。
   *
   * 等待必须按**时间**而不是按轮次：消费链路里有真实落盘（设置文件写入），
   * 整套测试并行跑时它能慢到几十毫秒 —— 用"等 50 个宏任务"会变成随机失败的测试。
   */
  const send = async (op, fingerprint = '') => {
    await ctx.settings.update(MEMORY_NAMESPACE, { request: { op, fingerprint } })
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      const request = ctx.settings.get(MEMORY_NAMESPACE)?.request
      if (request === undefined || request.op === '') return
    }
    throw new Error('命令没有被消费')
  }

  return {
    ctx,
    store,
    section,
    seed,
    view,
    send,
    dispose: async () => {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

test('投影：宿主把存储现状与生效策略写进命名空间（工作台读的就是它）', async () => {
  const harness = await boot()
  try {
    const entry = await harness.seed('用户喜欢喝咖啡', { tags: ['咖啡'], importance: 4, status: 'pending' })
    await harness.section.refresh()

    const doc = harness.view()
    assert.equal(harness.section.attached, true)
    assert.equal(doc.entries.length, 1)
    assert.equal(doc.entries[0].fingerprint, entry.dedupeKey)
    assert.deepEqual(doc.entries[0].tags, ['咖啡'])
    assert.equal(doc.entries[0].status, 'pending')
    assert.equal(doc.policy.mode, 'balanced', '工作台显示的是生效策略（P-030）')
    assert.equal(doc.policy.scopes['long-term'], true)
    assert.equal(doc.request.op, '', '稳态下命令槽是空的')
    // 界面视图只带叶子字段：内部记录（去重键之外的字段、冲突列表）不该漏出去。
    assert.equal('conflictWith' in doc.entries[0], false)
  } finally {
    await harness.dispose()
  }
})

test('确认与拒绝：命令从命令槽进来，落到存储，并回一句结论', async () => {
  const harness = await boot()
  try {
    const pending = await harness.seed('用户的门禁密码', { status: 'pending', sensitive: true })
    await harness.section.refresh()

    await harness.send('confirm', pending.dedupeKey)
    assert.equal(harness.store.get(pending.dedupeKey).status, 'active')
    assert.equal(harness.store.get(pending.dedupeKey).confirmedVia, 'workbench', 'T2：记下是哪一端确认的')
    assert.match(harness.view().notice, /已确认/)

    const second = await harness.seed('用户随口一提', { status: 'pending' })
    await harness.section.refresh()
    await harness.send('reject', second.dedupeKey)
    assert.equal(harness.store.get(second.dedupeKey), undefined, '拒绝即删除')
    assert.match(harness.view().notice, /已拒绝/)
  } finally {
    await harness.dispose()
  }
})

test('归档 / 恢复 / 固定 / 删除：四条命令都能从工作台发起', async () => {
  const harness = await boot()
  try {
    const entry = await harness.seed('旧项目信息')
    await harness.send('archive', entry.dedupeKey)
    assert.equal(harness.store.get(entry.dedupeKey).status, 'archived')

    await harness.send('restore', entry.dedupeKey)
    assert.equal(harness.store.get(entry.dedupeKey).status, 'active')

    await harness.send('pin', entry.dedupeKey)
    assert.equal(harness.store.get(entry.dedupeKey).pinned, true)
    await harness.send('unpin', entry.dedupeKey)
    assert.equal(harness.store.get(entry.dedupeKey).pinned, false)

    await harness.send('remove', entry.dedupeKey)
    assert.equal(harness.store.get(entry.dedupeKey), undefined)
  } finally {
    await harness.dispose()
  }
})

test('重复命令是幂等的：第二次不会产生副作用，只如实说明', async () => {
  const harness = await boot()
  try {
    const entry = await harness.seed('用户偏好简短回复')
    await harness.send('archive', entry.dedupeKey)
    await harness.send('archive', entry.dedupeKey)

    assert.equal(harness.store.get(entry.dedupeKey).status, 'archived')
    assert.match(harness.view().notice, /已归档/)
  } finally {
    await harness.dispose()
  }
})

test('不认识的命令在写入时就被拒（validate 只查命令槽，不查条目）', async () => {
  const harness = await boot()
  try {
    await assert.rejects(
      harness.ctx.settings.update(MEMORY_NAMESPACE, { request: { op: '格式化硬盘', fingerprint: 'x' } }),
      /不认识的记忆操作/,
    )
    // 投影里带着投影数据时，注册期与写入期的 validate 都不会因为它们而失败。
    await harness.seed('用户喜欢喝咖啡')
    await harness.section.refresh()
    assert.equal(harness.view().entries.length, 1)
  } finally {
    await harness.dispose()
  }
})

test('存储未就绪：命名空间照常注册（工作台能看到空列表），命令不落盘也不抛', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'humanity-memory-ns-'))
  const ctx = new Context()
  await ctx.plugin(SettingsFile, { path: path.join(dir, 'settings.yml') })
  const section = installMemorySection(ctx, createLog(ctx, 'test'), {
    store: () => undefined,
    policy: () => resolveMemoryPolicy('balanced'),
  })
  try {
    await flush()
    assert.equal(section.attached, true, '没有存储也要注册：否则工作台连"记忆为空"都看不到')
    await ctx.settings.update(MEMORY_NAMESPACE, { request: { op: 'remove', fingerprint: 'x' } })
    await flush()
    assert.equal(ctx.settings.get(MEMORY_NAMESPACE).entries.length, 0)
  } finally {
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('投影带出高级开关与「自定义」标记（工作台据此显示与编辑）', async () => {
  const custom = { customized: true, longTerm: false, work: true, session: true, maxInject: 2, decay: false, vector: true }
  const harness = await boot({ advanced: custom })
  try {
    await harness.section.refresh()
    const doc = harness.view()
    assert.equal(doc.policy.customized, true, '用户调过高级开关 ⇒ 界面显示「自定义」')
    assert.equal(doc.policy.scopes['long-term'], false)
    assert.equal(doc.advanced.maxInject, 2)
    assert.equal(doc.advanced.decay, false)
    assert.equal(doc.policy.vector, false, '向量开关真值为 true，但生效策略里恒为 false（P-027）')
  } finally {
    await harness.dispose()
  }
})

test('三层全关但模式不是 off：开关显示**生效值**（宿主已回退成按模式），不和作用域标签打架', async () => {
  // 2026-09-26 审计 C6：配置里存在 `customized + 三层全关 + balanced` 这种宿主会回退的组合时，
  // 旧投影把开关原样显示成"全关"，而「生效作用域」按回退后的策略显示"三层全在" ——
  // 两个控件贴着摆却互相打脸，用户不知道该信哪个。现在两者同源于 policy。
  const degenerate = { customized: true, longTerm: false, work: false, session: false, maxInject: 3, decay: true, vector: false }
  const harness = await boot({ advanced: degenerate })
  try {
    await harness.section.refresh()
    const doc = harness.view()
    assert.equal(doc.policy.mode, 'balanced', '模式本身没变')
    for (const scope of ['long-term', 'workspace', 'session']) {
      assert.equal(doc.policy.scopes[scope], true, `策略里 ${scope} 生效（回退到预设）`)
    }
    assert.deepEqual(
      [doc.advanced.longTerm, doc.advanced.work, doc.advanced.session],
      [true, true, true],
      '开关显示的就是生效值（回退后的真值），不是配置里的原值',
    )
    assert.equal(doc.advanced.maxInject, 3, '数字项仍显示用户填的原值（它没有被回退）')
  } finally {
    await harness.dispose()
  }
})

test('工作台的「整理记忆」命令走同一个命令槽', async () => {
  const harness = await boot()
  try {
    await harness.seed('用户喜欢喝咖啡', { importance: 2, updatedAt: '2026-01-01T00:00:00.000Z' })
    await harness.send('decay')
    assert.equal(harness.store.list(undefined, 'archived').length, 1)
    assert.match(harness.view().notice, /记忆维护/)
  } finally {
    await harness.dispose()
  }
})

test('客户端常量与宿主一致：命名空间名不许两边各写一个不同的值', async () => {
  const { readFileSync } = await import('node:fs')
  const bundle = readFileSync('lib/client.js', 'utf8')
  assert.ok(bundle.includes(MEMORY_NAMESPACE), '客户端 bundle 必须使用同一个命名空间名')
})

test('存储晚于命名空间就绪：notifyStoreReady 补投影 + 补消费被跳过的命令', async () => {
  // 真机症状的复现：存储是异步打开的，比命名空间注册晚。就绪之前收到的命令被跳过、
  // 投影提前返回 —— 没有这个回调，工作台会一直停在空列表上（存储里其实已有记忆）。
  const dir = await mkdtemp(path.join(tmpdir(), 'humanity-memory-ready-'))
  const ctx = new Context()
  await ctx.plugin(SettingsFile, { path: path.join(dir, 'settings.yml') })
  const table = createFakeTable()
  const store = createMemoryStore(table)
  let ready = false
  const section = installMemorySection(ctx, createLog(ctx, 'test'), {
    store: () => (ready ? store : undefined),
    policy: () => resolveMemoryPolicy('balanced'),
  })
  try {
    await flush()
    const entry = await store.put(
      createMemoryEntry({
        scope: 'long-term',
        content: '用户喜欢喝咖啡',
        origin: 'agent-derived',
        sourceSessionId: 's1',
        status: 'active',
        createdAt: NOW,
        updatedAt: NOW,
      }),
    )

    // 存储未就绪时发一条命令：会被跳过，命令槽留着，投影也是空的。
    await ctx.settings.update(MEMORY_NAMESPACE, { request: { op: 'archive', fingerprint: entry.dedupeKey } })
    await flush()
    assert.equal(store.get(entry.dedupeKey).status, 'active', '存储未就绪时命令确实被跳过')
    assert.equal(ctx.settings.get(MEMORY_NAMESPACE).entries.length, 0, '未就绪时投影为空')

    // 存储就绪：一次通知既补消费积压命令，也补投影。
    ready = true
    section.notifyStoreReady()
    await waitUntil(() => store.get(entry.dedupeKey).status === 'archived', '积压命令被补消费')
    await waitUntil(() => ctx.settings.get(MEMORY_NAMESPACE).entries.length === 1, '投影补上存储现状')
    assert.equal(ctx.settings.get(MEMORY_NAMESPACE).entries[0].fingerprint, entry.dedupeKey)
    assert.match(ctx.settings.get(MEMORY_NAMESPACE).notice, /已归档/)
  } finally {
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})
