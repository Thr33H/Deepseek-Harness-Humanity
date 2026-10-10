/**
 * 人格工作台控制器的测试（M2 步 6）。
 *
 * 测的是 `lib/client.js` 这个**构建产物**里导出的控制器，不是源码副本：这样"客户端 bundle 到底
 * 装了什么"与"它到底怎么行为"是同一个被测对象，源码改了但没重建会立刻在这里暴露。
 *
 * 覆盖面 = 这一层的全部对外行为：读取、编辑、保存前拦截、修订号回传、宿主拒绝、
 * 只读 provider、命名空间缺失、服务摘除、首次保存落初始化/封存标记。
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createFakeChannel, emptyPersona, withSection } from './helpers/persona-fake.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const nodeRequire = createRequire(import.meta.url)

/** 加载 bundle，取出它导出的控制器。平台模块只喂它真正 require 的那三个。 */
async function loadClient() {
  const source = await readFile(path.join(root, 'lib', 'client.js'), 'utf8')
  const calls = []
  const window = { __ModuleLoader__: { load: (descriptor) => calls.push(descriptor) } }
  new Function('window', source)(window)

  const react = nodeRequire('react')
  const require = (id) => {
    if (id === 'react') return react
    if (id === 'react/jsx-runtime') return nodeRequire('react/jsx-runtime')
    if (id === '@deepseek-ai/dsh-client-ui-primitives') {
      // 最小替身：本文件只渲染"封存入口"这一个断言，用不到原语的真实外观。
      // 其余用例都在控制器层断言，因此这里刻意保持极薄（要更完整的替身见 helpers/client-bundle.mjs）。
      return {
        Button: (props) => react.createElement('button', props, props?.children),
        Tag: (props) => react.createElement('span', props, props?.children),
        Input: (props) => react.createElement('input', props),
        Switch: (props) => react.createElement('input', { type: 'checkbox', checked: props?.checked, disabled: props?.disabled }),
        Tooltip: (props) => react.createElement('span', { 'data-tooltip': props?.label }, props?.children),
        Menu: (props) => react.createElement('span', { 'data-menu': 'closed' }, props?.children),
        HoverCard: (props) => react.createElement('span', props, props?.children),
        Modal: (props) => react.createElement('div', props, props?.children),
        IconQuestionOutline14: () => react.createElement('span', null, '?'),
        IconChevronRightOutline14: () => react.createElement('span', null, '>'),
        IconChevronDownOutline14: () => react.createElement('span', null, 'v'),
      }
    }
    throw new Error(`客户端 bundle 请求了平台表之外的模块：${id}`)
  }
  return calls[0].factory(require)
}

/** 起一个接好假通道、并且已经读完一次的控制器。 */
async function boot(document = emptyPersona(), options = {}) {
  const client = await loadClient()
  const fake = createFakeChannel(document, options)
  const controller = new client.PersonaWorkbenchController()
  controller.attach(fake.channel)
  await settle(controller)
  return { client, controller, ...fake }
}

/** 等控制器把异步读写跑完（状态机每步只做一次 await，几轮宏任务足够）。 */
async function settle(controller) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const status = controller.getSnapshot().status
    if (status === 'ready' || status === 'failed' || status === 'unavailable') return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('控制器没有在预期时间内进入稳定状态')
}

/** 一份"用户已经填过"的文档（初始化与封存标记都在）。 */
function seededPersona() {
  const document = emptyPersona()
  document.identityCard.fields[0].value = '小安'
  document.identityCard.fields[1].value = '女'
  document.identityCard.fields[2].value = '温和、直接'
  document.identityCard.initializedAt = '2026-09-23T00:00:00.000Z'
  document.identityCard.sealedAt = '2026-09-23T00:00:00.000Z'
  return document
}

test('读取：接上通道后 adoption 宿主文档、记录修订号，草稿与基线一致', async () => {
  const { controller } = await boot(seededPersona())

  const state = controller.getSnapshot()
  assert.equal(state.status, 'ready')
  assert.equal(state.writable, true)
  assert.equal(state.revision, 1)
  assert.equal(state.stored.identityCard.fields[0].value, '小安')
  assert.equal(state.draft.identityCard.fields[0].value, '小安')
})

