/**
 * F3 回归（2026-10-04）：**一条坏记录不该害死整库**。
 *
 * 事故链条（`reports/f12-fix.md` §5.4 / `reports/f3-fix.md`）：
 * 存储里**任何一条**记录过不了 schema ⇒ `facility.open` 抛 `invalid-record` ⇒ **整个领域打不开**
 * ⇒ ① 每轮注入假声明（F1 已治）② **`humanity_recall` 整场查不到记忆**（F3 要治的就是这条）。
 *
 * 修法见 `src/host/store-open.ts` 的 `tolerantRecord` / `purgeUnreadable`（含"为什么不用官方
 * `invalidRecords: 'backup-and-skip'`"的实测理由：single 布局的后端没有 `backupRecord`）。
 *
 * 这里用**真实**的 `dsh-storage` / `dsh-storage-json` / `dsh-storage-domain` 组合，
 * 因为要验的恰恰是"真实后端在一条坏记录上的行为"。假设施会把这件事一起假掉。
 *
 * 三态 + 跨表覆盖：无坏记录 / 一条坏记录 / 多条坏记录 / 坏记录同时落在
 * `memory_entries` 与 `persona_history` 两张表。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { createLog } from '../lib/log.js'
import { DOMAIN_NAME } from '../lib/store-schema.js'
import { openDomain } from '../lib/store-open.js'

/** 一条**合法**的记忆记录（字段对齐 `MemoryEntrySchema`）。 */
function goodEntry(id) {
  return {
    id,
    scope: 'long-term',
    content: `好记录 ${id}`,
    tags: [],
    importance: 2,
    confidence: 0.8,
    sensitive: false,
    pinned: false,
    origin: 'user-stated',
    sourceSessionId: 's1',
    sourceMessageId: '',
    ownerId: '',
    createdAt: '2026-10-04T00:00:00.000Z',
    updatedAt: '2026-10-04T00:00:00.000Z',
    lastUsedAt: '',
    useCount: 0,
    status: 'active',
    archivedAt: '',
    dedupeKey: id,
    conflictWith: [],
    confirmedVia: '',
    entryVersion: 1,
  }
}

/** 一条**违反 schema** 的记忆记录（scope 枚举外、importance 非数字、日期非法）。 */
const BAD_ENTRY = {
  id: 'bad-1',
  scope: 'not-a-valid-scope',
  content: '坏记录',
  tags: ['x'],
  importance: '非常高',
  confidence: '也许',
  sensitive: 'no',
  pinned: 'no',
  origin: 'bogus-origin',
  sourceSessionId: '',
  createdAt: 'not-a-date',
  updatedAt: 'not-a-date',
  useCount: '很多',
  dedupeKey: 'bad-1',
}

/** 一条违反 `PersonaHistorySchema` 的历史记录。 */
const BAD_HISTORY = { at: 12345, path: null, note: {} }

/** 在捕获 `console.error` 的前提下跑一段代码，并把 stderr 文本交回。 */
async function captureStderr(fn) {
  const out = []
  const original = console.error
  console.error = (...args) => out.push(args.map((value) => String(value)).join(' '))
  try {
    await fn()
  } finally {
    console.error = original
  }
  return out
}

/**
 * 起一个真实组合，并且**预先把指定的记录写进介质**（模拟"盘上已经有坏记录"）。
 *
 * 做法：先正常开一次领域把介质建出来，直接改介质文件注入坏记录，再开第二次。
 * 为什么不直接手写 JSON 文件：介质头（unit 版本戳）由后端写，手写容易造成"文件形状不对"，
 * 那会变成另一种失败（打不开介质），验不到我们要验的东西。
 * @param seed - `{ memory: object[], history: object[] }`，直接写进对应表。
 */
async function openWithSeededRecords(seed) {
  const dir = await mkdtemp(path.join(tmpdir(), 'humanity-f3-'))
  const storages = path.join(dir, 'storages')
  const file = path.join(storages, `${DOMAIN_NAME}.json`)

  // 第一次：建介质。
  {
    const ctx = new Context()
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root: storages })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const facility = ctx.storageDomain ?? ctx['storageDomain']
    const module = StorageDomain.default ?? StorageDomain
    const store = await openDomain(facility, createLog(ctx, 'f3-seed'), module)
    assert.ok(store !== undefined, '前提：空介质应当能正常打开')
    await store.close()
    await ctx.fiber.dispose()
  }

  // 注入坏记录：直接改介质文件。
  const parsed = JSON.parse(await readFile(file, 'utf8'))
  parsed.tables = parsed.tables ?? {}
  for (const [table, records] of [
    ['memory_entries', seed.memory ?? []],
    ['persona_history', seed.history ?? []],
  ]) {
    parsed.tables[table] = parsed.tables[table] ?? {}
    for (const record of records) {
      const key = record.id ?? record.dedupeKey ?? record.at ?? `seeded-${Math.random()}`
      parsed.tables[table][String(key)] = record
    }
  }
  await mkdir(storages, { recursive: true })
  await writeFile(file, JSON.stringify(parsed), 'utf8')

  // 第二次：带着坏记录打开。
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: storages })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await new Promise((resolve) => setTimeout(resolve, 50))
  const facility = ctx.storageDomain ?? ctx['storageDomain']
  const module = StorageDomain.default ?? StorageDomain
  return { ctx, dir, file, facility, module }
}

async function teardown(booted) {
  await booted.ctx.fiber.dispose()
  await rm(booted.dir, { recursive: true, force: true })
}

/** 列出某张表在内存句柄里的键（用来确认坏记录真的被摘掉了）。 */
function keysOf(table) {
  return [...table.keys()]
}

