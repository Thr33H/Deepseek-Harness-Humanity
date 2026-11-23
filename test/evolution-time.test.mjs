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
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { ensureTask, reschedule, roomDirOf } from '../lib/evolution/room.js'
import {
  afterWake,
  dayKeyOf,
  EMPTY_STATE,
  nextGapSeconds,
  readState,
  writeState,
} from '../lib/evolution/state.js'
import { buildWakePrompt } from '../lib/evolution/wake.js'
import { isWakeMessage } from '../lib/evolution/index.js'
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
  await writeState(documents, { taskId: 'task-1', dayKey: '2026-11-23', dayCount: 2 })
  const read = readState(documents)
  assert.equal(read.taskId, 'task-1')
  assert.equal(read.dayCount, 2)
  assert.equal(read.roomSessionId, '', '没写过的字段是空串，不是 undefined')
})

test('醒来那一段话：带标记、带时间、并且说清"没有人在等你"', () => {
  const prompt = buildWakePrompt('2026-11-23T07:04:00.000Z', 'Asia/Shanghai')
  assert.ok(prompt.includes(WAKE_MARKER), '必须带标记（醒来判据靠它）')
  assert.match(prompt, /15:04/, '时间按她的时区渲染（UTC 07:04 = 北京 15:04）')
  assert.match(prompt, /没有人在叫你/, '第一句就要否掉"有人来了"的误解')
  assert.match(prompt, /不用向谁汇报/, '要点明这一段时间不产出汇报')
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

test('房间：第一次是 new_once（指定目录与预设），之后只改下一次的时间', async () => {
  const service = fakeSchedule()
  const dir = await mkdtemp(path.join(tmpdir(), 'humanity-room-'))
  try {
    const deps = { schedule: () => service, homeDir: () => dir, log: quietLog }
    assert.equal(roomDirOf(deps), `${dir.replace(/[\\/]+$/, '')}/humanity/room`)

    const created = await ensureTask(deps, '', 600, '醒来')
    assert.equal(created.ok, true)
    assert.equal(created.room.taskId, 'task-1')
    const request = service.calls.create[0]
    assert.equal(request.title, '她自己的时间')
    assert.equal(request.timing.kind, 'after')
    assert.equal(request.timing.after_seconds, 600)
    assert.equal(request.target.kind, 'new_once', '第一次投递时自动开房间')
    assert.equal(request.target.create.agentPreset, 'humanity', '房间用「Humanity 沉浸」这一档')
    assert.match(request.target.create.cwd, /humanity[\\/]room$/, '房间落在她自己的目录')

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

test('房间：拿不到调度服务时安静失败，并给出人话原因', async () => {
  const deps = { schedule: () => undefined, homeDir: () => undefined, log: quietLog }
  const outcome = await ensureTask(deps, '', 600, '醒来')
  assert.equal(outcome.ok, false)
  assert.match(outcome.reason, /调度服务/)
  // 已有任务时也一样：不抛、不假装成功。
  const moved = await reschedule(deps, 'task-1', 600)
  assert.equal(moved.ok, false)
})