test('编辑：改草稿不动基线；重新加载会丢弃草稿（本步不做撤销栈）', async () => {
  const { controller } = await boot(seededPersona())

  controller.setIdentityValue(0, '清')
  controller.setSectionText('说话风格', '先给结论\n再给依据')

  const edited = controller.getSnapshot()
  assert.equal(edited.stored.identityCard.fields[0].value, '小安')
  assert.equal(edited.draft.identityCard.fields[0].value, '清')
  assert.deepEqual(edited.draft.mutableLayer.sections[1].items, ['先给结论', '再给依据'])

  await controller.load()
  assert.equal(controller.getSnapshot().draft.identityCard.fields[0].value, '小安')
})

test('保存：规范化后整份快照发给宿主，带上修订号，成功后基线换成宿主返回的值', async () => {
  const { controller, calls, state } = await boot(seededPersona())

  controller.setIdentityValue(0, '  清  ') // 前后空白应由规范化去掉
  await controller.save()

  assert.equal(calls.replace.length, 1)
  assert.equal(calls.replace[0].ns, 'humanity-persona')
  assert.equal(calls.replace[0].expectedRevision, 1, '必须把读到的修订号带回去')
  assert.equal(calls.replace[0].section.identityCard.fields[0].value, '清')

  const after = controller.getSnapshot()
  assert.equal(after.stored.identityCard.fields[0].value, '清')
  assert.equal(after.revision, 2)
  assert.notEqual(after.savedAt, '')
  assert.equal(state.revision, 2)
})

test('宿主文档缺核心字段（旧数据）：工作台加载即补齐，保存时把完整文档写回去（修复旧数据）', async () => {
  // 2026-09-23：这条用例原本断言"缺核心字段 ⇒ 本机拦下、不发请求"。加了「主语言」之后那个行为
  // 变成了**灾难**：旧数据（三字段）若在加载时不被补齐，用户一打开工作台就是一片红，宿主的注册钩子
  // 也会因此把整个命名空间弄崩。现在的口径是"规范化负责迁移、校验负责判定"：
  // 加载补齐 → 保存把修好的完整文档写回 → 旧数据在下一次保存后就彻底干净了。
  const document = seededPersona()
  document.identityCard.fields = document.identityCard.fields.filter((field) => field.key !== '主语言')
  const { controller, calls } = await boot(document)

  const loaded = controller.getSnapshot()
  assert.equal(loaded.status, 'ready')
  assert.deepEqual(
    loaded.draft.identityCard.fields.map((field) => field.key),
    ['姓名', '性别', '人格偏好', '主语言'],
    '加载时补齐缺失的核心字段（空值）—— 用户看到的是完整身份卡',
  )

  controller.setIdentityValue(2, '温和')
  await controller.save()

  assert.equal(calls.replace.length, 1)
  assert.deepEqual(
    calls.replace[0].section.identityCard.fields.map((field) => field.key),
    ['姓名', '性别', '人格偏好', '主语言'],
    '写回去的是完整文档（旧数据被修复，而不是原样写回缺字段的版本）',
  )
  assert.equal(calls.replace[0].section.identityCard.fields[3].value, '')
})

test('低风险规范化先于校验：空行（空字段名）被整理掉，而不是报错（P-010）', async () => {
  const { controller, calls } = await boot(seededPersona())

  controller.addIdentityField() // 名字空着的一条 → 规范化时丢弃
  controller.addIdentityField()
  const index = controller.getSnapshot().draft.identityCard.fields.length - 1
  controller.setIdentityKey(index, '归属地')
  controller.setIdentityValue(index, '示例城市')

  await controller.save()

  assert.equal(calls.replace.length, 1, '去空行属低风险，应当直接落盘而不是拦住用户')
  assert.deepEqual(
    calls.replace[0].section.identityCard.fields.map((field) => field.key),
    ['姓名', '性别', '人格偏好', '主语言', '归属地'],
  )
  assert.equal(calls.replace[0].section.identityCard.fields.at(-1).value, '示例城市')
})

test('重复字段名**不再**被静默去重：本机就拦下、报 identity.key-duplicate、不发请求', async () => {
  // 真机反馈缺陷 ①：原先 `normalizePersona` 按主键去重 ⇒ 第二个同名键**无声消失**，
  // 界面上还显示"保存成功"。现在同名键是自相矛盾的输入，必须在保存前说清楚。
  const { controller, calls } = await boot(seededPersona())

  controller.addIdentityField()
  const first = controller.getSnapshot().draft.identityCard.fields.length - 1
  controller.setIdentityKey(first, '归属地')
  controller.setIdentityValue(first, '示例城市')
  controller.addIdentityField()
  const duplicate = controller.getSnapshot().draft.identityCard.fields.length - 1
  controller.setIdentityKey(duplicate, '归属地')
  controller.setIdentityValue(duplicate, '示例城市')

  await controller.save()

  assert.equal(calls.replace.length, 0, '本机就能判定的问题不该打网络往返')
  const state = controller.getSnapshot()
  assert.ok(state.issues.some((issue) => issue.code === 'identity.key-duplicate'))
  assert.equal(state.issues.some((issue) => issue.severity === 'rejected'), true)
  // 草稿原样保留（被拒的东西一个字都不能吞）：两条「归属地」都还在，等用户自己决定留哪条。
  const keys = state.draft.identityCard.fields.map((field) => field.key)
  assert.equal(keys.filter((key) => key === '归属地').length, 2)
})

