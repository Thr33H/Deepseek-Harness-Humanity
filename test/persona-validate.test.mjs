/**
 * 人格校验与规范化的测试。
 *
 * 这里钉的是**判定边界**，尤其是两条最容易写错的：
 * 1. 同一个改法，"用户"与"Agent"的结论必须不同——用户在工作台里改固定层是权威输入，
 *    Agent 改则触发封存拒绝（P-013/P-023）；
 * 2. 低风险（去空白、去重）自动做，高风险（删核心字段、整节删除）一律拒绝，
 *    长文本只警告不拒绝（P-010/P-015）。
 *
 * 注：「改对用户称呼」**曾经**也在这条高风险线里，2026-09-23 真机反馈后按用户裁定拿掉了
 * （一个人可以有多个称呼）—— 相关用例已反转，见下面两条。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDefaultPersona } from '../lib/persona/model.js'
import { CONFIRMABLE_ISSUES, CORE_IDENTITY_KEYS, STANDARD_SECTION_TITLES, VALUE_SOFT_LIMIT } from '../lib/persona/constants.js'
import { effectivePersona, normalizePersona } from '../lib/persona/normalize.js'
import { stripControlChars } from '../lib/text.js'
import { validatePersona } from '../lib/persona/validate.js'
import { withSection } from './helpers/persona-fake.mjs'

/** 造一份"用户已经填过"的人格文档。 */
function filledPersona() {
  const persona = createDefaultPersona()
  persona.identityCard.fields[0].value = '小安'
  persona.identityCard.fields[1].value = '女'
  persona.identityCard.fields[2].value = '温和、直接'
  persona.identityCard.initializedAt = '2026-09-22T00:00:00.000Z'
  persona.identityCard.sealedAt = '2026-09-22T00:00:00.000Z'
  persona.mutableLayer.sections[0].items = ['主人']
  persona.mutableLayer.sections[1].items = ['先给结论，再给依据']
  return persona
}

/** 取出结论里的代码集合，便于断言"有没有这一类问题"。 */
const codesOf = (validation) => validation.issues.map((issue) => issue.code)

test('规范化：去空白、丢空项、去重，但**不排序**', () => {
  const persona = createDefaultPersona()
  persona.identityCard.fields.push({ key: '  昵称  ', value: '  小清  ', custom: true })
  persona.identityCard.fields.push({ key: '', value: '   ', custom: true })
  persona.mutableLayer.sections[1].items = ['  第二条  ', '第一条', '第一条', '   ']

  const normalized = normalizePersona(persona)

  assert.equal(normalized.identityCard.fields.at(-1).key, '昵称')
  assert.equal(normalized.identityCard.fields.at(-1).value, '小清')
  // 键值**都空**的行（工作台上点了「新增」还没填）是纯噪音，直接丢掉。
  assert.equal(normalized.identityCard.fields.length, CORE_IDENTITY_KEYS.length + 1, '4 个核心字段 + 昵称；空行已丢')
  // 顺序保持原样：自然语言列表的顺序本身携带含义，排序是有损的。
  assert.deepEqual(normalized.mutableLayer.sections[1].items, ['第二条', '第一条'])
})

test('⑥ 键空但**有内容**的行不能被静默丢掉：留给校验器报错（真机反馈："填的内容不见了"）', () => {
  const persona = createDefaultPersona()
  persona.identityCard.fields.push({ key: '', value: '没有名字的字段', custom: true })
  persona.mutableLayer.userDefined.push({ key: '', value: '白饭' })

  const normalized = normalizePersona(persona)

  // 规范化**只**丢空白行；有内容却漏了名字的行必须留下来，让用户被告知。
  assert.equal(normalized.identityCard.fields.length, CORE_IDENTITY_KEYS.length + 1)
  assert.equal(normalized.identityCard.fields.at(-1).value, '没有名字的字段')
  assert.deepEqual(normalized.mutableLayer.userDefined, [{ key: '', value: '白饭' }])

  const validation = validatePersona(normalized, createDefaultPersona(), 'user')
  assert.equal(validation.ok, false, '必须拒绝并说清原因，而不是无声吃掉')
  assert.deepEqual(codesOf(validation).sort(), ['identity.key-empty', 'mutable.user-defined-key-empty'])
})

