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
 * 假设置服务：把我们真正用到的那几个方法做出来。
 *
 * `installSection` 会把钩子交出来，测试直接调 `onChange()` 模拟"客户端写了命令槽"。
 */
function fakeSettings() {
  const docs = new Map()
  const hooks = new Map()
  const settings = {
    get(ns) {
      return docs.get(ns)
    },
    replace(ns, value) {
      docs.set(ns, value)
      hooks.get(ns)?.onChange?.(value)
    },
    installSection(_ctx, ns, _schema, base, installed) {
      docs.set(ns, base)
      hooks.set(ns, installed)
    },
  }
  return { settings, docs, hooks }
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
  const { settings, docs, hooks } = fakeSettings()
  /** 面板写配置全都记在这里（走的是宿主的桥，不是"当前那份设置服务"）。 */
  const patches = []
  const section = installEvolutionSection(fakeContext(settings), { info() {}, warn() {}, error() {} }, {
    documents: () => documents,
    state: () => documents.peek('humanity-evolution-state'),
    settings: () => ({ maxPerDay: 8 }),
    enabled: () => true,
    started: () => true,
    works: async () => [],
    threads: async () => [],
    grow: () => overrides.grow,
    tell: () => overrides.tell,
    dropCandidate: overrides.dropCandidate,
    readWork: async () => undefined,
    room: () => overrides.room ?? { text: '', path: '' },
    writeSettings: async (patch) => {
      if (overrides.writeFails === true) throw new Error('存储未就绪')
      patches.push(patch)
    },
  })
  await section.refresh()
  return { documents, settings, docs, hooks, patches, section }
}

/**
 * 模拟客户端写一条命令，然后触发一次 `onChange`（宿主就是在那里消费的）。
 * @param docs - 假设置服务里的样式表（命名空间 → 值）。
 * @param hooks - 安装时交出来的钩子。
 * @param op - 命令名。
 * @param value - 这条命令的载荷。
 */
function sendCommand(docs, hooks, op, value) {
  docs.set('humanity-evolution', { ...docs.get('humanity-evolution'), request: { op, value } })
  hooks.get('humanity-evolution').onChange()
}

test('她留给你的：待送的、送过的、看没看都进投影', async () => {
  const { docs } = await mount({
    tell: {
      pending: '有句话想说',
      pendingShow: '',
      lastAt: '2026-11-24T15:00:00.000Z',
      lastText: '昨天那句话',
      lastShow: 'note.md',
      unread: true,
      lastReason: '',
    },
  })
  const view = docs.get('humanity-evolution')
  assert.equal(view.tell.pending, '有句话想说')
  assert.equal(view.tell.lastText, '昨天那句话')
  assert.equal(view.tell.lastShow, 'note.md')
  assert.equal(view.tell.unread, true)
})

test('她留给你的：没有记录时给空，不给半个形状', async () => {
  const { docs } = await mount()
  const view = docs.get('humanity-evolution')
  assert.equal(view.tell.lastAt, '')
  assert.equal(view.tell.pending, '')
  assert.equal(view.tell.unread, false)
})

test('她自己整理：队列与上次痕迹会出现在投影里（页面上看得见）', async () => {
  const { docs } = await mount({
    grow: {
      candidates: [{ text: '爱吃糖葫芦', about: 'user', section: '关系', count: 2, days: 2 }],
      lastRun: { at: '2026-11-24T15:00:00.000Z', wrote: ['说话风格'], queued: ['爱吃糖葫芦'], note: '' },
    },
  })
  const view = docs.get('humanity-evolution')
  assert.equal(view.grow.candidates.length, 1)
  assert.equal(view.grow.candidates[0].text, '爱吃糖葫芦')
  assert.equal(view.grow.candidates[0].about, 'user')
  assert.equal(view.grow.candidates[0].count, 2)
  assert.equal(view.grow.candidates[0].days, 2)
  assert.deepEqual(view.grow.lastRun.wrote, ['说话风格'])
})