test('⑥ 「用户定义」入口已下线：合法文档照旧保存，数据原样带回（0.1.14）', async () => {
  const { controller, calls } = await boot(seededPersona())

  // 用户 2026-10-09："用户自定义可以删了，它跟添加小节重复了" ⇒ 界面上没有这个入口了，
  // 而 `userDefined` 字段仍在文档里（V7：下线 ≠ 删数据）。
  assert.equal(controller.addUserDefined, undefined, '「用户定义」的添加入口已下线')
  assert.equal(controller.setUserDefined, undefined, '「用户定义」的编辑入口已下线')
  assert.equal(controller.removeUserDefined, undefined, '「用户定义」的删除入口已下线')

  await controller.save()
  assert.equal(calls.replace.length, 1)
  assert.deepEqual(calls.replace[0].section.mutableLayer.userDefined, [], '字段照旧在文档里（空数组）')
})

test('⑥ 空的新增行仍旧静默丢掉（点了添加还没填，不该拦路）', async () => {
  const { controller, calls } = await boot(seededPersona())

  controller.addIdentityField()

  await controller.save()

  assert.equal(calls.replace.length, 1)
  assert.deepEqual(calls.replace[0].section.mutableLayer.userDefined, [], '「用户定义」字段照旧原样带回')
  assert.equal(calls.replace[0].section.identityCard.fields.length, 4, '核心固定层 4 项（含主语言）')
})

test('Bug B 清空自定义节的正文 = 删除该节（用户不必再找别的入口）；原生节清空后仍留着', async () => {
  const document = seededPersona()
  document.mutableLayer.sections.push({ title: '小明专属节', items: ['只有一条'] })
  // 0.1.14：「经验教训」已不是原生项 —— 夹具显式当自定义项加进来；这里用它当"被清空"的样本。
  withSection(document, '经验教训', ['别在深夜做决定'])
  const { controller, calls } = await boot(document)

  // 用户把自定义节的正文清空 → 保存。
  controller.setSectionText('小明专属节', '')
  // 同时清空一个**原生**节：它的含义是"这一节现在没内容"，节本身必须保留。
  controller.setSectionText('说话风格', '')

  await controller.save()

  assert.equal(calls.replace.length, 1)
  const titles = calls.replace[0].section.mutableLayer.sections.map((section) => section.title)
  assert.equal(titles.includes('小明专属节'), false, '清空正文就等于删掉这个自定义节')
  assert.equal(titles.includes('说话风格'), true, '原生节不能删')
  assert.deepEqual(
    calls.replace[0].section.mutableLayer.sections.find((section) => section.title === '说话风格').items,
    [],
  )
  // 另一半（0.1.14 的新口径）：**非原生**的「经验教训」清空同样等于删掉它。
  controller.setSectionText('经验教训', '')
  await controller.save()
  const after = calls.replace[1].section.mutableLayer.sections.map((section) => section.title)
  assert.equal(after.includes('经验教训'), false, '非原生节清空 = 删掉（与自定义节同待遇）')
  assert.equal(after.includes('对用户称呼'), true, '原生节照旧在')
})

test('R2 历史遗留的空壳自定义节在读取时就不显示（下一次保存顺手从存储里清掉）', async () => {
  const document = seededPersona()
  // 模拟上一版写进去、删不掉的僵尸空壳。
  document.mutableLayer.sections.push({ title: '回归测试节', items: [] })
  const { controller, calls } = await boot(document)

  const state = controller.getSnapshot()
  assert.equal(
    state.draft.mutableLayer.sections.some((section) => section.title === '回归测试节'),
    false,
    '空壳不该出现在界面草稿里',
  )
  assert.equal(
    state.stored.mutableLayer.sections.some((section) => section.title === '回归测试节'),
    false,
    '基线里也不该留着它（否则下一次保存会把它又写回去）',
  )

  // 随便改一处并保存：发出去的整份文档里已经没有那个空壳。
  controller.setIdentityValue(2, '温和、直接')
  await controller.save()
  assert.equal(calls.replace.length, 1)
  assert.equal(
    calls.replace[0].section.mutableLayer.sections.some((section) => section.title === '回归测试节'),
    false,
  )
})