test('规范化不修改入参（纯函数）', () => {
  const persona = createDefaultPersona()
  persona.mutableLayer.sections[1].items = ['  有空白  ']
  const before = JSON.stringify(persona)

  normalizePersona(persona)

  assert.equal(JSON.stringify(persona), before)
})

test('用户删掉核心身份字段会被拒绝', () => {
  const next = filledPersona()
  next.identityCard.fields = next.identityCard.fields.filter((field) => field.key !== '性别')

  const validation = validatePersona(next, filledPersona(), 'user')

  assert.equal(validation.ok, false)
  assert.deepEqual(codesOf(validation), ['identity.core-missing'])
})

test('超长值只警告、不阻断保存', () => {
  const next = filledPersona()
  next.identityCard.fields[2].value = '很'.repeat(VALUE_SOFT_LIMIT + 1)

  const validation = validatePersona(next, filledPersona(), 'user')

  assert.equal(validation.ok, true, '长文本不是错误，只是更贵')
  assert.deepEqual(codesOf(validation), ['identity.value-too-long'])
  assert.equal(validation.issues[0].severity, 'warning')
})

test('用户改固定层是允许的（只有用户能改）', () => {
  const next = filledPersona()
  next.identityCard.fields[2].value = '沉稳、克制'

  const validation = validatePersona(next, filledPersona(), 'user')

  assert.equal(validation.ok, true)
  assert.deepEqual(validation.issues, [])
})

test('Agent 改固定层被拒绝（封存）', () => {
  const next = filledPersona()
  next.identityCard.fields[2].value = 'Agent 自己想改的'

  const validation = validatePersona(next, filledPersona(), 'agent')

  assert.equal(validation.ok, false)
  assert.deepEqual(codesOf(validation), ['identity.sealed'])
  // 拒绝原因必须是结构化的（P-011），文案留给 Agent 按人格组织。
  assert.equal(validation.issues[0].severity, 'rejected')
  assert.match(validation.issues[0].message, /封存/)
})

test('Agent 把有内容的小标题整节删掉会被拒绝', () => {
  const prev = filledPersona()
  // 用**非原生**小节（经验教训）考"丢内容"这条规则：原生小节走另一条
  // （见下面「锁定 8 项」那条），两者混在一起时断言会同时收到两个代码，看不出是哪条在生效。
  // 0.1.14：「经验教训」已不是原生项 —— 夹具显式当自定义项加进来。
  withSection(prev, '经验教训', ['别在深夜做决定'])
  const next = filledPersona()
  next.mutableLayer.sections = next.mutableLayer.sections.filter((section) => section.title !== '经验教训')

  const validation = validatePersona(next, prev, 'agent')

  assert.equal(validation.ok, false)
  assert.deepEqual(codesOf(validation), ['mutable.section-dropped'])
})

test('默认 8 项：锁定小节整节删除被拒绝（用户与 Agent 两侧都拒）', () => {
  // 用户 2026-10-09：默认 8 项（固定层 4 项 + 人格卡前 4 个小节）不可删。
  // 固定层那一半由 `identity.core-missing` 管，可变层这一半由 `mutable.section-locked-missing` 管。
  const prev = filledPersona()
  for (const title of ['对用户称呼', '说话风格', '交付格式', '行为边界']) {
    const next = filledPersona()
    next.mutableLayer.sections = next.mutableLayer.sections.filter((section) => section.title !== title)

    const asUser = validatePersona(next, prev, 'user')
    assert.equal(asUser.ok, false, `用户删「${title}」也必须被拒（工作台不是绕过校验的后门）`)
    assert.deepEqual(codesOf(asUser), ['mutable.section-locked-missing'])
    assert.equal(asUser.issues[0].path, `mutableLayer.sections.${title}`)

    assert.equal(validatePersona(next, prev, 'agent').ok, false, `Agent 删「${title}」同样被拒`)
  }

  // 非锁定小节不受这条规则影响（否则"其余项均可删"就是假的）。
  const deletable = filledPersona()
  deletable.mutableLayer.sections = deletable.mutableLayer.sections.filter((section) => section.title !== '经验教训')
  assert.deepEqual(codesOf(validatePersona(deletable, prev, 'user')), [])
})

