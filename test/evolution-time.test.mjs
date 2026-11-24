/**
 * 她自己的一天（自进化第 0 期）的回归钉。
 *
 * 这里钉的不是"能跑"，而是四条一旦写错就会在真机上静默变味的规矩：
 * 1. **"今天"按她的时区算**（UTC 的日期会把凌晨算成前一天）；
 * 2. **次数上限不是配额**：到了上限就等到明天早上，绝不为了凑数再醒一次；
 * 3. **间隔是随机的**，且永远夹在 DSH 要求的最小投递间隔以上；
 * 4. **只有我们自己的那条调度消息算"醒来"** —— 你给自己排的提醒不算。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  ensureRoom,
  ensureTask,
  listWorks,
  readThreads,
  readWork,
  writeOwnFile,
  reschedule,
  roomDirOf,
} from '../lib/evolution/room.js'
import {
  afterWake,
  dayKeyOf,
  EMPTY_STATE,
  nextGapSeconds,
  readState,
  saveState,
} from '../lib/evolution/state.js'
import { buildWakePrompt } from '../lib/evolution/wake.js'
import {
  continuityOf,
  isBusySession,
  isScheduleMessage,
  isWakeMessage,
  withoutScheduleNoise,
} from '../lib/evolution/index.js'
import { WAKE_MARKER } from '../lib/evolution/constants.js'

/** 不打印的日志门面。 */
const quietLog = { info: () => {}, warn: () => {}, error: () => {} }

/** 一个只记调用的假调度服务。 */
function fakeSchedule(overrides = {}) {
  const calls = { create: [], edit: [], run: [], view: [] }
  const service = {
    calls,
    async create(request) {
      calls.create.push(request)
      return { id: 'task-1', active: 'active', nextScheduledAt: '2026-11-23T10:00:00.000Z', target: { kind: 'new_once' } }
    },
    async view(request) {
      calls.view.push(request)
      return overrides.viewResult ?? { code: 'schedule_not_found', id: request.id }
    },
    async edit(request) {
      calls.edit.push(request)
      return { id: request.id, active: 'active', nextScheduledAt: '2026-11-23T11:00:00.000Z', target: { kind: 'session', sessionId: 's-1' } }
    },
    async run(request) {
      calls.run.push(request)
      return { id: request.id, active: 'active', nextScheduledAt: '2026-11-23T11:00:00.000Z' }
    },
  }
  return service
}

/** 一个只支持读写的假文档表。 */
function fakeDocuments(initial) {
  let value = initial
  return {
    read: () => (value === undefined ? undefined : { value, revision: 1, updatedAt: '' }),
    write: async (_ns, next) => {
      value = next
      return { value, revision: 2, updatedAt: '' }
    },
    merge: async (_ns, patch) => {
      value = { ...value, ...patch }
      return { value, revision: 2, updatedAt: '' }
    },
    list: () => [],
    current: () => value,
  }
}