test('警告不拦路：超长值照常保存，但会作为 warning 留在结果里（P-015）', async () => {
  const { controller, calls } = await boot(seededPersona())

  controller.setIdentityValue(2, '很'.repeat(200))
  await controller.save()

  assert.equal(calls.replace.length, 1, 'warning 不该拦住保存')
  assert.ok(
    controller.getSnapshot().issues.some((issue) => issue.code === 'identity.value-too-long' && issue.severity === 'warning'),
  )
})

test('宿主拒绝：原样呈现宿主的说法，草稿保留（用户的改动不丢）', async () => {
  const { controller, calls } = await boot(seededPersona(), { failReplace: 'settings/rejected: 人格底色已对 Agent 封存' })

  controller.setIdentityValue(0, '清')
  await controller.save()

  const state = controller.getSnapshot()
  assert.equal(calls.replace.length, 1)
  assert.match(state.error ?? '', /settings\/rejected/)
  assert.equal(state.draft.identityCard.fields[0].value, '清', '被拒后草稿必须还在')
})

test('修订号冲突：宿主拒绝后留下原因，草稿不丢（乐观并发控制真的用上了）', async () => {
  const { controller, state, calls } = await boot(seededPersona())

  controller.setIdentityValue(0, '清')
  state.revision = 99 // 模拟"别的写入方改过"

  await controller.save()

  assert.equal(calls.replace.length, 1)
  assert.match(controller.getSnapshot().error ?? '', /conflict/)
  assert.equal(controller.getSnapshot().draft.identityCard.fields[0].value, '清')
})

test('传输层直接抛（断线 / 宿主重启）：忙碌标记必须清掉，原因必须显示（2026-09-26 客户端审计）', async () => {
  // 旧实现没有 try/catch：`replace` 抛出去会让 `saving` 永远为真 —— 保存按钮卡在「保存中…」，
  // 用户既不能重试也看不到原因；而且 rejection 从 `void controller.save()` 逃逸成未处理拒绝。
  const { client, controller, channel, state } = await boot(seededPersona())
  const throwing = {
    ...channel,
    replace: async () => {
      throw new Error('settings 通道已断开')
    },
  }
  const broken = new client.PersonaWorkbenchController()
  broken.attach(throwing)
  await settle(broken)

  broken.setIdentityValue(0, '清')
  await broken.save()

  const snapshot = broken.getSnapshot()
  assert.equal(snapshot.saving, false, '不许卡在"保存中…"')
  assert.equal(snapshot.status, 'ready', '一次写失败不该把整页判成失败')
  assert.match(snapshot.error ?? '', /断开/)
  assert.equal(snapshot.draft.identityCard.fields[0].value, '清', '草稿保留（用户白打一遍才是真的丢东西）')
  assert.equal(state.document.identityCard.fields[0].value !== '清', true, '宿主那份没被改')
  assert.equal(controller.getSnapshot().saving, false, '另一个控制器不受影响')
})

test('独立判断开关的传输层抛错同样清忙碌标记（同一个坑的另一半）', async () => {
  const { client, channel } = await boot(seededPersona())
  const broken = new client.PersonaWorkbenchController()
  broken.attach({
    ...channel,
    update: async () => {
      throw new Error('settings 通道已断开')
    },
  })
  await settle(broken)

  await broken.setIndependentJudgment(false)

  assert.equal(broken.getSnapshot().independentJudgmentSaving, false, '开关不许永久禁用')
  assert.match(broken.getSnapshot().error ?? '', /断开/)
})

test('首次从工作台保存会落下初始化与封存标记（P-002/P-003 的工作台路径）', async () => {
  const { controller, calls } = await boot()

  controller.setIdentityValue(0, '小安')
  await controller.save()

  const written = calls.replace[0].section.identityCard
  assert.notEqual(written.initializedAt, '')
  assert.equal(written.initializedAt, written.sealedAt)
})

test('已经有初始化标记时不重复打标记（第二次保存不动 initializedAt）', async () => {
  const { controller, calls } = await boot(seededPersona())

  controller.setIdentityValue(1, '女')
  await controller.save()

  assert.equal(calls.replace[0].section.identityCard.initializedAt, '2026-09-23T00:00:00.000Z')
  assert.equal(calls.replace[0].section.identityCard.sealedAt, '2026-09-23T00:00:00.000Z')
})

