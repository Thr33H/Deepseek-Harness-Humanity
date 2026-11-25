/**
 * 性格轴（2026-11-20）的测试。
 *
 * 钉的是四件事：
 * 1. **笼子只能定一次**：初始化时推导，之后 Agent 不能再动（用户在工作台可以）；
 * 2. **"此刻的值"不是笼子**：它将来会被经历推动，所以它变化不该被判成"改了封存的东西"；
 * 3. **缺一根就整次拒绝**：少一根的那根就永远管不住了，半张笼子比没有更糟；
 * 4. **给的是一句话不是数字**：模型看到数字会开始演数字。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CHARACTER_AXES } from '../lib/persona/constants.js'
import { createCharacter, createDefaultPersona } from '../lib/persona/model.js'
import { renderPersonaPrompt } from '../lib/persona/render.js'
import { validatePersona } from '../lib/persona/validate.js'

const codesOf = (validation) => validation.issues.map((issue) => issue.code)

/** 一份现成的四根轴：范围有宽有窄，理由各不相同。 */
function fourAxes() {
  return [
    { key: 'stability', min: 0.35, max: 0.62, reason: '看起来淡定，其实心里会翻' },
    { key: 'extraversion', min: 0.28, max: 0.52, reason: '不太主动，但熟了话会变多' },
    { key: 'agreeableness', min: 0.55, max: 0.8, reason: '不爱起冲突，但也不会什么都忍' },
    { key: 'openness', min: 0.72, max: 0.96, reason: '对没见过的东西几乎没有抵抗力' },
  ]
}

/** 造一份"已封存 + 已有性格"的文档。 */
function sealedPersona(axes = fourAxes()) {
  const persona = createDefaultPersona()
  persona.identityCard.fields[0].value = '小安'
  persona.identityCard.fields[2].value = '先观察再开口'
  persona.identityCard.initializedAt = '2026-11-20T00:00:00.000Z'
  persona.identityCard.sealedAt = '2026-11-20T00:00:00.000Z'
  const built = createCharacter(axes, '2026-11-20T00:00:00.000Z')
  assert.equal(built.ok, true, '前置条件：四根轴应当能推导成功')
  persona.character = built.layer
  return persona
}

// ---------------------------------------------------------------- 推导

test('推导：四根轴都给了，此刻的值落在自己范围的正中间', () => {
  const built = createCharacter(fourAxes(), '2026-11-20T00:00:00.000Z')
  assert.equal(built.ok, true)
  const byKey = Object.fromEntries(built.layer.axes.map((axis) => [axis.key, axis]))

  // 顺序与 CHARACTER_AXES 一致：工作台与提示词都按这个顺序读。
  assert.deepEqual(built.layer.axes.map((axis) => axis.key), [...CHARACTER_AXES])
  assert.equal(byKey.stability.value, 0.49) // (0.35 + 0.62) / 2 = 0.485 → 两位
  assert.equal(byKey.extraversion.value, 0.4)
  assert.equal(byKey.openness.value, 0.84)
  assert.equal(built.layer.derivedAt, '2026-11-20T00:00:00.000Z')
})

test('推导：缺一根就整次失败（半张笼子比没有更糟）', () => {
  const built = createCharacter(fourAxes().slice(0, 3), '2026-11-20T00:00:00.000Z')
  assert.equal(built.ok, false)
  assert.match(built.reason, /openness|缺了这几根轴/)
})

test('推导：未知的轴、重复的轴都拒绝', () => {
  const unknown = createCharacter(
    [...fourAxes(), { key: '尽责性', min: 0.2, max: 0.4, reason: '不在四根之内' }],
    '2026-11-20T00:00:00.000Z',
  )
  assert.equal(unknown.ok, false)
  assert.match(unknown.reason, /未知的轴/)

  const duplicated = createCharacter([...fourAxes(), fourAxes()[0]], '2026-11-20T00:00:00.000Z')
  assert.equal(duplicated.ok, false)
  assert.match(duplicated.reason, /给了两次/)
})

