/**
 * 记忆工作台控制器的测试（Host 侧用**按契约实现的假通道**）。
 *
 * 为什么可以假：这里要证的是"状态机与本地过滤"（读投影、分组、搜索、把点击翻译成哪条命令、
 * 只读/缺命名空间怎么降级），全在我们自己的代码里。真设置服务的链路已由
 * `memory-section.test.mjs` 用真服务覆盖 —— 两层各证各的，不互相冒充。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'

import { loadClientBundle } from './helpers/client-bundle.mjs'
import { CARD_SKELETON, countHints, visibleText } from './helpers/markup.mjs'

const nodeRequire = createRequire(import.meta.url)
const { createElement } = nodeRequire('react')
const render = (element) => nodeRequire('react-dom/server').renderToStaticMarkup(element)

// 客户端代码只存在于打包产物 `lib/client.js` 里（它就是 DSH 会加载的东西），
// 因此测试也走打包产物，而不是另建一条只在测试里成立的入口。
const client = await loadClientBundle()
const { MEMORY_NAMESPACE, MEMORY_OPS, MemoryWorkbenchController, MemoryPage, asMemoryDocument, filterEntries } =
  client

/** 宿主投影的一份样例（两条生效、一条待确认、一条归档）。 */
function sampleDoc() {
  return {
    entries: [
      entry('a', 'active', '用户喜欢喝咖啡', ['饮品']),
      entry('b', 'active', '项目用 TypeScript + React', ['技术']),
      entry('c', 'pending', '用户的门禁密码', [], { sensitive: true }),
      entry('d', 'archived', '旧项目信息', [], { importance: 0 }),
    ],
    policy: {
      mode: 'balanced',
      scopes: { 'long-term': true, workspace: true, session: false },
      autoInject: true,
      autoWrite: true,
      injectLimit: 3,
      relevanceThreshold: 0.35,
      decay: true,
      vector: false,
    },
    notice: '',
  }
}

function entry(fingerprint, status, content, tags = [], overrides = {}) {
  return {
    fingerprint,
    scope: 'long-term',
    status,
    content,
    tags,
    importance: 3,
    sensitive: false,
    pinned: false,
    conflictCount: 0,
    updatedAt: '2026-09-24T00:00:00.000Z',
    ...overrides,
  }
}

/** 造一个按契约实现的假通道。 */
function createFakeChannel(doc = sampleDoc(), options = {}) {
  const calls = { describe: 0, update: [] }
  const state = { doc, revision: 3, writable: options.writable ?? true, present: options.present ?? true }
  return {
    calls,
    channel: {
      async describe() {
        calls.describe += 1
        if (options.failDescribe !== undefined) return { ok: false, error: { message: options.failDescribe } }
        const namespaces = state.present
          ? [
              { ns: MEMORY_NAMESPACE, value: state.doc, revision: state.revision },
              { ns: 'humanity', value: {}, revision: 9 },
            ]
          : [{ ns: 'humanity', value: {}, revision: 9 }]
        return { ok: true, value: { writable: state.writable, namespaces } }
      },
      async update(ns, patch, expectedRevision) {
        calls.update.push({ ns, patch, expectedRevision })
        if (options.failUpdate !== undefined) return { ok: false, error: { message: options.failUpdate } }
        return { ok: true, value: { ns, value: state.doc, revision: state.revision + 1 } }
      },
    },
  }
}

test('读取：解析投影、按状态分组、搜索只过滤本地列表', async () => {
  const { channel } = createFakeChannel()
  const controller = new MemoryWorkbenchController()
  controller.attach(channel)
  await waitReady(controller)

  const state = controller.getSnapshot()
  assert.equal(state.status, 'ready')
  assert.equal(state.writable, true)
  assert.equal(state.revision, 3)
  assert.equal(state.configRevision, 9, '顶层配置的修订号要留着（改模式时带回去）')
  assert.equal(state.policy.mode, 'balanced')

  assert.deepEqual(controller.visible('active').map((item) => item.fingerprint), ['a', 'b'])
  assert.deepEqual(controller.visible('pending').map((item) => item.fingerprint), ['c'])
  assert.deepEqual(controller.visible('archived').map((item) => item.fingerprint), ['d'])

  controller.setQuery('咖啡')
  assert.deepEqual(controller.visible('active').map((item) => item.fingerprint), ['a'])
  assert.deepEqual(controller.visible('pending'), [], '搜索也要按状态分组')

  controller.setQuery('技术')
  assert.deepEqual(controller.visible('active').map((item) => item.fingerprint), ['b'], '标签也能搜到')

  controller.setQuery('不存在的东西')
  assert.deepEqual(controller.visible('active'), [])
})

