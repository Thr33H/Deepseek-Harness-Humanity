/**
 * 0.1.14 · 人格卡只剩 **4 个原生项**（其余一律自定义）+ 去掉「用户定义」区块（V3–V8）。
 *
 * 用户 2026-10-09 的两条原话（逐字）：
 * ① "只有 8 个原生项，角色卡 4 个，人格卡 4 个，其余都是属于自定一项，**没有标准这一说**，
 *    除了原生的 8 个外，**其余都一样待遇**，包括 dsh 新装一个 Humanity，也是显示 8 个原生项。"
 * ② "**用户自定义可以删了，它跟添加小节重复了。**"
 *
 * 本文件按项目书 §4 的 V3–V8 逐条钉住，并且**每条都要正反两面**（"删提示"不许变成"删校验"、
 * "能删能改名"不许变成"一律拒绝"）：
 * - V3 新装只有 8 个原生项（身份卡 4 + 人格卡 4，不再预置那 4 个空节）
 * - V4 降级为自定义项：**可删**（删后不再被补回）+ **可改名**（不产生"一节变两节"）
 * - V5 原生 4 项**仍锁定**：界面没入口 + 绕过界面直删直改被宿主拒（对照：非原生项照样能删能改）
 * - V6 "非标准"提示消失（且代码里无产出点）；**反例**：真正畸形的小节名仍被拦
 * - V7 「用户定义」区块下线，但**数据一个字节都不动**（含"空数组仍存在、不报错"）
 * - V8 注入正常：原生 4 节 + 自定义节都进提示词，原生在前，读数正常
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { CORE_IDENTITY_KEYS, PERSONA_ISSUE_CODES, STANDARD_SECTION_TITLES } from '../lib/persona/constants.js'
import { effectivePersona, normalizePersona } from '../lib/persona/normalize.js'
import { createDefaultPersona } from '../lib/persona/model.js'
import { personaPromptReport, PROMPT_CHAR_BUDGET, renderPersonaPrompt } from '../lib/persona/render.js'
import { collectPersonaContent } from '../lib/persona/render-content.js'
import { completeSections } from '../lib/persona/tool-helpers.js'
import { validatePersona } from '../lib/persona/validate.js'
import { createLog } from '../lib/log.js'
import { loadClientBundle } from './helpers/client-bundle.mjs'
import { createFakeChannel, emptyPersona, withSection } from './helpers/persona-fake.mjs'

/** 4 个原生小标题。 */
const NATIVE = [...STANDARD_SECTION_TITLES]

/** 0.1.13 及以前算"标准"、0.1.14 起降级为**普通自定义项**的那 4 个。 */
const DEMOTED = ['习惯与偏好', '经验教训', '情绪', '未结修正']

/** 起一个接好假通道、已读完一次的客户端控制器。 */
async function bootClient(document = emptyPersona()) {
  const client = await loadClientBundle()
  const controller = new client.PersonaWorkbenchController()
  controller.attach(createFakeChannel(document).channel)
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (controller.getSnapshot().status === 'ready') break
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(controller.getSnapshot().status, 'ready', '控制器没在预期时间内读到文档')
  return { client, controller }
}

/* ---------------------------------------------------------------- V3 新装只有 8 个原生项 */

test('V3 正面：新装文档 = 身份卡 4 字段 + 人格卡**恰好 4** 个原生小节（不再预置那 4 个空节）', () => {
  const persona = createDefaultPersona()

  assert.deepEqual(
    persona.identityCard.fields.map((field) => field.key),
    [...CORE_IDENTITY_KEYS],
    '身份卡 4 个原生字段',
  )
  assert.deepEqual(
    persona.mutableLayer.sections.map((section) => section.title),
    NATIVE,
    '人格卡 4 个原生小节 —— 旧版那 4 个空节不再预置',
  )
  assert.equal(NATIVE.length + CORE_IDENTITY_KEYS.length, 8, '合起来正好是用户说的"8 个原生项"')
  for (const title of DEMOTED) {
    assert.equal(persona.mutableLayer.sections.some((section) => section.title === title), false, `新装不该预置「${title}」`)
  }
})

