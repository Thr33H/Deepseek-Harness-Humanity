/**
 * 0.1.10 · B：自进化每轮**顺带**跑一次记忆衰减核算（V6/V7/V8）。
 *
 * 病根：0.1.9 的衰减只在**检索路径**顺带触发（`void`、不 await、≥24h 一次），
 * 于是"记忆维护"基本等于"没人看得见"——生产库里 98 条记忆全 active、0 归档。
 * 本版让自进化每轮都跑一次，并把报告**写进运行记录**（用户翻时间线就能看见）。
 *
 * 本文件钉三条性质：
 * 1. **阳性**：跑一轮，运行记录里出现核算报告（扫描/受保护/未到期/归档），且真的归档了该归档的（V6）；
 * 2. **阴性对照**：`advanced.decay=false`（含记忆模块 off）时**不跑核算** —— 库里的条目一个都不许动，
 *    运行记录里也不许出现那行报告（V7，防恒真）；
 * 3. **可配**：`decayUnusedDays` 配 30 就解析成 30，没配就是 90（默认不漂移），且窗口真的影响行为（V8）。
 *
 * ⚠️ 时间显式传入（`deps.now`）：衰减是"多少天没用"的判定，靠真实时钟的用例会在某天突然变红。
 * 归档是**状态位**不是删除：`restore` 可恢复（受保护规则本轮一个字都没动）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { Config } from '../lib/config.js'
import { createRunner } from '../lib/evolution/run.js'
import { createLog } from '../lib/log.js'
import { createMemoryEntry } from '../lib/memory/model.js'
import { overridesOf, resolveMemoryPolicy } from '../lib/memory/policy.js'
import { createMemoryStore } from '../lib/memory/store.js'
import { createFakeTable, fakeEvolutionState, fakeSessionQuery } from './helpers/evolution-fake.mjs'

const log = createLog(new Context(), 'test')
const NOW = '2026-09-25T12:00:00.000Z'
const BASELINE = '2026-09-20T00:00:00.000Z'

/** `days` 天前的 ISO 时刻（相对 `NOW`）。 */
function daysAgo(days) {
  return new Date(Date.parse(NOW) - days * 86_400_000).toISOString()
}

/** 写入一条记忆（默认：很早写下、从没用过、重要度 3 ⇒ 可衰减区）。 */
async function seedMemory(store, content, overrides = {}) {
  const entry = createMemoryEntry({
    scope: 'long-term',
    content,
    origin: 'agent-derived',
    sourceSessionId: 's1',
    status: 'active',
    confidence: 0.6,
    importance: 3,
    createdAt: daysAgo(300),
    updatedAt: daysAgo(300),
    ...overrides,
  })
  await store.put(entry)
  return entry
}

/**
 * 造运行环境：**没有待消化内容**（`sessionQuery` 空、模型路由缺席）——
 * 这正是要证的："维护不依赖扫描与模型路由"。
 * @param options.policy - 生效记忆策略（决定跑不跑核算）。
 */
function harness(options = {}) {
  const { state } = fakeEvolutionState()
  const memoryTable = createFakeTable()
  const store = createMemoryStore(memoryTable)
  const policy = options.policy ?? resolveMemoryPolicy('balanced')
  const config = {
    evolution: {
      enabled: true,
      schedule: { mode: 'idle', idleMinutes: 30, timeOfDay: '03:00', weekday: 1, monthDay: 1, timezone: '' },
      scan: { includeSubSessions: false },
      budget: {
        maxSessionsPerRun: 5,
        maxEventsPerSession: 200,
        maxInputBytesPerCall: 32768,
        maxOutputTokensPerCall: 2000,
        dailyCallCap: 20,
      },
    },
    dream: { enabled: true },
  }
  const deps = {
    state,
    config: () => config,
    enabled: () => true,
    sessionQuery: () => fakeSessionQuery([], {}),
    llm: {
      route: () => undefined,
      streamText: async () => {
        throw new Error('本轮没有待消化内容，不该调用模型')
      },
    },
    classify: () => ({
      memoryStore: () => store,
      memoryPolicy: () => policy,
      persona: () => undefined,
      skills: () => undefined,
      state,
      log,
    }),
    log,
    now: () => NOW,
  }
  return { runner: createRunner(deps), state, store }
}

/** 预置基线并跑一轮。 */
async function runOnce(harnessed) {
  await harnessed.state.mutateState({ baselineAt: BASELINE })
  return harnessed.runner.start({ mode: 'incremental', trigger: 'manual' })
}

/** 由高级开关（配置形状）解析出生效策略 —— 走产品真实的配置通道，不手搓策略对象。 */
function policyOf(advanced) {
  return resolveMemoryPolicy('balanced', overridesOf(advanced, 'balanced') ?? {})
}