test('操作：每次点击翻译成一条命令，写进命令槽并带上修订号', async () => {
  const fake = createFakeChannel()
  const controller = new MemoryWorkbenchController()
  controller.attach(fake.channel)
  await waitReady(controller)
  fake.calls.update.length = 0

  await controller.confirm('c')
  await controller.reject('c')
  await controller.archive('a')
  await controller.restore('d')
  await controller.remove('b')
  await controller.setPinned('a', true)
  await controller.setPinned('a', false)

  assert.deepEqual(
    fake.calls.update.map((call) => call.patch.request.op),
    ['confirm', 'reject', 'archive', 'restore', 'remove', 'pin', 'unpin'],
  )
  for (const call of fake.calls.update) {
    assert.equal(call.ns, MEMORY_NAMESPACE, '记忆命令只写记忆命名空间')
    assert.equal(call.expectedRevision, 3, '带上读到的修订号（乐观并发控制）')
    assert.equal(typeof call.patch.request.fingerprint, 'string')
  }
})

test('切换模式：写顶层 humanity 配置的 modules.memory.mode（开关即时生效）', async () => {
  const fake = createFakeChannel()
  const controller = new MemoryWorkbenchController()
  controller.attach(fake.channel)
  await waitReady(controller)
  fake.calls.update.length = 0

  await controller.setMode('manual')

  assert.equal(fake.calls.update.length, 1)
  assert.equal(fake.calls.update[0].ns, 'humanity')
  assert.deepEqual(fake.calls.update[0].patch, {
    modules: { memory: { mode: 'manual', advanced: { customized: false } } },
  }, '切模式同时关掉高级覆盖，否则上一轮的高级值会把新模式拖回原样')
  assert.equal(fake.calls.update[0].expectedRevision, 9, '用顶层配置自己的修订号')
})

test('只读与失败：都不改变列表，只把原因写进 error', async () => {
  const readOnly = createFakeChannel(sampleDoc(), { writable: false })
  const first = new MemoryWorkbenchController()
  first.attach(readOnly.channel)
  await waitReady(first)
  await first.archive('a')
  assert.equal(readOnly.calls.update.length, 0, '只读 provider 下不该发出写入')
  assert.match(first.getSnapshot().error ?? '', /只读/)

  const failing = createFakeChannel(sampleDoc(), { failUpdate: '宿主拒绝了这次写入' })
  const second = new MemoryWorkbenchController()
  second.attach(failing.channel)
  await waitReady(second)
  await second.confirm('c')
  assert.match(second.getSnapshot().error ?? '', /宿主拒绝/)
  assert.deepEqual(second.visible('pending').map((item) => item.fingerprint), ['c'], '失败后列表保持原样')
})

test('降级：命名空间缺失、通道形状不对、describe 失败，都不抛错', async () => {
  const missing = new MemoryWorkbenchController()
  missing.attach(createFakeChannel(sampleDoc(), { present: false }).channel)
  await waitReady(missing)
  assert.equal(missing.getSnapshot().status, 'failed')
  assert.match(missing.getSnapshot().error ?? '', /命名空间/)

  const broken = new MemoryWorkbenchController()
  broken.attach({ describe: 'not a function' })
  await Promise.resolve()
  assert.equal(broken.getSnapshot().status, 'unavailable', '形状不对就整条通道判为不可用')

  const failing = new MemoryWorkbenchController()
  failing.attach(createFakeChannel(sampleDoc(), { failDescribe: '远端炸了' }).channel)
  await waitReady(failing)
  assert.equal(failing.getSnapshot().status, 'failed')
  assert.match(failing.getSnapshot().error ?? '', /远端炸了/)

  // describe 成功但**缺 namespaces**：明确报"描述不完整"，不许停在"正在读取…"（那时连重新加载都点不了）。
  const shapeless = new MemoryWorkbenchController()
  shapeless.attach({
    describe: async () => ({ ok: true, value: { writable: true } }),
    update: async () => ({ ok: true, value: undefined }),
  })
  await waitReady(shapeless)
  assert.equal(shapeless.getSnapshot().status, 'failed')
  assert.match(shapeless.getSnapshot().error ?? '', /不完整/)
})

