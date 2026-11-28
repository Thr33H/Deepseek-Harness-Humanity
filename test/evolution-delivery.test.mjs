/**
 * "卡片只是通道"这一层的回归钉。
 *
 * 钉三件事：
 * 1. 会自己到点的旧任务（`after`）**不算通道** —— 它到点就自己投，等于绕过插件做决定；
 * 2. 停着的卡片（`rrule`，2099 才到点）能被认领，不会越建越多；
 * 3. 认领不到就新建一条，而且新建的必须是停着的。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ensureChannel, sendViaCard } from '../lib/evolution/delivery.js'
import { DORMANT_RRULE } from '../lib/evolution/room.js'

const quietLog = { info: () => {}, warn: () => {}, error: () => {} }

/**
 * 假调度服务：只记调用，按我们给的任务表演。
 * @param tasks - `catalog()` 返回的任务。
 */
function fakeSchedule(tasks = []) {
  const calls = { create: [], edit: [], catalog: 0 }
  let next = 1
  return {
    calls,
    async catalog() {
      calls.catalog += 1
      return tasks
    },
    async create(request) {
      calls.create.push(request)
      const id = `task-${next++}`
      // 真机形状：摊平（`ScheduleCatalogEntry = ScheduleRecord & {...}`）。
      return { id, title: request.title, kind: request.timing.kind, scheduledAt: request.timing.rrule ?? '', target: request.target }
    },
    async edit(request) {
      calls.edit.push(request)
      return {}
    },
  }
}

const deps = (schedule) => ({
  schedule: () => schedule,
  agents: () => undefined,
  workspaces: () => undefined,
  modelSelection: () => undefined,
  homeDir: () => undefined,
  roomSetting: () => '',
  log: quietLog,
})

test('通道只认停着的卡片：会自己到点的旧任务会被删掉，再新建一条停着的', async () => {
  const schedule = fakeSchedule([
    {
      id: 'old-wake', title: '她自己的时间', kind: 'after',
      target: { kind: 'session', sessionId: 'session-room' },
    },
  ])
  const out = await ensureChannel(deps(schedule), 'wake', 'session-room', '醒来', 'Asia/Shanghai')
  assert.equal(out.ok, true)
  assert.deepEqual(schedule.calls.edit[0], { id: 'old-wake', action: 'delete' }, '会自己到点的旧任务必须先清')
  assert.equal(schedule.calls.create.length, 1, '清完之后要新建一条')
  assert.equal(schedule.calls.create[0].timing.kind, 'rrule', '新建的必须是停着的卡片')
  assert.match(schedule.calls.create[0].timing.rrule, /2099/, '锚在 2099：它永远不自己响')
})

test('已有停着的卡片：认领它，不重复建', async () => {
  const schedule = fakeSchedule([
    {
      id: 'card-1', title: '她自己的时间', kind: 'rrule', rrule: DORMANT_RRULE,
      target: { kind: 'session', sessionId: 'session-room' },
    },
  ])
  const out = await ensureChannel(deps(schedule), 'wake', 'session-room', '醒来', 'Asia/Shanghai')
  assert.deepEqual(out, { ok: true, taskId: 'card-1' })
  assert.equal(schedule.calls.create.length, 0, '认领到了就不该再建')
  assert.equal(schedule.calls.edit.length, 0, '也不该动它')
})

test('卡片投到别的会话：旧的是废卡，删掉再建一条', async () => {
  const schedule = fakeSchedule([
    {
      id: 'card-other', title: '她自己的时间', kind: 'rrule', rrule: DORMANT_RRULE,
      target: { kind: 'session', sessionId: 'session-elsewhere' },
    },
  ])
  const out = await ensureChannel(deps(schedule), 'wake', 'session-room', '醒来', 'Asia/Shanghai')
  assert.equal(out.ok, true)
  assert.equal(out.taskId, 'task-1', '新建的那条')
  assert.equal(schedule.calls.create[0].target.sessionId, 'session-room')
  assert.deepEqual(schedule.calls.edit[0], { id: 'card-other', action: 'delete' }, '一种通道只留一张')
})

test('存储那种嵌套形状也要认（catalog 摊平，view/create 里见过嵌套）', async () => {
  const schedule = fakeSchedule([
    {
      record: { id: 'card-nested', title: '她自己的时间', kind: 'rrule' },
      target: { kind: 'session', sessionId: 'session-room' },
    },
  ])
  const out = await ensureChannel(deps(schedule), 'wake', 'session-room', '醒来', 'Asia/Shanghai')
  assert.deepEqual(out, { ok: true, taskId: 'card-nested' }, '嵌套形状也要认领得到（否则会每轮新建一张）')
  assert.equal(schedule.calls.create.length, 0)
})

test('同标题的重复卡：留一张、删多余的', async () => {
  const schedule = fakeSchedule([
    { id: 'card-a', title: '她自己的时间', kind: 'rrule', target: { kind: 'session', sessionId: 'session-room' } },
    { id: 'card-b', title: '她自己的时间', kind: 'rrule', target: { kind: 'session', sessionId: 'session-room' } },
  ])
  const out = await ensureChannel(deps(schedule), 'wake', 'session-room', '醒来', 'Asia/Shanghai')
  assert.deepEqual(out, { ok: true, taskId: 'card-a' })
  assert.deepEqual(schedule.calls.edit, [{ id: 'card-b', action: 'delete' }], '重复的那张要删掉')
})

test('投递：直接把消息交给活着的 agent（来源标成调度），不靠调度服务的 run', async () => {
  const sent = []
  const agent = {
    status: 'idle',
    followup: (message) => {
      sent.push(message)
      agent.status = 'running'
    },
  }
  const registry = { get: () => agent, resume: async () => ({ agent }), create: async () => ({}) }
  const schedule = fakeSchedule()
  const out = await sendViaCard({ ...deps(schedule), agents: () => registry }, 'card-1', 'session-room', '该写日记了')
  assert.deepEqual(out, { ok: true })
  assert.equal(sent.length, 1, '消息必须真的交出去')
  assert.equal(sent[0].source.kind, 'schedule', '来源是调度：会话里才显示成自动化任务块')
  assert.equal(sent[0].role, 'user')
  assert.equal(sent[0].content[0].text, '该写日记了')
  assert.equal(schedule.calls.edit.length, 1, '卡片上的字也要改成这一次说的（记录）')
})

test('投递：她说没开始这一轮，就如实报失败（不许假装送到）', async () => {
  const agent = { status: 'idle', followup: () => {} }
  const registry = { get: () => agent, resume: async () => ({ agent }), create: async () => ({}) }
  const out = await sendViaCard({ ...deps(fakeSchedule()), agents: () => registry }, '', 'session-room', '话')
  assert.equal(out.ok, false)
  assert.match(out.reason ?? '', /没有卡片/)
})
