/**
 * 房间的名字：她自己那间按日期命名。
 *
 * 为什么值得钉：DSH 原本会按对话内容自动起标题（"关于晚饭的讨论"这种），
 * 而我们要的是**日期** —— 一年以后能直接翻到"11 月 25 日她做了什么"。
 *
 * 2026-11-25 两次真机失败换来的两条约束（都钉在这里）：
 * 1. **必须拿活着的会话对象**，不能用 id 去查（插件作用域里查不到）；
 * 2. 名字已经是这个就**不能**再改名（启动一次就追加一条事件是不行的）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { renameSession, titleFor } from '../lib/evolution/title.js'

const SESSION = { id: 'session-1' }

/** 假世界：标题表 + 追加记录。 */
function fake(current) {
  const appended = []
  let title = current
  return {
    appended,
    deps: {
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
  const outcome = renameSession(world.deps, SESSION, '2026-11-25')
  assert.equal(outcome.kind, 'already')
  assert.deepEqual(world.appended, [], '不该重复追加')
})

test('名字不对（DSH 自动起的）→ 改成日期', () => {
  const world = fake('关于晚饭的讨论')
  const outcome = renameSession(world.deps, SESSION, '2026-11-25')
  assert.equal(outcome.kind, 'renamed')
  assert.deepEqual(world.appended, ['2026-11-25'])
  assert.equal(world.now(), '2026-11-25')
})

test('没有活的会话对象 / 服务不在 —— 跳过并说清原因，不抛', () => {
  const world = fake('x')
  const noSession = renameSession(world.deps, undefined, '2026-11-25')
  assert.equal(noSession.kind, 'skipped')
  assert.match(noSession.reason, /没有活的会话对象/)

  const noService = renameSession({ titles: () => undefined }, SESSION, '2026-11-25')
  assert.equal(noService.kind, 'skipped')
  assert.match(noService.reason, /标题服务不在/)
})

test('改名本身失败（比如标题不合法）也不抛，返回原因', () => {
  const outcome = renameSession(
    {
      titles: () => ({
        get: () => ({ title: '旧的' }),
        rename: () => {
          throw new Error('session title must contain visible characters')
        },
      }),
    },
    SESSION,
    '2026-11-25',
  )
  assert.equal(outcome.kind, 'skipped')
  assert.match(outcome.reason, /改名失败/)
  assert.match(outcome.reason, /visible characters/)
})
