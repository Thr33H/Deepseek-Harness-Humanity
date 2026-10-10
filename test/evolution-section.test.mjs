/**
 * 自进化命名空间（工作台数据层）的宿主侧测试：**真实设置服务** + 假存储 + 假动作面。
 *
 * 与 `memory-section.test.mjs` 同一取舍：要证的正是"浏览器写命令 → validate/onChange 钩子
 * 真的被调用 → 命令真的执行 → 投影真的写回、命令槽按守则清空"这条链路；
 * 提案审核与运行编排的语义各自有自己的测试文件。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SettingsFile from '@deepseek-ai/dsh-settings-file'
import { createLog } from '../lib/log.js'
import { EVOLUTION_NAMESPACE } from '../lib/evolution/constants.js'
import { createProposal, createRunRecord } from '../lib/evolution/model.js'
import { installEvolutionSection } from '../lib/evolution/section.js'
import { DECIDED_VIEW_CAP, shouldClearRequest } from '../lib/evolution/section-runtime.js'
import { EMPTY_REQUEST } from '../lib/evolution/ops.js'
import { fakeEvolutionState } from './helpers/evolution-fake.mjs'

/** 让已排队的微任务跑完（ctx.inject 回调与 onChange 的异步消费都靠它落地）。 */
const flush = () => new Promise((resolve) => setImmediate(resolve))

/** 等到条件成立。 */
async function waitUntil(check, description, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`等待超时：${description}`)
}