test('解析与过滤是纯函数：缺字段兜底、非法值报错、空搜索词返回全部', () => {
  const doc = asMemoryDocument({ entries: [{ fingerprint: 'x' }, null, { content: '没有指纹' }] })
  assert.equal(doc.entries.length, 1, '缺指纹的条目直接丢掉')
  assert.equal(doc.entries[0].scope, 'long-term', '缺字段用兜底值')
  assert.deepEqual(doc.entries[0].tags, [])
  assert.equal(doc.policy.mode, 'balanced')
  assert.throws(() => asMemoryDocument(null), /不是对象/)

  const entries = [entry('a', 'active', '咖啡'), entry('b', 'pending', '咖啡')]
  assert.equal(filterEntries(entries, 'active', '').length, 1)
  assert.equal(filterEntries(entries, 'pending', '咖啡').length, 1)
  assert.deepEqual(filterEntries(entries, 'active', '茶'), [])
})

test('客户端与宿主的操作集合一致：两边各写一份字面量，不允许悄悄分叉', () => {
  assert.deepEqual(
    [...MEMORY_OPS],
    ['confirm', 'reject', 'archive', 'restore', 'pin', 'unpin', 'remove', 'decay', 'dedupe', 'undo-dedupe', 'rescope'],
  )
  assert.equal(MEMORY_NAMESPACE, 'humanity-memory')
})

/** 等控制器读起来（attach 的 load 是异步的）。 */
async function waitReady(controller) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const status = controller.getSnapshot().status
    if (status !== 'idle' && status !== 'loading') return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error('控制器没有在预期时间内就绪')
}

test('记忆页面渲染不崩，且关键控件都在（策略 / 待确认 / 搜索 / 三组操作）', async () => {
  const fake = createFakeChannel()
  const controller = new MemoryWorkbenchController()
  controller.attach(fake.channel)
  await waitReady(controller)

  // 文案字典用"键名兜底"（键名直接回显），断言因此不依赖具体措辞。
  const html = render(createElement(MemoryPage, { t: (key) => String(key), controller }))

  assert.match(html, /memory\.policy/)
  // 模式下拉现在是官方 Menu（Button 触发）而不是浏览器 <select>：默认关着，锚点上写着当前值。
  assert.match(html, /data-menu="closed"/, '模式下拉必须存在（官方 Menu，默认收起）')
  assert.match(html, /data-menu-value="balanced"/, '下拉上要显示当前模式')
  assert.match(html, /memory\.mode\.balanced/)
  assert.match(html, /memory\.searchPlaceholder/, '搜索框必须存在')
  assert.match(html, /memory\.pending/, '有待确认条目时必须出现待确认区')
  assert.match(html, /memory\.confirm/)
  assert.match(html, /memory\.reject/)
  assert.match(html, /memory\.archive/, '活跃条目要有归档操作')
  assert.match(html, /memory\.pin/)
  assert.match(html, /memory\.remove/)
  assert.match(html, /memory\.archived/)
  assert.match(html, /memory\.decayAction/, '整理记忆按钮必须存在')
  assert.match(html, /memory\.advanced/, '高级折叠区的入口必须存在')
  // 折叠区：右侧是**官方 Button**（ghost + chevron），带 aria-expanded 与无障碍名。
  // 用户 2026-09-26 两条要求都钉在这里：一是"展开的按钮得看得见"（在右边），二是"尽量原生"。
  assert.match(html, /aria-expanded="false" aria-label="memory\.advanced\.expand"/, '高级区默认收起，右侧是原生展开按钮')
  assert.match(html, /memory\.advanced/, '高级区标题仍在')
  // 生效作用域只列生效中的层（session 关着 ⇒ 不该出现）。
  assert.equal(html.includes('memory.scope.session'), false, '关掉的作用域直接不显示')
  assert.equal(html.includes('memory.degraded.title'), false, '没探测到极简模式时不该出现警告条')

  // 统一卡片骨架（用户 2026-09-26：「包括人格、记忆、技能……总之有很多条目，风格统一」）：
  // 左元信息（归属 + 重要度/时间）｜中内容｜右操作，三个页面同一组列宽。
  assert.ok(html.includes(CARD_SKELETON), '记忆条目要用统一骨架')
  assert.ok(html.split(CARD_SKELETON).length - 1 >= 3, '每条记忆各一张卡（样例里有 3 条）')

  // 控件纪律（用户 2026-09-26：「能用原生就用原生，这样连主题都不用适配了」）：
  // 页面上不许再出现浏览器自绘的 <select>（它不吃 DSH 令牌，深色主题下就是一块白底补丁）。
  assert.equal(html.includes('<select'), false, '不许再用裸 <select>：下拉一律走官方 Menu')
  assert.equal(html.split('data-menu="closed"').length - 1 >= 3, true, '模式与每条记忆的归属都得是官方下拉')

  // 说明收进「?」（用户 2026-09-26）：口径与限制挂在卡片标题/按钮旁边，不再铺成说明段。
  assert.ok(countHints(html) >= 2, '策略卡与高级区各要有一个「?」入口')
  assert.match(html, /data-tooltip="memory\.policy\.hint"/, '策略口径挂在标题的「?」上')
  assert.match(html, /data-tooltip="memory\.dedupeHint"/, '合并判据挂在按钮旁的「?」上')
  const visible = visibleText(html)
  for (const gone of ['memory.policy.hint', 'memory.dedupeHint']) {
    assert.equal(visible.includes(gone), false, `说明文字不该同时留在正文里：${gone}`)
  }
})