test('她自己整理：没有队列时给空，不给半个形状', async () => {
  const { docs } = await mount()
  const view = docs.get('humanity-evolution')
  assert.deepEqual(view.grow.candidates, [])
  assert.equal(view.grow.lastRun.at, '')
})

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
  sendCommand(docs, hooks, 'open', '2026-11-23')
  await new Promise((resolve) => setTimeout(resolve, 20))

  const after = documents.peek('humanity-diary')
  const opened = after.entries.find((entry) => entry.date === '2026-11-23')
  assert.notEqual(opened.openedAt, '', '翻开时刻要落盘（重启也算数）')
  const view = docs.get('humanity-evolution')
  assert.equal(view.diary.find((entry) => entry.date === '2026-11-23').text, '那天我没做什么。')
  assert.match(view.notice, /2026-11-23/, '要告诉用户翻开了哪一天')
  assert.deepEqual(view.request, { op: '', value: '' }, '命令槽消费完要清空')
})

test('改次数上限：写进套件配置；越界不许写', async () => {
  const { docs, hooks, patches } = await mount()
  sendCommand(docs, hooks, 'cap', '6')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(patches.length, 1, '要真的写一次配置')
  assert.equal(patches[0].modules.evolution.maxWakesPerDay, 6)

  // 越界值：不写配置，只给一句人话。
  sendCommand(docs, hooks, 'cap', '99')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(patches.length, 1, '越界不该写进配置')
  assert.match(docs.get('humanity-evolution').notice, /0/, '要说清合法范围')
})

test('改她的房间：写进套件配置；名字里带斜杠当场拦下', async () => {
  const { docs, hooks, patches } = await mount()
  sendCommand(docs, hooks, 'room', '书房')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(patches.length, 1, '要真的写一次配置')
  assert.equal(patches[0].modules.evolution.room, '书房')

  sendCommand(docs, hooks, 'room', 'a/b')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(patches.length, 1, '带斜杠的不该写进配置')
  assert.match(docs.get('humanity-evolution').notice, /斜杠/, '要说清为什么不收')
})

test('改她的房间：空串 = 回到老位置（也是一次配置写入）', async () => {
  const { docs, hooks, patches } = await mount()
  sendCommand(docs, hooks, 'room', '')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(patches.length, 1)
  assert.equal(patches[0].modules.evolution.room, '')
})

test('写配置失败要如实说（别让面板看起来像成功了）', async () => {
  const { docs, hooks } = await mount({ writeFails: true })
  sendCommand(docs, hooks, 'room', '书房')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.match(docs.get('humanity-evolution').notice, /没改成/, '失败必须有话说')
  assert.match(docs.get('humanity-evolution').notice, /存储未就绪/, '原因要原样带出来')
})

test('后台刷新不许抹掉上一句话（点了没反应就是这么来的）', async () => {
  const { docs, hooks, section } = await mount()
  sendCommand(docs, hooks, 'room', 'a/b')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.match(docs.get('humanity-evolution').notice, /斜杠/)
  await section.refresh()
  assert.match(docs.get('humanity-evolution').notice, /斜杠/, '重投影之后那句话还在')
})

test('读不到文件时给原因，不假装下载成功', async () => {
  const { docs, hooks } = await mount()
  sendCommand(docs, hooks, 'read', 'note.md')
  await new Promise((resolve) => setTimeout(resolve, 20))
  const view = docs.get('humanity-evolution')
  assert.match(view.notice, /读不到/, '要说清为什么没有文件')
  assert.deepEqual(view.transfer, { name: '', mime: '', base64: '' }, '失败时不该带任何字节')
})

test('删候选：一条命令过去，宿主转给人格那边执行，并把结果写成通知', async () => {
  const seen = []
  const { docs, hooks } = await mount({
    dropCandidate: async (text) => {
      seen.push(text)
      return { ok: true }
    },
  })
  sendCommand(docs, hooks, 'grow-drop', '爱吃糖葫芦')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(seen, ['爱吃糖葫芦'], '交出去的正是那一条')
  assert.match(docs.get('humanity-evolution').notice, /删掉了/)
})

test('删候选：宿主说删不了就照实说，不假装删成功', async () => {
  const { docs, hooks } = await mount({
    dropCandidate: async () => ({ ok: false, reason: '队列里没有这一条（可能刚变过）' }),
  })
  sendCommand(docs, hooks, 'grow-drop', '已经不在了')
  await new Promise((resolve) => setTimeout(resolve, 20))
  const notice = docs.get('humanity-evolution').notice
  assert.match(notice, /没删成/)
  assert.match(notice, /可能刚变过/, '原因要原样带出来')
})