test('推导：下限高于上限、或越出 0–1，都拒绝', () => {
  const inverted = fourAxes()
  inverted[0] = { ...inverted[0], min: 0.9, max: 0.2 }
  assert.equal(createCharacter(inverted, '2026-11-20T00:00:00.000Z').ok, false)

  const overflow = fourAxes()
  overflow[1] = { ...overflow[1], max: 1.4 }
  assert.equal(createCharacter(overflow, '2026-11-20T00:00:00.000Z').ok, false)
})

// ---------------------------------------------------------------- 校验

test('校验：还没有性格时不判"缺轴"（未初始化的文档本来就是空的）', () => {
  const persona = createDefaultPersona()
  const validation = validatePersona(persona, undefined, 'agent')
  assert.equal(codesOf(validation).includes('character.axis-missing'), false)
})

test('校验：四根齐、范围合法时没有任何性格类问题', () => {
  const persona = sealedPersona()
  const validation = validatePersona(persona, undefined, 'user')
  assert.deepEqual(codesOf(validation).filter((code) => code.startsWith('character.')), [])
})

test('校验：缺一根报 character.axis-missing', () => {
  const persona = sealedPersona()
  persona.character.axes = persona.character.axes.filter((axis) => axis.key !== 'openness')
  const validation = validatePersona(persona, undefined, 'user')
  assert.equal(validation.ok, false)
  assert.ok(codesOf(validation).includes('character.axis-missing'))
})

test('校验：此刻的值掉出范围报 character.value-out-of-range', () => {
  const persona = sealedPersona()
  const axis = persona.character.axes.find((item) => item.key === 'stability')
  axis.value = 0.95 // 范围是 0.35–0.62
  const validation = validatePersona(persona, undefined, 'user')
  assert.equal(validation.ok, false)
  assert.ok(codesOf(validation).includes('character.value-out-of-range'))
})

test('校验：没写理由只是警告，不挡写入', () => {
  const axes = fourAxes()
  axes[2] = { ...axes[2], reason: '   ' }
  const persona = sealedPersona(axes)
  const validation = validatePersona(persona, undefined, 'user')
  assert.equal(validation.ok, true, '理由缺失不该卡住初始化')
  assert.ok(codesOf(validation).includes('character.reason-missing'))
})

// ---------------------------------------------------------------- 封存

test('封存：Agent 再改范围就被拒（那是"天生"，只有对方能改）', () => {
  const prev = sealedPersona()
  const next = JSON.parse(JSON.stringify(prev))
  next.character.axes[0].max = 0.95
  const validation = validatePersona(next, prev, 'agent')
  assert.equal(validation.ok, false)
  assert.ok(codesOf(validation).includes('character.sealed'))
})

test('封存：用户在工作台改范围放行（同一个改法，结论不同）', () => {
  const prev = sealedPersona()
  const next = JSON.parse(JSON.stringify(prev))
  next.character.axes[0].max = 0.95
  const validation = validatePersona(next, prev, 'user')
  assert.equal(codesOf(validation).includes('character.sealed'), false)
})

test('封存：只改"此刻的值"不算改笼子 —— 它将来会被经历推动', () => {
  const prev = sealedPersona()
  const next = JSON.parse(JSON.stringify(prev))
  // 在范围内挪一点：0.49 → 0.6（范围 0.35–0.62）
  next.character.axes.find((axis) => axis.key === 'stability').value = 0.6
  const validation = validatePersona(next, prev, 'agent')
  assert.equal(codesOf(validation).includes('character.sealed'), false)
  assert.equal(validation.ok, true)
})

// ---------------------------------------------------------------- 渲染

test('渲染：四根都说，中间档也有自己的说法（2026-11-25：不再沉默）', () => {
  const persona = sealedPersona([
    // 0.5 → 中间；0.4 → 中间；0.2 → 偏低；0.84 → 偏高
    { key: 'stability', min: 0.5, max: 0.5, reason: '稳' },
    { key: 'extraversion', min: 0.3, max: 0.5, reason: '话少' },
    { key: 'agreeableness', min: 0.1, max: 0.3, reason: '护己' },
    { key: 'openness', min: 0.72, max: 0.96, reason: '好奇' },
  ])
  const text = renderPersonaPrompt(persona, { enabled: true })
  assert.match(text, /此刻的你/)
  assert.match(text, /护着自己，不肯先退/, '宜人性 0.2 应当说"低"那一档')
  assert.match(text, /看见没见过的东西就想凑近/, '开放性 0.84 应当说"高"那一档')
  assert.match(text, /表面看着稳，心里其实在翻/, '稳定性落在中间：它有话说，只是说得像"两头顶着"')
  assert.match(text, /看人：熟了话就多，不熟就收着/, '外向性落在中间同样有话说')
  assert.equal(/一碰就晃/.test(text), false, '中间档不该被说成偏向某一端')
})