test('读取失败时页头把原因显示出来（带 role="alert"）：不许只把状态字段改掉、界面一个字不说', async () => {
  // 2026-09-26 客户端审计：`state.error` 曾经只影响"能不能编辑"，页面上一个字都不显示 ——
  // 用户看到的是一个空列表，以为"我没有记忆"，而不是"读不到了"。
  const controller = new MemoryWorkbenchController()
  controller.attach(createFakeChannel(sampleDoc(), { failDescribe: '远端炸了' }).channel)
  await waitReady(controller)

  const html = render(createElement(MemoryPage, { t: (key) => String(key), controller }))
  assert.match(html, /role="alert"/, '失败提示要能被读屏播报')
  assert.match(html, /远端炸了/, '宿主给的原因原样显示')
})

test('没有待确认条目时不渲染待确认区（空卡片只会让页面更长）', async () => {
  const doc = sampleDoc()
  doc.entries = doc.entries.filter((item) => item.status !== 'pending')
  const controller = new MemoryWorkbenchController()
  controller.attach(createFakeChannel(doc).channel)
  await waitReady(controller)

  const html = render(createElement(MemoryPage, { t: (key) => String(key), controller }))
  assert.equal(html.includes('memory.confirm'), false, '没有待确认条目就不该出现确认按钮')
  assert.match(html, /memory\.active/, '活跃列表照常显示')

  const empty = new MemoryWorkbenchController()
  const emptyDoc = sampleDoc()
  emptyDoc.entries = []
  empty.attach(createFakeChannel(emptyDoc).channel)
  await waitReady(empty)
  const emptyHtml = render(createElement(MemoryPage, { t: (key) => String(key), controller: empty }))
  assert.match(emptyHtml, /memory\.empty/, '一条都没有时显示空态文案')
})

test('极简模式：宿主探测到注入被丢弃时，页面顶部出现警告条（含技术原因）', async () => {
  const doc = sampleDoc()
  doc.degraded = true
  const controller = new MemoryWorkbenchController()
  controller.attach(createFakeChannel(doc).channel)
  await waitReady(controller)

  const html = render(createElement(MemoryPage, { t: (key) => String(key), controller }))
  assert.match(html, /memory\.degraded\.title/, '警告条标题必须渲染')
  assert.match(html, /memory\.degraded\.body/)
  assert.match(html, /memory\.degraded\.tech/, '要给出技术原因')
  assert.ok(html.indexOf('memory.degraded.title') < html.indexOf('memory.policy'), '警告条在页面最上方')
})

