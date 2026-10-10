/**
 * 存储领域的迁移测试（G-004「升级零迁移」的验收点）。
 *
 * 为什么必须用**真实**后端而不是假设施：迁移的正确性全在"能不能读懂旧文件"这件事上——
 * 版本校验、`compatibleVersions`、schema 对旧记录的容忍度，全部由 storage-domain +
 * storage-json 在打开时执行。假设施会把这一整层替换掉，也就测不到任何东西。
 * 所以这里的做法是：**先手写一份旧版本的存储文件**，再用当前版本的插件去打开它。
 *
 * 为什么直接调 `installHumanityStore` 而不是 `ctx.plugin(Humanity)`：
 * 需要一个**可观察的成功信号**（`onReady`）。只断言"文件没被改写"是空过的——
 * 插件彻底打不开领域时，文件同样不会被改写，那样测试会在实现坏掉时保持绿色
 * （本文件的第三条就曾经这样空过）。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { createLog } from '../lib/log.js'
import { createMemoryEntry } from '../lib/memory/model.js'
import { DOMAIN_NAME, HISTORY_TABLE, installHumanityStore, PERSONA_DATA_SCHEMA_VERSION } from '../lib/store.js'

const INSTALLED_AT = '2026-01-01T00:00:00.000Z'

/** 手写一份存储单元文件，模拟某个版本留下的数据。 */
async function seedUnit(root, version, global) {
  await writeFile(
    path.join(root, 'humanity.json'),
    JSON.stringify({ unit: { name: DOMAIN_NAME, version }, global, tables: {} }, null, 2),
    'utf8',
  )
}

/** 读回存储单元文件。 */
async function readUnit(root) {
  return JSON.parse(await readFile(path.join(root, 'humanity.json'), 'utf8'))
}

/** 起一套真实服务，并在其上安装存储（返回可观察的成功信号）。 */
async function boot(root) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })

  const ready = []
  installHumanityStore(ctx, createLog(ctx, 'test'), (store) => ready.push(store))

  return {
    ctx,
    /** 等到领域真的打开；超时即失败。 */
    waitReady: async (timeoutMs = 3000) => {
      const deadline = Date.now() + timeoutMs
      while (ready.length === 0) {
        if (Date.now() > deadline) throw new Error('等待超时：存储领域没有打开')
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      return ready[0]
    },
    /** 明确断言"没有打开"（用于降级场景）；给异步打开留出足够时间去失败。 */
    settle: async (timeoutMs = 200) => {
      await new Promise((resolve) => setTimeout(resolve, timeoutMs))
    },
    dispose: () => ctx.fiber.dispose(),
  }
}

/** 造一个带存储根目录的临时环境。 */
async function makeRoot(prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  const root = path.join(dir, 'storages')
  await mkdir(root, { recursive: true })
  return { dir, root }
}

