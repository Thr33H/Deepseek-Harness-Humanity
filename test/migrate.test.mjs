/**
 * 旧设置迁移的行为钉子（`src/host/migrate.ts`）。
 *
 * 防的是三类真机故障：
 * 1. **往返丢失**——从旧设置读出来的内容必须逐字进文档表（人格文档本体只在旧文件里）；
 * 2. **重复导入覆盖**——插件每次启动都会跑一次迁移，第二次必须跳过已有内容；
 * 3. **坏数据连坐**——YAML 坏了要显式报错并**不写任何东西**，而且绝不改动源文件。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createDocumentStore } from '../lib/documents.js'
import { migrateLegacyDocuments } from '../lib/migrate.js'

/** 内存表（形状与 storage-domain 的 KvTable 一致）。 */
function createTable() {
  const rows = new Map()
  return {
    rows,
    get: (key) => rows.get(key),
    entries: () => rows.entries(),
    put: async (key, value) => void rows.set(key, value),
    delete: async (key) => rows.delete(key),
  }
}

/** 记录日志的门面。 */
function createLog() {
  const lines = []
  return { lines, info: (m) => lines.push(`info:${m}`), warn: (m) => lines.push(`warn:${m}`), error: (m) => lines.push(`error:${m}`) }
}

/** 造一个临时 DSH_HOME，写入给定的 settings 文件内容。 */
function homeWith(fileName, content) {
  const dir = mkdtempSync(join(tmpdir(), 'humanity-migrate-'))
  writeFileSync(join(dir, fileName), content, 'utf8')
  return dir
}

const LEGACY = [
  'humanity-persona:',
  '  schemaVersion: 1',
  '  identityCard:',
  '    fields:',
  '      - key: 姓名',
  '        value: 小明',
  '  mutableLayer:',
  '    sections:',
  '      说话风格: 极简',
  'humanity:',
  '  antiSycophancy: false',
  'other-section:',
  '  ignored: true',
  '',
].join('\n')

test('往返：旧设置里的两个命名空间逐字进文档表，其他段落不碰', async () => {
  const dir = homeWith('settings.yaml.imported', LEGACY)
  try {
    const table = createTable()
    const result = await migrateLegacyDocuments(createDocumentStore(table), createLog(), dir)

    assert.deepEqual(result.imported, ['humanity-persona', 'humanity'])
    assert.equal(table.get('humanity-persona').value.identityCard.fields[0].value, '小明')
    assert.deepEqual(table.get('humanity-persona').value.mutableLayer.sections, { 说话风格: '极简' })
    assert.deepEqual(table.get('humanity').value, { antiSycophancy: false })
    assert.equal(table.get('other-section'), undefined, '别的段落不归我们管')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('幂等：第二次跑跳过已有内容，绝不覆盖（也绝不改源文件）', async () => {
  const dir = homeWith('settings.yaml.imported', LEGACY)
  try {
    const table = createTable()
    const store = createDocumentStore(table)
    await migrateLegacyDocuments(store, createLog(), dir)
    // 用户在**新版本里**改过人格（模拟），再启动一次不能把它盖回旧值。
    await store.write('humanity-persona', { schemaVersion: 9, identityCard: { fields: [] }, mutableLayer: { sections: {} } })

    const before = readFileSync(join(dir, 'settings.yaml.imported'), 'utf8')
    const second = await migrateLegacyDocuments(store, createLog(), dir)

    assert.deepEqual(second.imported, [], '第二次不该再导入任何东西')
    assert.equal(store.read('humanity-persona').value.schemaVersion, 9, '已有内容必须原样保留')
    assert.equal(readFileSync(join(dir, 'settings.yaml.imported'), 'utf8'), before, '源文件必须逐字不变')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('坏数据：YAML 解析失败时显式报错，且一个字都不写', async () => {
  const dir = homeWith('settings.yaml.imported', 'humanity-persona: [unclosed\n  - : :\n')
  try {
    const table = createTable()
    const log = createLog()
    const result = await migrateLegacyDocuments(createDocumentStore(table), log, dir)

    assert.deepEqual(result.imported, [])
    assert.equal(result.reason, '旧设置文件解析失败')
    assert.equal(table.rows.size, 0, '解析失败时不能写入任何表项')
    assert.equal(log.lines.some((line) => line.startsWith('error:')), true, '失败必须响（error 级日志）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('没有旧文件 / 没有 DSH_HOME：跳过并记日志，不抛', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'humanity-migrate-'))
  try {
    const table = createTable()
    const log = createLog()
    const noFile = await migrateLegacyDocuments(createDocumentStore(table), log, empty)
    assert.equal(noFile.reason, '没有旧设置文件')
    assert.equal(table.rows.size, 0)

    const noHome = await migrateLegacyDocuments(createDocumentStore(table), log, undefined)
    assert.equal(noHome.reason, 'DSH_HOME 未设置')
    assert.equal(log.lines.some((line) => line.includes('DSH_HOME 未设置')), true)
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})

test('回退链：没有 .imported 时读原始 settings.yaml', async () => {
  const dir = homeWith('settings.yaml', LEGACY)
  try {
    const table = createTable()
    const result = await migrateLegacyDocuments(createDocumentStore(table), createLog(), dir)
    assert.deepEqual(result.imported, ['humanity-persona', 'humanity'])
    assert.match(result.source, /settings\.yaml$/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