test('锁定的是"整项删除"，不是编辑：清空条目、改写内容都照常放行', () => {
  const prev = filledPersona()
  const next = filledPersona()
  // 节还在、条目清空：这是"这一节现在没内容"，不是删项。锁定规则**不**在这里出声
  // （用户侧放行；Agent 侧另有 section-cleared 拦"删内容"，那是另一条规则）。
  next.mutableLayer.sections[1].items = []
  assert.equal(validatePersona(next, prev, 'user').ok, true, '用户清空一节：放行')
  assert.deepEqual(
    codesOf(validatePersona(next, prev, 'agent')).filter((code) => code.startsWith('mutable.section-locked')),
    [],
    '锁定规则只管"整项删除"，不管"清空"',
  )

  const rewritten = filledPersona()
  rewritten.mutableLayer.sections[1].items = ['先给结论，再给理由']
  assert.equal(validatePersona(rewritten, prev, 'user').ok, true, '改写内容照常放行')
})

test('用户删掉非锁定小节：放行，且生效口径里它**确实不存在**（不是留个空壳）', () => {
  const prev = filledPersona()
  // 0.1.14：「经验教训」已不是原生项 —— 夹具显式当自定义项加进来。
  withSection(prev, '经验教训', ['别在深夜做决定'])

  const next = filledPersona()
  next.mutableLayer.sections = next.mutableLayer.sections.filter((section) => section.title !== '经验教训')

  const asUser = validatePersona(next, prev, 'user')
  assert.equal(asUser.ok, true, '用户的权威编辑：删自己写的东西不该被拦')
  assert.deepEqual(codesOf(asUser), [])
  assert.equal(
    effectivePersona(next).mutableLayer.sections.some((section) => section.title === '经验教训'),
    false,
    '落盘口径里这一节确实不存在了',
  )
})

test('Agent 改变对用户称呼主值**不再**被判高风险（2026-09-23 真机反馈后的裁定）', () => {
  // 旧行为：rejected + 「请让用户在工作台确认」—— 而那个确认入口当时并不存在，形成死结。
  // 新行为：一个人可以有多个称呼，改称呼就是普通写入（进历史、可被下一次整理取代）。
  const prev = filledPersona()
  const next = filledPersona()
  next.mutableLayer.sections[0].items = ['陛下']

  const validation = validatePersona(next, prev, 'agent')

  assert.equal(validation.ok, true)
  assert.deepEqual(codesOf(validation), [])
})

test('用户改称呼同样允许（两侧一致，不再有"只有用户能改"的特例）', () => {
  const prev = filledPersona()
  const next = filledPersona()
  next.mutableLayer.sections[0].items = ['陛下']

  assert.equal(validatePersona(next, prev, 'user').ok, true)
})

test('重复小标题被拒绝；自定义小标题**不再有任何提示**（0.1.14：没有"标准/非标准"这一说）', () => {
  const prev = filledPersona()
  const next = filledPersona()
  next.mutableLayer.sections.push({ title: '说话风格', items: ['重复的'] })
  next.mutableLayer.sections.push({ title: '我的自定义标题', items: ['内容'] })

  const validation = validatePersona(next, prev, 'user')

  assert.equal(validation.ok, false)
  // 只剩"重复标题"这一条：`mutable.section-non-standard` 随用户 2026-10-09 的产品决定
  // （"除了原生的 8 个外，其余都一样待遇，**没有标准这一说**"）删除，已无产出点。
  assert.deepEqual(codesOf(validation).sort(), ['mutable.section-duplicate'])
  assert.equal(
    validation.issues.some((issue) => issue.code === 'mutable.section-non-standard'),
    false,
    '不得再产出"非标准"提示',
  )
})

test('没有小标题却带条目的小节被拒绝（2026-09-26 审计 P2：它永远进不了提示词）', () => {
  // 旧行为只给它一句「不在标准集合内」的警告，而 `collectPersonaContent` 只收有名字的小节 ——
  // 于是那几条内容**写进去了、界面上也看得见、却永远不会生效**，用户与 Agent 都看不出来。
  const prev = filledPersona()
  const next = filledPersona()
  next.mutableLayer.sections.push({ title: '', items: ['这条永远不会生效'] })

  const validation = validatePersona(next, prev, 'user')

  assert.equal(validation.ok, false, '不许静默收下')
  assert.deepEqual(codesOf(validation), ['mutable.section-title-empty'])
  assert.equal(validation.issues[0].severity, 'rejected')
  assert.match(validation.issues[0].message, /没有小标题/)
})

