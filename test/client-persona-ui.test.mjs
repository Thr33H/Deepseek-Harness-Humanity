/**
 * 人格页 **0.1.13 交互改造**的证据测试（项级锁定 / 整项删除 / 去输入框 / 底部添加）。
 *
 * 判据来源：`docs/plans/humanity-0.1.13-persona-ui-lock-delete.md` §4 的 V3–V7。
 * 三条纪律（写这份文件的理由）：
 * 1. **V4 必须用注入/投影读数证明"真删"** —— 只看界面不算：这里既看发给宿主的整份快照，
 *    也走宿主真实的 `writePersona`，再把落盘结果喂给 `renderPersonaPrompt` 读注入内容；
 * 2. **V3 要正反两面** —— 界面上没有入口（正面）+ 绕过界面直接请求删除被拒（反面，
 *    客户端没有该动作 **且** 宿主校验拒绝）；
 * 3. **V5 要阴性对照** —— 默认态没有输入框，进编辑态**必须**出现，否则"没有输入框"可能只是
 *    组件根本没渲染。
 *
 * 被测对象是构建产物 `lib/client.js`（DSH 真正加载的东西）与 `lib/` 下的宿主代码，
 * 不用源码副本：「改了源码没重建」会在这里当场暴露。
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

import { LOCKED_SECTION_TITLES } from '../lib/persona/constants.js'
import { PersonaWriteRejected, writePersona } from '../lib/persona/document.js'
import { createDefaultPersona } from '../lib/persona/model.js'
import { effectivePersona, normalizePersona } from '../lib/persona/normalize.js'
import { renderPersonaPrompt } from '../lib/persona/render.js'
import { collectPersonaContent } from '../lib/persona/render-content.js'
import { validatePersona } from '../lib/persona/validate.js'
import { loadClientBundle } from './helpers/client-bundle.mjs'
import { createFakeChannel, emptyPersona, withSection } from './helpers/persona-fake.mjs'

const nodeRequire = createRequire(import.meta.url)

/** 等控制器把异步读写跑完（状态机每步只做一次 await，几轮宏任务足够）。 */
async function settle(controller) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const status = controller.getSnapshot().status
    if (status === 'ready' || status === 'failed' || status === 'unavailable') return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('控制器没有在预期时间内进入稳定状态')
}

/** 起一个接好假通道、已读完一次的控制器。 */
async function boot(document = emptyPersona()) {
  const client = await loadClientBundle()
  const fake = createFakeChannel(document)
  const controller = new client.PersonaWorkbenchController()
  controller.attach(fake.channel)
  await settle(controller)
  return { client, controller, ...fake }
}

/**
 * 一份"用户已经填过、已封存"的文档，外加两处**可删**的东西：
 * 「经验教训」小节（非锁定标准小节）、自定义小节、自定义字段、「用户定义」一条。
 */
function seededPersona() {
  const document = emptyPersona()
  document.identityCard.fields[0].value = '小安'
  document.identityCard.fields[1].value = '女'
  document.identityCard.fields.push({ key: '归属地', value: '示例城市', custom: true })
  document.identityCard.initializedAt = '2026-09-23T00:00:00.000Z'
  document.identityCard.sealedAt = '2026-09-23T00:00:00.000Z'
  document.mutableLayer.sections[0].items = ['主人']
  document.mutableLayer.sections[1].items = ['先给结论，再给依据']
  // 0.1.14：「经验教训」不再是原生项 —— 夹具显式当自定义项加进来（与工作台"添加小节"同语义）。
  withSection(document, '经验教训', ['别在深夜做决定'])
  document.mutableLayer.sections.push({ title: '决定权', items: ['技术判断我说了算'] })
  document.mutableLayer.userDefined.push({ key: '咖啡', value: '不加糖' })
  return document
}

/** 一份把「经验教训」整节删掉的文档（不是清空：这一节从数组里消失）。 */
function withoutSection(document, title) {
  const next = JSON.parse(JSON.stringify(document))
  next.mutableLayer.sections = next.mutableLayer.sections.filter((section) => section.title !== title)
  return next
}

