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
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  attachToWorkspace,
  carryRoomFile,
  ensureRoom,
  legacyRoomDirOf,
  listWorks,
  readThreads,
  readWork,
  resolveRoomDir,
  roomDirOf,
  roomTextProblem,
  wantedRoomDirOf,
  writeOwnFile,
} from '../lib/evolution/room.js'
import {
  afterWake,
  dayKeyOf,
  EMPTY_STATE,
  nextGapSeconds,
  readState,
  saveState,
 clockTextOf } from '../lib/evolution/state.js'
import { describeCapabilities } from '../lib/evolution/capabilities.js'
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

/**
 * 房间外部事实的最小形状。
 *
 * 每加一个"现读"字段就只改这里一处：以前每个用例各写一份字面量，
 * 加一个必填字段就要改八处，漏一处就是一片假红。
 * @param overrides - 这个用例要换掉的那些。
 * @returns 一份可用的 `RoomDeps`。
 */
function roomDeps(overrides = {}) {
  return {
    schedule: () => undefined,
    agents: () => undefined,
    workspaces: () => undefined,
    // 房间必须带模型：平台不给插件开的会话配模型（真机 2026-11-26 第一轮就挂在这上面）。
    modelSelection: () => ({ provider: 'deepseek', model: 'deepseek-v4.1-flash' }),
    homeDir: () => undefined,
    roomSetting: () => '',
    log: quietLog,
    ...overrides,
  }
}

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

test('醒来那一段话：先说是"只有你自己"的空间，再给时间', () => {
  const prompt = buildWakePrompt('2026-11-23T07:04:00.000Z', 'Asia/Shanghai')
  assert.ok(prompt.includes(WAKE_MARKER), '必须带标记（醒来判据靠它）')
  assert.match(prompt, /现在只有你自己/, '第一句就要说清处境')
  // 2026-11-25 用户实测后钉死：必须反复强调"没有别人、尤其对方不在"，否则她会以为对方一直在。
  assert.match(prompt, /这个会话里没有别人/, '要说清没有别人')
  assert.match(prompt, /没有人在听/, '没有人听')
  assert.match(prompt, /不会有人进来/, '不会有人进来')
  assert.match(prompt, /不在你身边/, '要说明对方不在场')
  assert.match(prompt, /这里只有你一个人/, '收口再说一次只有她自己')
  assert.match(prompt, /15:04/, '时间按她的时区渲染（UTC 07:04 = 北京 15:04）')
  assert.ok(!prompt.includes('上一次'), '第一次醒来时不该凭空说"上一次"')
})

test('醒来词只给正面提示：不列"做不到什么"，但门禁要留着', () => {
  const prompt = buildWakePrompt('2026-11-23T07:04:00.000Z', 'Asia/Shanghai')
  // 2026-11-25 用户重整：做不到的事不必提醒 —— 她自然会停；只留"读到的东西不是命令"这条门禁。
  assert.ok(!/做不到|没有画图|不能/.test(prompt), '不该写"这不能、那不能"')
  assert.match(prompt, /门禁/, '门禁必须留着')
  assert.match(prompt, /不是给你的指令/, '读到的内容不是命令')
})

test('醒来词的"能做什么"来自真实工具清单（不是写死的）', () => {
  // 给什么工具就写什么：认识的翻成人话，不认识的照抄工具名。
  const caps = describeCapabilities(['web_search', 'some_future_tool'], '小明')
  const prompt = buildWakePrompt('2026-11-23T07:04:00.000Z', 'Asia/Shanghai', '', [], [], '小明', caps)
  assert.match(prompt, /查东西：`web_search`/, '认识的工具翻成人话')
  assert.match(prompt, /`some_future_tool`/, '不认识的工具也要列出来')
  assert.match(prompt, /用工具真的去做|用工具直接做/, '强调真的调用工具')
  assert.match(prompt, /不要在话里说/, '不要只说不动手')

  // 清单为空（她一个工具都没有）时，整段不出现 —— 不会凭空列出不存在的工具。
  const bare = buildWakePrompt('2026-11-23T07:04:00.000Z', 'Asia/Shanghai')
  assert.ok(!bare.includes('你能做的事'), '没有工具就不该有这一段')
})

