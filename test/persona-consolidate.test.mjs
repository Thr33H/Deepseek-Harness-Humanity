/**
 * 人格卡**整合**的测试（2026-09-26 新增，P-056 的回归钉）。
 *
 * 缘起：用户「自进化系统应该也要有整合这些的能力，而不是靠用户发现，然后用户调整」。
 * 真机背景：可变层是**追加式**写回（只跳过逐字相同的），模型每次换个说法就多一条 ——
 * 某实例的「对用户称呼」攒到 7 条、其中 5 条同义，把人格卡顶到注入预算上限。
 *
 * 这个文件钉四件事：
 * 1. **该并的并**：措辞几乎相同的（真机 Dice 0.87–1.00）并成一条，留信息量更大的那条；
 * 2. **不该并的绝不并**：互相包含但各是一条规矩的（真机最高 0.68）一条都不许少；
 * 3. **不跨小节**：用户自己分的类，不许替用户合并结构；
 * 4. **写入路径不再造新的**：同义的新条目不追加；模型给的整合建议只在"逐字对得上"时生效。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { mergePersonaSections } from '../lib/evolution/classify-persona.js'
import { consolidatePersona, isNearDuplicateItem, PERSONA_MERGE_DICE } from '../lib/persona/consolidate.js'
import { createDefaultPersona } from '../lib/persona/model.js'

/**
 * 一份已初始化的人格。
 * @param titles - 要预置的小标题 → 条目。
 */
function personaWith(titles) {
  const persona = createDefaultPersona()
  persona.identityCard.initializedAt = '2026-09-23T00:00:00.000Z'
  persona.identityCard.sealedAt = '2026-09-23T00:00:00.000Z'
  persona.identityCard.fields.forEach((field) => {
    field.value = '值'
  })
  for (const [title, items] of Object.entries(titles)) {
    const section = persona.mutableLayer.sections.find((entry) => entry.title === title)
    assert.ok(section !== undefined, `没有这个小标题：${title}`)
    section.items = [...items]
  }
  return persona
}

/**
 * 取某个小节当前条目。
 * @param document - 人格文档。
 * @param title - 小节标题。
 * @returns 该小节的条目。
 */
function itemsOf(document, title) {
  return document.mutableLayer.sections.find((section) => section.title === title)?.items ?? []
}

test('该并的并：措辞几乎相同的两条并成一条，留下信息量更大的那条', () => {
  const persona = personaWith({
    说话风格: ['台词不加括号，直接写', '台词不加括号、直接写'],
    交付格式: ['以小说体推进，注重心理与身体反应细节', '以小说体推进剧情，注重心理与身体反应细节'],
  })

  const { document, merged } = consolidatePersona(persona)

  assert.equal(merged.length, 2)
  assert.deepEqual(itemsOf(document, '说话风格'), ['台词不加括号，直接写'], '同样长 ⇒ 留先出现的那条（稳定可预期）')
  assert.deepEqual(
    itemsOf(document, '交付格式'),
    ['以小说体推进剧情，注重心理与身体反应细节'],
    '一条是另一条的延长 ⇒ 留更长的那条，信息不丢',
  )
  assert.deepEqual(
    merged.map((item) => item.title).sort(),
    ['交付格式', '说话风格'],
    '合并清单要能被人复核',
  )
})

test('不该并的绝不并：互相包含但各是一条规矩的，一条都不许少（合成卡标定）', () => {
  // 夹具是**合成卡**（2026-10-10 内容级脱敏：原锚取自某实例真机卡）。三对实测 Dice 0.703 / 0.553 / 0.111，
  // 全部低于阈值 —— 它们是"两条规矩"而不是重复。阈值 0.82 的标定史见 `src/host/persona/consolidate.ts`。
  const persona = personaWith({
    行为边界: [
      '不擅自跳过用户指定的示例节点',
      '用户未表态前保持当前示例推进，不擅自跳过用户指定的示例节点',
      '不代替用户决定关键示例分支；用户未表态前保持当前示例推进',
    ],
  })

  const { document, merged } = consolidatePersona(persona)

  assert.equal(merged.length, 0, `阈值 ${PERSONA_MERGE_DICE} 必须高于合成卡里最高的近似对（0.703）`)
  assert.equal(itemsOf(document, '行为边界').length, 3, '一条都不许少')
})