test('V3 客户端半边：新装文档同样是 4 + 4（界面拿到的草稿就是它）', async () => {
  const { controller } = await bootClient(emptyPersona())
  const draft = controller.getSnapshot().draft

  assert.deepEqual(
    draft.mutableLayer.sections.map((section) => section.title),
    NATIVE,
    '界面上新装只有 4 个原生小节',
  )
  assert.deepEqual(draft.identityCard.fields.map((field) => field.key), [...CORE_IDENTITY_KEYS])
})

/* ------------------------------------------------- V4 降级为自定义项（正反两面：可删 / 可改名） */

test('V4-① 正面：现存「经验教训」**可删**，且删后**不再被自动补回**（宿主"整理补齐"也不补）', () => {
  const current = createDefaultPersona()
  withSection(current, '经验教训', ['别在深夜做决定'])

  // ① 界面/工具语义：显式传 `items: []` 就是"删这一节"，规范化后整节消失（不留空壳）。
  const cleared = { ...current, mutableLayer: { ...current.mutableLayer, sections: completeSections([{ title: '经验教训', items: [] }], current) } }
  const effective = effectivePersona(cleared)
  assert.equal(effective.mutableLayer.sections.some((section) => section.title === '经验教训'), false, '清空即删除')

  // ② 删掉之后再走一轮"整理补齐"：**不补回来**（只有原生 4 个会被补齐）。
  const nextRound = completeSections([{ title: '说话风格', items: ['少用形容词'] }], effective)
  const titles = nextRound.map((section) => section.title)
  assert.equal(titles.includes('经验教训'), false, '删掉的自定义节不许被补回')
  assert.deepEqual(titles.filter((title) => NATIVE.includes(title)), NATIVE, '原生 4 个照旧补齐')

  // ③ 与"漏传 = 不动"的区别（反面对照）：没删过的时候漏传必须原样保留。
  const omitted = completeSections([{ title: '说话风格', items: ['少用形容词'] }], current)
  assert.deepEqual(
    omitted.find((section) => section.title === '经验教训').items,
    ['别在深夜做决定'],
    '漏传 ≠ 删除（这一条是 0.1.12 就有的语义，不能被这轮改动打破）',
  )
})

test('V4-① 反面：宿主校验仍然接受"删掉非原生节"（用户与 Agent 都不该被这条拦住）', () => {
  const prev = createDefaultPersona()
  withSection(prev, '经验教训', ['别在深夜做决定'])
  const next = { ...prev, mutableLayer: { ...prev.mutableLayer, sections: effectivePersona(prev).mutableLayer.sections.filter((s) => s.title !== '经验教训') } }

  const asUser = validatePersona(normalizePersona(next), effectivePersona(prev), 'user')
  assert.equal(asUser.ok, true, `用户删自己的自定义节不该被拦（实际：${asUser.issues.map((i) => i.code).join(',')}）`)
})

test('V4-② 正面：现存「经验教训」**可改名**，且改名**不产生"一节变两节"**', async () => {
  const { controller } = await bootClient((() => {
    const doc = emptyPersona()
    withSection(doc, '经验教训', ['别在深夜做决定'])
    return doc
  })())

  const before = controller.getSnapshot().draft.mutableLayer.sections.length
  controller.beginRename('section:经验教训')
  assert.notEqual(controller.getSnapshot().renaming, undefined, '非原生小节可以进改名态')
  controller.setRenameName('踩坑记录')
  assert.equal(controller.getSnapshot().renameIssue, undefined, '改成非保留名应当没有问题码')
  controller.confirmRename()

  const sections = controller.getSnapshot().draft.mutableLayer.sections
  assert.equal(sections.length, before, '条目数不变（不是"新增一节、旧节还在"）')
  assert.equal(sections.some((section) => section.title === '经验教训'), false, '旧名字必须消失')
  assert.equal(sections.filter((section) => section.title === '踩坑记录').length, 1, '新名字**恰好一节**')
  assert.deepEqual(sections.find((section) => section.title === '踩坑记录').items, ['别在深夜做决定'], '内容跟着走')
})