test('渲染：真机那一组值（宜人性 0.375 落在中间）不再被整条藏掉', () => {
  // 2026-11-25 真机：她的宜人性 0.375、稳定性 0.665。旧写法只说"很稳、话多、爱凑近"，
  // "护着自己、只对认下的人松口"一个字都没有 —— 而她看到的那个人几乎不是她。
  const axes = [
    { key: 'stability', min: 0.45, max: 0.7, reason: '心也会翻' },
    { key: 'extraversion', min: 0.7, max: 0.95, reason: '话往外喷' },
    { key: 'agreeableness', min: 0.1, max: 0.45, reason: '不肯先退' },
    { key: 'openness', min: 0.6, max: 0.95, reason: '想凑近' },
  ]
  const persona = sealedPersona(axes)
  persona.character = {
    derivedAt: '2026-11-20T00:00:00.000Z',
    axes: [
      { key: 'stability', min: 0.45, max: 0.7, value: 0.665, reason: '心也会翻' },
      { key: 'extraversion', min: 0.7, max: 0.95, value: 0.89, reason: '话往外喷' },
      { key: 'agreeableness', min: 0.1, max: 0.45, value: 0.375, reason: '不肯先退' },
      { key: 'openness', min: 0.6, max: 0.95, value: 0.765, reason: '想凑近' },
    ],
  }
  const text = renderPersonaPrompt(persona, { enabled: true })
  assert.match(text, /平时不让，只有认下的人才能让我松口/, '宜人性 0.375 必须说出来')
  assert.match(text, /很稳，事过就过/, '稳定性 0.665 是"高"那一档')
  assert.match(text, /话往外冒，憋着比说错还难受/, '外向性 0.89 是"很高"那一档')
})

test('五档的分界：0.2 / 0.35 / 0.65 / 0.85', async () => {
  const { bandOf } = await import('../lib/persona/render-character.js')
  const band = (value) => bandOf({ key: 'stability', value, min: 0, max: 1, reason: '' })
  assert.equal(band(0.0), 0)
  assert.equal(band(0.19), 0)
  assert.equal(band(0.2), 1, '0.2 归"低"这一档')
  assert.equal(band(0.34), 1)
  assert.equal(band(0.35), 2)
  assert.equal(band(0.64), 2)
  assert.equal(band(0.65), 3)
  assert.equal(band(0.849), 3)
  assert.equal(band(0.85), 4)
  assert.equal(band(1), 4)
  assert.equal(band(Number.NaN), undefined, '数值坏了就不写这一根，别瞎说')
})

test('渲染：还没有性格时，人格段里不出现"此刻的你"', () => {
  const persona = createDefaultPersona()
  persona.identityCard.fields[0].value = '小安'
  persona.identityCard.initializedAt = '2026-11-20T00:00:00.000Z'
  persona.identityCard.sealedAt = '2026-11-20T00:00:00.000Z'
  const text = renderPersonaPrompt(persona, { enabled: true })
  assert.match(text, /小安/)
  assert.equal(/此刻的你/.test(text), false)
})

test('渲染：性格那行排在底色之后、信息之前', () => {
  const persona = sealedPersona()
  persona.mutableLayer.sections[0].items = ['主人']
  const text = renderPersonaPrompt(persona, { enabled: true })
  const atCharacter = text.indexOf('此刻的你')
  const atSections = text.indexOf('## 你的信息')
  assert.ok(atCharacter > 0)
  assert.ok(atSections > atCharacter, '性格应当在"你的信息"之前')
})