/**
 * 宿主侧的最小设置命名空间替身：`writePersona` 只用到 `get` / `replace`。
 * @param document - 初始生效文档。
 * @returns 句柄、落盘状态与历史条目收集器。
 */
function hostHarness(document) {
  const store = { value: JSON.parse(JSON.stringify(document)) }
  const history = []
  const state = {
    attached: true,
    fallback: JSON.parse(JSON.stringify(document)),
    settings: {
      get: () => store.value,
      replace: async (_ns, value) => {
        store.value = value
      },
    },
  }
  return { state, store, history, sink: () => (entry) => history.push(entry) }
}

/* ---------------------------------------------------------------------------
 * V4：其余项可删，而且是**真删**（文档里没有、注入里也没有，且进历史）
 * ------------------------------------------------------------------------- */

test('V4 删掉「经验教训」整节：文档里没有、注入里也没有（注入/投影读数，不是只看界面）', async () => {
  const document = seededPersona()
  const { controller, calls } = await boot(document)

  // 阳性对照：删之前，这一节**确实**在注入内容里（否则后面的"没有"说明不了任何事）。
  const beforePrompt = renderPersonaPrompt(controller.getSnapshot().stored, { enabled: true })
  assert.match(beforePrompt, /别在深夜做决定/, '删之前它应当进提示词')
  assert.deepEqual(
    collectPersonaContent(controller.getSnapshot().stored).sections.map((section) => section.title),
    ['对用户称呼', '说话风格', '经验教训', '决定权'],
  )

  // 走界面那条路：请求删除 → 二次确认 → 落进草稿 → 保存。
  assert.equal(controller.getSnapshot().pendingDelete, undefined, '起点：没有待确认的删除')
  controller.requestDelete('section:经验教训')
  assert.equal(controller.getSnapshot().pendingDelete, 'section:经验教训', '删除先进入二次确认态')
  assert.equal(
    controller.getSnapshot().draft.mutableLayer.sections.some((section) => section.title === '经验教训'),
    true,
    '还没确认时一个字都不许删',
  )
  controller.confirmDelete()
  await controller.save()

  // ① 发给宿主的那份快照里，这一节不存在（不是清空成空壳）。
  assert.equal(calls.replace.length, 1)
  const sent = calls.replace[0].section
  assert.equal(
    sent.mutableLayer.sections.some((section) => section.title === '经验教训'),
    false,
    '发给宿主的整份快照里没有这一节',
  )
  assert.equal(sent.mutableLayer.sections.some((section) => section.title === '决定权'), true, '别的自定义小节不受影响')

  // ② 注入读数：以**保存后宿主返回的那份**（= stored）算注入内容。
  const stored = controller.getSnapshot().stored
  assert.equal(
    stored.mutableLayer.sections.some((section) => section.title === '经验教训'),
    false,
    '宿主返回的文档里也没有它',
  )
  const prompt = renderPersonaPrompt(stored, { enabled: true })
  assert.equal(prompt.includes('别在深夜做决定'), false, '注入内容里没有它的条目（真删，不是假删）')
  assert.equal(prompt.includes('经验教训'), false, '连小节名都不该出现在注入内容里')
  assert.deepEqual(
    collectPersonaContent(stored).sections.map((section) => section.title),
    ['对用户称呼', '说话风格', '决定权'],
    '投影读数：剩下的小节里没有它',
  )
  // 阴性对照的另一半：正文其余内容照旧在（不是"整个注入都没了"）。
  assert.match(prompt, /先给结论，再给依据/)
})

