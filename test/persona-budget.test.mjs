/**
 * 人格注入**预算拟合**的测试（2026-09-26 新增，回归钉）。
 *
 * 缘起：用户发现某实例的提示词末尾挂着「（人格内容超出注入预算，已截断）」，而她的可变层
 * 有 7 个小节、54 条。查下去发现旧实现把"一个小节"当成一整行，**放不下就整节丢掉** ——
 * 真机后果是 3 个小节（习惯与偏好 / 经验教训 / 未结修正）从来没进过提示词，54 条只进去 23 条。
 * 这个文件钉住修完之后的四条性质：
 * 1. **预算装得下就一条都不许少**（不再有"每节最多 6 条"的固定悬崖）；
 * 2. **超预算时每个小节都必须在场**（保底一条 + 轮转加条，绝不整节消失）；
 * 3. **总长含截断标记仍不超预算**（旧实现把标记算在预算外）；
 * 4. **账目与文档一致**（工作台显示的"有几条没进去"必须是真的）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createDefaultPersona } from '../lib/persona/model.js'
import { PERSONA_SECTION_ORDER } from '../lib/persona/prompt.js'
import { MUTABLE_OPS_GUIDE } from '../lib/persona/prompt-texts.js'
import { personaPromptReport, PROMPT_CHAR_BUDGET, renderPersonaPrompt } from '../lib/persona/render.js'

/** 一份"写满了"的人格：7 个小节、每节若干条（形状对齐真机那张卡）。 */
function fullPersona(perSection = 8, itemLength = 24) {
  const persona = createDefaultPersona()
  persona.identityCard.initializedAt = '2026-09-23T00:00:00.000Z'
  persona.identityCard.sealedAt = '2026-09-23T00:00:00.000Z'
  persona.identityCard.fields.forEach((field, index) => {
    field.value = `值${index + 1}`
  })
  persona.mutableLayer.sections.forEach((section, sectionIndex) => {
    section.items = Array.from(
      { length: perSection },
      (_, index) => `第${sectionIndex + 1}节第${index + 1}条：${'填'.repeat(itemLength)}`,
    )
  })
  return persona
}

/** 文档里所有非空条目数（与拟合账目对比用）。 */
function countItems(persona) {
  return persona.mutableLayer.sections.reduce(
    (sum, section) => sum + section.items.filter((item) => item.trim() !== '').length,
    0,
  )
}

test('预算装得下：一条都不许少，也不该出现「未注入」字样', () => {
  const persona = fullPersona(4, 12)

  const text = renderPersonaPrompt(persona, { enabled: true, independentJudgment: false })
  const stats = personaPromptReport(persona, { independentJudgment: false })

  assert.ok(stats !== undefined)
  assert.equal(stats.dropped, 0, '预算之内不该丢任何条目')
  assert.equal(stats.injected, countItems(persona), '注入条数等于文档里的条数')
  assert.doesNotMatch(text, /未注入/, '没丢东西就不该有未注入说明')
  assert.doesNotMatch(text, /已截断/, '没丢东西就不该有截断标记')
  assert.ok(text.length <= PROMPT_CHAR_BUDGET, `总长 ${text.length} 超过预算`)
})

test('超出预算：**每个小节都必须在场**（旧实现会整节消失）', () => {
  // 每节 20 条长值 ⇒ 总量远超预算，逼出降级路径。
  const persona = fullPersona(20, 60)

  const text = renderPersonaPrompt(persona, { enabled: true, independentJudgment: false })
  const stats = personaPromptReport(persona, { independentJudgment: false })

  assert.ok(stats !== undefined)
  assert.ok(stats.dropped > 0, '这份文档必然超预算')
  for (const section of persona.mutableLayer.sections) {
    assert.match(text, new RegExp(`- ${section.title}：`), `小节「${section.title}」必须在场，而不是整节消失`)
    const fit = stats.sections.find((entry) => entry.title === section.title)
    assert.ok(fit !== undefined && fit.injected >= 1, `小节「${section.title}」至少要保底一条`)
    assert.equal(fit.injected + fit.dropped, section.items.length, '每节的账要平')
  }
  assert.equal(stats.injected + stats.dropped, countItems(persona), '总账要平')
  assert.match(text, /已截断/, '丢了东西就必须如实标注')
  assert.ok(text.length <= PROMPT_CHAR_BUDGET, `总长 ${text.length}（含标记）超过预算`)
})

