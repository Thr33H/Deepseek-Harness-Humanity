/**
 * 自进化客户端测试：两端一致性（命名空间/命令集）、投影解析、控制器状态机、
 * 命令与配置写入的补丁形状、侧栏红点与待确认页渲染。
 *
 * 与 `client-memory.test.mjs` 同一取舍：通道是按官方契约实现的假件（真设置服务链路
 * 由 `evolution-section.test.mjs` 覆盖）；代码从**打包产物** `lib/client.js` 里取——
 * 那才是 DSH 会加载的东西。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'

import { EVOLUTION_NAMESPACE as HOST_NS, EVOLUTION_OPS as HOST_OPS } from '../lib/evolution/constants.js'
import { loadClientBundle } from './helpers/client-bundle.mjs'
import { CARD_SKELETON, countHints, visibleText } from './helpers/markup.mjs'

const nodeRequire = createRequire(import.meta.url)
const { createElement } = nodeRequire('react')
const render = (element) => nodeRequire('react-dom/server').renderToStaticMarkup(element)

const client = await loadClientBundle()
const {
  EVOLUTION_NAMESPACE,
  EVOLUTION_OPS,
  EvolutionWorkbenchController,
  asEvolutionDocument,
  asEvolutionConfig,
  emptyEvolutionState,
  HumanityPanelIconWithBadge,
  PendingDetails,
  MemoryWorkbenchController,
} = client

const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

/** 宿主投影的一份样例。 */
function sampleDoc(overrides = {}) {
  return {
    runs: [
      {
        id: 'r1',
        mode: 'dream',
        trigger: 'scheduled',
        status: 'completed',
        startedAt: '2026-09-25T03:00:00.000Z',
        finishedAt: '2026-09-25T03:01:00.000Z',
        scannedSessions: 2,
        parsedEvents: 30,
        memoriesWritten: 1,
        proposalsCreated: 2,
        inputTokens: 900,
        outputTokens: 300,
        calls: 2,
        narrative: '梦见 boot 清单在闪烁。',
        insights: ['部署焦虑反复出现'],
        error: '',
      },
    ],
    proposals: [
      { id: 'p1', kind: 'persona', title: '身份卡字段：归属地 → 示例城市', reason: '用户明确说过', diff: '', status: 'pending', createdAt: '2026-09-25T03:01:00.000Z', decidedAt: '' },
      { id: 'p2', kind: 'skill', title: '新技能：weekly-report', reason: '重复出现', diff: '', status: 'applied', createdAt: '2026-09-24T03:01:00.000Z', decidedAt: '2026-09-24T09:00:00.000Z' },
    ],
    pendingCounts: { memory: 1, persona: 1, skill: 0, route: 0, total: 2 },
    status: { enabled: true, storeReady: true, scanReady: true, modelReady: false, skillsReady: true },
    nextRunAt: Date.parse('2026-09-26T03:00:00.000Z'),
    baselineAt: '2026-09-20T00:00:00.000Z',
    dailyCalls: 4,
    dailyCallCap: 20,
    notice: '梦境整理已启动',
    request: { op: '', id: '', mode: '', rescanKind: '', rescanValue: '' },
    ...overrides,
  }
}

/** 造一个按契约实现的假通道（describe/update；记录写入）。 */
function fakeChannel(options = {}) {
  const updates = []
  const doc = options.doc ?? sampleDoc()
  const config = options.config ?? { modules: { evolution: asEvolutionConfig(undefined) } }
  return {
    updates,
    async describe() {
      if (options.failDescribe !== undefined) return { ok: false, error: { message: options.failDescribe } }
      return {
        ok: true,
        value: {
          writable: options.writable ?? true,
          namespaces: options.present === false ? [] : [
            { ns: EVOLUTION_NAMESPACE, value: doc, revision: 5 },
            { ns: 'humanity', value: config, revision: 9 },
          ],
        },
      }
    },
    async update(ns, patch, revision) {
      updates.push({ ns, patch, revision })
      if (options.failUpdate !== undefined) return { ok: false, error: { message: options.failUpdate } }
      return { ok: true, value: undefined }
    },
  }
}

/** 键名当译文的 t（渲染测试用）。 */
const keyT = (key) => key

test('两端一致：命名空间与命令集必须与宿主常量逐字相同（写错=命令进错槽）', () => {
  assert.equal(EVOLUTION_NAMESPACE, HOST_NS)
  assert.equal(EVOLUTION_NAMESPACE, 'humanity-evolution')
  assert.deepEqual([...EVOLUTION_OPS], [...HOST_OPS])
})