test('空壳小节（无名 + 无条目）不作声：没有内容可丢，规范化时直接丢掉', () => {
  const prev = filledPersona()
  const next = filledPersona()
  next.mutableLayer.sections.push({ title: '', items: [] })

  const validation = validatePersona(next, prev, 'user')

  assert.equal(validation.ok, true)
  assert.deepEqual(codesOf(validation), [])
  assert.equal(
    effectivePersona(next).mutableLayer.sections.some((section) => section.title === ''),
    false,
    '没有名字又没有内容的节点留不到生效文档里',
  )
})

test('首次初始化没有 prev 时不触发封存判定（Agent 要能写第一次）', () => {
  const next = filledPersona()

  const validation = validatePersona(next, undefined, 'agent')

  assert.equal(validation.ok, true)
  assert.deepEqual(validation.issues, [])
})

test('prev 是"没人写过的默认文档"时，Agent 也能写第一次（`section.write()` 的 prev 永远有值）', () => {
  // 这条钉的是一个真实缺陷：`PersonaSection.write()` 里的 prev 是**当前生效文档**，
  // 未初始化时那份中性默认文档也算一份。只看 `prev !== undefined`，聊天初始化就永远走不通。
  // 这里的样子与聊天初始化一致：只写身份卡，可变层原样不动。
  const next = createDefaultPersona()
  next.identityCard.fields[0].value = '小安'
  next.identityCard.fields[1].value = '女'
  next.identityCard.fields[2].value = '温和、直接'
  next.identityCard.initializedAt = '2026-09-23T00:00:00.000Z'
  next.identityCard.sealedAt = '2026-09-23T00:00:00.000Z'

  const validation = validatePersona(next, createDefaultPersona(), 'agent')

  assert.equal(validation.ok, true)
  assert.deepEqual(validation.issues, [])
})

test('没打初始化标记但已有人填过内容：Agent 不得覆盖（内容也是封存判据的一半）', () => {
  const touched = createDefaultPersona()
  touched.identityCard.fields[0].value = '用户手填的名字'

  const validation = validatePersona(filledPersona(), touched, 'agent')

  assert.equal(validation.ok, false)
  assert.ok(codesOf(validation).includes('identity.sealed'))
})

test('打了初始化标记就等于已封存：Agent 不能改（P-002 的标记优先于内容）', () => {
  const initialized = createDefaultPersona()
  initialized.identityCard.initializedAt = '2026-09-22T00:00:00.000Z'

  const validation = validatePersona(filledPersona(), initialized, 'agent')

  assert.equal(validation.ok, false)
  assert.ok(codesOf(validation).includes('identity.sealed'))
})

test('ok 为假当且仅当存在 rejected 级问题', () => {
  const next = filledPersona()
  next.identityCard.fields[2].value = '很'.repeat(VALUE_SOFT_LIMIT + 1)

  const warningsOnly = validatePersona(next, filledPersona(), 'user')
  assert.equal(warningsOnly.issues.every((issue) => issue.severity === 'warning'), true)
  assert.equal(warningsOnly.ok, true)

  const withRejection = validatePersona(next, filledPersona(), 'agent')
  assert.equal(withRejection.ok, false)
})

/* ---------------------------------------------------------------------------
 * 2026-09-23 真机反馈的四个数据校验/语义缺陷（逐条钉住）
 * ① userDefined 同名键被静默丢弃 → 必须拒绝
 * ② 固定层字段名混进可变层 → 必须拒绝（不是警告）
 * ④ 控制字符原样落盘 → 写之前剥掉
 * ⑤ "漏传一节" 与 "传空数组" 语义混淆 → 漏传=不动，只有显式 [] 才走删内容确认
 * Bug B（同日追加）：非标准节 + items: [] 曾经变成删不掉的僵尸空壳 → 现在等于删除该节
 * ------------------------------------------------------------------------- */

