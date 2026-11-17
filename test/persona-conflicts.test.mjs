/**
 * 人格内部**语义冲突**的钉子（`conflicts.ts` + 写入校验）。
 *
 * 为什么单独一组：这个判据的两端都是"宁可漏报"——
 * - 漏报的代价：两条矛盾同时进提示词，行为随机（就是本组要修的病）；
 * - 误报的代价：对方正常的保存被拦下，还被告知"这两条打架了"，而它们根本不相干。
 *
 * 所以这里**正反两面都钉**：该抓的抓，不该抓的（相似度不够、极性相同、分处两节）一条都不许抓。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { conflicts, findConflicts, normalizeForConflict } from '../lib/persona/conflicts.js'
import { createDefaultPersona } from '../lib/persona/model.js'
import { normalizePersona } from '../lib/persona/normalize.js'
import { validatePersona } from '../lib/persona/validate.js'

/** 造一份"已封存、信息里有一节"的文档。 */
function personaWith(title, items) {
  const doc = createDefaultPersona()
  doc.identityCard.fields[0].value = '小安'
  doc.identityCard.initializedAt = '2026-11-01T00:00:00.000Z'
  doc.identityCard.sealedAt = '2026-11-01T00:00:00.000Z'
  const section = doc.mutableLayer.sections.find((item) => item.title === title)
  if (section === undefined) doc.mutableLayer.sections.push({ title, items })
  else section.items = items
  return doc
}

/** 取出结论里的代码。 */
const codesOf = (validation) => validation.issues.map((issue) => issue.code)

/* ───────────────────────── 判据本身 ───────────────────────── */

test('归一化：否定词与标点都去掉，「叫主人」与「不准叫主人」落在同一句上', () => {
  assert.equal(normalizeForConflict('叫主人'), normalizeForConflict('不准叫主人'))
  assert.equal(normalizeForConflict('不要熬夜。'), normalizeForConflict('别熬夜'))
})

test('该抓的：极性相反且内容几乎相同', () => {
  assert.equal(conflicts('叫主人', '不准叫主人'), true)
  assert.equal(conflicts('用敬语', '不用敬语'), true)
  assert.equal(conflicts('提过去的事', '不要提过去的事'), true)
  assert.equal(conflicts('熬夜', '别熬夜'), true, '单字否定词吃掉「别」也照样抓到')
})

test('不该抓的：相似度不够 / 极性相同 / 只是同一件事的两种说法', () => {
  assert.equal(conflicts('不喜欢吵', '不讨厌安静'), false, '去掉否定词后毫不相似')
  assert.equal(conflicts('话少但句句有落点', '不要话少'), false, '相似度不够')
  assert.equal(conflicts('别熬夜', '不要通宵'), false, '两条都否定 ⇒ 不是对立')
  assert.equal(conflicts('先给结论再给依据', '先给结论，再给依据'), false, '只是标点不同、极性相同')
})

test('findConflicts 给出的是下标对，且左小右大', () => {
  const pairs = findConflicts(['叫主人', '话少', '不准叫主人'])
  assert.deepEqual(pairs, [{ left: 0, right: 2 }])
})

/* ───────────────────────── 写入校验 ───────────────────────── */

test('Agent 写入矛盾两条 ⇒ 拒绝，并指明是哪两条、留哪条', () => {
  const prev = personaWith('对TA的称呼', ['叫主人'])
  const next = personaWith('对TA的称呼', ['叫主人', '不准叫主人'])

  const validation = validatePersona(normalizePersona(next), normalizePersona(prev), 'agent')

  assert.equal(validation.ok, false, '不能让两条矛盾同时进提示词')
  assert.deepEqual(codesOf(validation), ['mutable.item-conflict'])
  assert.match(validation.issues[0].message, /叫主人/)
  assert.match(validation.issues[0].message, /留哪一条/)
})

test('祖父化：两条本来就都在（旧账）⇒ 不拦这次无关的保存', () => {
  const prev = personaWith('说话风格', ['叫主人', '不准叫主人'])
  const next = personaWith('说话风格', ['叫主人', '不准叫主人', '话少'])

  const validation = validatePersona(normalizePersona(next), normalizePersona(prev), 'agent')

  assert.equal(validation.ok, true, '旧矛盾不该变成"一个字都存不进去"的死结')
  assert.deepEqual(codesOf(validation), [])
})

test('对方在工作台里的编辑不受这条约束（他的卡他做主）', () => {
  const prev = personaWith('说话风格', ['叫主人'])
  const next = personaWith('说话风格', ['叫主人', '不准叫主人'])

  const validation = validatePersona(normalizePersona(next), normalizePersona(prev), 'user')

  assert.equal(validation.ok, true)
  assert.equal(codesOf(validation).includes('mutable.item-conflict'), false)
})

test('分处两节不判冲突（结构是对方分的）', () => {
  const prev = personaWith('说话风格', ['叫主人'])
  const next = personaWith('说话风格', ['叫主人'])
  next.mutableLayer.sections.find((item) => item.title === '行为边界').items = ['不准叫主人']

  const validation = validatePersona(normalizePersona(next), normalizePersona(prev), 'agent')

  assert.equal(validation.ok, true)
})