test('V4-② 反面：改成**原生**名字仍被拦（那是"变成锁定项"的语义变更，不是改名）', async () => {
  const { controller } = await bootClient((() => {
    const doc = emptyPersona()
    withSection(doc, '经验教训', ['别在深夜做决定'])
    return doc
  })())

  const before = JSON.stringify(controller.getSnapshot().draft)
  controller.beginRename('section:经验教训')
  controller.setRenameName('对用户称呼')
  controller.confirmRename()
  assert.equal(JSON.stringify(controller.getSnapshot().draft), before, '被拦下时草稿一个字不动（原生名是保留名）')
  assert.notEqual(controller.getSnapshot().renaming, undefined, '表单不关：用户看得见自己填的名字')
})

/* --------------------------------------------------- V5 原生 4 项仍锁定（正反两面） */

test('V5 正面（界面半边）：原生 4 小节既没有删除入口、也没有改名入口；条目照旧可编辑', async () => {
  const { controller } = await bootClient(emptyPersona())
  const before = JSON.stringify(controller.getSnapshot().draft)

  for (const title of NATIVE) {
    const id = `section:${title}`
    // 绕过界面（直接调控制器）：必须全是空操作。
    controller.requestDelete(id)
    assert.equal(controller.getSnapshot().pendingDelete, undefined, `「${title}」连删除确认都进不去`)
    controller.beginRename(id)
    assert.equal(controller.getSnapshot().renaming, undefined, `「${title}」连改名态都进不去`)
    controller.confirmDelete()
    controller.confirmRename()
  }
  assert.equal(JSON.stringify(controller.getSnapshot().draft), before, '四个原生小节一个都没被动过')

  // 条目级的编辑**不受影响**（锁的是"整项删除/改名"，不是内容）。
  controller.setSectionText('对用户称呼', '主人')
  assert.deepEqual(controller.getSnapshot().draft.mutableLayer.sections[0].items, ['主人'])
})

test('V5 对照（防"一律拒绝"的恒真式）：非原生小节在同一个控制器里**能**进改名态、**能**删', async () => {
  const { controller } = await bootClient((() => {
    const doc = emptyPersona()
    withSection(doc, '经验教训', ['别在深夜做决定'])
    return doc
  })())

  controller.beginRename('section:经验教训')
  assert.notEqual(controller.getSnapshot().renaming, undefined, '非原生小节应当可以改名')
  controller.cancelRename()

  controller.requestDelete('section:经验教训')
  assert.equal(controller.getSnapshot().pendingDelete, 'section:经验教训', '非原生小节应当可以删（先二次确认）')
  controller.confirmDelete()
  assert.equal(
    controller.getSnapshot().draft.mutableLayer.sections.some((section) => section.title === '经验教训'),
    false,
    '确认后真的删掉',
  )
})

test('V5 反面（宿主半边）：绕过界面直删/直改原生小节被拒；对照：非原生项照样能删能改', () => {
  const prev = createDefaultPersona()
  withSection(prev, '经验教训', ['别在深夜做决定'])

  // ① 直删一个原生小节 ⇒ `mutable.section-locked-missing`（rejected）。
  const dropped = {
    ...prev,
    mutableLayer: { ...prev.mutableLayer, sections: prev.mutableLayer.sections.filter((s) => s.title !== '对用户称呼') },
  }
  const asUser = validatePersona(normalizePersona(dropped), effectivePersona(prev), 'user')
  assert.equal(asUser.ok, false, '绕过界面的删除必须被宿主拒绝（工作台不是后门）')
  assert.ok(
    asUser.issues.some((issue) => issue.code === 'mutable.section-locked-missing' && issue.severity === 'rejected'),
    `必须有锁定项缺失的拒绝（实际：${asUser.issues.map((i) => i.code).join(',')}）`,
  )

  // ② 直改一个原生小节的标题（等于删掉原名）同样被拒。
  const renamed = {
    ...prev,
    mutableLayer: {
      ...prev.mutableLayer,
      sections: prev.mutableLayer.sections.map((s) => (s.title === '说话风格' ? { title: '语气', items: s.items } : s)),
    },
  }
  assert.equal(validatePersona(normalizePersona(renamed), effectivePersona(prev), 'user').ok, false, '原生小节不许改名')

  // ③ 对照：非原生项（含降级的那 4 个）照样能删能改 —— 这一条防"一律拒绝"的恒真式。
  const custom = {
    ...prev,
    mutableLayer: {
      ...prev.mutableLayer,
      sections: prev.mutableLayer.sections
        .filter((s) => s.title !== '经验教训')
        .map((s) => (s.title === '情绪' ? { title: '心情', items: s.items } : s))
        .concat([{ title: '情绪', items: ['今天有点累'] }]),
    },
  }
  const customResult = validatePersona(normalizePersona(custom), effectivePersona(prev), 'user')
  assert.equal(customResult.ok, true, `删一个、改一个自定义节必须放行（实际：${customResult.issues.map((i) => i.code).join(',')}）`)
})