test('Bug B/R1 规范化**不删**空壳节（删除留给 effectivePersona 在校验之后做）', () => {
  const persona = createDefaultPersona()
  persona.mutableLayer.sections.push({ title: '小明专属节', items: [] })
  persona.mutableLayer.sections.push({ title: '健康情况', items: ['对花生过敏'] })
  persona.mutableLayer.sections[2].items = [] // 交付格式：标准节清空

  const normalized = normalizePersona(persona)
  const titles = normalized.mutableLayer.sections.map((section) => section.title)

  // 校验必须看到"调用方传了什么"：空壳节还在 ⇒ 才能区分"显式清空"与"漏传"（否则就是 R1）。
  assert.deepEqual(titles, [...STANDARD_SECTION_TITLES, '小明专属节', '健康情况'])

  const kept = effectivePersona(normalized).mutableLayer.sections.map((section) => section.title)
  assert.equal(kept.includes('小明专属节'), false, '删除这一步：自定义节 + 空 items = 删掉')
  assert.equal(kept.includes('健康情况'), true, '有内容的非标准节照旧保留')
  assert.equal(kept.includes('交付格式'), true, '标准节即使清空也必须保留（schema/展示顺序的一部分）')
})

test('Bug B/R1 显式清空自定义节 = section-cleared（可确认的删除），**不是** section-dropped', () => {
  // R1/R4 的原文：报错说「要清空请传 items: []」，真传了 items: [] 又被判成"整节不见了"。
  const prev = createDefaultPersona()
  prev.identityCard.fields[0].value = '小安'
  prev.identityCard.fields[1].value = '女'
  prev.identityCard.fields[2].value = '温和'
  prev.mutableLayer.sections.push({ title: '回归测试节', items: ['回归测试内容'] })

  const intent = normalizePersona({
    ...prev,
    mutableLayer: {
      ...prev.mutableLayer,
      sections: prev.mutableLayer.sections.map((section) =>
        section.title === '回归测试节' ? { title: section.title, items: [] } : section,
      ),
    },
  })

  const validation = validatePersona(intent, prev, 'agent')
  assert.equal(validation.ok, false)
  assert.deepEqual(
    validation.issues.filter((issue) => issue.severity === 'rejected').map((issue) => issue.code),
    ['mutable.section-cleared'],
    '显式清空不是"整节不见了"（非标准小标题那条 warning 仍会出现，属正常提示）',
  )
  const cleared = validation.issues.find((issue) => issue.code === 'mutable.section-cleared')
  assert.match(cleared.message, /清空即删除该节/, '自定义节要说明"清空 = 删除"')
  assert.ok(CONFIRMABLE_ISSUES.includes('mutable.section-cleared'), '确认之后就能真的删掉')
  assert.equal(cleared.path, 'mutableLayer.sections.回归测试节', 'R3：按名字定位')

  // 确认放行 → 落盘时 effectivePersona 才真正把它删掉。
  const confirmed = validatePersona(intent, prev, 'agent', { confirmed: ['mutable.section-cleared'] })
  assert.equal(confirmed.ok, true)
  const finalTitles = effectivePersona(intent).mutableLayer.sections.map((section) => section.title)
  assert.equal(finalTitles.includes('回归测试节'), false, 'R2：这条路径必须真的能删掉它')

  // 用户在工作台里清空 = 用户自己的决定，不该被拦。
  assert.equal(validatePersona(intent, prev, 'user').ok, true)
})

test('R3 小标题级问题的 path 一律用名字（不再有的用下标、有的用名字）', () => {
  const prev = createDefaultPersona()
  prev.identityCard.fields[0].value = '小安'
  prev.identityCard.fields[1].value = '女'
  prev.identityCard.fields[2].value = '温和'
  prev.mutableLayer.sections.push({ title: '回归测试节', items: ['回归测试内容'] })

  // 漏传（整节消失）
  const omitted = validatePersona(
    {
      ...prev,
      mutableLayer: {
        ...prev.mutableLayer,
        sections: prev.mutableLayer.sections.filter((section) => section.title !== '回归测试节'),
      },
    },
    prev,
    'agent',
  )
  assert.deepEqual(codesOf(omitted), ['mutable.section-dropped'])
  assert.equal(omitted.issues[0].path, 'mutableLayer.sections.回归测试节')

  // 超长条目（0.1.14：这里原本还断言一条"非标准警告"，该提示已随产品决定删除）
  const warned = validatePersona(
    {
      ...prev,
      mutableLayer: {
        ...prev.mutableLayer,
        sections: prev.mutableLayer.sections.map((section) =>
          section.title === '回归测试节' ? { title: section.title, items: ['很长'.repeat(80)] } : section,
        ),
      },
    },
    createDefaultPersona(),
    'agent',
  )
  const paths = warned.issues.map((issue) => issue.path)
  // 0.1.14：这里原本还有一条 `mutableLayer.sections.回归测试节`（"非标准"警告的 path）——
  // 那条提示已随产品决定删除，于是只剩超长条目这一条，且它照旧用**名字**定位。
  assert.deepEqual(paths.sort(), ['mutableLayer.sections.回归测试节.items[0]'])
})