test('V4 宿主侧：走真实 writePersona 落盘 → 删除生效，且被删内容进 persona_history', async () => {
  const document = seededPersona()
  const { state, store, history, sink } = hostHarness(document)
  const next = withoutSection(document, '经验教训')

  await writePersona(state, sink, next, 'user')

  // ① 落盘：宿主里那份文档确实没有这一节。
  assert.equal(
    store.value.mutableLayer.sections.some((section) => section.title === '经验教训'),
    false,
    '落盘后的文档里没有它',
  )
  // ② 注入读数：拿落盘结果直接渲染提示词。
  const prompt = renderPersonaPrompt(store.value, { enabled: true })
  assert.equal(prompt.includes('别在深夜做决定'), false, '注入内容里没有它')
  // ③ 可回溯：被删掉的条目进了历史（宿主既有行为，`persistPersona` → `supersededBy`）。
  assert.equal(history.length, 1, '删除留下的是一条"被取代"的历史记录')
  assert.equal(history[0].path, 'mutableLayer.sections.经验教训')
  assert.equal(history[0].previous, '别在深夜做决定')
  assert.equal(history[0].source, 'user')
})

test('V4 可删的不止原生小节：自定义小节、自定义字段都能整项删掉（「用户定义」条目已下线、但数据保留）', async () => {
  const { controller, calls } = await boot(seededPersona())

  controller.requestDelete('section:决定权')
  controller.confirmDelete()
  controller.requestDelete('identity:4') // 归属地（自定义字段）
  controller.confirmDelete()
  await controller.save()

  const sent = calls.replace[0].section
  assert.equal(sent.mutableLayer.sections.some((section) => section.title === '决定权'), false)
  assert.equal(sent.identityCard.fields.some((field) => field.key === '归属地'), false)
  // ⚠️ 0.1.14：「用户定义」退出界面（用户："用户自定义可以删了"）—— 它**没有**被删掉，
  // 而是随整份快照原样写回（V7：下线不等于毁数据）。
  assert.deepEqual(sent.mutableLayer.userDefined, [{ key: '咖啡', value: '不加糖' }], '数据一个字节都没动')
  assert.deepEqual(
    sent.identityCard.fields.map((field) => field.key),
    ['姓名', '性别', '人格偏好', '主语言'],
    '核心 4 项一个都不少',
  )
})

/* ---------------------------------------------------------------------------
 * V3：默认 8 项锁死 —— 正面（界面没有入口）+ 反面（绕过界面直接请求删除被拒）
 * ------------------------------------------------------------------------- */

test('V3 反面①：客户端没有"删除锁定项"这个动作 —— 连二次确认都进不去，草稿一个字不动', async () => {
  const { controller } = await boot(seededPersona())

  // 4 个核心身份字段 + 4 个锁定小节：逐个试。
  for (const itemId of ['identity:0', 'identity:1', 'identity:2', 'identity:3', ...LOCKED_SECTION_TITLES.map((title) => `section:${title}`)]) {
    controller.requestDelete(itemId)
    assert.equal(controller.getSnapshot().pendingDelete, undefined, `${itemId} 不该进入删除确认态`)
    controller.confirmDelete() // 即使强行确认
  }

  const draft = controller.getSnapshot().draft
  // 0.1.14：默认只有 4 个**原生**小节；「经验教训」「决定权」是夹具当**自定义项**加进去的，
  // 因此排在原生 4 个之后（顺序按文档里的先后）。
  assert.deepEqual(draft.mutableLayer.sections.map((section) => section.title), [
    '对用户称呼',
    '说话风格',
    '交付格式',
    '行为边界',
    '经验教训',
    '决定权',
  ])
  assert.deepEqual(draft.identityCard.fields.map((field) => field.key), ['姓名', '性别', '人格偏好', '主语言', '归属地'])
})

