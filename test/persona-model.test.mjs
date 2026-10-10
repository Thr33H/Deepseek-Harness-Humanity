/**
 * 人格数据模型的默认值与结构回归测试。
 *
 * 与 `host-config.test.mjs` 同一个思路：把默认值**逐字段钉死**。
 * G-004 要求"默认值定死、升级不漂移"，而人格文档是用户看得见、会长期持有的数据，
 * 它的默认值漂了比开关漂了更难察觉。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CORE_IDENTITY_KEYS, STANDARD_SECTION_TITLES } from '../lib/persona/constants.js'
import { createDefaultPersona, PersonaSchema, PERSONA_SCHEMA_VERSION } from '../lib/persona/model.js'

test('空输入解析出完整的中性默认人格', () => {
  const persona = createDefaultPersona()

  assert.equal(persona.schemaVersion, PERSONA_SCHEMA_VERSION)
  assert.deepEqual(
    persona.identityCard.fields.map((field) => field.key),
    [...CORE_IDENTITY_KEYS],
  )
  assert.deepEqual(
    persona.mutableLayer.sections.map((section) => section.title),
    [...STANDARD_SECTION_TITLES],
  )
  assert.deepEqual(persona.mutableLayer.userDefined, [])
})

test('默认人格是"未初始化、未封存"的空白状态，而不是某个具体人格', () => {
  const persona = createDefaultPersona()

  assert.equal(persona.identityCard.initializedAt, '')
  assert.equal(persona.identityCard.sealedAt, '')
  for (const field of persona.identityCard.fields) {
    assert.equal(field.value, '', `默认身份卡不该预设「${field.key}」的值`)
    assert.equal(field.custom, false)
  }
  for (const section of persona.mutableLayer.sections) {
    assert.deepEqual(section.items, [])
  }
})

test('可变层的默认小标题直接来自常量，不是抄一遍', () => {
  // 改 STANDARD_SECTION_TITLES 而忘改默认值，是这类代码最典型的分叉。
  // 0.1.14：原生小节 **4 个**（用户："人格卡 4 个……其余都是属于自定一项"）。
  assert.equal(STANDARD_SECTION_TITLES.length, 4)
  assert.deepEqual(
    createDefaultPersona().mutableLayer.sections.map((section) => section.title),
    [...STANDARD_SECTION_TITLES],
  )
})

test('未提供的兄弟键取默认值，但数组字段是整体替换而不是逐项合并', () => {
  const persona = PersonaSchema({ identityCard: { fields: [{ key: '姓名', value: '测试', custom: false }] } })

  assert.equal(persona.identityCard.fields[0].value, '测试')
  // 数组不长出"补齐"的项：漏传就是漏传。
  // 这是有意保留的性质——补默认项会让用户以为保存成功，而实际丢了「性别 / 人格偏好」；
  // 现在漏传会被 validatePersona 判为缺核心字段而**拒绝**，错误在写入前就暴露。
  assert.deepEqual(
    persona.identityCard.fields.map((field) => field.key),
    ['姓名'],
  )
  // 未提供的兄弟键仍取默认值。
  assert.equal(persona.identityCard.initializedAt, '')
  assert.equal(persona.identityCard.sealedAt, '')
  assert.equal(persona.mutableLayer.sections.length, STANDARD_SECTION_TITLES.length)
})

// 0.1.14：`isStandardMutableLayer`（"可变层是不是全由标准标题组成"）随用户"没有标准这一说"的
// 产品决定一起删除（见 `predicates.ts` 的文件头与 `constants.ts` 的 `PERSONA_ISSUE_CODES` 注释）——
// 它服务的那条 `mutable.section-non-standard` 提示已无产出点，派生判断也一并退役。
// 新装只预置 **4 个原生小节**：`createDefaultPersona()` 与常量同源（上面那条用例已钉）。