// ① —— 缺陷原文：「传两个同名键，第二个无声消失，界面还显示保存成功」。
test('①「用户定义」同名键必须被拒绝（不再静默丢第二个）', () => {
  const next = filledPersona()
  next.mutableLayer.userDefined = [
    { key: '口味', value: '清淡' },
    { key: '口味', value: '嗜辣' },
  ]

  const validation = validatePersona(next, filledPersona(), 'user')

  assert.equal(validation.ok, false, '同名键是自相矛盾的输入，不能落盘')
  assert.deepEqual(codesOf(validation), ['mutable.user-defined-duplicate'])
  assert.equal(validation.issues[0].severity, 'rejected')
  assert.equal(validation.issues[0].path, 'mutableLayer.userDefined[1].key')
  assert.match(validation.issues[0].message, /口味/)
})

test('① 规范化不再对「用户定义」按键去重 —— 数据必须原样交到校验层', () => {
  const next = createDefaultPersona()
  next.mutableLayer.userDefined = [
    { key: '口味', value: '清淡' },
    { key: '口味', value: '嗜辣' },
  ]

  const normalized = normalizePersona(next)

  assert.equal(normalized.mutableLayer.userDefined.length, 2, '静默去重就是静默丢数据')
})

test('① 身份卡字段同样不再被静默去重：重复字段名报 identity.key-duplicate', () => {
  const next = filledPersona()
  next.identityCard.fields.push({ key: '姓名', value: '另一个名字', custom: true })

  const normalized = normalizePersona(next)
  assert.equal(normalized.identityCard.fields.length, CORE_IDENTITY_KEYS.length + 1, '规范化不能吞掉重复字段')

  const validation = validatePersona(normalized, filledPersona(), 'user')
  assert.equal(validation.ok, false)
  assert.ok(codesOf(validation).includes('identity.key-duplicate'))
})

// ② —— 固定层是"只有用户能改、对 Agent 封存"的那一层；冒牌同名条目会绕过封存。
test('② 固定层字段名作为可变层小标题必须被拒绝（不是警告）', () => {
  const next = filledPersona()
  next.mutableLayer.sections.push({ title: CORE_IDENTITY_KEYS[0], items: ['冒牌姓名'] })

  const validation = validatePersona(next, filledPersona(), 'user')

  assert.equal(validation.ok, false)
  assert.ok(codesOf(validation).includes('mutable.core-key-shadowed'))
  assert.equal(
    validation.issues.find((issue) => issue.code === 'mutable.core-key-shadowed').severity,
    'rejected',
  )
})

test('② 固定层字段名作为「用户定义」的键同样被拒绝', () => {
  const next = filledPersona()
  next.mutableLayer.userDefined = [{ key: CORE_IDENTITY_KEYS[2], value: '天真烂漫' }]

  const validation = validatePersona(next, filledPersona(), 'user')

  assert.equal(validation.ok, false)
  assert.deepEqual(codesOf(validation), ['mutable.core-key-shadowed'])
  assert.equal(validation.issues[0].path, 'mutableLayer.userDefined[0].key')
})

test('② 判定与写入来源无关：Agent 写也拒绝（脏数据不该因来源而放行）', () => {
  const next = filledPersona()
  next.mutableLayer.userDefined = [{ key: CORE_IDENTITY_KEYS[1], value: '女' }]

  const validation = validatePersona(next, filledPersona(), 'agent')

  assert.equal(validation.ok, false)
  assert.ok(codesOf(validation).includes('mutable.core-key-shadowed'))
})