test('V3 反面②：绕过界面直接请求删除 —— 宿主校验拒绝（工作台不是后门）', async () => {
  const prev = seededPersona()
  const next = withoutSection(prev, '对用户称呼')

  // 浏览器直写就是走这条判定（`section.ts` 的 `validate` 钩子逐字是
  // `validatePersona(normalizePersona(value), effectivePersona(readCurrent(state)), 'user')`）。
  const asHook = validatePersona(normalizePersona(next), effectivePersona(prev), 'user')
  assert.equal(asHook.ok, false, '宿主校验必须拒绝缺锁定小节的文档')
  const locked = asHook.issues.find((issue) => issue.code === 'mutable.section-locked-missing')
  assert.ok(locked !== undefined, `必须有锁定项缺失这条拒绝（实际：${asHook.issues.map((issue) => issue.code).join(',')}）`)
  assert.equal(locked.severity, 'rejected')
  assert.equal(locked.path, 'mutableLayer.sections.对用户称呼')

  // 走宿主真实写入路径：抛 PersonaWriteRejected，且落盘那份文档一个字没改。
  const { state, store, sink } = hostHarness(prev)
  await assert.rejects(() => writePersona(state, sink, next, 'user'), PersonaWriteRejected)
  assert.equal(store.value.mutableLayer.sections.some((section) => section.title === '对用户称呼'), true, '拒绝后宿主那份没被改')

  // 反面②的另一半：Agent 侧同样拒（锁定与来源无关）。
  assert.equal(validatePersona(normalizePersona(next), effectivePersona(prev), 'agent').ok, false)
})

test('V3 反面③：直接删核心身份字段（姓名）也被拒 —— 旧约束一条没松', async () => {
  const prev = seededPersona()
  const next = JSON.parse(JSON.stringify(prev))
  next.identityCard.fields = next.identityCard.fields.filter((field) => field.key !== '姓名')

  // `ensureCoreFields` 会把核心字段补回来（旧数据兼容），所以这里判的是"补回来之后仍然齐全"：
  // 真正的防线是 `checkCoreFields` 对**绕过规范化**的调用方，见下面那条。
  const normalized = normalizePersona(next)
  assert.equal(normalized.identityCard.fields.some((field) => field.key === '姓名'), true, '规范化补齐核心字段')
  assert.equal(validatePersona(normalized, effectivePersona(prev), 'user').ok, true, '补齐后可以保存（修复旧数据）')

  // 绕过规范化直接提交：`checkCoreFields` 拦下（与 0.1.12 行为一致，未放松）。
  const raw = validatePersona({ ...next, mutableLayer: normalizePersona(next).mutableLayer }, effectivePersona(prev), 'user')
  assert.equal(raw.ok, false)
  assert.ok(raw.issues.some((issue) => issue.code === 'identity.core-missing'))
})

/* ---------------------------------------------------------------------------
 * V5：形态 —— 内容永久可编辑、名称不可编辑（返工后的口径）
 * ------------------------------------------------------------------------- */

test('V5 内容永久可编辑：没有"编辑态"这道门 —— 改内容直接落草稿，控制器也不提供 beginEdit', async () => {
  const { controller } = await boot(seededPersona())

  // 返工口径（用户原话）："每项的名称不要输入框了" —— 内容仍然一直是输入框。
  // 因此控制器里**不该**再有"进入/退出编辑态"这类开关（有的话界面就得先点一下才能改）。
  assert.equal(controller.beginEdit, undefined, '不再有 beginEdit（内容不需要先点开）')
  assert.equal(controller.endEdit, undefined, '不再有 endEdit')
  assert.equal(controller.getSnapshot().editing, undefined, '状态里也没有 editing')

  assert.equal(controller.setUserDefined, undefined, '「用户定义」的编辑入口已随区块下线（0.1.14）')
  // 直接改就是落草稿（界面上的输入框绑的就是这些方法）。
  controller.setSectionText('经验教训', '新的教训')
  controller.setIdentityValue(0, '小示例')

  const draft = controller.getSnapshot().draft
  assert.deepEqual(draft.mutableLayer.sections.find((s) => s.title === '经验教训').items, ['新的教训'])
  assert.equal(draft.identityCard.fields[0].value, '小示例')
  assert.equal(draft.mutableLayer.userDefined[0].value, '不加糖', '「用户定义」没人再动它（数据保留）')
})