test('高级开关：点下去**立刻**翻、全程不闪 loading；回读后仍是新值（用户 2026-09-26 反馈）', async () => {
  // 用可控的通道：写入卡住不返回，好观察"写回之前界面已经变成什么样"。
  // 写入成功时像宿主那样**把补丁合并进文档**（否则回读会把乐观值冲掉，那是夹具的错不是产品的错）。
  // 样例文档里没有 advanced 段（那一段在真实投影里是宿主算出来的）——这里补上，测试才动得了开关。
  const doc = { ...sampleDoc(), advanced: { longTerm: true, work: true, session: true, maxInject: 3, decay: true } }
  let release = () => {}
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const channel = {
    async describe() {
      return {
        ok: true,
        value: {
          writable: true,
          namespaces: [
            { ns: MEMORY_NAMESPACE, value: doc, revision: 3 },
            { ns: 'humanity', value: {}, revision: 9 },
          ],
        },
      }
    },
    async update(_ns, patch) {
      await gate
      Object.assign(doc.advanced, patch.modules.memory.advanced)
      return { ok: true, value: undefined }
    },
  }
  const controller = new MemoryWorkbenchController()
  controller.attach(channel)
  await waitReady(controller)

  // 记录状态机的每一步，事后核对"有没有经过 loading"。
  const seen = []
  const unsubscribe = controller.subscribe(() => {
    const snapshot = controller.getSnapshot()
    seen.push({ status: snapshot.status, work: snapshot.advanced.work })
  })

  const pending = controller.setAdvanced({ work: false })
  // 写回还没返回：开关必须已经翻了（官方 Switch 的滑块动画靠这一拍）。
  assert.equal(controller.getSnapshot().advanced.work, false, '乐观：点下去就翻，不等往返')
  assert.equal(controller.getSnapshot().policy.customized, true, '右侧「当前模式」同步显示成自定义')
  // 关键：配置写入**不许**占整页的 busy —— 一占，29 条记忆的按钮与作用域下拉会一起变灰再变亮，
  // 那就是用户看到的"闪一下"（2026-09-26 第三轮才定位到）。各行自管 busy（官方 DeveloperToolsRow 写法）。
  assert.equal(controller.getSnapshot().busy, '', '条目操作标记保持空闲 ⇒ 列表里的控件不许跟着变灰')
  // 写入是**排队**发出的（下一个微任务才落到 RPC 上），所以让一拍再看标记。
  await Promise.resolve()
  assert.equal(controller.getSnapshot().configBusy, 'advanced', '配置写入只亮自己的标记')

  release()
  await pending
  unsubscribe()
  assert.equal(controller.getSnapshot().advanced.work, false, '回读之后仍是新值（以宿主为准）')
  assert.deepEqual(
    seen.filter((step) => step.status === 'loading'),
    [],
    '写回期间不许经过 loading（那一拍就是"闪屏"的来源）',
  )
})

test('高级开关写失败：翻回原值并如实说明原因（不许假装成功）', async () => {
  const { channel } = createFakeChannel(sampleDoc(), { failUpdate: '并发冲突：修订号过期' })
  const controller = new MemoryWorkbenchController()
  controller.attach(channel)
  await waitReady(controller)
  assert.equal(controller.getSnapshot().advanced.work, true)

  await controller.setAdvanced({ work: false })

  const state = controller.getSnapshot()
  assert.equal(state.advanced.work, true, '宿主没收下 ⇒ 界面翻回去')
  assert.match(state.error ?? '', /并发冲突/, '原因如实显示')
  assert.equal(state.status, 'ready', '失败也不该把整页打成失败态')
})

test('宿主重投影慢一拍：回读给出旧值时，开关也不许弹回去（2026-09-26 真机「点了没反应」）', async () => {
  // 真实的时序：配置写回成功 → 宿主**异步**重投影 → 投影才是新值。
  // 而我们在 update 一返回就回读，那一刻读到的还是上一次投影。
  const doc = { ...sampleDoc(), advanced: { longTerm: true, work: true, session: true, maxInject: 3, decay: true } }
  const channel = {
    async describe() {
      return {
        ok: true,
        value: {
          writable: true,
          namespaces: [
            { ns: MEMORY_NAMESPACE, value: doc, revision: 3 },
            { ns: 'humanity', value: {}, revision: 9 },
          ],
        },
      }
    },
    // 宿主收下了写入，但投影还是旧的（重投影是异步的）。
    async update() {
      return { ok: true, value: undefined }
    },
  }
  const controller = new MemoryWorkbenchController()
  controller.attach(channel)
  await waitReady(controller)

  await controller.setAdvanced({ work: false })
  const afterWrite = controller.getSnapshot()
  assert.equal(afterWrite.advanced.work, false, '投影还没更新：界面要停在用户拨的值上，不许弹回')
  assert.equal(afterWrite.policy.customized, true, '「当前模式」同样不许弹回')

  // 宿主重投影落下来了：这一次读必须收敛，并且本地改动随之撤掉（之后以宿主为准）。
  Object.assign(doc.advanced, { work: false, customized: true })
  await controller.load()
  assert.equal(controller.getSnapshot().advanced.work, false, '收敛后仍是同一个值')
  assert.equal(controller.getSnapshot().policy.customized, true)
})
