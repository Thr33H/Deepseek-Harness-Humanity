/**
 * 存储 seam 的 attach / detach 语义测试。
 *
 * 为什么要单独测这一层：`ctx.get('storageDomain')` 与 `ctx.inject(['storageDomain'], …)` 在
 * "服务一开始就在"时行为完全一样——只靠真实组合测不出区别（Web 组合里 storage 行总是先挂载）。
 * 这里用一个**假设施**精确控制服务的出现与消失时机，把四种时序钉死：
 * 缺席时不打开、后挂载时打开、卸载时关闭、**打开还没完成就被卸载**。
 *
 * 假设施而不是真后端：真的 storage-json 无法制造"打开挂起"这种时序，而那个竞态正是最容易漏的。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createLog } from '../lib/log.js'
import { DOMAIN_NAME, DOMAIN_VERSION, installHumanityStore, PERSONA_DATA_SCHEMA_VERSION } from '../lib/store.js'

/** 让已排队的微任务与 `setImmediate` 回调先跑完，再断言异步打开的结果。 */
const flush = () => new Promise((resolve) => setImmediate(resolve))

/**
 * 造一个存储领域设施替身。
 * @param options.installedAt - 已存元数据里的首次安装时间；省略表示"从未写过"。
 * @param options.manualOpen - true 时 `open()` 挂起，直到调用 `releaseOpen()`。
 */
function createFakeFacility(options = {}) {
  const calls = { open: 0, set: 0, close: 0, spec: undefined }
  let value = { installedAt: options.installedAt ?? '', schemaVersion: options.schemaVersion ?? 1 }
  let releaseOpen
  const gate = options.manualOpen === true ? new Promise((resolve) => { releaseOpen = resolve }) : undefined

  const tables = new Map()

  return {
    calls,
    meta: () => value,
    releaseOpen: () => releaseOpen?.(),
    facility: {
      async open(spec) {
        calls.open += 1
        calls.spec = spec
        if (gate !== undefined) await gate
        return {
          global: {
            // 真后端会把存下来的 global 过一遍 schema，缺字段按默认值补齐。
            // 假设施必须照做：否则"老文件没有 schemaVersion"这件事在假设施里表现为
            // undefined，迁移链会找不到起点而抛错——那是假设施在撒谎，不是被测代码有问题。
            get: () => ({ schemaVersion: 1, ...value }),
            set: async (next) => {
              calls.set += 1
              value = next
            },
          },
          table: (name) => {
            const records = tables.get(name) ?? new Map()
            tables.set(name, records)
            return {
              put: async (key, record) => {
                records.set(key, record)
              },
              get size() {
                return records.size
              },
            }
          },
          close: async () => {
            calls.close += 1
          },
        }
      },
    },
  }
}

/** 起一个裸上下文并挂上存储安装器。 */
function boot(options = {}) {
  const ctx = new Context()
  const { facility, calls, meta, releaseOpen } = createFakeFacility(options)
  const ready = []
  installHumanityStore(ctx, createLog(ctx, 'test'), (store) => ready.push(store))
  return { ctx, facility, calls, meta, releaseOpen, ready }
}

test('storageDomain 缺席时不打开、不抛错（只降级存储功能）', async () => {
  const { ctx, calls, ready } = boot()
  await flush()
  assert.equal(calls.open, 0)
  assert.equal(ready.length, 0)
  await ctx.fiber.dispose()
})

test('storageDomain 后挂载时能打开，并写下首次安装标记', async () => {
  const { ctx, facility, calls, meta, ready } = boot()
  await flush()
  assert.equal(calls.open, 0, '服务还没出现，不应该打开')

  ctx.provide('storageDomain', facility)
  await flush()

  assert.equal(calls.open, 1, '服务出现后应该补上打开')
  assert.equal(calls.set, 1, '首次安装应该写一次 installedAt')
  assert.ok(meta().installedAt.length > 0)
  assert.equal(ready.length, 1)
  await ctx.fiber.dispose()
})

test('已有 installedAt 时保留原值，不重复写', async () => {
  const installedAt = '2026-01-01T00:00:00.000Z'
  const { ctx, facility, calls, meta, ready } = boot({ installedAt, schemaVersion: PERSONA_DATA_SCHEMA_VERSION })
  ctx.provide('storageDomain', facility)
  await flush()

  assert.equal(calls.set, 0, '已是当前数据代时不该再写')
  assert.equal(meta().installedAt, installedAt)
  assert.equal(ready[0]?.installedAt, installedAt)
  await ctx.fiber.dispose()
})

test('摘除 storageDomain 时释放领域', async () => {
  const { ctx, facility, calls } = boot()
  ctx.provide('storageDomain', facility)
  await flush()
  assert.equal(calls.open, 1)

  await ctx.fiber.dispose()
  assert.equal(calls.close, 1, '卸载必须释放领域，否则领域名会被一直占住')
})

test('打开还没完成就被卸载：完成后立刻关闭，不留下没人释放的领域', async () => {
  const { ctx, facility, calls, releaseOpen, ready } = boot({ manualOpen: true })
  ctx.provide('storageDomain', facility)
  await flush()
  assert.equal(calls.open, 1, '应该已经开始打开')
  assert.equal(calls.close, 0, '此时还没打开完，不该关')

  await ctx.fiber.dispose()
  releaseOpen()
  await flush()

  assert.equal(calls.close, 1, '打开完成后必须补一次关闭')
  assert.equal(ready.length, 0, '已经卸载了，不能再对外声称就绪')
})

test('领域声明用的是 humanity v1，与常量一致', async () => {
  const { ctx, facility, calls } = boot()
  ctx.provide('storageDomain', facility)
  await flush()

  assert.equal(calls.spec?.name, DOMAIN_NAME)
  assert.equal(calls.spec?.version, DOMAIN_VERSION)
  await ctx.fiber.dispose()
})