test('V5 只读部署：输入框渲染出来但是 disabled（改不了也不假装能改）', async () => {
  const { client, controller } = await boot(seededPersona())
  const readOnly = new client.PersonaWorkbenchController()
  readOnly.attach(createFakeChannel(seededPersona(), { writable: false }).channel)
  await settle(readOnly)

  assert.equal(readOnly.getSnapshot().writable, false)
  // 内容区的可编辑性由 `disabled` 表达（`PersonaCards` 传 `disabled = saving || !writable`）：
  // 这里只钉"只读时确实不 writable"，界面那一半由 `client-bundle` 的标记用例覆盖。
  controller.setIdentityValue(0, '小示例')
  assert.equal(readOnly.getSnapshot().draft.identityCard.fields[0].value, '小安', '只读控制器不会跟着别人改')
})

/* ---------------------------------------------------------------------------
 * V6：底部添加（点了才出现输入区 + 保存按钮；取消/空输入有明确行为）
 * ------------------------------------------------------------------------- */

test('V6 空输入是明确的空操作：按钮禁用（界面）与不落草稿（控制器）说的是同一件事', async () => {
  const { controller, calls } = await boot(seededPersona())

  assert.equal(controller.getSnapshot().addForm, undefined, '默认态没有添加表单')
  controller.openAdd('identity')
  assert.deepEqual(controller.getSnapshot().addForm, { kind: 'identity', name: '', value: '' })

  // 什么都不填就点保存 → 草稿不变、表单还在、一个请求都不发。
  controller.setAddField('name', '   ')
  controller.setAddField('value', '   ')
  await controller.commitAdd()
  assert.equal(controller.getSnapshot().draft.identityCard.fields.length, 5, '没有新增字段')
  assert.notEqual(controller.getSnapshot().addForm, undefined, '表单保持打开（用户还没填完）')
  assert.equal(calls.replace.length, 0, '空输入不发写请求')

  // 只填一半同样不算数。
  controller.setAddField('name', '时区')
  await controller.commitAdd()
  assert.equal(controller.getSnapshot().draft.identityCard.fields.length, 5)
  assert.equal(calls.replace.length, 0)

  // 取消：表单收起，草稿一个字不动。
  controller.cancelAdd()
  assert.equal(controller.getSnapshot().addForm, undefined)
  assert.equal(controller.getSnapshot().draft.identityCard.fields.length, 5)
})

test('V6 填齐后保存：新项进列表、写回宿主，并成为新的基线', async () => {
  const { controller, calls } = await boot(seededPersona())

  controller.openAdd('identity')
  controller.setAddField('name', '时区')
  controller.setAddField('value', 'UTC+8')
  await controller.commitAdd()

  assert.equal(calls.replace.length, 1, '添加顺带走一次保存（底部那个保存按钮不是摆设）')
  const sent = calls.replace[0].section
  assert.deepEqual(sent.identityCard.fields.at(-1), { key: '时区', value: 'UTC+8', custom: true })
  assert.equal(controller.getSnapshot().addForm, undefined, '保存后表单收起')
  assert.equal(controller.getSnapshot().savedAt !== '', true)
  assert.equal(controller.getSnapshot().stored.identityCard.fields.at(-1).key, '时区', '新项进了基线（列表里看得到）')
})

test('V6 加小节：新名字建一节；与已有小节同名则往那一节追加一条（不造重复标题）', async () => {
  const { controller, calls } = await boot(seededPersona())

  controller.openAdd('section')
  controller.setAddField('name', '原型')
  controller.setAddField('value', '女仆长·示例')
  await controller.commitAdd()

  const afterFirst = controller.getSnapshot().stored.mutableLayer.sections
  assert.deepEqual(afterFirst.at(-1), { title: '原型', items: ['女仆长·示例'] })

  // 同名 → 追加到「经验教训」，而不是多出一个同名小节（那会被 `mutable.section-duplicate` 拒）。
  controller.openAdd('section')
  controller.setAddField('name', '经验教训')
  controller.setAddField('value', '第二条教训')
  await controller.commitAdd()

  const sections = controller.getSnapshot().stored.mutableLayer.sections
  assert.equal(sections.filter((section) => section.title === '经验教训').length, 1)
  assert.deepEqual(sections.find((section) => section.title === '经验教训').items, ['别在深夜做决定', '第二条教训'])
  assert.equal(calls.replace.length, 2)
})