test('"今天"按她的时区算：UTC 的日期会把凌晨算成前一天', () => {
  // 东八区 2026-11-24 00:30 = UTC 2026-11-23 16:30。
  assert.equal(dayKeyOf('2026-11-23T16:30:00.000Z', 'Asia/Shanghai'), '2026-11-24')
  assert.equal(dayKeyOf('2026-11-23T16:30:00.000Z', 'UTC'), '2026-11-23')
  // 时区名填错时不许整条作息崩掉：退回进程时区（这里只要求它仍给出一个合法日期）。
  assert.match(dayKeyOf('2026-11-23T16:30:00.000Z', 'Not/AZone'), /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(dayKeyOf('不是时间', 'Asia/Shanghai'), '')
})

test('次数到了上限就等到明天早上，绝不为了凑数再醒一次', () => {
  // 北京 15:00、今天已经醒满 3 次。
  const state = { ...EMPTY_STATE, dayKey: '2026-11-23', dayCount: 3 }
  const gap = nextGapSeconds(state, { maxPerDay: 3, minGapMinutes: 40, maxGapMinutes: 150 }, '2026-11-23T07:00:00.000Z', 'Asia/Shanghai', () => 0)
  assert.ok(gap !== undefined, '到了上限也不是不再排，而是排到明天')
  assert.ok(gap >= 8 * 3600, `应当等到明天早上（实际 ${gap} 秒）`)
})

test('上限为 0 = 不主动醒（只能手动叫醒）', () => {
  const gap = nextGapSeconds(EMPTY_STATE, { maxPerDay: 0, minGapMinutes: 40, maxGapMinutes: 150 }, '2026-11-23T07:00:00.000Z', 'Asia/Shanghai')
  assert.equal(gap, undefined)
})

test('间隔在两条线之间随机取，且不低于 DSH 的最小投递间隔', () => {
  const rhythm = { maxPerDay: 8, minGapMinutes: 40, maxGapMinutes: 150 }
  const low = nextGapSeconds(EMPTY_STATE, rhythm, '2026-11-23T07:00:00.000Z', 'Asia/Shanghai', () => 0)
  const high = nextGapSeconds(EMPTY_STATE, rhythm, '2026-11-23T07:00:00.000Z', 'Asia/Shanghai', () => 1)
  assert.equal(low, 40 * 60, '随机源取 0 ⇒ 最短间隔')
  assert.equal(high, 150 * 60, '随机源取 1 ⇒ 最长间隔')
  // 配反了（min > max）也不许排出负数或 0。
  const reversed = nextGapSeconds(EMPTY_STATE, { maxPerDay: 8, minGapMinutes: 150, maxGapMinutes: 40 }, '2026-11-23T07:00:00.000Z', 'Asia/Shanghai', () => 0.5)
  assert.ok(reversed >= 60, '夹在最小投递间隔以上')
})

test('醒来记账：同一天累加、跨天从 1 重新开始', () => {
  const day1 = afterWake(EMPTY_STATE, '2026-11-23T07:00:00.000Z', 'Asia/Shanghai')
  assert.deepEqual(day1, { dayKey: '2026-11-23', dayCount: 1, lastWakeAt: '2026-11-23T07:00:00.000Z' })
  const again = afterWake({ ...EMPTY_STATE, ...day1 }, '2026-11-23T09:00:00.000Z', 'Asia/Shanghai')
  assert.equal(again.dayCount, 2)
  // 东八区次日 00:30（UTC 还是 23 号）——必须算新的一天。
  const nextDay = afterWake({ ...EMPTY_STATE, ...again }, '2026-11-23T16:30:00.000Z', 'Asia/Shanghai')
  assert.equal(nextDay.dayKey, '2026-11-24')
  assert.equal(nextDay.dayCount, 1)
})

test('状态文档：没写过就是空状态；写进去的字段读得回来', async () => {
  const documents = fakeDocuments(undefined)
  assert.deepEqual(readState(documents), EMPTY_STATE)
  await saveState(documents, { ...readState(documents), taskId: 'task-1', dayKey: '2026-11-23', dayCount: 2 })
  const read = readState(documents)
  assert.equal(read.taskId, 'task-1')
  assert.equal(read.dayCount, 2)
  assert.equal(read.roomSessionId, '', '没写过的字段是空串，不是 undefined')
})

test('醒来那一段话：带标记、带时间、并且说清"没有人在等你"', () => {
  const prompt = buildWakePrompt('2026-11-23T07:04:00.000Z', 'Asia/Shanghai')
  assert.ok(prompt.includes(WAKE_MARKER), '必须带标记（醒来判据靠它）')
  assert.match(prompt, /15:04/, '时间按她的时区渲染（UTC 07:04 = 北京 15:04）')
  assert.match(prompt, /没有人在叫你/, '要点明这一段时间没有人在等')
  assert.match(prompt, /不用向谁汇报/, '要点明这一段时间不产出汇报')
  assert.ok(!prompt.includes('上一次'), '第一次醒来时不该凭空说"上一次"')
})

test('醒来词要拆掉"这是用户发来的"这个误认（真机第一晚她把它当成了主人来了）', () => {
  const prompt = buildWakePrompt('2026-11-23T07:04:00.000Z', 'Asia/Shanghai')
  assert.match(prompt, /不是他发的/, '必须说清不是他发的')
  assert.match(prompt, /自己给自己定的闹钟/, '要说清这是她自己的闹钟')
})

test('醒来词要给"能做什么"，也要说清做不到什么（只给自由她会坐着想事情）', () => {
  const prompt = buildWakePrompt('2026-11-23T07:04:00.000Z', 'Asia/Shanghai')
  assert.match(prompt, /上网搜东西/, '搜索是真能做的')
  assert.match(prompt, /读写文件/, '文件读写是真能做的')
  assert.match(prompt, /没有画图/, '做不到的要明说，别让她以为自己能画')
})

test('醒来词要带上她手上还没做完的事；没有就说没有', () => {
  const withThreads = buildWakePrompt('2026-11-23T07:04:00.000Z', 'Asia/Shanghai', '', [
    '追的连载看到第 37 章，想看下一章',
  ])
  assert.match(withThreads, /你手上还没做完的事/)
  assert.match(withThreads, /第 37 章/)

  const empty = buildWakePrompt('2026-11-23T07:04:00.000Z', 'Asia/Shanghai')
  assert.match(empty, /没有攒着没做完的事/)
})

test('线索账就是她目录里的 todo.md：读得到就用，读不到当空', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'humanity-threads-'))
  try {
    const deps = { schedule: () => undefined, agents: () => undefined, homeDir: () => dir, log: quietLog }
    assert.deepEqual(await readThreads(deps), [], '还没有文件时是空的（不替她编内容）')
    await mkdir(path.join(dir, 'humanity', 'room'), { recursive: true })
    await writeFile(
      path.join(dir, 'humanity', 'room', 'todo.md'),
      '# 我手上的事\n\n- 追的电视剧看到第 9 集，马上结局\n- 想弄明白潮汐为什么一天两次\n',
      'utf8',
    )
    assert.deepEqual(await readThreads(deps), ['追的电视剧看到第 9 集，马上结局', '想弄明白潮汐为什么一天两次'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('醒来那一段话可以接上"上次做到哪"：连续，但标明那是她自己的记录', () => {
  const prompt = buildWakePrompt('2026-11-23T07:04:00.000Z', 'Asia/Shanghai', '我在看一篇讲潮汐的文章，看到一半')
  assert.match(prompt, /我在看一篇讲潮汐的文章/, '要带上上次的尾巴')
  assert.match(prompt, /不是别人说的话/, '必须说清这不是"有人对她说"')
})

test('接续摘要：压成一行、只留尾巴（太长会把唤醒词撑爆）', () => {
  assert.equal(continuityOf('  第一行\n\n第二行  '), '第一行 第二行')
  assert.equal(continuityOf('   '), '')
  const long = 'x'.repeat(400)
  const capped = continuityOf(long, 300)
  assert.ok(capped.startsWith('…'), '截断要留痕迹')
  assert.equal(capped.length, 301)
})

test('重排下一次时可以顺带换掉提示词（连续性靠它）', async () => {
  const service = fakeSchedule()
  const deps = { schedule: () => service, agents: () => undefined, homeDir: () => undefined, log: quietLog }
  await reschedule(deps, 'task-1', 600, '新的一段话')
  assert.equal(service.calls.edit[0].patch.prompt, '新的一段话')
  assert.deepEqual(service.calls.edit[0].patch.timing, { kind: 'after', after_seconds: 600 })
})

test('只有我们自己的调度消息算醒来：你给自己排的提醒不算', () => {
  const wake = { source: { kind: 'schedule' }, content: [{ type: 'text', text: `${WAKE_MARKER} 现在…` }] }
  const reminder = { source: { kind: 'schedule' }, content: [{ type: 'text', text: '[SCHEDULE REMINDER] 提醒她喝水' }] }
  const user = { source: { kind: 'user' }, content: [{ type: 'text', text: `${WAKE_MARKER} 我发了这句` }] }
  assert.equal(isWakeMessage(wake), true)
  assert.equal(isWakeMessage(reminder), false, '别的提醒不算"她自己的时间"')
  assert.equal(isWakeMessage(user), false, '来源不是调度就不算')
  assert.equal(isWakeMessage({ content: 'not-an-array' }), false)
})

test('她房间里要滤掉调度器的变更通知，你那边一条都不能动', () => {
  const wake = { source: { kind: 'schedule' }, content: [{ type: 'text', text: `${WAKE_MARKER} 现在…` }] }
  const noise = { source: { kind: 'schedule' }, content: [{ type: 'text', text: '你的定时任务已被修改' }] }
  const user = { source: { kind: 'user' }, content: [{ type: 'text', text: '在吗' }] }

  const room = withoutScheduleNoise([wake, noise, user], true)
  assert.deepEqual(room, [wake, user], '房间里只留她自己的时间和人说的话')

  const outside = [wake, noise, user]
  assert.equal(withoutScheduleNoise(outside, false), outside, '别处原样返回（你自己的提醒不能被滤）')
  assert.equal(isScheduleMessage(noise), true)
  assert.equal(isScheduleMessage(user), false)
})

test('单线程：她在别处说话时，房间的闹钟要压着', () => {
  assert.equal(isBusySession('user/message', 'session-chat', 'session-room'), true, '在别的会话里说话 ⇒ 她正忙')
  assert.equal(isBusySession('assistant/message', 'session-chat', 'session-room'), true, '她刚回完一句也算还在聊')
  assert.equal(
    isBusySession('session/end-seed', 'session-chat', 'session-room'),
    false,
    '重启时重放的生命周期事件不算她在忙（真机踩过：闹钟一启动就被压住）',
  )
  assert.equal(isBusySession('user/message', 'session-room', 'session-room'), false, '房间自己的事件不算"她在别处"')
  assert.equal(isBusySession('user/message', '', 'session-room'), false, '取不到会话 id 时不做判断（宁可不动）')
})

test('房间：从 Agent 注册表开出，再把任务投进这个已有会话', async () => {
  const service = fakeSchedule()
  const created = []
  const agents = {
    async create(options) {
      created.push(options)
      return { agent: { session: { id: options.sessionId } } }
    },
    get: () => undefined,
    async resume() {
      throw new Error('not stored')
    },
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'humanity-room-'))
  try {
    const deps = { schedule: () => service, agents: () => agents, homeDir: () => dir, log: quietLog }
    assert.equal(roomDirOf(deps), `${dir.replace(/[\\/]+$/, '')}/humanity/room`)

    const room = await ensureRoom(deps, '')
    assert.equal(room.ok, true)
    assert.match(room.sessionId, /^session-[0-9a-f-]{36}$/, '会话 id 用 session-<uuid>')
    assert.equal(created[0].meta.agentPreset, 'humanity', '房间用「Humanity 沉浸」这一档')
    assert.match(created[0].meta.cwd, /humanity[\\/]room$/, '房间落在她自己的目录')

    const task = await ensureTask(deps, '', room.sessionId, 600, '醒来')
    assert.equal(task.ok, true)
    assert.equal(task.room.taskId, 'task-1')
    const request = service.calls.create[0]
    assert.equal(request.title, '她自己的时间')
    assert.equal(request.timing.kind, 'after')
    assert.equal(request.timing.after_seconds, 600)
    // 这个部署的 Host 不能建会话（真机报错），所以目标必须是已存在的会话。
    assert.deepEqual(request.target, { kind: 'session', sessionId: room.sessionId })

    const moved = await reschedule(deps, 'task-1', 900)
    assert.equal(moved.ok, true)
    assert.deepEqual(service.calls.edit[0], {
      id: 'task-1',
      action: 'update',
      patch: { timing: { kind: 'after', after_seconds: 900 }, active: true },
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('房间：已经活着就复用；恢复失败就重开一间', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'humanity-room-alive-'))
  try {
    const alive = {
      async create() {
        throw new Error('不该被调用')
      },
      get: (id) => ({ session: { id } }),
      async resume() {
        throw new Error('不该被调用')
      },
    }
    const reused = await ensureRoom({ schedule: () => undefined, agents: () => alive, homeDir: () => dir, log: quietLog }, 'session-old')
    assert.deepEqual(reused, { ok: true, sessionId: 'session-old' })

    const created = []
    const dead = {
      async create(options) {
        created.push(options.sessionId)
        return {}
      },
      get: () => undefined,
      async resume() {
        throw new Error('会话已经不在了')
      },
    }
    const reopened = await ensureRoom({ schedule: () => undefined, agents: () => dead, homeDir: () => dir, log: quietLog }, 'session-gone')
    assert.equal(reopened.ok, true)
    assert.notEqual(reopened.sessionId, 'session-gone', '恢复失败要重开，而不是从此没有房间')
    assert.equal(created.length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('她留下的东西：文本给预览、图片只给大小、点开头的文件不列', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'humanity-works-'))
  try {
    const room = path.join(dir, 'humanity', 'room')
    await mkdir(room, { recursive: true })
    await writeFile(path.join(room, 'note.md'), '# 今天\n\n查了潮汐的事。', 'utf8')
    await writeFile(path.join(room, 'draft.txt'), '草稿', 'utf8')
    await writeFile(path.join(room, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    await writeFile(path.join(room, 'todo.md'), '- 追的连载看到第 37 章', 'utf8')
    await writeFile(path.join(room, '.hidden'), 'x', 'utf8')
    const deps = { schedule: () => undefined, agents: () => undefined, homeDir: () => dir, log: quietLog }

    const works = await listWorks(deps)
    const names = works.map((item) => item.name).sort()
    assert.deepEqual(names, ['draft.txt', 'note.md', 'pic.png', 'todo.md'], '点开头的隐藏文件不列')
    const note = works.find((item) => item.name === 'note.md')
    assert.equal(note.kind, 'text')
    assert.match(note.preview, /查了潮汐的事/)
    const pic = works.find((item) => item.name === 'pic.png')
    assert.equal(pic.kind, 'image')
    assert.equal(pic.preview, '', '图片不给预览（浏览器拿不到文件）')
    assert.ok(pic.size > 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('下载：只认顶层真文件，路径花招与超大文件一律拒绝', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'humanity-read-'))
  try {
    const room = path.join(dir, 'humanity', 'room')
    await mkdir(room, { recursive: true })
    await writeFile(path.join(room, 'note.md'), '查了潮汐', 'utf8')
    await writeFile(path.join(room, 'big.txt'), 'x'.repeat(5000), 'utf8')
    const deps = { schedule: () => undefined, agents: () => undefined, homeDir: () => dir, log: quietLog }

    const ok = await readWork(deps, 'note.md')
    assert.ok(ok !== undefined)
    assert.equal(Buffer.from(ok.base64, 'base64').toString('utf8'), '查了潮汐', 'base64 要还原成原文')
    assert.match(ok.mime, /markdown/)

    assert.equal(await readWork(deps, '../note.md'), undefined, '路径花招要拒')
    assert.equal(await readWork(deps, 'sub/note.md'), undefined, '不许带目录')
    assert.equal(await readWork(deps, 'missing.md'), undefined, '不存在的文件要拒')
    assert.equal(await readWork(deps, 'big.txt', 100), undefined, '超过上限要拒')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('房间：拿不到调度服务 / Agent 注册表时安静失败，并给出人话原因', async () => {
  const nothing = { schedule: () => undefined, agents: () => undefined, homeDir: () => undefined, log: quietLog }
  const outcome = await ensureTask(nothing, '', 'room-9', 600, '醒来')
  assert.equal(outcome.ok, false)
  assert.match(outcome.reason, /调度服务/)
  // 已有任务时也一样：不抛、不假装成功。
  const moved = await reschedule(nothing, 'task-1', 600)
  assert.equal(moved.ok, false)

  const noAgents = await ensureRoom(nothing, '')
  assert.equal(noAgents.ok, false)
  assert.match(noAgents.reason, /Agent 注册表/)
})

test('她自己的副本：只许写顶层文件名，内容要读得回来', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'humanity-own-'))
  try {
    const deps = { schedule: () => undefined, agents: () => undefined, homeDir: () => dir, log: quietLog }
    assert.equal(await writeOwnFile(deps, 'diary-2026-11-24.md', '# 2026-11-24\n\n今天我去查了潮汐。\n'), true)
    const works = await listWorks(deps)
    const written = works.find((item) => item.name === 'diary-2026-11-24.md')
    assert.ok(written !== undefined, '要出现在她自己的目录里')
    assert.match(written.preview, /今天我去查了潮汐/, '正文要读得回来')

    assert.equal(await writeOwnFile(deps, '../evil.md', 'x'), false, '路径花招要拒')
    assert.equal(await writeOwnFile(deps, '', 'x'), false, '空名字要拒')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})