test('投影解析：完整文档逐字段落地；坏顶层抛、坏字段兜底', () => {
  const doc = asEvolutionDocument(sampleDoc())
  assert.equal(doc.runs.length, 1)
  assert.equal(doc.runs[0].narrative, '梦见 boot 清单在闪烁。')
  assert.deepEqual(doc.runs[0].insights, ['部署焦虑反复出现'])
  assert.equal(doc.pendingCounts.total, 2)
  assert.equal(doc.evolutionStatus.modelReady, false, '降级状态必须如实带出（工作台显示原因）')
  assert.equal(doc.nextRunAt, Date.parse('2026-09-26T03:00:00.000Z'))
  assert.equal(doc.dailyCalls, 4)

  assert.throws(() => asEvolutionDocument(null), /不是对象/)
  const patched = asEvolutionDocument({ runs: '坏形状', pendingCounts: { total: '很多' } })
  assert.deepEqual(patched.runs, [])
  assert.equal(patched.pendingCounts.total, 0)
})

test('配置解析：缺失回工程默认值（与宿主 schema 默认一致）', () => {
  const config = asEvolutionConfig(undefined)
  assert.equal(config.schedule.mode, 'idle')
  assert.equal(config.schedule.idleMinutes, 30)
  assert.equal(config.budget.dailyCallCap, 20)
  assert.equal(config.scan.includeSubSessions, false)
  // 2026-09-26：单次输出上限 2000 → 4000（旧值会把稍长的解析结果截断成 truncated 失败）。
  // 客户端这份默认值必须与宿主 schema **同一个数**，否则"没填过"的配置在界面上显示成另一个值。
  assert.equal(config.budget.maxOutputTokensPerCall, 4000, '与 EXPECTED_DEFAULTS 同源')
  assert.equal(config.budget.maxSessionsPerRun, 5)
})

test('控制器：接通道读投影 → ready；命名空间缺失 → failed 且如实说明', async () => {
  const controller = new EvolutionWorkbenchController()
  controller.attach(fakeChannel())
  await settle()
  let snapshot = controller.getSnapshot()
  assert.equal(snapshot.status, 'ready')
  assert.equal(snapshot.revision, 5)
  assert.equal(snapshot.configRevision, 9)
  assert.equal(snapshot.pendingCounts.total, 2)

  const missing = new EvolutionWorkbenchController()
  missing.attach(fakeChannel({ present: false }))
  await settle()
  snapshot = missing.getSnapshot()
  assert.equal(snapshot.status, 'failed')
  assert.match(snapshot.error, /尚未就绪/)
})

test('控制器：命令走 evolution 命名空间并带修订号；配置走 humanity 命名空间', async () => {
  const channel = fakeChannel()
  const controller = new EvolutionWorkbenchController()
  controller.attach(channel)
  await settle()

  await controller.runNow()
  assert.deepEqual(channel.updates[0], {
    ns: EVOLUTION_NAMESPACE,
    patch: { request: { op: 'run', id: '', mode: 'incremental', rescanKind: '', rescanValue: '' } },
    revision: 5,
  })

  await controller.dream()
  assert.equal(channel.updates[1].patch.request.mode, 'dream')

  await controller.rescan({ kind: 'days', value: '7' })
  assert.deepEqual(channel.updates[2].patch.request, { op: 'rescan', id: '', mode: '', rescanKind: 'days', rescanValue: '7' })

  await controller.approve('p1')
  assert.deepEqual(channel.updates[3].patch.request, { op: 'approve', id: 'p1', mode: '', rescanKind: '', rescanValue: '' })

  await controller.setEvolutionConfig({ schedule: { mode: 'daily' } })
  const configWrite = channel.updates[4]
  assert.equal(configWrite.ns, 'humanity', '调度/预算写顶层配置（宿主的 onChanged 会重排定时器）')
  assert.deepEqual(configWrite.patch, { modules: { evolution: { schedule: { mode: 'daily' } } } })
  assert.equal(configWrite.revision, 9)
})

test('技能保存被宿主拒绝时返回 false（页面据此**不关**表单）：用户按的保存不能悄无声息', async () => {
  // 2026-09-26 客户端审计：`SkillsPage` 原来不管成败都关表单，用户按了保存毫无反馈。
  // 现在页面只在 `ok === true` 时收起，所以"宿主拒绝"这条路径必须真的回 false。
  const channel = fakeChannel({ failUpdate: '技能名不符合 kebab-case' })
  const controller = new EvolutionWorkbenchController()
  controller.attach(channel)
  await settle()

  const ok = await controller.updateSkill({ name: 'Weekly Report', description: '说明', content: '正文' })

  assert.equal(ok, false, '必须回 false（true 会让表单关掉、像成功了一样）')
  assert.match(controller.getSnapshot().error ?? '', /kebab-case/)
  assert.equal(controller.getSnapshot().busy, '', '忙碌标记要清掉（否则按钮永久禁用）')
  assert.equal(channel.updates[0].patch.request.op, 'skill-update')
  assert.equal(channel.updates[0].patch.request.skillName, 'Weekly Report', '表单三字段都要发出去')
})

