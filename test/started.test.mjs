/**
 * 「humanity 正式启动」的判据测试（2026-11-22）。
 *
 * 用户定的规则：人格**封存**之前，情绪/记忆/自进化一律休眠；封存那一刻才启动。
 * 这条判据被宿主用来开关三个模块，必须能单独验 —— 它读的是活文档，不能缓存。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { emotionDeps, humanityStarted, memoryDeps } from '../lib/deps.js'

/** 造一个只有人格文档的宿主状态。 */
const stateWith = (sealedAt) => ({
  persona: { section: { read: () => ({ identityCard: { sealedAt } }) } },
})

test('启动判据：封存了才算启动', () => {
  assert.equal(humanityStarted(stateWith('2026-11-22T12:00:00.000Z')), true)
})

test('启动判据：没封存就是休眠（空白、缺字段、没人格模块都算没启动）', () => {
  assert.equal(humanityStarted(stateWith('')), false)
  assert.equal(humanityStarted(stateWith('   ')), false, '空白也要当没封存')
  assert.equal(humanityStarted({}), false, '人格模块还没装上')
  assert.equal(humanityStarted({ persona: { section: { read: () => ({}) } } }), false, '文档形状残缺')
})

test('休眠：人格没封存时情绪与记忆的 enabled() 都是 false，封存后立刻为 true（现读，不缓存）', () => {
  // 用户 2026-11-22 的规则：人格封存前，其他模块一律休眠。最危险的不是"关不掉"，
  // 而是把它在装配时算一次缓存下来 —— 那时存储往往还没就绪，读到的是默认文档。
  let sealed = ''
  const settings = {
    read: () => ({ enabled: true, modules: { emotion: { enabled: true }, memory: { enabled: true } } }),
  }
  const state = { persona: { section: { read: () => ({ identityCard: { sealedAt: sealed } }) } } }
  const memory = memoryDeps(settings, state)
  const emotion = emotionDeps(settings, state)

  assert.equal(memory.enabled(), false, '没封存：记忆休眠')
  assert.equal(emotion.enabled(), false, '没封存：情绪休眠')

  sealed = '2026-11-22T12:29:00.000Z'
  assert.equal(memory.enabled(), true, '同一份 deps 上必须立刻读到封存（不能缓存）')
  assert.equal(emotion.enabled(), true)
})