test('命名空间缺席：状态是 unavailable，保存是空操作（不编造可编辑的默认值）', async () => {
  const { controller, calls } = await boot(emptyPersona(), { present: false })

  assert.equal(controller.getSnapshot().status, 'unavailable')
  controller.setIdentityValue(0, '小安')
  await controller.save()
  assert.equal(calls.replace.length, 0)
})

test('只读 provider：writable=false 时不发写请求', async () => {
  const { controller, calls } = await boot(emptyPersona(), { writable: false })

  assert.equal(controller.getSnapshot().writable, false)
  controller.setIdentityValue(0, '小安')
  await controller.save()
  assert.equal(calls.replace.length, 0)
})

test('读取失败与摘除服务：都退化成明确状态，不假装 ready', async () => {
  const { controller } = await boot(emptyPersona(), { failDescribe: 'boom' })
  assert.equal(controller.getSnapshot().status, 'failed')
  assert.equal(controller.getSnapshot().error, 'boom')

  controller.detach()
  assert.equal(controller.getSnapshot().status, 'unavailable')
})

test('自定义字段：可加、可改名、可删；核心三段式删不掉（P-012/P-014）', async () => {
  const { controller, calls } = await boot(seededPersona())

  controller.addIdentityField()
  const index = controller.getSnapshot().draft.identityCard.fields.length - 1
  controller.setIdentityKey(index, '归属地')
  controller.setIdentityValue(index, '示例城市')
  controller.removeIdentityField(0) // 核心字段，应被忽略

  await controller.save()

  assert.deepEqual(
    calls.replace[0].section.identityCard.fields.map((field) => field.key),
    ['姓名', '性别', '人格偏好', '主语言', '归属地'],
  )

  // 删的必须是**自定义**那一项：按 `custom` 找下标，而不是写死位置
  // （核心字段列表变过：2026-09-23 加了「主语言」，写死下标的那版就是这么过期的）。
  const customIndex = controller.getSnapshot().draft.identityCard.fields.findIndex((field) => field.custom)
  controller.removeIdentityField(customIndex)
  assert.equal(controller.getSnapshot().draft.identityCard.fields.length, 4, '核心固定层 4 项（含主语言）不因删自定义字段而减少')
})

/* ---------------------------------------------------------------------------
 * 独立判断开关（顶层 humanity 配置，不是人格文档字段）
 * ------------------------------------------------------------------------- */

test('独立判断开关：加载时读到顶层配置的值（默认开），并记录它的修订号', async () => {
  const on = await boot(seededPersona())
  assert.equal(on.controller.getSnapshot().independentJudgment, true, '缺省即开（与 schema 默认值一致）')

  const off = await boot(seededPersona(), { independentJudgment: false })
  assert.equal(off.controller.getSnapshot().independentJudgment, false, '用户关过就显示关')
})

test('独立判断开关：切换走 humanity 命名空间的 update（合并补丁 + 修订号），成功后采用宿主返回值', async () => {
  const { controller, calls } = await boot(seededPersona())

  await controller.setIndependentJudgment(false)

  assert.equal(calls.update.length, 1, '必须有且只有一次写入')
  assert.equal(calls.update[0].ns, 'humanity', '写的是顶层配置，不是 humanity-persona')
  assert.deepEqual(calls.update[0].patch, { independentJudgment: false })
  assert.equal(calls.update[0].expectedRevision, 7, '带上读取时的修订号（乐观并发控制）')
  assert.equal(controller.getSnapshot().independentJudgment, false)
  assert.equal(controller.getSnapshot().independentJudgmentRevision, 8, '采用宿主返回的新修订号')
  assert.equal(controller.getSnapshot().independentJudgmentSaving, false)
})

test('独立判断开关：宿主拒绝时保持原值并把原因显示出来（不假装切成功了）', async () => {
  const { controller } = await boot(seededPersona(), { failUpdate: 'settings/rejected: 该部署禁止修改' })

  await controller.setIndependentJudgment(false)

  const state = controller.getSnapshot()
  assert.equal(state.independentJudgment, true, '仍停在原值')
  assert.equal(state.independentJudgmentSaving, false)
  assert.match(state.error ?? '', /该部署禁止修改/, '原样呈现宿主的说法')
})