test('降级是「逐条」而不是「整节」：条目多的节拿到的条数不少于条目少的节', () => {
  const persona = fullPersona(20, 60)
  // 让第一节只有 1 条：它必然全额注入；后面几节再多也不该把它挤掉。
  const first = persona.mutableLayer.sections[0]
  first.items = ['唯一的一条']

  const stats = personaPromptReport(persona, { independentJudgment: false })

  assert.ok(stats !== undefined)
  const head = stats.sections[0]
  assert.ok(head !== undefined)
  assert.equal(head.injected, 1, '保底轮先给每节一条，第一条不会因为别节条目多而丢')
  assert.equal(head.dropped, 0)
})

test('账目：未初始化 / 没内容时算不出账（界面据此不显示）', () => {
  assert.equal(personaPromptReport(createDefaultPersona()), undefined, '未初始化 ⇒ 没有注入内容可言')

  const empty = createDefaultPersona()
  empty.identityCard.initializedAt = '2026-09-23T00:00:00.000Z'
  empty.identityCard.fields.forEach((field) => {
    field.value = ''
  })
  empty.mutableLayer.sections.forEach((section) => {
    section.items = []
  })
  assert.equal(personaPromptReport(empty), undefined, '内容为空 ⇒ 空串，不该有一份"0 条"的账')
})

test('两个固定段不参与人格内容的预算（独立判断开着只影响内容可用额度）', () => {
  const persona = fullPersona(20, 60)

  const withAnti = renderPersonaPrompt(persona, { enabled: true, independentJudgment: true })
  const without = renderPersonaPrompt(persona, { enabled: true, independentJudgment: false })

  assert.match(withAnti, /操作约定（Humanity）/, '操作约定段永远完整')
  assert.ok(without.length <= PROMPT_CHAR_BUDGET, '关掉独立判断时也不超预算')
  // 独立判断占掉预算 ⇒ 内容能装的条数不会更多（应当更少或持平）。
  const antiStats = personaPromptReport(persona, { independentJudgment: true })
  const plainStats = personaPromptReport(persona, { independentJudgment: false })
  assert.ok(antiStats !== undefined && plainStats !== undefined)
  assert.ok(antiStats.injected <= plainStats.injected, '独立判断占用同一份预算')
  assert.ok(withAnti.includes(MUTABLE_OPS_GUIDE))
  assert.ok(PERSONA_SECTION_ORDER > 0, '人格段在系统提示词里有位置（防止误删接线）')
})

test('单条超软上限被裁短时也算截断（账目不许说"全都进去了"）', () => {
  // 2026-09-26 审计 P1：被裁的条目**照样进得去**（`injected` 照加、`dropped` 是 0），
  // 于是工作台显示"24/24 条全部进提示词"，而其中一条的尾巴其实没进去 ——
  // 提示词末尾挂着「已截断」，账目却说全进去了，两个说法互相打脸。
  const persona = fullPersona(2, 12)
  persona.mutableLayer.sections[0].items[0] = `超长条目：${'长'.repeat(200)}`

  const stats = personaPromptReport(persona, { independentJudgment: false })
  assert.ok(stats !== undefined)
  assert.equal(stats.dropped, 0, '它是进去了的（不是整条掉队）')
  assert.equal(stats.truncated, true, '但尾巴被裁了 ⇒ 账目必须承认截断')

  const text = renderPersonaPrompt(persona, { enabled: true, independentJudgment: false })
  assert.ok(text.includes('…'), '注入文本里能看到截断标记')
  assert.ok(text.includes('已截断'), '提示词末尾要如实说明')
  assert.ok(text.length <= PROMPT_CHAR_BUDGET, '加了截断标记也不许超预算（标记也占字符）')
})

test('`{{` 的中和发生在拟合之前：中和多出来的字符也算进预算', () => {
  // 2026-09-26 审计 P7：中和放在拟合之后时，预算按"没中和的文本"算，
  // 而 `{{` ⇒ `{ {` 每条多一个字符，最终注入长度就会超出上限。
  const persona = fullPersona(0, 0)
  persona.mutableLayer.sections[0].items = Array.from(
    { length: 40 },
    (_, index) => `第${index}条：${'{{x}}'.repeat(8)}`,
  )

  const text = renderPersonaPrompt(persona, { enabled: true, independentJudgment: false })
  assert.equal(text.includes('{{'), false, '注进提示词的文本里不许还有 {{')
  assert.ok(text.length <= PROMPT_CHAR_BUDGET, '中和后的长度仍要落在预算内')

  const stats = personaPromptReport(persona, { independentJudgment: false })
  assert.ok(stats !== undefined)
  assert.ok(stats.used <= stats.budget, `账目里的用量也要在预算内（used=${stats.used} budget=${stats.budget}）`)
})