test('V6 「用户定义」入口已下线；添加小节后仍是合法文档（宿主校验通过）', async () => {
  const { controller, calls } = await boot(seededPersona())

  assert.equal(controller.addUserDefined, undefined, '「用户定义」的添加入口已下线（0.1.14）')
  controller.openAdd('section')
  controller.setAddField('name', '原型')
  controller.setAddField('value', '女仆长·示例')
  await controller.commitAdd()

  const sent = calls.replace[0].section
  assert.deepEqual(sent.mutableLayer.userDefined, [{ key: '咖啡', value: '不加糖' }], '「用户定义」的数据原样写回')
  assert.equal(validatePersona(normalizePersona(sent), effectivePersona(seededPersona()), 'user').ok, true)
})

/* ---------------------------------------------------------------------------
 * V10–V13（0.1.13 追加）：给**自定义项**改名
 * ------------------------------------------------------------------------- */

test('V10 正面：改名成功后**落盘**，且注入/投影里是新名字（两类自定义项各一次）', async () => {
  const { controller, calls } = await boot(seededPersona())

  // 阳性对照：改名前，两个旧名字都在注入内容里。
  const before = renderPersonaPrompt(controller.getSnapshot().stored, { enabled: true })
  for (const name of ['归属地', '决定权']) assert.equal(before.includes(name), true, `改名前 ${name} 应当进注入`)

  controller.beginRename('section:决定权')
  controller.setRenameName('审批权')
  controller.confirmRename()
  controller.beginRename('identity:4') // 归属地
  controller.setRenameName('常驻地')
  controller.confirmRename()
  // ⚠️ 0.1.14：「用户定义」不再有改名入口（区块已下线）—— 它的数据照旧原样写回，见下。
  await controller.save()

  // ① 落盘：发给宿主的整份快照里是新名字、没有旧名字。
  const sent = calls.replace[0].section
  assert.equal(sent.mutableLayer.sections.some((section) => section.title === '决定权'), false)
  assert.equal(sent.mutableLayer.sections.some((section) => section.title === '审批权'), true)
  assert.deepEqual(sent.identityCard.fields.at(-1), { key: '常驻地', value: '示例城市', custom: true })
  assert.equal(sent.mutableLayer.userDefined[0].key, '咖啡', '「用户定义」的键没被人动过')

  // ② 注入 / 投影读数（不是只看界面）：宿主返回的那份文档喂给真实渲染。
  const stored = controller.getSnapshot().stored
  const content = collectPersonaContent(stored)
  assert.deepEqual(
    content.sections.map((section) => section.title),
    ['对用户称呼', '说话风格', '经验教训', '审批权'],
    '投影里的自定义小节是新名字',
  )
  // 投影只收**有值**的字段（人格偏好 / 主语言在 seededPersona 里是空的，所以不在这里）。
  assert.deepEqual(content.fields.map((field) => field.key), ['姓名', '性别', '常驻地'])
  assert.deepEqual(content.userDefined.map((entry) => entry.key), ['咖啡'], '「用户定义」的数据仍在投影里')

  const prompt = renderPersonaPrompt(stored, { enabled: true })
  assert.equal(prompt.includes('审批权'), true, '注入内容里是新小节名')
  assert.equal(prompt.includes('决定权'), false, '旧小节名不再出现')
  assert.equal(prompt.includes('常驻地'), true)
  assert.equal(prompt.includes('归属地'), false)
  // 「用户定义」的内容仍会进注入（数据没删，只是界面不再渲染/编辑它）——这是有意的：
  // 用户要的是"界面上不再编辑它"，不是"它失效"。
  assert.equal(prompt.includes('咖啡'), true, '数据仍在，注入照旧')
})

