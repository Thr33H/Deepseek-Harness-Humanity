/**
 * 自进化页的渲染回归钉。
 *
 * 钉三件事（都是"这一页存在"之外真正会坏的地方）：
 * 1. 她的今天：读不到时**如实说读不到**，不编数字；
 * 2. 日记：没打开的那一天**不出现正文**，只出现日期；
 * 3. 作品：文本给名字与大小。
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

import { loadClientBundle } from './helpers/client-bundle.mjs'

const nodeRequire = createRequire(import.meta.url)
const render = (element) => nodeRequire('react-dom/server').renderToStaticMarkup(element)

/** 造一个只回一份投影的假通道。 */
function fakeChannel(doc) {
  return {
    async describe() {
      // 与真机一致：describe 返回的是**列表**，不是单个命名空间。
      return { ok: true, value: { writable: true, namespaces: [{ ns: 'humanity-evolution', value: doc, revision: 1 }] } }
    },
    async replace() {
      return { ok: true, value: { revision: 2 } }
    },
  }
}

const BASE = {
  status: {
    enabled: true,
    started: true,
    sleeping: false,
    energy: 34,
    dayCount: 3,
    maxPerDay: 8,
    lastWakeAt: '2026-11-24T04:38:09.667Z',
    nextAt: '2026-11-24T06:29:10.763Z',
    taskReady: true,
    lastError: '',
  },
  diary: [
    { date: '2026-11-23', opened: false, openedAt: '', text: '' },
    { date: '2026-11-22', opened: true, openedAt: '2026-11-23T02:00:00.000Z', text: '今天我去查了潮汐的事。' },
  ],
  works: [{ name: 'note.md', size: 2048, updatedAt: '2026-11-24T05:00:00.000Z', kind: 'text', preview: '查了潮汐' }],
  threads: ['把潮汐那笔账查清楚'],
  transfer: { name: '', mime: '', base64: '' },
  request: { op: '', date: '' },
  notice: '',
}

/** 词典：直接回键名，断言看的是结构不是文案。 */
const t = (key) => String(key)
const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

test('自进化页：状态、日记、作品都渲染出来', async () => {
  const client = await loadClientBundle()
  const controller = new client.EvolutionWorkbenchController()
  controller.attach(fakeChannel(BASE))
  await settle()
  const html = render(nodeRequire('react').createElement(client.EvolutionPage, { t, controller }))

  assert.match(html, /workbench\.evolution\.today/)
  assert.match(html, /workbench\.evolution\.energy\.tired/, '精力 34 ⇒ 有点累那一档')
  assert.match(html, /workbench\.evolution\.wakesValue/, '要显示今天几次与上限')
  assert.match(html, /note\.md/, '作品要列出来')
  assert.match(html, /把潮汐那笔账查清楚/, '她自己攒的事要看得见')
})

test('自进化页：没翻开的日记不给正文，翻开过的才给', async () => {
  const client = await loadClientBundle()
  const controller = new client.EvolutionWorkbenchController()
  controller.attach(fakeChannel(BASE))
  await settle()
  const html = render(nodeRequire('react').createElement(client.EvolutionPage, { t, controller }))

  assert.match(html, /2026-11-23/, '日期要显示（那天还没打开）')
  assert.ok(!html.includes('翻开就收不回去了'), '默认态不该出现确认提示')
  assert.match(html, /今天我去查了潮汐的事/, '打开过的那篇才显示正文')
})

test('自进化页：她自己整理的那块要看得见（队列 + 上次写了什么）', async () => {
  const client = await loadClientBundle()
  const controller = new client.EvolutionWorkbenchController()
  controller.attach(fakeChannel({
    ...BASE,
    grow: {
      candidates: [{ text: '爱吃糖葫芦', about: 'user', section: '关系', count: 2, days: 2 }],
      lastRun: { at: '2026-11-24T15:00:00.000Z', wrote: ['说话风格'], queued: ['爱吃糖葫芦'], note: '' },
    },
  }))
  await settle()
  const html = render(nodeRequire('react').createElement(client.EvolutionPage, { t, controller }))

  assert.match(html, /workbench\.evolution\.grow\.title/)
  assert.match(html, /爱吃糖葫芦/, '攒着的候选要列出来')
  assert.match(html, /workbench\.evolution\.grow\.aboutUser/, '要标出"关于他"')
  assert.match(html, /workbench\.evolution\.grow\.lastRun/, '上次整理的时刻要显示')
  assert.match(html, /workbench\.evolution\.grow\.wrote/, '上次写进了哪一节要显示')
})

test('自进化页：她留给你的那一块要看得见（待送 / 送过 / 看没看）', async () => {
  const client = await loadClientBundle()
  const controller = new client.EvolutionWorkbenchController()
  controller.attach(fakeChannel({
    ...BASE,
    tell: {
      pending: '还有一句想说',
      pendingShow: '',
      lastAt: '2026-11-24T15:00:00.000Z',
      lastText: '昨天我找过你',
      lastShow: 'note.md',
      unread: true,
      lastReason: '',
    },
  }))
  await settle()
  const html = render(nodeRequire('react').createElement(client.EvolutionPage, { t, controller }))

  assert.match(html, /workbench\.evolution\.tell\.title/)
  assert.match(html, /还有一句想说/, '待送的那句要显示')
  assert.match(html, /昨天我找过你/, '上一次说的话要显示')
  assert.match(html, /note\.md/, '附带给他看的东西要显示')
  assert.match(html, /workbench\.evolution\.tell\.unread/, '没看过的要标出来')
})

test('自进化页：读不到时如实说读不到，不编数字', async () => {
  const client = await loadClientBundle()
  const controller = new client.EvolutionWorkbenchController()
  const html = render(nodeRequire('react').createElement(client.EvolutionPage, { t, controller }))
  assert.match(html, /workbench\.metric\.unavailable/)
})