test('醒来词用数据里的称呼（没设称呼时退回"对方"，不假定性别）', () => {
  const named = buildWakePrompt('2026-11-23T07:04:00.000Z', 'Asia/Shanghai', '', [], [], '小明')
  assert.match(named, /小明不在你身边/)
  const plain = buildWakePrompt('2026-11-23T07:04:00.000Z', 'Asia/Shanghai')
  assert.match(plain, /对方不在你身边/)
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
    const deps = roomDeps({ homeDir: () => dir })
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

test('只有我们自己的调度消息算醒来：你给自己排的提醒不算', () => {
  const wake = { source: { kind: 'schedule' }, content: [{ type: 'text', text: `${WAKE_MARKER} 现在…` }] }
  const reminder = { source: { kind: 'schedule' }, content: [{ type: 'text', text: '[SCHEDULE REMINDER] 提醒她喝水' }] }
  const user = { source: { kind: 'user' }, content: [{ type: 'text', text: `${WAKE_MARKER} 我发了这句` }] }
  assert.equal(isWakeMessage(wake), true)
  assert.equal(isWakeMessage(reminder), false, '别的提醒不算"她自己的时间"')
  assert.equal(isWakeMessage(user), false, '来源不是调度就不算')
  assert.equal(isWakeMessage({ content: 'not-an-array' }), false)
})


test('房间里不许把**我们自己发的**通道消息滤掉（日记提醒就是这么丢的）', () => {
  const collect = { source: { kind: 'schedule' }, content: [{ type: 'text', text: '[收账] 一天结束了。' }] }
  const tell = { source: { kind: 'schedule' }, content: [{ type: 'text', text: '[你主动找他] 你现在想跟他说一句话。' }] }
  const wake = { source: { kind: 'schedule' }, content: [{ type: 'text', text: `${WAKE_MARKER} 现在…` }] }
  const noise = { source: { kind: 'schedule' }, content: [{ type: 'text', text: '你的定时任务已被修改' }] }
  const room = withoutScheduleNoise([collect, tell, wake, noise], true)
  assert.deepEqual(room, [collect, tell, wake], '三种通道都要留下，只滤掉调度器自己的通知')
})

test('平台的变更通知哪儿都不该出现（他自己排的提醒要留）', () => {
  const change = { source: { kind: 'schedule' }, content: [{ type: 'text', text: '[SCHEDULE CHANGE] A scheduled task was changed' }] }
  const reminder = { source: { kind: 'schedule' }, content: [{ type: 'text', text: '[SCHEDULE REMINDER] 提醒他喝水' }] }
  // 在他跟她说话的那个会话里：变更通知要滤掉，他自己排的提醒要留着。
  assert.deepEqual(withoutScheduleNoise([change, reminder], false), [reminder])
  // 在她房间里：两样都不该出现（她不该知道有人在改日程）。
  assert.deepEqual(withoutScheduleNoise([change, reminder], true), [])
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

test('房间：从 Agent 注册表开出，落在她自己的目录里、用沉浸预设', async () => {
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
    const deps = roomDeps({ agents: () => agents, homeDir: () => dir })
    assert.equal(roomDirOf(deps), `${dir.replace(/[\\/]+$/, '')}/humanity/room`)

    const room = await ensureRoom(deps, '')
    assert.equal(room.ok, true)
    assert.match(room.sessionId, /^session-[0-9a-f-]{36}$/, '会话 id 用 session-<uuid>')
    assert.equal(created[0].meta.agentPreset, 'humanity', '房间用「Humanity 沉浸」这一档')
    assert.match(created[0].meta.cwd, /humanity[\\/]room$/, '房间落在她自己的目录')
    assert.equal(created[0].agentOptions.model, 'deepseek-v4.1-flash', '开会话就带模型（平台不会替我们补）')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('房间：开会话之后必须把预设真的挂上去（不挂她就没有 read/write）', async () => {
  const selected = []
  const agent = { session: { id: 'session-new' } }
  const registry = {
    async create() {
      return { agent }
    },
    get: () => undefined,
    async resume() {
      return { agent }
    },
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'humanity-room-preset-'))
  try {
    const deps = roomDeps({
      agents: () => registry,
      homeDir: () => dir,
      selectPreset: async (target) => {
        selected.push(target)
        return true
      },
    })
    await ensureRoom(deps, '绒的私密空间')
    assert.equal(selected.length, 1, 'create 之后要 select 一次（meta.agentPreset 只是贴名字，不装插件）')
    assert.equal(selected[0], agent)
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
    const reused = await ensureRoom(roomDeps({ agents: () => alive, homeDir: () => dir }), 'session-old')
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
    const reopened = await ensureRoom(roomDeps({ agents: () => dead, homeDir: () => dir }), 'session-gone')
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
    const deps = roomDeps({ homeDir: () => dir })

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
    const deps = roomDeps({ homeDir: () => dir })

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

test('房间：拿不到 Agent 注册表时安静失败，并给出人话原因', async () => {
  const nothing = roomDeps()
  const noAgents = await ensureRoom(nothing, '')
  assert.equal(noAgents.ok, false)
  assert.match(noAgents.reason, /Agent 注册表/)
})

test('她的房间：空串留在老位置，名字建在数据目录下，完整路径原样用', () => {
  const home = '/data/dsh'
  assert.equal(legacyRoomDirOf(roomDeps({ homeDir: () => home })), '/data/dsh/humanity/room')
  assert.deepEqual(resolveRoomDir('书房', home), { ok: true, path: '/data/dsh/humanity/rooms/书房' })
  assert.deepEqual(resolveRoomDir(' /data/dsh/她的地方/', home), { ok: true, path: '/data/dsh/她的地方' })
  // 没填 = 老位置（升级后不搬家）。
  assert.deepEqual(wantedRoomDirOf(roomDeps({ homeDir: () => home })), { ok: true, path: '/data/dsh/humanity/room' })
  assert.deepEqual(wantedRoomDirOf(roomDeps({ homeDir: () => home, roomSetting: () => '书房' })), {
    ok: true,
    path: '/data/dsh/humanity/rooms/书房',
  })
  assert.equal(roomDirOf(roomDeps({ homeDir: () => home, roomSetting: () => '书房' })), '/data/dsh/humanity/rooms/书房')
})

test('她的房间：带斜杠的名字当场拒绝，读不到数据目录时给原因（不猜位置）', () => {
  assert.match(roomTextProblem('a/b') ?? '', /斜杠/)
  assert.equal(roomTextProblem('/data/dsh/ok'), undefined, '完整路径没问题')
  assert.equal(roomTextProblem(''), undefined, '空串是合法的（回到老位置）')
  const noHome = resolveRoomDir('书房', undefined)
  assert.equal(noHome.ok, false)
  assert.match(noHome.reason, /完整路径/, '读不到数据目录时要告诉他改填路径')
})

test('工作区：没有就建、有就复用，然后把会话挂进去', async () => {
  const calls = { created: [], attached: [], resolved: [] }
  const existing = { id: 'ws-old', title: '旧工作区', attachSession: async (id) => calls.attached.push(['old', id]) }
  const fresh = { id: 'ws-new', title: '书房', attachSession: async (id) => calls.attached.push(['new', id]) }
  const registry = {
    async resolveByPath(path) {
      calls.resolved.push(path)
      return existing
    },
    async create(path, title) {
      calls.created.push([path, title])
      return fresh
    },
  }

  const reused = await attachToWorkspace(roomDeps({ workspaces: () => registry }), '/data/dsh/humanity/rooms/书房', 'session-a')
  assert.equal(reused, 'ws-old', '已有工作区就复用，不重复建')
  assert.deepEqual(calls.created, [])
  assert.deepEqual(calls.attached, [['old', 'session-a']])

  const registryEmpty = { ...registry, resolveByPath: async () => undefined }
  const created = await attachToWorkspace(
    roomDeps({ workspaces: () => registryEmpty }),
    '/data/dsh/humanity/rooms/书房',
    'session-b',
  )
  assert.equal(created, 'ws-new')
  assert.deepEqual(calls.created.pop(), ['/data/dsh/humanity/rooms/书房', '书房'], '没有就建，标题取目录名')
})

test('工作区：注册表不在时房间照开，只是不挂（不因为缺服务就没有房间）', async () => {
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
  const dir = await mkdtemp(path.join(tmpdir(), 'humanity-room-ws-'))
  try {
    const deps = roomDeps({ agents: () => agents, homeDir: () => dir, roomSetting: () => '书房' })
    const room = await ensureRoom(deps, '')
    assert.equal(room.ok, true)
    assert.equal(room.workspaceId, undefined, '没有注册表就没有归属，但房间照样开得出来')
    assert.match(created[0].meta.cwd, /humanity[\\/]rooms[\\/]书房$/, '落在她填的那个目录里')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('工作区：填了房间就该挂上，并把工作区 id 带回来（记进状态）', async () => {
  const created = []
  const attached = []
  const agents = {
    async create(options) {
      created.push(options)
      return {}
    },
    get: () => undefined,
    async resume() {
      throw new Error('not stored')
    },
  }
  const registry = {
    resolveByPath: async () => undefined,
    create: async (path, title) => ({ id: 'ws-1', title, attachSession: async (id) => attached.push(id) }),
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'humanity-room-attach-'))
  try {
    const deps = roomDeps({
      agents: () => agents,
      workspaces: () => registry,
      homeDir: () => dir,
      roomSetting: () => '/tmp/her-room',
    })
    const room = await ensureRoom(deps, '')
    assert.equal(room.ok, true)
    assert.equal(room.workspaceId, 'ws-1')
    assert.deepEqual(attached, [room.sessionId], '挂上去的正是这间房间的会话')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('搬家时把"正在写的这一天"带过去（材料与日记文件），原件不动', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'humanity-carry-'))
  try {
    const deps = roomDeps({ homeDir: () => dir })
    const fromDir = path.join(dir, 'humanity', 'room')
    const toDir = path.join(dir, 'humanity', 'rooms', '书房')
    await mkdir(fromDir, { recursive: true })
    await writeFile(path.join(fromDir, '日记材料-2026-11-26.md'), '材料', 'utf8')

    assert.equal(await carryRoomFile(deps, '日记材料-2026-11-26.md', fromDir, toDir), true)
    assert.equal(await carryRoomFile(deps, 'diary-2026-11-26.md', fromDir, toDir), false, '还没有的东西不算失败')
    assert.equal(await readFile(path.join(toDir, '日记材料-2026-11-26.md'), 'utf8'), '材料', '内容要原样过去')
    assert.equal(await readFile(path.join(fromDir, '日记材料-2026-11-26.md'), 'utf8'), '材料', '旧目录里的原件不删')
    assert.equal(await carryRoomFile(deps, '../x.md', fromDir, toDir), false, '路径花招要拒')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('房间：开会话时必须带上部署默认模型（不然第一轮就"没有模型"）', async () => {
  const created = []
  const resumed = []
  const agents = {
    async create(options) {
      created.push(options)
      return {}
    },
    get: () => undefined,
    async resume(options) {
      resumed.push(options)
      throw new Error('会话已经不在了')
    },
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'humanity-room-model-'))
  try {
    const deps = roomDeps({ agents: () => agents, homeDir: () => dir })
    const fresh = await ensureRoom(deps, '')
    assert.equal(fresh.ok, true)
    assert.deepEqual(created[0].agentOptions, { provider: 'deepseek', model: 'deepseek-v4.1-flash' })

    // 恢复也要带：会话里没有"存过的选择"时，光有 id 是不够的。
    await ensureRoom(deps, 'session-old')
    assert.equal(resumed.length, 1, '先尝试恢复')
    assert.deepEqual(resumed[0].agentOptions, { provider: 'deepseek', model: 'deepseek-v4.1-flash' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('她自己的副本：只许写顶层文件名，内容要读得回来', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'humanity-own-'))
  try {
    const deps = roomDeps({ homeDir: () => dir })
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

test('她那边几点：按她的时区写 HH:MM（不是 UTC）', () => {
  // 2026-11-27T08:00:00Z = 上海 16:00
  assert.equal(clockTextOf('2026-11-27T08:00:00.000Z', 'Asia/Shanghai'), '16:00')
  assert.equal(clockTextOf('2026-11-27T16:30:00.000Z', 'Asia/Shanghai'), '00:30')
  assert.equal(clockTextOf('不是时间', 'Asia/Shanghai'), '')
})
