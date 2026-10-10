/**
 * 自有数据面（`TypertRemoteService` + `@Remote`）的行为钉子。
 *
 * 这些断言防的是四类真机故障：
 * 1. **网关发现不到 endpoint**——`typertRemote` 绑定与 `@Remote` 标记缺失/形状不对
 *    （第一轮就是因为挂错了侧，`/api/humanity/*` 根本不存在）；
 * 2. **参数名漂移**——网关是从方法源码里解析参数名当 wire 字段的，形参一旦变成解构/默认值
 *    就是 `gateway/signature-invalid`，这里把签名钉死；
 * 3. **投影读不回来**（客户端读到空值）——命名空间注册与视图形状；
 * 4. **失败被吞掉**——未知命名空间必须显式抛错，而不是返回空值。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'

import { createDocumentStore, mergeDocument } from '../lib/documents.js'
import { DataPlaneRejected, HumanityDataPlane, installDataPlane } from '../lib/data-plane.js'

/** 造一个内存表（形状与 storage-domain 的 KvTable 一致）。 */
function createTable() {
  const rows = new Map()
  return {
    get: (key) => rows.get(key),
    entries: () => rows.entries(),
    put: async (key, value) => void rows.set(key, value),
    delete: async (key) => rows.delete(key),
  }
}

/** 静默日志门面（记录内容，测试按需断言）。 */
function createLog() {
  const lines = []
  return { lines, info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) }
}

/** 造一个挂了内存命名空间的数据面。 */
function createPlane() {
  const log = createLog()
  const plane = new HumanityDataPlane(new Context(), log)
  const state = { value: { sections: { 说话风格: '极简' } }, revision: 4 }
  plane.register({
    ns: 'humanity-persona',
    view: () => ({ value: state.value, revision: state.revision }),
    replace: async (value, expectedRevision) => {
      if (expectedRevision !== undefined && expectedRevision !== state.revision) throw new DataPlaneRejected('修订号对不上，请重读后再写')
      state.value = value
      state.revision += 1
    },
    update: async (patch) => {
      state.value = mergeDocument(state.value, patch)
      state.revision += 1
    },
  })
  return { plane, log, state }
}

test('网关发现契约：typertRemote 绑定 + 三个 @Remote 标记', () => {
  const ctx = new Context()
  const plane = new HumanityDataPlane(ctx, createLog())

  assert.equal(plane.name, 'humanity', '服务键就是 wire 命名空间')
  assert.deepEqual(plane.typertRemote, { service: plane, serviceKey: 'humanity', namespace: 'humanity' })
  assert.deepEqual(
    remoteMethods(plane).map((marker) => marker.exportName ?? marker.method).sort(),
    ['describe', 'replace', 'update'],
    '网关按这些标记认领 /api/humanity/<method>',
  )
})

test('参数名是裸标识符（网关从源码解析，改成解构/默认值即 signature-invalid）', () => {
  /** 复刻网关的解析：取方法源码括号里的参数名。 */
  const parameterNames = (method) => {
    const source = Function.prototype.toString.call(HumanityDataPlane.prototype[method])
    const body = source.slice(source.indexOf('(') + 1, source.indexOf(')'))
    return body.length === 0 ? [] : body.split(',').map((part) => part.trim())
  }

  assert.deepEqual(parameterNames('describe'), [])
  assert.deepEqual(parameterNames('replace'), ['ns', 'section', 'expectedRevision'])
  assert.deepEqual(parameterNames('update'), ['ns', 'patch', 'expectedRevision'])
})

test('describe / replace / update 的语义与旧设置通道一致', async () => {
  const { plane, state } = createPlane()

  const described = await plane.describe()
  assert.deepEqual(described, {
    writable: true,
    namespaces: [{ ns: 'humanity-persona', value: { sections: { 说话风格: '极简' } }, revision: 4 }],
  })

  const written = await plane.replace('humanity-persona', { sections: {} }, 4)
  assert.deepEqual(written, { ns: 'humanity-persona', value: { sections: {} }, revision: 5 })

  const patched = await plane.update('humanity-persona', { sections: { 经验教训: ['x'] } }, undefined)
  assert.deepEqual(patched.value, { sections: { 经验教训: ['x'] } })
  assert.equal(patched.revision, 6)
  assert.equal(state.revision, 6)
})

test('乐观并发：修订号对不上时显式抛错（写入不落）', async () => {
  const { plane } = createPlane()
  const failure = await plane.replace('humanity-persona', { sections: {} }, 1).catch((error) => error)
  assert.equal(failure instanceof DataPlaneRejected, true)
  assert.match(failure.message, /修订号对不上/)
})

test('未知命名空间：显式抛错并带上"现在挂了哪些"', async () => {
  const { plane } = createPlane()
  const failure = await plane.replace('humanity-unknown', {}, undefined).catch((error) => error)
  assert.equal(failure instanceof DataPlaneRejected, true)
  assert.match(failure.message, /humanity-unknown/)
  assert.match(failure.message, /humanity-persona/)
})

test('update 被拒时留日志（失败可观测），并把原始错误抛给客户端', async () => {
  const log = createLog()
  const plane = new HumanityDataPlane(new Context(), log)
  plane.register({
    ns: 'humanity-memory',
    view: () => ({ value: {}, revision: 3 }),
    replace: async () => {},
    update: async () => {
      throw new Error('显式清空有内容的一节')
    },
  })

  const failure = await plane.update('humanity-memory', {}, 3).catch((error) => error)
  assert.match(failure.message, /显式清空/)
  assert.equal(log.lines.some((line) => line.includes('数据面 update(humanity-memory) 被拒')), true)
})

test('文档表：写入递增修订号，合并只覆盖提到的字段', async () => {
  const store = createDocumentStore(createTable(), () => '2026-09-29T00:00:00.000Z')

  const first = await store.write('humanity-persona', {
    identityCard: { fields: [{ key: '姓名', value: '小明' }] },
    schemaVersion: 1,
  })
  assert.equal(first.revision, 1)

  const merged = await store.merge('humanity-persona', { schemaVersion: 2 })
  assert.equal(merged.revision, 2)
  assert.equal(merged.value.schemaVersion, 2)
  assert.deepEqual(merged.value.identityCard.fields, [{ key: '姓名', value: '小明' }], '没提到的字段必须原样保留')
  assert.equal(merged.updatedAt, '2026-09-29T00:00:00.000Z')

  assert.equal(store.read('humanity-memory'), undefined, '没写过的命名空间读出来是 undefined，不是空文档')
  assert.deepEqual(store.list().map((row) => row.ns), ['humanity-persona'])
})

test('深合并：数组整体替换，嵌套对象逐层合并', () => {
  const merged = mergeDocument(
    { modules: { memory: { mode: 'auto', advanced: { decay: true } } }, tags: ['a'] },
    { modules: { memory: { mode: 'manual' } }, tags: [] },
  )
  assert.deepEqual(merged, { modules: { memory: { mode: 'manual', advanced: { decay: true } } }, tags: [] })
})

test('installDataPlane 返回可直接注册命名空间的数据面', () => {
  const log = createLog()
  const plane = installDataPlane(new Context(), log)
  assert.notEqual(plane, undefined)
  assert.deepEqual(plane.mounted(), [])
  assert.equal(log.lines.some((line) => line.includes('/api/humanity/')), true, '启动摘要要写清 wire 面在哪')
})