/* ------------------------------------------- V6 "非标准"提示消失（配反例：别把删提示做成删校验） */

test('V6 正面：降级的那 4 个节**不再产出任何提示**；该问题码在代码里无产出点', () => {
  const persona = createDefaultPersona()
  for (const title of DEMOTED) withSection(persona, title, [`${title}的内容`])

  const validation = validatePersona(normalizePersona(persona), effectivePersona(persona), 'user')
  assert.equal(validation.ok, true, `4 个降级节都该是合法的（实际：${validation.issues.map((i) => i.code).join(',')}）`)
  assert.deepEqual(validation.issues, [], '一条提示都不该有')
  assert.equal(
    validation.issues.some((issue) => issue.code === 'mutable.section-non-standard'),
    false,
    '不得再产出"非标准"提示',
  )

  // 代码里也没有产出点：问题码本身已从公开集合里删除（`grep` 可证）。
  assert.equal(
    PERSONA_ISSUE_CODES.includes('mutable.section-non-standard'),
    false,
    '问题码已随产品决定删除（与 mutable.address-changed 同一种退役方式）',
  )
})

test('V6 反例（不许把"删提示"做成"删校验"）：畸形小节名照旧被拦', () => {
  const prev = createDefaultPersona()

  // ① 空标题 + 有内容 ⇒ rejected（它永远不会进提示词，写进去等于内容静默失效）。
  const emptyTitle = {
    ...prev,
    mutableLayer: { ...prev.mutableLayer, sections: [...prev.mutableLayer.sections, { title: '', items: ['这条永远不会生效'] }] },
  }
  const blank = validatePersona(normalizePersona(emptyTitle), effectivePersona(prev), 'user')
  assert.equal(blank.ok, false, '无名小节必须照旧被拒')
  assert.ok(blank.issues.some((issue) => issue.code === 'mutable.section-title-empty'), '必须是 section-title-empty')

  // ② 重复标题 ⇒ rejected（这条也不该因为"没有标准这一说"而放松）。
  //    ⚠️ 直接把**未规范化**的文档交给校验器：`normalizePersona` 会把同名节合并掉，
  //    而"绕过规范化直接提交"正是校验器要独立守住的那条线（与既有用例同一口径）。
  const duplicate = {
    ...prev,
    mutableLayer: { ...prev.mutableLayer, sections: [...prev.mutableLayer.sections, { title: '说话风格', items: ['重复的'] }] },
  }
  const dup = validatePersona(duplicate, effectivePersona(prev), 'user')
  assert.equal(dup.ok, false, '重复标题必须照旧被拒')
  assert.ok(dup.issues.some((issue) => issue.code === 'mutable.section-duplicate'))

  // ③ 冒牌固定层字段名 ⇒ rejected（层次不许混）。
  const shadow = {
    ...prev,
    mutableLayer: { ...prev.mutableLayer, sections: [...prev.mutableLayer.sections, { title: '姓名', items: ['冒牌'] }] },
  }
  const shadowed = validatePersona(shadow, effectivePersona(prev), 'user')
  assert.equal(shadowed.ok, false, '固定层字段名不得作为可变层小标题')
  assert.ok(shadowed.issues.some((issue) => issue.code === 'mutable.core-key-shadowed'))
})

/* --------------------------------------------- V7 「用户定义」区块下线，但数据一个字节都不动 */

