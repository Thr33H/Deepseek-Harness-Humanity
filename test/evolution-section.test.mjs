/**
 * 自进化工作台的**命令消费**回归钉。
 *
 * 这一段以前只在真机上点过，没有测试。它最容易坏在三个地方：
 * 1. **没翻开的那一天不能有正文**（门在宿主这边，不是前端藏起来）；
 * 2. 翻开之后要落盘成 `openedAt`（重启也算数），并把结果写回通知；
 * 3. 「一天最多醒几次」要真的写进套件配置（写不进去必须如实说）。
 *
 * 用假 settings 替身走完整条路：客户端写命令槽 → onChange → 宿主消费 → 重新投影。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installEvolutionSection } from '../lib/evolution/section.js'

/** 一个按键存文档的假文档表。 */
function fakeDocuments(seed = {}) {
  const store = new Map(Object.entries(seed))
  return {
    read: (key) => (store.has(key) ? { value: store.get(key), revision: 1, updatedAt: '' } : undefined),
    write: async (key, value) => {
      store.set(key, value)
      return { value, revision: 2, updatedAt: '' }
    },
    merge: async () => {
      throw new Error('自进化只用 write')
    },
    list: () => [...store.keys()],
    peek: (key) => store.get(key),
  }
}

/**
 * 假设置服务：把我们真正用到的那四个方法做出来。
 *
 * `installSection` 会把钩子交出来，测试直接调 `onChange()` 模拟"客户端写了命令槽"。
 */
function fakeSettings() {
  const docs = new Map()
  const hooks = new Map()
  const updates = []
  const settings = {
    get(ns) {
      return docs.get(ns)
    },
    replace(ns, value) {
      docs.set(ns, value)
      hooks.get(ns)?.onChange?.(value)
    },
    update(ns, patch) {
      updates.push({ ns, patch })
      const current = docs.get(ns) ?? {}
      docs.set(ns, { ...current, ...patch })
      hooks.get(ns)?.onChange?.(docs.get(ns))
    },
    installSection(_ctx, ns, _schema, base, installed) {
      docs.set(ns, base)
      hooks.set(ns, installed)
    },
  }
  return { settings, docs, hooks, updates }
}

/** 假上下文：注入立刻成功，效应直接忽略。 */
function fakeContext(settings) {
  return {
    inject: (_deps, callback) => {
      callback({ settings })
      return () => {}
    },
    effect: () => () => {},
  }
}

/** 造一份她的状态。 */
function stateOf(overrides = {}) {
  return {
    taskId: 'task-1',
    roomSessionId: 'session-room',
    lastWakeAt: '2026-11-24T04:00:00.000Z',
    nextAt: '2026-11-24T06:00:00.000Z',
    dayKey: '2026-11-24',
    dayCount: 2,
    energy: 58,
    energyAt: '2026-11-24T04:00:00.000Z',
    sleepingSince: '',
    tokensToday: 1000,
    tokensDayKey: '2026-11-24',
    lastError: '',
    lastSettleError: '',
    lastAttemptAt: '2026-11-24T04:00:00.000Z',
    ...overrides,
  }
}

/** 造一份日记（一篇合着、一篇已翻开）。 */
function diaryOf() {
  return {
    entries: [
      { date: '2026-11-22', text: '那天我查了潮汐。', createdAt: '2026-11-22T15:00:00.000Z', openedAt: '2026-11-23T02:00:00.000Z', noticedAt: '' },
      { date: '2026-11-23', text: '那天我没做什么。', createdAt: '2026-11-23T15:00:00.000Z', openedAt: '', noticedAt: '' },
    ],
  }
}

/** 装一个工作台并把首帧投影取出来。 */
async function mount(overrides = {}) {
  const documents = fakeDocuments({
    'humanity-evolution-state': stateOf(overrides.state),
    'humanity-diary': overrides.diary ?? diaryOf(),
  })
  const { settings, docs, hooks, updates } = fakeSettings()
  const section = installEvolutionSection(fakeContext(settings), { info() {}, warn() {}, error() {} }, {
    documents: () => documents,
    state: () => documents.peek('humanity-evolution-state'),
    settings: () => ({ maxPerDay: 8 }),
    enabled: () => true,
    started: () => true,
    works: async () => [],
    threads: async () => [],
    readWork: async () => undefined,
  })
  await section.refresh()
  return { documents, settings, docs, hooks, updates, section }
}

test('工作台首帧：合着的日记不给正文，翻开过的才给', async () => {
  const { docs } = await mount()
  const view = docs.get('humanity-evolution')
  assert.equal(view.diary.length, 2)
  const closed = view.diary.find((entry) => entry.date === '2026-11-23')
  const opened = view.diary.find((entry) => entry.date === '2026-11-22')
  assert.equal(closed.text, '', '没翻开的那天不许下发正文')
  assert.equal(opened.text, '那天我查了潮汐。', '翻开过的才给')
  assert.equal(view.status.dayCount, 2)
  assert.equal(view.status.maxPerDay, 8)
})

test('翻开命令：落盘 openedAt、下发正文、写回通知', async () => {
  const { documents, docs, hooks } = await mount()
  const before = documents.peek('humanity-diary')
  const target = before.entries.find((entry) => entry.date === '2026-11-23')
  assert.equal(target.openedAt, '')

  // 模拟客户端：把命令写进命令槽，然后触发一次 onChange。
  docs.set('humanity-evolution', { ...docs.get('humanity-evolution'), request: { op: 'open', date: '2026-11-23' } })
  hooks.get('humanity-evolution').onChange()
  await new Promise((resolve) => setTimeout(resolve, 20))

  const after = documents.peek('humanity-diary')
  const opened = after.entries.find((entry) => entry.date === '2026-11-23')
  assert.notEqual(opened.openedAt, '', '翻开时刻要落盘（重启也算数）')
  const view = docs.get('humanity-evolution')
  assert.equal(view.diary.find((entry) => entry.date === '2026-11-23').text, '那天我没做什么。')
  assert.match(view.notice, /2026-11-23/, '要告诉用户翻开了哪一天')
  assert.deepEqual(view.request, { op: '', date: '' }, '命令槽消费完要清空')
})

test('改次数上限：写进套件配置；越界不许写', async () => {
  const { docs, hooks, updates } = await mount()
  docs.set('humanity-evolution', { ...docs.get('humanity-evolution'), request: { op: 'cap', date: '6' } })
  hooks.get('humanity-evolution').onChange()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(updates.length, 1, '要真的写一次配置')
  assert.equal(updates[0].ns, 'humanity')
  assert.equal(updates[0].patch.modules.evolution.maxWakesPerDay, 6)

  // 越界值：不写配置，只给一句人话。
  docs.set('humanity-evolution', { ...docs.get('humanity-evolution'), request: { op: 'cap', date: '99' } })
  hooks.get('humanity-evolution').onChange()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(updates.length, 1, '越界不该写进配置')
  assert.match(docs.get('humanity-evolution').notice, /0/, '要说清合法范围')
})

test('读不到文件时给原因，不假装下载成功', async () => {
  const { docs, hooks } = await mount()
  docs.set('humanity-evolution', { ...docs.get('humanity-evolution'), request: { op: 'read', date: 'note.md' } })
  hooks.get('humanity-evolution').onChange()
  await new Promise((resolve) => setTimeout(resolve, 20))
  const view = docs.get('humanity-evolution')
  assert.match(view.notice, /读不到/, '要说清为什么没有文件')
  assert.deepEqual(view.transfer, { name: '', mime: '', base64: '' }, '失败时不该带任何字节')
})