test('极性否决：一条带否定、另一条不带 ⇒ 再像也是反面，绝不并（2026-09-26 审计 P3）', () => {
  // 「不要在我工作时打扰我」与「要在我工作时打扰我」Dice = 0.941，只差一个"不"字 ——
  // 旧逻辑正是靠那 12 个相同的字把它判成重复，并掉一条等于**替用户改了意思**。
  assert.equal(
    isNearDuplicateItem('不要在我工作时打扰我', '要在我工作时打扰我'),
    false,
    '一句带否定、一句不带 ⇒ 不是重复',
  )
  // 两边都带否定时不受影响：那是同一条规矩的两种说法（Dice 0.833，仍要能并）。
  assert.equal(isNearDuplicateItem('不要用 emoji 回复我', '回复我时不要用 emoji'), true)
  // 写入路径同样受保护：反面意见不许被当成重复而丢掉。
  const persona = personaWith({ 行为边界: ['要在我工作时打扰我'] })
  const { added } = mergePersonaSections(persona, [{ section: '行为边界', items: ['不要在我工作时打扰我'] }])
  assert.deepEqual(added, ['行为边界：+ 不要在我工作时打扰我'], '反面条目必须真的写进去')
})

test('不跨小节：同样的一句话落在两个小节里，各留各的（结构是用户分的）', () => {
  const persona = personaWith({
    说话风格: ['先给结论，再给依据'],
    交付格式: ['先给结论，再给依据'],
  })

  const { document, merged } = consolidatePersona(persona)

  assert.equal(merged.length, 0)
  assert.equal(itemsOf(document, '说话风格').length, 1)
  assert.equal(itemsOf(document, '交付格式').length, 1)
})

test('逐字相同：只留一条（旧行为就有的那一档，不能被长度门槛弄丢）', () => {
  const persona = personaWith({ 说话风格: ['温柔', '温柔', '温柔'] })

  const { document, merged } = consolidatePersona(persona)

  assert.equal(merged.length, 2)
  assert.deepEqual(itemsOf(document, '说话风格'), ['温柔'], '两个字也要去重')
})

test('太短的条目只走"逐字"那一档：不因为像就被并掉', () => {
  assert.equal(isNearDuplicateItem('主人', '主人'), true, '逐字相同永远算重复')
  assert.equal(isNearDuplicateItem('主人', '主人偏好长篇沉浸式角色扮演，重细节'), false, '两三个字不参与相似度档')
  assert.equal(isNearDuplicateItem('', '任何东西'), false, '空条目不参与')
})

test('整合不产生副作用：原文档保持不动（纯函数）', () => {
  const persona = personaWith({ 说话风格: ['台词不加括号，直接写', '台词不加括号、直接写'] })
  const before = JSON.stringify(persona)

  const { document } = consolidatePersona(persona)

  assert.equal(JSON.stringify(persona), before, '入参不许被改')
  assert.notEqual(JSON.stringify(document), before, '返回的是新文档')
})

test('写入路径：同义的新条目不追加（这才是重复的源头）', () => {
  const persona = personaWith({ 说话风格: ['台词不加括号，直接写'] })

  const { added } = mergePersonaSections(persona, [
    { section: '说话风格', items: ['台词不加括号、直接写', '用户情绪低落时先陪伴'] },
  ])

  assert.deepEqual(added, ['说话风格：+ 用户情绪低落时先陪伴'], '换个说法复述同一条不算新增')
})

test('写入路径：模型给的整合建议只在"逐字对得上"时生效', () => {
  const persona = personaWith({
    对用户称呼: ['「主人」', '在该角色扮演设定中，以「主人」称呼用户', '称呼主人为「主人」'],
  })

  const { next, merged } = mergePersonaSections(
    persona,
    [],
    [
      {
        section: '对用户称呼',
        keep: '在该角色扮演设定中，以「主人」称呼用户',
        // 第三条形近但不同字：对不上就不动（宁可少并一条，也不凭"大概"删用户的内容）。
        drop: ['「主人」', '称呼用户为「主人」'],
        reason: '都是同一个称呼的重复说法',
      },
    ],
  )

  assert.equal(merged, 1, '只并掉逐字对得上的那条')
  assert.deepEqual(itemsOf(next, '对用户称呼'), ['在该角色扮演设定中，以「主人」称呼用户', '称呼主人为「主人」'])
})