test('V10 宿主侧：改名走真实 writePersona 落盘，且旧名字进 persona_history（可回溯）', async () => {
  const document = seededPersona()
  const { state, store, history, sink } = hostHarness(document)
  const renamed = JSON.parse(JSON.stringify(document))
  renamed.mutableLayer.sections.find((section) => section.title === '决定权').title = '审批权'

  await writePersona(state, sink, renamed, 'user')

  assert.equal(store.value.mutableLayer.sections.some((section) => section.title === '审批权'), true, '落盘后是新名字')
  assert.equal(store.value.mutableLayer.sections.some((section) => section.title === '决定权'), false)
  // 改名的可回溯：旧名字那一节的条目按"被取代"留档（`supersededBy` 按标题找不到旧节 ⇒ 整节算被取代）。
  assert.equal(history.length, 1)
  assert.equal(history[0].path, 'mutableLayer.sections.决定权')
  assert.equal(history[0].previous, '技术判断我说了算')
  // 注入读数：新名字进提示词。
  assert.match(renderPersonaPrompt(store.value, { enabled: true }), /审批权/)
})

test('V11 反面（控制器）：**锁定的 8 项** beginRename 是空操作；非原生项（含「经验教训」）可改名', async () => {
  const { controller } = await boot(seededPersona())

  const forbidden = [
    'identity:0',
    'identity:1',
    'identity:2',
    'identity:3',
    // 原生 4 小节：名字是插件认的标识（`LOCKED_SECTION_TITLES`），既不可删也不可改名。
    'section:对用户称呼',
    'section:说话风格',
    'section:交付格式',
    'section:行为边界',
  ]
  for (const itemId of forbidden) {
    controller.beginRename(itemId)
    assert.equal(controller.getSnapshot().renaming, undefined, `${itemId} 不该进入改名态`)
  }
  // 允许的：自定义字段 / 自定义小节 / **原来的「经验教训」**（0.1.14 起它和用户自己加的一样）。
  for (const itemId of ['identity:4', 'section:决定权', 'section:经验教训']) {
    controller.beginRename(itemId)
    assert.notEqual(controller.getSnapshot().renaming, undefined, `${itemId} 应当可以改名`)
    controller.cancelRename()
  }
})

test('V13 边界（控制器）：空名 / 撞标准名 / 重名一律不落草稿，且不关表单、不覆盖别的项', async () => {
  const { controller } = await boot(seededPersona())
  const before = JSON.stringify(controller.getSnapshot().draft)

  const attempts = [
    ['section:决定权', '   ', '空名'],
    ['section:决定权', '经验教训', '撞已有小节名（重名）'],
    ['section:决定权', '对用户称呼', '撞原生锁定小节名'],
    ['identity:4', '咖啡', '撞「用户定义」的键（数据仍在文档里 ⇒ 仍占名字空间）'],
    ['identity:4', '姓名', '撞固定层字段名（宿主 core-key-shadowed）'],
  ]
  for (const [itemId, name, why] of attempts) {
    controller.beginRename(itemId)
    controller.setRenameName(name)
    controller.confirmRename()
    assert.equal(JSON.stringify(controller.getSnapshot().draft), before, `${why}：草稿必须一个字不动`)
    assert.notEqual(controller.getSnapshot().renaming, undefined, `${why}：表单不关（用户看得见自己填的名字）`)
    controller.cancelRename()
  }

  // **不许静默覆盖**：挨个确认过之后，两边都还在原名上。
  const draft = controller.getSnapshot().draft
  assert.equal(draft.mutableLayer.sections.some((section) => section.title === '决定权'), true)
  assert.equal(draft.mutableLayer.sections.some((section) => section.title === '经验教训'), true)
  assert.equal(draft.identityCard.fields.some((field) => field.key === '归属地'), true)
  assert.equal(draft.mutableLayer.userDefined[0].key, '咖啡', '「用户定义」的数据没被这些改名动过')
})