test('控制器：只读通道拒绝写入；detach 后回到未就绪但保留数据', async () => {
  const channel = fakeChannel({ writable: false })
  const controller = new EvolutionWorkbenchController()
  controller.attach(channel)
  await settle()
  await controller.runNow()
  assert.equal(channel.updates.length, 0, '只读时一个字节都不写')
  assert.match(controller.getSnapshot().error, /只读/)

  controller.detach()
  assert.equal(controller.getSnapshot().status, 'unavailable')
  assert.equal(controller.getSnapshot().runs.length, 1, '用户正在看的内容不该凭空消失')
})

test('侧栏红点：有待确认画点、没有不画；订阅面缺失退化为纯图标（外壳级组件不许崩）', async () => {
  const controller = new EvolutionWorkbenchController()
  controller.attach(fakeChannel())
  await settle() // 投影是异步读的：等状态机到 ready 再渲染
  const withBadge = render(
    createElement(HumanityPanelIconWithBadge, {
      size: 16,
      subscribe: controller.subscribe,
      getCount: () => controller.getSnapshot().pendingCounts.total,
    }),
  )
  assert.match(withBadge, /border-radius:50%/, '待确认 2 条：红点必须在')

  const zero = new EvolutionWorkbenchController()
  const noBadge = render(
    createElement(HumanityPanelIconWithBadge, {
      size: 16,
      subscribe: zero.subscribe,
      getCount: () => zero.getSnapshot().pendingCounts.total,
    }),
  )
  assert.doesNotMatch(noBadge, /border-radius:50%/, '没有待确认：不画点')

  const bare = render(createElement(HumanityPanelIconWithBadge, { size: 16 }))
  assert.ok(bare.length > 0, '订阅面缺失也要画出图标（替身环境里字形是直通元素，只断言非空）')
  assert.doesNotMatch(bare, /border-radius:50%/)
})

test('待确认页：记忆与提案两个区都在，计数徽标如实', async () => {
  const evolution = new EvolutionWorkbenchController()
  evolution.attach(fakeChannel())
  const memory = new MemoryWorkbenchController()
  memory.attach({
    describe: async () => ({
      ok: true,
      value: {
        writable: true,
        namespaces: [
          {
            ns: 'humanity-memory',
            revision: 2,
            value: {
              entries: [
                { fingerprint: 'm1', scope: 'long-term', status: 'pending', content: '用户的门禁密码', tags: [], importance: 3, sensitive: true, pinned: false, conflictCount: 0, updatedAt: '2026-09-25T00:00:00.000Z' },
              ],
              policy: { mode: 'balanced', scopes: {}, autoInject: true, autoWrite: true, injectLimit: 3, relevanceThreshold: 0.35, decay: true, vector: false, customized: false },
              advanced: { longTerm: true, work: true, session: true, maxInject: 3, decay: true },
              notice: '',
              degraded: false,
              request: { op: '', fingerprint: '' },
            },
          },
        ],
      },
    }),
    update: async () => ({ ok: true, value: undefined }),
  })
  await settle()

  const markup = render(createElement(PendingDetails, { t: keyT, evolution, memory }))
  // 标题与计数徽标归 `PendingCard`（常驻顶部那张卡），明细只管"有哪些待办"。
  assert.doesNotMatch(markup, /evolution\.pending\.title/, '明细不自带标题（避免与卡片重复）')
  assert.match(markup, /用户的门禁密码/, '记忆待确认条目必须出现在统一待确认页')
  assert.match(markup, /身份卡字段：归属地 → 示例城市/, 'pending 提案在列')
  assert.doesNotMatch(markup, /weekly-report/, '已处理提案不出现在待确认页')
})

test('空态：没有通道时页面渲染"未就绪"而不是崩溃', () => {
  const controller = new EvolutionWorkbenchController()
  const { EvolutionPage } = client
  const markup = render(createElement(EvolutionPage, { t: keyT, controller }))
  assert.match(markup, /evolution\.title/)
  assert.equal(emptyEvolutionState().status, 'idle')
})

