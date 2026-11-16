/**
 * 「关系」搬家（底色 → 信息）的钉子。
 *
 * 背景（2026-11-16 用户拍板 A）：关系是慢变的，底色是封存的 —— 放在底色里就永远停在
 * 初始化那一刻。于是把它搬进信息，成为第 5 个原生小节；底色里那条删除（历史可回滚）。
 *
 * 这个迁移动的是**封存数据**，所以每条都要钉死：只搬名字里带「关系」的、别的字段一个字不动、
 * 幂等、失败不抛。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createDefaultPersona } from '../lib/persona/model.js'
import { migrateRelationshipFromIdentity } from '../lib/persona/relationship.js'

const silentLog = { info() {}, warn() {}, error() {}, debug() {} }

/** 造一个人格读写入口的替身：只实现迁移用到的那三个成员。 */
function fakeSection(document, options = {}) {
  let current = document
  const writes = []
  return {
    writes,
    get current() {
      return current
    },
    attached: options.attached ?? true,
    read: () => current,
    write: async (next, source) => {
      writes.push({ next, source })
      current = next
    },
  }
}

/** 一份"已初始化、已封存"的卡，底色里带着关系自定义字段。 */
function sealedWithRelationship() {
  const doc = createDefaultPersona()
  doc.identityCard.initializedAt = '2026-11-01T00:00:00.000Z'
  doc.identityCard.sealedAt = '2026-11-01T00:00:00.000Z'
  doc.identityCard.fields[0].value = '溟澜'
  doc.identityCard.fields.push({ key: '与火火的关系', value: '恋人', custom: true })
  doc.identityCard.fields.push({ key: '身份', value: '昭朝通政使', custom: true })
  return doc
}

test('搬家：底色里的「与X的关系」进信息「关系」节，并从底色删除（其它自定义字段不动）', async () => {
  const section = fakeSection(sealedWithRelationship())
  const changed = await migrateRelationshipFromIdentity(section, silentLog)

  assert.equal(changed, true)
  assert.equal(section.writes.length, 1, '只写一次')
  assert.equal(section.writes[0].source, 'user', '宿主代对方执行，写来源记为 user（agent 会被封存规则挡住）')

  const next = section.current
  assert.deepEqual(
    next.identityCard.fields.map((field) => field.key),
    ['姓名', '性别', '人格偏好', '主语言', '身份'],
    '「与火火的关系」必须离开底色，「身份」必须留下',
  )
  const relationship = next.mutableLayer.sections.find((item) => item.title === '关系')
  assert.ok(relationship !== undefined, '信息里要有「关系」这一节')
  assert.deepEqual(relationship.items, ['恋人'])
})

test('幂等：跑第二次什么都不写', async () => {
  const section = fakeSection(sealedWithRelationship())
  await migrateRelationshipFromIdentity(section, silentLog)
  const before = section.writes.length

  const again = await migrateRelationshipFromIdentity(section, silentLog)
  assert.equal(again, false)
  assert.equal(section.writes.length, before, '第二次不该再写盘')
})

test('没有关系字段、但缺「关系」小节 ⇒ 补一个空小节（老卡片对齐原生 5 节）', async () => {
  const doc = createDefaultPersona()
  doc.identityCard.initializedAt = '2026-11-01T00:00:00.000Z'
  doc.identityCard.sealedAt = '2026-11-01T00:00:00.000Z'
  doc.mutableLayer.sections = doc.mutableLayer.sections.filter((item) => item.title !== '关系')

  const section = fakeSection(doc)
  assert.equal(await migrateRelationshipFromIdentity(section, silentLog), true)
  assert.ok(section.current.mutableLayer.sections.some((item) => item.title === '关系'))
})

test('未初始化且没有关系字段 ⇒ 什么都不做（新装不能被误写成"迁移过"）', async () => {
  const section = fakeSection(createDefaultPersona())
  assert.equal(await migrateRelationshipFromIdentity(section, silentLog), false)
  assert.equal(section.writes.length, 0)
})

test('命名空间没接上 ⇒ 直接返回 false，不读也不写', async () => {
  const section = fakeSection(sealedWithRelationship(), { attached: false })
  assert.equal(await migrateRelationshipFromIdentity(section, silentLog), false)
  assert.equal(section.writes.length, 0)
})

test('写入抛错不冒泡（迁移失败不该拦住插件启动）', async () => {
  const doc = sealedWithRelationship()
  const section = {
    attached: true,
    read: () => doc,
    write: async () => {
      throw new Error('模拟写盘失败')
    },
  }
  assert.equal(await migrateRelationshipFromIdentity(section, silentLog), false)
})