test('第 1 代数据文件能被当前版本打开：数据代升级、旧数据保留、介质版本不动', async () => {
  const { dir, root } = await makeRoot('humanity-migrate-')
  // 第 1 代文件的 global 里没有 schemaVersion——正是老版本留下的样子。
  await seedUnit(root, 1, { installedAt: INSTALLED_AT })

  const harness = await boot(root)
  try {
    const store = await harness.waitReady()
    assert.equal(store.installedAt, INSTALLED_AT, '首次安装时间必须原样保留')

    const unit = await readUnit(root)
    // 介质版本必须保持 1：升它会让老文件在 single 布局下被 version-mismatch 拒绝。
    assert.equal(unit.unit.version, 1, '介质格式没变，版本号不该动')
    assert.equal(unit.global.installedAt, INSTALLED_AT, '元数据里也要原样保留')
    assert.equal(unit.global.schemaVersion, PERSONA_DATA_SCHEMA_VERSION, '数据代应被盖章升到当前代')
    // 第 2 代新增的历史表在旧文件里不存在；打开后应当是空表，而不是缺表或报错。
    assert.deepEqual(unit.tables[HISTORY_TABLE] ?? {}, {})
  } finally {
    await harness.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('已是当前数据代时重复打开不再迁移（幂等，不会每次启动都写盘）', async () => {
  const { dir, root } = await makeRoot('humanity-idempotent-')
  await seedUnit(root, 1, { installedAt: INSTALLED_AT, schemaVersion: PERSONA_DATA_SCHEMA_VERSION })
  const before = await readUnit(root)

  const harness = await boot(root)
  try {
    await harness.waitReady()
    assert.deepEqual(await readUnit(root), before, '已是当前代时不该改动文件')
  } finally {
    await harness.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('无法识别的未来版本：降级为无持久化，且不碰看不懂的数据（G-002）', async () => {
  const { dir, root } = await makeRoot('humanity-future-')
  await seedUnit(root, 99, { installedAt: INSTALLED_AT, schemaVersion: 99 })
  const before = await readUnit(root)

  const harness = await boot(root)
  try {
    // 这一条断言才是关键：领域**没有**打开。配合上面两条"会打开"的用例，
    // 本用例不可能在实现坏掉时保持绿色。
    await harness.settle()
    await assert.rejects(harness.waitReady(50), /没有打开/)
    // 降级的含义是"不碰"，不是"覆盖成能读的样子"。
    assert.deepEqual(await readUnit(root), before, '看不懂的数据必须原样保留')
  } finally {
    await harness.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('历史表可用：写入后条数增加（v2 新增能力不是摆设）', async () => {
  const { dir, root } = await makeRoot('humanity-history-')

  const harness = await boot(root)
  try {
    const store = await harness.waitReady()
    assert.equal(store.historyCount(), 0)

    await store.recordHistory({
      at: '2026-09-23T00:00:00.000Z',
      source: 'user',
      path: 'identityCard.fields.姓名',
      previous: '旧名字',
      reason: 'superseded',
    })

    assert.equal(store.historyCount(), 1)
  } finally {
    await harness.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('记忆表：第 2 代旧文件（没有该表）打开后自动补空表，写入的条目重启后仍在', async () => {
  const { dir, root } = await makeRoot('humanity-memory-')
  // 第 2 代文件的 global 有 schemaVersion=2 —— 正是"有历史表、没有记忆表"的样子。
  await seedUnit(root, 1, { installedAt: INSTALLED_AT, schemaVersion: 2 })
  const item = createMemoryEntry({
    scope: 'long-term',
    content: '用户偏好简短回复',
    origin: 'user-stated',
    sourceSessionId: 'session-1',
    status: 'active',
  })

  const first = await boot(root)
  try {
    const store = await first.waitReady()
    assert.equal(store.memory.get(item.dedupeKey), undefined, '旧文件里没有这张表，读出空而不是报错')
    await store.memory.put(item.dedupeKey, item)
    assert.deepEqual(await readUnit(root).then((unit) => unit.global.schemaVersion), PERSONA_DATA_SCHEMA_VERSION)
  } finally {
    await first.dispose()
  }

  const second = await boot(root)
  try {
    const reopened = await second.waitReady()
    const readBack = reopened.memory.get(item.dedupeKey)
    assert.equal(readBack?.content, '用户偏好简短回复', '记忆必须真的落盘并过一遍 schema')
    assert.equal(readBack?.origin, 'user-stated', '来源不能被存储层改写（P-033）')
  } finally {
    await second.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('自进化四表：第 3 代旧文件（没有这些表）打开后自动补空表并升到第 4 代', async () => {
  const { dir, root } = await makeRoot('humanity-evolution-')
  // 第 3 代 = M3 收口时的数据代（有历史表与记忆表，没有自进化表）。
  await seedUnit(root, 1, { installedAt: INSTALLED_AT, schemaVersion: 3 })

  const harness = await boot(root)
  try {
    const store = await harness.waitReady()
    assert.equal(store.installedAt, INSTALLED_AT, '首次安装时间必须原样保留')

    // 四张新表都拿到句柄、初始为空（缺表由 storage-domain 打开时补空——零迁移的机械保证）。
    for (const table of Object.values(store.evolution)) {
      assert.deepEqual([...table.entries()], [])
    }

    // 写入一条运行记录再重读文件：数据代已盖章为 4，且记录真的落盘。
    const record = {
      id: 'run-1',
      mode: 'incremental',
      trigger: 'manual',
      status: 'completed',
      startedAt: '2026-09-25T00:00:00.000Z',
      finishedAt: '2026-09-25T00:00:01.000Z',
      scannedSessions: 1,
      parsedEvents: 2,
      memoriesWritten: 0,
      proposalsCreated: 0,
      inputTokens: 0,
      outputTokens: 0,
      calls: 0,
      narrative: '',
      insights: [],
      error: '',
    }
    await store.evolution.runs.put(record.id, record)
    const unit = await readUnit(root)
    assert.equal(unit.global.schemaVersion, PERSONA_DATA_SCHEMA_VERSION)
    assert.equal(unit.global.schemaVersion, 5)
    assert.equal(unit.tables.evolution_runs['run-1'].status, 'completed')
    assert.equal(unit.unit.version, 1, '介质格式没变，版本号不该动')
  } finally {
    await harness.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})