test('V7-① 客户端：三个「用户定义」入口全部下线（界面不再渲染/编辑它）', async () => {
  const { controller } = await bootClient(emptyPersona())
  assert.equal(controller.addUserDefined, undefined, '添加入口已下线')
  assert.equal(controller.setUserDefined, undefined, '编辑入口已下线')
  assert.equal(controller.removeUserDefined, undefined, '删除入口已下线')
})

test('V7-② 数据保留（非空）：`userDefined` 原样穿过保存，一个字节都不动', async () => {
  const document = emptyPersona()
  document.mutableLayer.userDefined.push({ key: '咖啡', value: '不加糖' })
  const fake = createFakeChannel(document)
  const client = await loadClientBundle()
  const controller = new client.PersonaWorkbenchController()
  controller.attach(fake.channel)
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (controller.getSnapshot().status === 'ready') break
    await new Promise((resolve) => setTimeout(resolve, 5))
  }

  assert.deepEqual(controller.getSnapshot().draft.mutableLayer.userDefined, [{ key: '咖啡', value: '不加糖' }], '读到草稿里')
  controller.setSectionText('对用户称呼', '主人')
  await controller.save()

  assert.equal(fake.calls.replace.length, 1, '一次保存')
  assert.deepEqual(
    fake.calls.replace[0].section.mutableLayer.userDefined,
    [{ key: '咖啡', value: '不加糖' }],
    '「用户定义」的数据必须原样写回（下线 ≠ 删数据）',
  )
})

test('V7-③ 数据保留（空数组）：空 `userDefined` 仍存在、不报错（用户的卡就是这一档）', () => {
  const persona = createDefaultPersona()
  assert.deepEqual(persona.mutableLayer.userDefined, [], '字段存在且为空数组（不是 undefined）')
  assert.equal(validatePersona(normalizePersona(persona), effectivePersona(persona), 'user').ok, true, '空数组必须合法')

  // 规范化与"生效口径"都不许把它删掉或改形。
  assert.deepEqual(normalizePersona(persona).mutableLayer.userDefined, [])
  assert.deepEqual(effectivePersona(persona).mutableLayer.userDefined, [])
  assert.equal('userDefined' in persona.mutableLayer, true, '字段本身必须在（schema 的一部分）')
})

/* ------------------------------------------------------------------- V8 注入正常 */

test('V8 注入：原生 4 节 + 自定义节都进提示词，原生在前；读数正常', () => {
  const persona = createDefaultPersona()
  persona.identityCard.initializedAt = '2026-09-01T00:00:00.000Z'
  persona.identityCard.sealedAt = '2026-09-01T00:00:00.000Z'
  persona.identityCard.fields.forEach((field, index) => {
    field.value = `值${index + 1}`
  })
  persona.mutableLayer.sections[0].items = ['主人']
  persona.mutableLayer.sections[1].items = ['先给结论，再给依据']
  withSection(persona, '经验教训', ['别在深夜做决定'])
  withSection(persona, '我自己的标题', ['自定义内容'])

  const text = renderPersonaPrompt(persona, { enabled: true, independentJudgment: false })
  for (const needle of ['对用户称呼', '主人', '说话风格', '先给结论', '经验教训', '别在深夜做决定', '我自己的标题']) {
    assert.ok(text.includes(needle), `注入内容里必须有「${needle}」`)
  }
  // 原生在前：4 个原生标题里**有内容的**都排在那两个自定义小节之前。
  const positions = ['对用户称呼', '说话风格', '经验教训', '我自己的标题'].map((title) => text.indexOf(title))
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), '顺序：原生在前，自定义在后（按文档顺序）')

  // 投影与预算读数：4 + 2 节都在投影里，且这份小卡没超预算。
  const content = collectPersonaContent(persona)
  assert.deepEqual(
    content.sections.map((section) => section.title),
    ['对用户称呼', '说话风格', '经验教训', '我自己的标题'],
    '投影只收有内容的小节，顺序不变',
  )
  const report = personaPromptReport(persona, { independentJudgment: false })
  assert.ok(report !== undefined && report.budget > 0 && report.budget < PROMPT_CHAR_BUDGET, '预算读数在 2400 以内（扣固定段）')
  assert.equal(report.truncated, false, '这份小卡不该被截断')
  assert.ok(report.used > 0, '用掉的字数必须为正')
})