// ④ —— NUL / ANSI ESC 是粘贴或序列化带进来的噪音，落盘前必须剥掉。
test('④ 控制字符在规范化阶段被剥掉，换行/制表保留', () => {
  const next = createDefaultPersona()
  next.identityCard.fields[0].value = '小\u0000安\u001b[31m'
  next.mutableLayer.sections[0].items = ['主\u0007人\n第二行\t结束']
  next.mutableLayer.userDefined = [{ key: '口\u0000味', value: '清\u001b淡' }]

  const normalized = normalizePersona(next)

  assert.equal(normalized.identityCard.fields[0].value, '小安')
  assert.equal(normalized.mutableLayer.sections[0].items[0], '主人\n第二行\t结束')
  assert.equal(normalized.mutableLayer.userDefined[0].key, '口味')
  assert.equal(normalized.mutableLayer.userDefined[0].value, '清淡')
})

test('④ stripControlChars 删 C0 其余与 DEL，保留 \\n \\r \\t，并整体删掉 ANSI 转义序列', () => {
  assert.equal(stripControlChars('a\u0000b\u001bc\u007fd'), 'abcd')
  assert.equal(stripControlChars('a\nb\rc\td'), 'a\nb\rc\td')
  // 只删 ESC 会留下 `[31m` 残渣，所以整条 CSI 一起删。
  assert.equal(stripControlChars('\u001b[31m红色\u001b[0m'), '红色')
  assert.equal(stripControlChars('\u001b]0;标题\u0007正文'), '正文')
  // 未闭合的 OSC（没有 BEL/ST 收尾）：至少不能把 ESC 留在数据里。
  assert.equal(stripControlChars('\u001b]0;没闭合'), '0;没闭合')
  // 非控制字符的空白（含全角空格 U+3000、不换行空格 U+00A0）不归它管，保持原样。
  assert.equal(stripControlChars('好\u00a0的'), '好\u00a0的')
})

test('④ 校验看到的就是落盘的内容：净化先于校验', () => {
  // 若先校验后净化，这里会看到"净化后还有控制字符"或者"校验的是另一份字符串"。
  const next = createDefaultPersona()
  next.identityCard.fields[0].value = '阿\u0000清'
  next.identityCard.fields[1].value = '女'
  next.identityCard.fields[2].value = '温和'
  next.identityCard.initializedAt = '2026-09-23T00:00:00.000Z'

  const normalized = normalizePersona(next)
  const validation = validatePersona(normalized, createDefaultPersona(), 'agent')

  assert.equal(validation.ok, true)
  assert.equal(/\u0000/.test(JSON.stringify(normalized)), false)
})

// ⑤ —— 「漏传」= 不动这一节；「显式传 []」= 删内容，必须在对话里确认。
test('⑤ 显式清空有内容的一节报 mutable.section-cleared（可确认项）', () => {
  const prev = filledPersona()
  const next = filledPersona()
  next.mutableLayer.sections[1].items = []

  const validation = validatePersona(next, prev, 'agent')

  assert.equal(validation.ok, false)
  assert.deepEqual(codesOf(validation), ['mutable.section-cleared'])
  assert.match(validation.issues[0].message, /确认/)
  assert.ok(CONFIRMABLE_ISSUES.includes('mutable.section-cleared'))
})

test('⑤ section-cleared 在用户确认后降级为 warning 放行；未列入白名单的拒绝项不受影响', () => {
  const prev = filledPersona()
  const next = filledPersona()
  next.mutableLayer.sections[1].items = []

  const confirmed = validatePersona(next, prev, 'agent', { confirmed: ['mutable.section-cleared'] })

  assert.equal(confirmed.ok, true)
  assert.deepEqual(codesOf(confirmed), ['mutable.section-cleared'], '仍要如实汇报"按确认删除了"')
  assert.equal(confirmed.issues[0].severity, 'warning')

  // 白名单是**写死的**：伪造一个已确认的核心字段缺失，依然拒绝。
  const missingCore = filledPersona()
  missingCore.identityCard.fields = missingCore.identityCard.fields.filter((field) => field.key !== '性别')
  const stillRejected = validatePersona(missingCore, prev, 'agent', {
    confirmed: ['identity.core-missing'],
  })
  assert.equal(stillRejected.ok, false)
})

test('⑤ 用户自己清空一节不算"删用户内容"：只对 agent 生效', () => {
  const prev = filledPersona()
  const next = filledPersona()
  next.mutableLayer.sections[1].items = []

  const validation = validatePersona(next, prev, 'user')

  assert.equal(validation.ok, true)
  assert.deepEqual(codesOf(validation), [])
})

