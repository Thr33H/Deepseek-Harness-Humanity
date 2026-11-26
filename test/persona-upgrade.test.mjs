/**
 * 人格文档**一次性升级**（写回式）的钉子 —— `upgrade.ts`。
 *
 * 两件事都是 2026-11-16 用户拍板的：
 * ① 「关系」从底色搬进信息（底色是封存的，关系放进去就永远停在初始化那一刻）；
 * ② 退役「交付格式」——槽位删掉，条目并进「说话风格」（留着槽位会持续把语气拉回汇报体）。
 *
 * 因为它们动的是**对方亲手写的数据**，每条都要钉死：只搬该搬的、别的字段一个字不动、
 * 幂等、不丢内容、失败不抛。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createDefaultPersona } from '../lib/persona/model.js'
import { upgradePersonaDocument } from '../lib/persona/upgrade.js'

const silentLog = { info() {}, warn() {}, error() {}, debug() {} }

/** 造一个人格读写入口的替身：只实现升级用到的那三个成员。 */
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

/** 一份"已初始化、已封存"的卡：底色带关系字段，信息里带已退役的「交付格式」。 */
function sealedWithLegacyData() {
  const doc = createDefaultPersona()
  doc.identityCard.initializedAt = '2026-11-01T00:00:00.000Z'
  doc.identityCard.sealedAt = '2026-11-01T00:00:00.000Z'
  doc.identityCard.fields[0].value = '溟澜'
  doc.identityCard.fields.push({ key: '与小明的关系', value: '恋人', custom: true })
  doc.identityCard.fields.push({ key: '身份', value: '昭朝通政使', custom: true })
  // 旧卡片里「交付格式」还在（现在是退役槽位）。
  doc.mutableLayer.sections.push({ title: '交付格式', items: ['先给结论，再给依据'] })
  return doc
}

test('搬家：底色里的「与X的关系」进信息「关系」节，并从底色删除（其它自定义字段不动）', async () => {
  const section = fakeSection(sealedWithLegacyData())
  const changed = await upgradePersonaDocument(section, silentLog)

  assert.equal(changed, true)
  assert.equal(section.writes.length, 1, '只写一次（两件事合成一次写盘）')
  assert.equal(section.writes[0].source, 'user', '宿主代对方执行，写来源记为 user（agent 会被封存规则挡住）')

  const next = section.current
  assert.deepEqual(
    next.identityCard.fields.map((field) => field.key),
    ['姓名', '性别', '人格偏好', '主语言', '身份'],
    '「与小明的关系」必须离开底色，「身份」必须留下',
  )
  const relationship = next.mutableLayer.sections.find((item) => item.title === '关系')
  assert.ok(relationship !== undefined, '信息里要有「关系」这一节')
  assert.deepEqual(relationship.items, ['恋人'])
})

test('退役「交付格式」：槽位消失，条目并进「说话风格」（一个字都不丢）', async () => {
  const doc = sealedWithLegacyData()
  doc.mutableLayer.sections.find((item) => item.title === '说话风格').items = ['话少但句句有落点']
  const section = fakeSection(doc)

  await upgradePersonaDocument(section, silentLog)

  const next = section.current
  assert.equal(
    next.mutableLayer.sections.some((item) => item.title === '交付格式'),
    false,
    '槽位必须消失（留着会持续把语气拉回汇报体）',
  )
  assert.deepEqual(
    next.mutableLayer.sections.find((item) => item.title === '说话风格').items,
    ['话少但句句有落点', '先给结论，再给依据'],
    '原有条目在前，被退役的条目接在后面',
  )
})

test('幂等：跑第二次什么都不写', async () => {
  const section = fakeSection(sealedWithLegacyData())
  await upgradePersonaDocument(section, silentLog)
  const before = section.writes.length

  const again = await upgradePersonaDocument(section, silentLog)
  assert.equal(again, false)
  assert.equal(section.writes.length, before, '第二次不该再写盘')
})

test('没有关系字段、但缺「关系」小节 ⇒ 补一个空小节（老卡片对齐原生四节）', async () => {
  const doc = createDefaultPersona()
  doc.identityCard.initializedAt = '2026-11-01T00:00:00.000Z'
  doc.identityCard.sealedAt = '2026-11-01T00:00:00.000Z'
  doc.mutableLayer.sections = doc.mutableLayer.sections.filter((item) => item.title !== '关系')

  const section = fakeSection(doc)
  assert.equal(await upgradePersonaDocument(section, silentLog), true)
  assert.ok(section.current.mutableLayer.sections.some((item) => item.title === '关系'))
})

test('未初始化且没有旧数据 ⇒ 什么都不做（新装不能被误写成"升级过"）', async () => {
  const section = fakeSection(createDefaultPersona())
  assert.equal(await upgradePersonaDocument(section, silentLog), false)
  assert.equal(section.writes.length, 0)
})

test('命名空间没接上 ⇒ 直接返回 false，不读也不写', async () => {
  const section = fakeSection(sealedWithLegacyData(), { attached: false })
  assert.equal(await upgradePersonaDocument(section, silentLog), false)
  assert.equal(section.writes.length, 0)
})

test('写入抛错不冒泡（升级失败不该拦住插件启动）', async () => {
  const doc = sealedWithLegacyData()
  const section = {
    attached: true,
    read: () => doc,
    write: async () => {
      throw new Error('模拟写盘失败')
    },
  }
  assert.equal(await upgradePersonaDocument(section, silentLog), false)
})