test('说明收进「?」：自进化页的口径挂在标题旁，正文里不再有说明段（用户 2026-09-26）', async () => {
  const controller = new EvolutionWorkbenchController()
  controller.attach(fakeChannel())
  await settle()
  const { EvolutionPage } = client
  const markup = render(createElement(EvolutionPage, { t: keyT, controller }))

  assert.match(markup, /data-tooltip="evolution\.subtitle"/, '模块介绍挂在运行状态标题旁')
  assert.match(markup, /data-tooltip="evolution\.action\.hint"/, '手动触发的口径挂在标题旁')
  assert.match(markup, /data-tooltip="evolution\.rescan\.hint"/, '回扫的口径挂在标题旁')
  assert.match(markup, /data-tooltip="evolution\.schedule\.hint"/, '调度的口径挂在标题旁')
  assert.match(markup, /data-tooltip="evolution\.budget\.hint"/, '预算的口径挂在标题旁')
  assert.ok(countHints(markup) >= 5, '这一页至少要有五个「?」入口')

  // 控件纪律（用户 2026-09-26）：下拉与数字输入一律走官方原语 —— 裸 <select> 不吃 DSH 令牌，
  // 深色主题下是一块白底补丁；数字框还带浏览器自绘的上下箭头。
  assert.equal(markup.includes('<select'), false, '不许再用裸 <select>：下拉一律走官方 Menu')
  assert.match(markup, /data-menu-value="idle"/, '调度方式挂在官方下拉上，并显示当前值')
  assert.match(markup, /data-menu-value="days"/, '回扫范围也是官方下拉')

  const visible = visibleText(markup)
  for (const gone of ['evolution.subtitle', 'evolution.action.hint', 'evolution.rescan.hint', 'evolution.schedule.hint', 'evolution.budget.hint']) {
    assert.equal(visible.includes(gone), false, `说明文字不该同时留在正文里：${gone}`)
  }
})

test('提案列表：待确认摊开理由、已处理压成一行（点箭头才展开）', async () => {
  const controller = new EvolutionWorkbenchController()
  controller.attach(fakeChannel())
  await settle()
  const { EvolutionPage } = client
  const markup = render(createElement(EvolutionPage, { t: keyT, controller }))

  // 待确认：理由是他要据此决定的东西，必须直接看得见。
  assert.match(markup, /用户明确说过/, '待确认提案的理由要摊开')
  assert.match(markup, /evolution\.proposal\.approve/, '待确认提案要有批准按钮')

  // 已处理：压成一行 —— 理由默认**不渲染**（历史备查，不该占满屏幕）。
  assert.equal(markup.includes('重复出现'), false, '已处理提案的理由默认收起')
  assert.match(markup, /新技能：weekly-report/, '标题仍然看得见（一行摘要）')
  assert.match(markup, /aria-expanded="false"/, '展开控件要如实标注状态')
  assert.match(markup, /evolution\.proposal\.details/, '展开控件要有无障碍名')

  // 统一卡片骨架：提案与运行记录走的是与记忆/技能同一副骨架。
  assert.ok(markup.includes(CARD_SKELETON), '提案/时间线要用统一骨架')

  // 面板标题旁挂说明（P-053：解释进「?」，不铺正文）。
  assert.match(markup, /data-tooltip="evolution\.proposals\.hint"/, '提案是什么、要不要你点头，挂在「?」里')
})

test('运行时间线：标签与时刻一行、统计一行；时刻按 MM-DD HH:mm 显示（完整 ISO 进 title）', async () => {
  const controller = new EvolutionWorkbenchController()
  controller.attach(fakeChannel())
  await settle()
  const { EvolutionPage } = client
  const markup = render(createElement(EvolutionPage, { t: keyT, controller }))

  // 原来整张卡套着单行布局，标签/原始 ISO/统计/注记被挤在同一行 —— 现在竖排。
  // HTML 属性名大小写不敏感：React 的静态渲染输出的是 dateTime，浏览器里等价于 datetime。
  assert.match(markup, /<time[^>]*dateTime="2026-09-25T03:00:00\.000Z"[^>]*title="2026-09-25T03:00:00\.000Z"[^>]*>09-25 03:00<\/time>/, '时刻要短显示，完整 ISO 留在 title 与 dateTime 上')
  assert.equal(markup.includes('2026-09-25T03:00:00.000Z</'), false, '原始 ISO 不再直接铺在界面上')
  // 这个文件用键名兜底当译文（keyT），所以统计行渲染出来就是键名 —— 数字替换由字典层保证。
  assert.match(markup, /evolution\.run\.stats/, '统计行仍然在')
  assert.match(markup, /data-tooltip="evolution\.timeline\.hint"/, '时间线是什么，挂在「?」里')
  assert.match(markup, /aria-expanded="false"/, '梦境叙事用带状态的展开按钮')
})