test('写入路径：keep 不在该小节里时整条建议作废（不能把两条都删掉）', () => {
  const persona = personaWith({ 对用户称呼: ['「主人」', '称呼主人为「主人」'] })

  const { next, merged } = mergePersonaSections(
    persona,
    [],
    [{ section: '对用户称呼', keep: '这条根本不在卡里', drop: ['「主人」', '称呼主人为「主人」'], reason: 'x' }],
  )

  assert.equal(merged, 0)
  assert.equal(itemsOf(next, '对用户称呼').length, 2, '保留项找不到时不许删任何东西')
})

test('自进化会在运行开头做免费整合：并掉了就写入，没得并可写就不写', async () => {
  const { applyConsolidation } = await import('../lib/persona/consolidate-apply.js')
  const logs = []
  const log = { info: (message) => logs.push(message), warn: () => {}, error: () => {} }

  /** 一个只记账的假人格入口。 */
  const fakeSection = (document) => ({
    reads: 0,
    writes: [],
    read() {
      this.reads += 1
      return document
    },
    async write(next, source) {
      this.writes.push({ next, source })
    },
  })

  const dirty = fakeSection(personaWith({ 说话风格: ['台词不加括号，直接写', '台词不加括号、直接写'] }))
  assert.equal(await applyConsolidation(dirty, log), 1, '有一对可并 ⇒ 返回 1')
  assert.equal(dirty.writes.length, 1, '并掉了就要写回')
  assert.equal(dirty.writes[0].source, 'agent', '走正规写入路径，以 agent 身份')
  assert.deepEqual(itemsOf(dirty.writes[0].next, '说话风格'), ['台词不加括号，直接写'])

  const clean = fakeSection(personaWith({ 说话风格: ['台词不加括号，直接写'] }))
  assert.equal(await applyConsolidation(clean, log), 0)
  assert.equal(clean.writes.length, 0, '没有可并项时一次写入都不发')

  const untouched = fakeSection(createDefaultPersona())
  assert.equal(await applyConsolidation(untouched, log), 0, '人格未初始化：不谈整理')
  assert.equal(untouched.writes.length, 0)
})

test('整合失败绝不冒泡：写入被拒只记一条警告（不许影响这一轮整理）', async () => {
  const { applyConsolidation } = await import('../lib/persona/consolidate-apply.js')
  const warned = []
  const log = { info: () => {}, warn: (message) => warned.push(message), error: () => {} }
  const section = {
    read: () => personaWith({ 说话风格: ['台词不加括号，直接写', '台词不加括号、直接写'] }),
    write: async () => {
      throw new Error('校验拒绝')
    },
  }

  assert.equal(await applyConsolidation(section, log), 0, '失败就当没并')
  assert.equal(warned.length, 1, '如实记一条警告')
})

test('提示词必须把人格卡原文交给模型（否则它没法逐字指出要并掉哪几条）', async () => {
  const { buildSystemPrompt } = await import('../lib/evolution/prompt.js')
  const card = [{ title: '对用户称呼', items: ['「主人」', '在该角色扮演设定中，以「主人」称呼用户'] }]

  const withCard = buildSystemPrompt({ mode: 'incremental', workspaceLabel: 'TEST', sectionTitles: ['对用户称呼'], personaCard: card })
  assert.match(withCard, /当前人格卡内容/, '要有一段"当前内容"')
  assert.match(withCard, /在该角色扮演设定中，以「主人」称呼用户/, '条目要逐字给出来')
  assert.match(withCard, /sectionConsolidations/, '要有整合字段的规则')
  assert.match(withCard, /逐字一致/, '要说明引用必须逐字一致（否则写不进去）')

  const withoutCard = buildSystemPrompt({ mode: 'incremental', workspaceLabel: 'TEST', sectionTitles: [] })
  assert.doesNotMatch(withoutCard, /当前人格卡内容/, '没有卡就不该出现这一段')
})