test('V13 边界（控制器）：回退与只读 —— 取消零改动；只读部署下 beginRename 是空操作', async () => {
  const { client, controller } = await boot(seededPersona())
  const before = JSON.stringify(controller.getSnapshot().draft)

  controller.beginRename('section:决定权')
  controller.setRenameName('审批权')
  controller.cancelRename()
  assert.equal(JSON.stringify(controller.getSnapshot().draft), before, '取消零改动')
  assert.equal(controller.getSnapshot().renaming, undefined, '表单收起')

  const readOnly = new client.PersonaWorkbenchController()
  readOnly.attach(createFakeChannel(seededPersona(), { writable: false }).channel)
  await settle(readOnly)
  readOnly.beginRename('section:决定权')
  assert.equal(readOnly.getSnapshot().renaming, undefined, '只读部署：不给一个改了也存不下去的输入框')
})

test('V13 边界（控制器）：改名保存后草稿与基线一致（不是"改了但没存"）', async () => {
  const { controller, calls } = await boot(seededPersona())

  controller.beginRename('section:决定权')
  controller.setRenameName('审批权')
  controller.confirmRename()
  assert.equal(controller.getSnapshot().renaming, undefined, '确认后表单收起')
  await controller.save()

  assert.equal(calls.replace.length, 1)
  const state = controller.getSnapshot()
  assert.equal(state.stored.mutableLayer.sections.some((section) => section.title === '审批权'), true)
  assert.equal(JSON.stringify(state.stored), JSON.stringify(state.draft), '基线 = 草稿（已落盘）')
})

/* ---------------------------------------------------------------------------
 * 回归：固定层 / 注入预算 / 归档规则一条不松
 * ------------------------------------------------------------------------- */

test('V7 回归：锁定判定不影响 Agent 的常规整理（漏传 = 不动，原生四节齐全）', async () => {
  const prev = seededPersona()
  // Agent 的 update 工具会把**原生**小节补齐（`completeSections`）：原生 4 个永远在，
  // 其余（含夹具里的「经验教训」「决定权」）按"漏传 = 不动"原样带回。
  const { completeSections } = await import('../lib/persona/tool-helpers.js')
  const sections = completeSections([{ title: '经验教训', items: ['新教训'] }], prev)
  const next = { ...prev, mutableLayer: { ...prev.mutableLayer, sections } }

  const validation = validatePersona(normalizePersona(next), effectivePersona(prev), 'agent')
  assert.equal(validation.ok, true, `Agent 常规整理照旧放行（实际：${validation.issues.map((issue) => issue.code).join(',')}）`)
})

test('V7 回归：注入预算没被动过；历史表名与语义不变（只有"保留期"是这轮新增的）', async () => {
  const { PROMPT_CHAR_BUDGET } = await import('../lib/persona/render.js')
  const { HISTORY_TABLE } = await import('../lib/store-schema.js')
  assert.equal(PROMPT_CHAR_BUDGET, 2400, '注入预算一个字没改')
  // 归档规则的**语义**没动：历史仍然 append-only、不进注入、被取代就留档。
  // 0.1.13 只在它之上加了一层保留期（用户要求），那条链路由 `persona-history-retention.test.mjs` 覆盖。
  assert.equal(HISTORY_TABLE, 'persona_history')
})

test('V7 回归：schema 默认值仍由常量生成（0.1.14 起只预置 4 个原生小节）', () => {
  const persona = createDefaultPersona()
  assert.deepEqual(
    persona.mutableLayer.sections.map((section) => section.title),
    ['对用户称呼', '说话风格', '交付格式', '行为边界'],
    '新装不再预置那 4 个空节（用户："dsh 新装一个 Humanity，也是显示 8 个原生项"）',
  )
  assert.equal(validatePersona(normalizePersona(persona), effectivePersona(persona), 'user').ok, true)
})
