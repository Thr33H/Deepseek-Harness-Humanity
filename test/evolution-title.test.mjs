/**
 * 房间的名字：她自己那间按日期命名。
 *
 * 为什么值得钉：DSH 原本会按对话内容自动起标题（"关于晚饭的讨论"这种），
 * 而我们要的是**日期** —— 一年以后能直接翻到"11 月 25 日她做了什么"。
 * 这条能力 2026-11-25 查证过：`sessionTitle` 服务的 `rename` 能写，并且写完之后
 * 自动起名不会再覆盖（标题被钉住）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { syncRoomTitle, titleFor } from '../lib/evolution/title.js'

const SESSION = { id: 'session-1' }

/** 假世界：会话表、标题表、追加记录。 */
function fake(current) {
  const appended = []
  let title = current
  return {
    appended,
    deps: {
      sessions: () => ({ get: (id) => (id === 'session-1' ? SESSION : undefined) }),
      titles: () => ({
        get: () => (title === undefined ? undefined : { title }),
        rename: (_session, next) => {
          title = next
          appended.push(next)
          return { title: next }
        },
      }),
    },
    now: () => title,
  }
}

test('名字就是那天的日期', () => {
  assert.equal(titleFor('2026-11-25'), '2026-11-25')
  assert.equal(titleFor(''), '')
})

test('名字已经对了就不动（每次启动都追加一条改名事件是不行的）', () => {
  const world = fake('2026-11-25')
  const outcome = syncRoomTitle(world.deps, 'session-1', '2026-11-25')
  assert.equal(outcome.kind, 'already')
  assert.deepEqual(world.appended, [], '不该重复追加')
})

test('名字不对（DSH 自动起的）→ 改成日期', () => {
  const world = fake('关于晚饭的讨论')
  const outcome = syncRoomTitle(world.deps, 'session-1', '2026-11-25')
  assert.equal(outcome.kind, 'renamed')
  assert.deepEqual(world.appended, ['2026-11-25'])
  assert.equal(world.now(), '2026-11-25')
})

test('会话不是活的、或者服务不在 —— 跳过并说清原因，不抛', () => {
  const world = fake('x')
  const missing = syncRoomTitle(world.deps, 'session-ghost', '2026-11-25')
  assert.equal(missing.kind, 'skipped')
  assert.match(missing.reason, /不是活的/)

  const noService = syncRoomTitle(
    { sessions: () => undefined, titles: () => undefined },
    'session-1',
    '2026-11-25',
  )
  assert.equal(noService.kind, 'skipped')
  assert.match(noService.reason, /会话服务不在/)

  const noTitleService = syncRoomTitle(
    { sessions: world.deps.sessions, titles: () => undefined },
    'session-1',
    '2026-11-25',
  )
  assert.equal(noTitleService.kind, 'skipped')
  assert.match(noTitleService.reason, /标题服务不在/)
})

test('改名本身失败（比如标题不合法）也不抛，返回原因', () => {
  const world = fake('旧的')
  const outcome = syncRoomTitle(
    {
      sessions: world.deps.sessions,
      titles: () => ({
        get: () => ({ title: '旧的' }),
        rename: () => {
          throw new Error('session title must contain visible characters')
        },
      }),
    },
    'session-1',
    '2026-11-25',
  )
  assert.equal(outcome.kind, 'skipped')
  assert.match(outcome.reason, /改名失败/)
  assert.match(outcome.reason, /visible characters/)
})