/** 起一套真实设置服务 + 自进化命名空间。 */
async function boot(options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'humanity-evolution-ns-'))
  const ctx = new Context()
  await ctx.plugin(SettingsFile, { path: path.join(dir, 'settings.yml') })
  const { state } = fakeEvolutionState()
  const starts = []
  const approvals = []
  const runner = {
    current: () => (options.busy === true ? { id: 'x', mode: 'incremental', startedAt: '' } : undefined),
    start: async (runOptions) => {
      starts.push(runOptions)
      return { id: 'run', ...createRunRecord('incremental', 'manual'), status: 'completed' }
    },
  }
  const proposals = {
    approve: async (id) => {
      approvals.push(['approve', id])
      return options.approveNotice ?? '提案已应用。'
    },
    reject: async (id) => {
      approvals.push(['reject', id])
      return '已拒绝该提案。'
    },
    delete: async (id) => {
      approvals.push(['delete', id])
      return '提案已删除。'
    },
  }

  let storeReady = options.storeReady ?? true
  const section = installEvolutionSection(ctx, createLog(ctx, 'test'), {
    state: () => (storeReady ? state : undefined),
    ops: () => ({ runner, proposals, refresh: () => {}, warn: () => {} }),
    // 0.1.9：`storeReady` 由宿主**现算**（不再由投影层写死 true）⇒ 这里也如实跟着存储句柄走。
    status: () => ({ enabled: true, storeReady, scanReady: true, modelReady: true, skillsReady: true }),
    memoryPendingCount: () => options.memoryPending ?? 0,
    nextRunAt: () => options.nextRunAt ?? 0,
    dailyCallCap: () => 20,
  })
  await flush()
  // 首次投影是异步落盘（settings.update 跨微任务/IO）：等它到位，否则断言读到 schema 默认值。
  if (storeReady) {
    await waitUntil(() => ctx.settings.get(EVOLUTION_NAMESPACE)?.status?.storeReady === true, '首次投影落盘')
  }

  return {
    ctx,
    state,
    section,
    starts,
    approvals,
    runner,
    view: () => ctx.settings.get(EVOLUTION_NAMESPACE),
    send: async (request) => {
      await ctx.settings.update(EVOLUTION_NAMESPACE, { request })
    },
    setStoreReady: (next) => {
      storeReady = next
    },
    dispose: async () => {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

test('命令槽按**逐字段**比对清空：技能命令的内容字段也算数（审计：漏比等于静默吞命令）', () => {
  // 技能命令把 op/id/mode/rescan* 之外的字段留在 skillName / skillDescription / skillContent 里，
  // 旧实现只比前五项 —— 于是"第一条技能命令的投影"会把窗口内提交的第二条技能命令一起清掉，
  // 用户按了保存却什么都没发生（没有任何报错，最难查的一类）。
  const skill = (name, content) => ({
    ...EMPTY_REQUEST,
    op: 'skill-update',
    skillName: name,
    skillContent: content,
  })

  assert.equal(shouldClearRequest(skill('a', '正文一'), skill('a', '正文一')), true, '同一条 ⇒ 可以清')
  assert.equal(shouldClearRequest(skill('a', '正文二'), skill('a', '正文一')), false, '正文改了 ⇒ 是另一条命令')
  assert.equal(shouldClearRequest(skill('b', '正文一'), skill('a', '正文一')), false, '换了个技能 ⇒ 不许清')
  assert.equal(shouldClearRequest({ ...EMPTY_REQUEST }, skill('a', '正文一')), true, '空槽无事可做')
  assert.equal(shouldClearRequest(undefined, skill('a', '正文一')), false, '读不到槽就不动它')
  assert.equal(shouldClearRequest(skill('a', '正文一'), undefined), false, '不是由命令触发的投影不许替客户端做决定')
})

test('接上设置服务即注册并投影：宿主字段齐、命令槽为空', async () => {
  const harness = await boot()
  try {
    assert.equal(harness.section.attached, true)
    const doc = harness.view()
    assert.deepEqual(doc.runs, [])
    assert.deepEqual(doc.proposals, [])
    assert.deepEqual(doc.pendingCounts, { memory: 0, persona: 0, skill: 0, route: 0, total: 0 })
    assert.deepEqual(doc.status, { enabled: true, storeReady: true, scanReady: true, modelReady: true, skillsReady: true })
    assert.equal(doc.dailyCallCap, 20)
    assert.equal(doc.request.op, '')
  } finally {
    await harness.dispose()
  }
})

test('存储里有内容 → 投影带出运行/提案/计数；记忆 pending 并入总数（P-042）', async () => {
  const harness = await boot({ memoryPending: 2 })
  try {
    const run = createRunRecord('dream', 'scheduled', '2026-09-25T03:00:00.000Z')
    await harness.state.putRun({ ...run, status: 'completed', narrative: '一段梦', insights: ['洞察'] })
    await harness.state.putProposal(createProposal({ kind: 'persona', title: '身份卡：归属地' }, 65536))
    await harness.section.refresh()

    const doc = harness.view()
    assert.equal(doc.runs.length, 1)
    assert.equal(doc.runs[0].narrative, '一段梦')
    assert.equal(doc.proposals.length, 1)
    assert.deepEqual(doc.pendingCounts, { memory: 2, persona: 1, skill: 0, route: 0, total: 3 })
  } finally {
    await harness.dispose()
  }
})

test('客户端命令 approve：真的执行、结论进 notice、命令槽清空', async () => {
  const harness = await boot()
  try {
    await harness.send({ op: 'approve', id: 'p1', mode: '', rescanKind: '', rescanValue: '' })
    await waitUntil(() => harness.approvals.length > 0, '命令被消费')
    assert.deepEqual(harness.approvals[0], ['approve', 'p1'])
    await waitUntil(() => harness.view().notice === '提案已应用。', '结论投影回工作台')
    await waitUntil(() => harness.view().request.op === '', '命令槽清空')
  } finally {
    await harness.dispose()
  }
})

test('run 命令：发射 runner 并立刻回通知（不阻塞命令队列）', async () => {
  const harness = await boot()
  try {
    await harness.send({ op: 'run', id: '', mode: 'dream', rescanKind: '', rescanValue: '' })
    await waitUntil(() => harness.starts.length > 0, '运行被启动')
    assert.deepEqual(harness.starts[0], { mode: 'dream', trigger: 'manual', rescan: undefined })
    await waitUntil(() => harness.view().notice.includes('已启动'), '启动通知投影')
  } finally {
    await harness.dispose()
  }
})

test('run 命令在互斥被占时：不发射，通知里如实说明', async () => {
  const harness = await boot({ busy: true })
  try {
    await harness.send({ op: 'run', id: '', mode: 'incremental', rescanKind: '', rescanValue: '' })
    await waitUntil(() => harness.view().notice.includes('已有一次整理在运行'), '互斥通知')
    assert.equal(harness.starts.length, 0)
  } finally {
    await harness.dispose()
  }
})

test('rescan 范围不合法：拒绝并说明，不发射', async () => {
  const harness = await boot()
  try {
    await harness.send({ op: 'rescan', id: '', mode: '', rescanKind: 'days', rescanValue: '零' })
    await waitUntil(() => harness.view().notice.includes('不合法'), '拒绝通知')
    assert.equal(harness.starts.length, 0)

    await harness.send({ op: 'rescan', id: '', mode: '', rescanKind: 'days', rescanValue: '7' })
    await waitUntil(() => harness.starts.length > 0, '合法回扫被启动')
    assert.deepEqual(harness.starts[0].rescan, { kind: 'days', days: 7 })
  } finally {
    await harness.dispose()
  }
})

test('未知命令被 validate 钩子拒之门外（注册期教训：坏命令不许进来）', async () => {
  const harness = await boot()
  try {
    await assert.rejects(
      harness.send({ op: '格式化硬盘', id: '', mode: '', rescanKind: '', rescanValue: '' }),
      /不认识的自进化操作/,
    )
  } finally {
    await harness.dispose()
  }
})

test('存储未就绪：注册照做（工作台要能看到"未就绪"）、命令跳过；就绪后补消费 + 补投影', async () => {
  const harness = await boot({ storeReady: false })
  try {
    assert.equal(harness.section.attached, true, '没有存储也要注册：否则工作台连状态都看不到')
    await harness.send({ op: 'approve', id: 'p1', mode: '', rescanKind: '', rescanValue: '' })
    await flush()
    assert.equal(harness.approvals.length, 0, '存储未就绪时命令被跳过而不是丢失')

    harness.setStoreReady(true)
    harness.section.notifyStoreReady()
    await waitUntil(() => harness.approvals.length === 1, '积压命令被补消费')
    await waitUntil(() => harness.view().status.storeReady === true, '投影补上就绪状态')
  } finally {
    await harness.dispose()
  }
})

test(`已处理提案在投影里最多 ${DECIDED_VIEW_CAP} 条；pending 永远全量`, async () => {
  const harness = await boot()
  try {
    for (let index = 0; index < DECIDED_VIEW_CAP + 5; index += 1) {
      const record = createProposal({ kind: 'route', title: `已处理 ${index}` }, 65536)
      await harness.state.putProposal({ ...record, status: 'rejected' })
    }
    for (let index = 0; index < 3; index += 1) {
      await harness.state.putProposal(createProposal({ kind: 'skill', title: `待确认 ${index}` }, 65536))
    }
    await harness.section.refresh()

    const doc = harness.view()
    assert.equal(doc.proposals.length, DECIDED_VIEW_CAP + 3)
    // pending 排在前面（用户打开待确认页先看到待办）。
    assert.equal(doc.proposals[0].status, 'pending')
    assert.equal(doc.pendingCounts.total, 3)
  } finally {
    await harness.dispose()
  }
})

test('设置服务缺席：不抛、attached=false（G-002 降级）', async () => {
  const ctx = new Context()
  const { state } = fakeEvolutionState()
  const section = installEvolutionSection(ctx, createLog(ctx, 'test'), {
    state: () => state,
    ops: () => undefined,
    status: () => ({ enabled: true, storeReady: true, scanReady: false, modelReady: false, skillsReady: false }),
    memoryPendingCount: () => 0,
    nextRunAt: () => 0,
    dailyCallCap: () => 20,
  })
  await flush()
  assert.equal(section.attached, false)
  await ctx.fiber.dispose()
})