test('独立判断开关：只读 provider 下不写（本机先拦住）', async () => {
  const { controller, calls } = await boot(seededPersona(), { writable: false })

  await controller.setIndependentJudgment(false)

  assert.equal(calls.update.length, 0)
  assert.equal(controller.getSnapshot().independentJudgment, true)
})

test('独立判断开关：人名册缺失（命名空间不在）时保持默认开，不因为读不到就显示成关', async () => {
  const { controller } = await boot(seededPersona(), { present: false })

  assert.equal(controller.getSnapshot().status, 'unavailable')
  assert.equal(controller.getSnapshot().independentJudgment, true)
})

test('封存：已初始化但未封存的卡，用户点「封存」就能封上（2026-09-26 真机缺口）', async () => {
  // 真机现象：预填 / 旧数据那种「initializedAt 有值、sealedAt 为空」的卡，界面里**没有**任何
  // 能封存的入口（封存原本只发生在"首次保存"），于是独立判断开关永远是灰的、标签一直显示"未封存"。
  const { controller, calls } = await boot(seededPersona())
  controller.detach() // 从干净状态起：先造一张"已初始化、未封存"的卡
  const fake = createFakeChannel(seededPersona())
  fake.state.document.identityCard.sealedAt = ''
  const fresh = new (await loadClient()).PersonaWorkbenchController()
  fresh.attach(fake.channel)
  await settle(fresh)

  assert.equal(fresh.getSnapshot().stored.identityCard.sealedAt, '', '起点：未封存')
  const before = fresh.getSnapshot().draft.identityCard.initializedAt
  await fresh.seal()

  const written = calls.replace.at(-1) ?? fake.calls.replace.at(-1)
  assert.ok(written !== undefined, '封存必须真的写回宿主')
  assert.notEqual(written.section.identityCard.sealedAt, '', 'sealedAt 被落上')
  assert.equal(written.section.identityCard.initializedAt, before, '初始化时刻不许被覆盖')
  assert.equal(fresh.getSnapshot().stored.identityCard.sealedAt !== '', true, '封存后界面读到的就是已封存')
})

test('两张卡各有自己的保存按钮（用户 2026-09-26；底栏不再重复一个）', async () => {
  const client = await loadClient()
  const { createElement } = nodeRequire('react')
  const render = (element) => nodeRequire('react-dom/server').renderToStaticMarkup(element)
  const controller = new client.PersonaWorkbenchController()
  controller.attach(createFakeChannel(seededPersona()).channel)
  await settle(controller)
  const seat = createElement(
    client.createWorkbenchSeat(
      controller,
      new client.MemoryWorkbenchController(),
      new client.EvolutionWorkbenchController(),
    ),
    { t: (key) => String(key) },
  )
  const html = render(seat)
  const saveCount = html.split('>persona.save<').length - 1
  assert.ok(saveCount >= 2, `身份卡与人格卡各要一个保存按钮（实际 ${saveCount} 个）`)
  assert.ok(html.indexOf('persona.identityCard') < html.indexOf('>persona.save<'), '第一个保存按钮出现在身份卡内')
  assert.equal(html.includes('persona.reload'), true, '底栏仍保留重新加载')
})

test('封存按钮只在未封存时出现（页面标记层面钉住入口）', async () => {
  const client = await loadClient()
  const { createElement } = nodeRequire('react')
  const render = (element) => nodeRequire('react-dom/server').renderToStaticMarkup(element)

  const channel = createFakeChannel(seededPersona())
  channel.state.document.identityCard.sealedAt = ''
  const controller = new client.PersonaWorkbenchController()
  controller.attach(channel.channel)
  await settle(controller)
  const seat = (c) =>
    createElement(client.createWorkbenchSeat(c, new client.MemoryWorkbenchController(), new client.EvolutionWorkbenchController()), {
      t: (key) => String(key),
    })
  const unsealed = render(seat(controller))
  assert.match(unsealed, /persona\.sealAction/, '未封存 ⇒ 有「封存」按钮')
  assert.match(unsealed, /persona\.unsealed/, '标签写的是"未封存"（不是"未初始化"）')

  const sealedChannel = createFakeChannel(seededPersona()) // seeded 的那份 sealedAt 非空
  const sealedController = new client.PersonaWorkbenchController()
  sealedController.attach(sealedChannel.channel)
  await settle(sealedController)
  const sealed = render(seat(sealedController))
  assert.equal(sealed.includes('persona.sealAction'), false, '已封存 ⇒ 不再显示「封存」按钮')
  assert.match(sealed, /persona\.sealed/)
})