test('⑤ 空节被清空不报 section-cleared（没有内容可删）', () => {
  const prev = filledPersona()
  const next = filledPersona()
  next.mutableLayer.sections[2].items = []

  const validation = validatePersona(next, prev, 'agent')

  assert.equal(validation.ok, true)
  assert.deepEqual(codesOf(validation), [])
})

/* ---------------------------------------------------------------------------
 * 2026-09-23 数据模型调整：①「当前状态」→「情绪」；② 固定层加「主语言」
 * ------------------------------------------------------------------------- */

test('迁移：「当前状态」节自动改名为「情绪」，内容一字不丢，且可反复执行', () => {
  // 0.1.14：默认文档只有 4 个原生小节，「情绪」不再是其中之一 ⇒ 旧数据长这样：
  // 文档里直接有**一节叫「当前状态」**（对现在来说就是个自定义标题）。夹具照这个形状造。
  const legacy = createDefaultPersona()
  withSection(legacy, '当前状态', ['今天有点累', '刚开完会'])

  const migrated = normalizePersona(legacy)
  const titles = migrated.mutableLayer.sections.map((section) => section.title)

  assert.equal(titles.includes('当前状态'), false, '旧标题必须消失')
  assert.deepEqual(
    migrated.mutableLayer.sections.find((section) => section.title === '情绪').items,
    ['今天有点累', '刚开完会'],
    '内容原样保留',
  )
  // 幂等：再跑一次结果不变（每次读取都会经过规范化，所以这条是硬要求）。
  assert.deepEqual(normalizePersona(migrated), migrated)
})

test('迁移：新旧标题同时存在时**合并**，不产生重复标题（否则用户每次保存都会被拒）', () => {
  const both = createDefaultPersona()
  withSection(both, '情绪', ['今天很开心'])
  withSection(both, '当前状态', ['刚开完会', '今天很开心'])

  const migrated = normalizePersona(both)
  const titles = migrated.mutableLayer.sections.map((section) => section.title)

  assert.equal(titles.filter((title) => title === '情绪').length, 1, '合并成一个「情绪」节')
  assert.equal(titles.includes('当前状态'), false)
  assert.deepEqual(
    migrated.mutableLayer.sections.find((section) => section.title === '情绪').items,
    ['今天很开心', '刚开完会'],
    '两边的条目都保留，重复条目只留一条',
  )
  // 合并后的文档必须是合法的（否则用户什么都没做错却被拒）。
  assert.equal(validatePersona(migrated, both, 'user').ok, true)
})

test('主语言是核心字段：删掉它会被拒绝（与姓名/性别/人格偏好同级）', () => {
  const next = filledPersona()
  next.identityCard.fields = next.identityCard.fields.filter((field) => field.key !== '主语言')

  const validation = validatePersona(next, filledPersona(), 'user')

  assert.equal(validation.ok, false)
  assert.ok(codesOf(validation).includes('identity.core-missing'))
  assert.match(validation.issues.find((issue) => issue.code === 'identity.core-missing').message, /主语言/)
})

test('主语言：默认文档里就有这个字段（schema 默认值跟着 CORE_IDENTITY_KEYS 生成）', () => {
  const persona = createDefaultPersona()
  assert.deepEqual(
    persona.identityCard.fields.map((field) => field.key),
    [...CORE_IDENTITY_KEYS],
  )
  assert.equal(persona.identityCard.fields.at(-1).key, '主语言', '顺序排在人格偏好之后')
  assert.equal(persona.identityCard.fields.at(-1).custom, false, '它是核心字段，不是自定义字段')
})

test('反向查重：固定层新增字段与可变层小标题撞名被拒；存量同名字段祖父化放行（round 48）', () => {
  const persona = createDefaultPersona()
  persona.identityCard.fields.push({ key: '对用户称呼', value: '公主', custom: true })

  const validation = validatePersona(normalizePersona(persona), createDefaultPersona(), 'user')
  assert.equal(validation.ok, false, '撞名必须在源头被拒，而不是留给每次可变层写入去报')
  assert.ok(codesOf(validation).includes('identity.shadows-mutable'))

  // 祖父化：prev 里已存在同名字段 ⇒ 不拦后续保存（否则旧撞名文档会卡死一切修改）。
  const stored = normalizePersona(persona)
  const again = validatePersona(stored, stored, 'user')
  assert.equal(codesOf(again).includes('identity.shadows-mutable'), false, '存量同名字段不得阻塞后续保存')
})
