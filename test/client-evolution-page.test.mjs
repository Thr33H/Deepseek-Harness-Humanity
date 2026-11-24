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
      return { ok: true, value: { value: doc, revision: 1 } }
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

test('自进化页：读不到时如实说读不到，不编数字', async () => {
  const client = await loadClientBundle()
  const controller = new client.EvolutionWorkbenchController()
  const html = render(nodeRequire('react').createElement(client.EvolutionPage, { t, controller }))
  assert.match(html, /workbench\.metric\.unavailable/)
})