test('V6 阳性：跑一轮 ⇒ 运行记录里出现核算报告，该归档的真的被归档', async () => {
  const harnessed = harness()
  await seedMemory(harnessed.store, '用户偏好简短回复', { importance: 3, updatedAt: daysAgo(300) })
  await seedMemory(harnessed.store, '用户明确说过的重要约定', { importance: 4, updatedAt: daysAgo(300) })
  await seedMemory(harnessed.store, '最近写下的偏好', { importance: 3, updatedAt: daysAgo(10) })

  const record = await runOnce(harnessed)

  assert.match(record.error, /记忆维护/, '运行记录里必须出现这次核算')
  assert.match(record.error, /扫描 3 条/, '扫描数要如实')
  assert.match(record.error, /受保护 1 条/, 'importance≥4 属受保护（P-026，规则未动）')
  assert.match(record.error, /未到期 1 条/, '10 天未用还在 90 天窗口内')
  assert.match(record.error, /归档 1 条/, '300 天未用的低重要度条目应被归档')
  // 报告不是嘴上说说：库里的状态真的变了（归档=状态位，可 restore，不是删除）。
  assert.equal(harnessed.store.list(undefined, 'archived').length, 1, '老条目进归档')
  assert.equal(harnessed.store.list(undefined, 'active').length, 2, '其余两条原状保留')
  assert.equal(harnessed.store.list(undefined, 'active').some((entry) => entry.importance === 4), true, '受保护条目重要度不许动')
})

test('V7 阴性对照：advanced.decay=false 时根本不跑核算（库里一条都不许动）', async () => {
  const disabled = policyOf({
    customized: true,
    longTerm: true,
    work: true,
    session: true,
    maxInject: 3,
    decay: false,
    decayUnusedDays: 90,
    vector: false,
  })
  assert.equal(disabled.decay, false, '前提：策略里衰减是关的')

  const harnessed = harness({ policy: disabled })
  await seedMemory(harnessed.store, '用户偏好简短回复', { importance: 3, updatedAt: daysAgo(300) })

  const record = await runOnce(harnessed)

  // 同一条条目在 V6 里会被归档 ⇒ 这里的"没动"不是恒真，而是开关真的起作用。
  const entry = harnessed.store.list()[0]
  assert.equal(entry.importance, 3, '衰减关：重要度一个字都不许动')
  assert.equal(entry.status, 'active', '衰减关：不许归档')
  assert.equal(harnessed.store.list(undefined, 'archived').length, 0)
  assert.doesNotMatch(record.error, /记忆维护/, '衰减关：运行记录里不许出现核算报告（跑了就有痕迹）')

  // 记忆模块整个 off 是同一条闸的另一面。
  const off = harness({ policy: resolveMemoryPolicy('off') })
  await seedMemory(off.store, '用户偏好简短回复', { importance: 3, updatedAt: daysAgo(300) })
  const offRecord = await runOnce(off)
  assert.equal(off.store.list()[0].status, 'active')
  assert.doesNotMatch(offRecord.error, /记忆维护/)
})

test('V8 可配：decayUnusedDays 配 30 解析成 30，未配置仍是 90（默认不漂移）', () => {
  const defaults = Config({})
  assert.equal(defaults.modules.memory.advanced.decayUnusedDays, 90, '未配置 ⇒ 90')
  assert.equal(resolveMemoryPolicy('balanced').decayUnusedDays, 90, '预设策略的窗口仍是 90')
  assert.equal(resolveMemoryPolicy('balanced', {}).decayUnusedDays, 90)

  const custom = Config({ modules: { memory: { advanced: { customized: true, decayUnusedDays: 30 } } } })
  assert.equal(custom.modules.memory.advanced.decayUnusedDays, 30, '配置读得回来')
  assert.equal(policyOf(custom.modules.memory.advanced).decayUnusedDays, 30, '生效策略里是 30')

  // 与三层开关同一条纪律：`customized` 没打开时，高级区里写的值不参与解析（跟随预设模式）。
  const following = Config({ modules: { memory: { advanced: { decayUnusedDays: 30 } } } })
  assert.equal(overridesOf(following.modules.memory.advanced, 'balanced'), undefined)
  assert.equal(resolveMemoryPolicy('balanced', {}).decayUnusedDays, 90)
})

test('V8b 可配真的生效：窗口调成 30 天后，40 天未用的条目在顺带核算里被降权（默认 90 则不动）', async () => {
  const custom = Config({ modules: { memory: { advanced: { customized: true, decayUnusedDays: 30 } } } })
  const shortWindow = harness({ policy: policyOf(custom.modules.memory.advanced) })
  await seedMemory(shortWindow.store, '四十天没用的偏好', { importance: 3, updatedAt: daysAgo(40) })
  const record = await runOnce(shortWindow)

  const entry = shortWindow.store.list()[0]
  assert.ok(entry.importance < 3, `窗口 30 天 ⇒ 40 天未用应当降权（实际 ${entry.importance}）`)
  assert.equal(entry.status, 'active', '降到 ARCHIVE_IMPORTANCE 之上 ⇒ 只降权不归档')
  assert.match(record.error, /降权 1 条/, '报告里要如实写下降权')

  // 对照组：默认窗口 90 天时同一条目属于"未到期"，一个字都不动。
  const byDefault = harness()
  await seedMemory(byDefault.store, '四十天没用的偏好', { importance: 3, updatedAt: daysAgo(40) })
  const defaultRecord = await runOnce(byDefault)
  assert.equal(byDefault.store.list()[0].importance, 3, '默认 90 天：40 天未用不该降权')
  assert.match(defaultRecord.error, /未到期 1 条/)
})