test('F3 ①：**无坏记录**时行为与从前一致（不能因为加固把正常路径弄坏）', async () => {
  const booted = await openWithSeededRecords({ memory: [goodEntry('ok-1'), goodEntry('ok-2')] })
  try {
    let store
    const stderr = await captureStderr(async () => {
      store = await openDomain(booted.facility, createLog(booted.ctx, 'f3'), booted.module)
    })
    assert.ok(store !== undefined, '无坏记录必须照常打开')
    assert.deepEqual(
      keysOf(store.memory).sort(),
      ['ok-1', 'ok-2'],
      '两条好记录都要在',
    )
    assert.equal(stderr.length, 0, '没有坏记录就不该有隔离告警（否则会日常刷屏）')
    await store.close()
  } finally {
    await teardown(booted)
  }
})

test('F3 ②：**一条**坏记录 ⇒ 领域照常打开、坏记录被隔离、好记录仍在、stderr 点名', async () => {
  const booted = await openWithSeededRecords({
    memory: [goodEntry('ok-1'), BAD_ENTRY, goodEntry('ok-2')],
  })
  try {
    let store
    const stderr = await captureStderr(async () => {
      store = await openDomain(booted.facility, createLog(booted.ctx, 'f3'), booted.module)
    })

    // 核心判据：领域打开了（以前这里会抛 invalid-record ⇒ 整库失忆）。
    assert.ok(store !== undefined, '有坏记录也必须能打开（F3 的全部意义）')

    // 好记录照常加载 —— 这就是"humanity_recall 还能查到好记录"的数据侧前提。
    assert.deepEqual(keysOf(store.memory).sort(), ['ok-1', 'ok-2'], '两条好记录都必须在')

    // 坏记录被摘掉（不是留在表里当哑弹）。
    assert.equal(keysOf(store.memory).includes('bad-1'), false, '坏记录必须被摘掉')

    // 直写 stderr 点名（F2 的通道，F3 的颗粒度）。
    assert.equal(stderr.length >= 1, true, '必须留下容器外可见的告警')
    const joined = stderr.join('\n')
    assert.match(joined, /\[humanity\]/, '可 grep 的前缀')
    assert.match(joined, /bad-1/, '要点名是哪一条')
    assert.match(joined, /memory_entries/, '要说清在哪张表')
    assert.match(joined, /原始值/, '要带上原始值（single 布局没有介质备份，这行是唯一副本）')
    // ⚠️ 这条断言是拿真实事故换来的：第一版用 `z.union([schema, Marked.catch(…)])`，
    // `Marked` 是 `$strip` 对象会把 `raw` 剥掉，日志实际写成 `原始值=undefined` ——
    // 等于把"这一条到底存了什么"这条最重要的线索丢了。`preprocess` 版本才带得住。
    assert.doesNotMatch(joined, /原始值=undefined/, '原始值不许是 undefined（必须带上真实内容）')
    assert.match(joined, /not-a-valid-scope/, '原始值里要能看到坏字段的真实内容')

    await store.close()
  } finally {
    await teardown(booted)
  }
})

test('F3 ③：**多条**坏记录 + 跨表（memory_entries 与 persona_history）⇒ 逐条隔离，好记录全在', async () => {
  const booted = await openWithSeededRecords({
    memory: [goodEntry('ok-1'), BAD_ENTRY, { ...BAD_ENTRY, id: 'bad-2', dedupeKey: 'bad-2' }, goodEntry('ok-2')],
    history: [BAD_HISTORY, {
      at: '2026-10-04T00:00:00.000Z',
      source: 'user',
      path: 'identityCard.fields.姓名',
      previous: '旧名字',
      reason: 'superseded',
    }],
  })
  try {
    let store
    const stderr = await captureStderr(async () => {
      store = await openDomain(booted.facility, createLog(booted.ctx, 'f3'), booted.module)
    })

    assert.ok(store !== undefined, '多条坏记录同样不能让整库打不开')
    assert.deepEqual(keysOf(store.memory).sort(), ['ok-1', 'ok-2'], '两条好记录都必须在（两条坏记录不干扰）')

    const joined = stderr.join('\n')
    assert.match(joined, /bad-1/, '第一条坏记录要点名')
    assert.match(joined, /bad-2/, '第二条坏记录也要点名')
    // 跨表覆盖：历史表里的坏记录同样被隔离，且**没有**把 domain 打不开。
    assert.match(joined, /本次共隔离/, '要有一条汇总，说明这次隔离了几条')

    // 好历史记录仍在（证明 persona_history 表也活着）。
    assert.ok(store.historyCount() >= 1, '正常的旧历史记录要留住')

    await store.close()
  } finally {
    await teardown(booted)
  }
})

test('F3 边界：坏记录在 `persona_history`（**不是**记忆表）⇒ 记忆表照常可用', async () => {
  const booted = await openWithSeededRecords({
    memory: [goodEntry('ok-1')],
    history: [BAD_HISTORY],
  })
  try {
    let store
    const stderr = await captureStderr(async () => {
      store = await openDomain(booted.facility, createLog(booted.ctx, 'f3'), booted.module)
    })
    assert.ok(store !== undefined, '坏在历史表也不能让整库打不开')
    assert.deepEqual(keysOf(store.memory), ['ok-1'], '记忆表不受别的表牵连 —— 这条正是"整场失忆"的反面')
    assert.match(stderr.join('\n'), /persona_history/, '告警要指到真正出问题的那张表')
    await store.close()
  } finally {
    await teardown(booted)
  }
})
