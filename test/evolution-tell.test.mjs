/**
 * 「她主动找你说一句」的回归钉。
 *
 * 三条护栏少一条她就变成推销机器人，所以每条都钉：
 * 1. 一次只说一句（上一句没送走，不收下一句）；
 * 2. 有话在先、有地方可送；
 * 3. 他忙着的时候不送。
 *
 * 外加一条：投递时那段提示词必须**拆穿"这是定时消息"**——否则她会以为是他来了，
 * 答非所问（同一个坑在"她自己醒来"那里踩过一次）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { TELL_DOC_KEY, TELL_MAX_CHARS } from '../lib/evolution/constants.js'
import { EMPTY_TELL, buildTellPrompt, canDeliver, canQueue, readTell, saveTell, unreadOf } from '../lib/evolution/tell.js'

/** 只支持读写文档的假文档表。 */
function fakeDocuments(initial = {}) {
  const store = new Map(Object.entries(initial))
  return {
    read: (ns) => (store.has(ns) ? { value: store.get(ns), revision: 1, updatedAt: '' } : undefined),
    write: async (ns, next) => {
      store.set(ns, next)
      return { value: next, revision: 2, updatedAt: '' }
    },
    peek: (ns) => store.get(ns),
  }
}

const TODAY = '2026-11-25'
const NOW = '2026-11-25T08:00:00.000Z'

test('留话：空话、太长、还有一句没送 —— 都不收（今天说过也照样收）', () => {
  assert.equal(canQueue(EMPTY_TELL, { text: '   ' }).ok, false, '空话不收')
  assert.equal(canQueue(EMPTY_TELL, { text: '啊'.repeat(TELL_MAX_CHARS + 1) }).ok, false, '太长不收')
  assert.equal(canQueue({ ...EMPTY_TELL, pending: '上一句' }, { text: '新的一句' }).ok, false, '上一句没送走就说下一句')
  assert.equal(canQueue({ ...EMPTY_TELL, lastDay: TODAY }, { text: '想说的' }).ok, true, '一天一次那条已经删了：想找就找')
})

test('留话：正常的一句会收下，并修剪掉多余空白', () => {
  const verdict = canQueue(EMPTY_TELL, { text: '  今天  我去看了潮汐 ' })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.text, '今天 我去看了潮汐')
  assert.equal(verdict.show, '')
})

test('留话：可以只给他看一样东西，不带话', () => {
  const verdict = canQueue(EMPTY_TELL, { show: 'note.md' })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.text, '')
  assert.equal(verdict.show, 'note.md')
})

test('留话：文件只认她自己目录里的顶层名字（带路径、点点、点开头都不收）', () => {
  assert.equal(canQueue(EMPTY_TELL, { show: 'sub/note.md' }).ok, false)
  assert.equal(canQueue(EMPTY_TELL, { show: '..\\note.md' }).ok, false)
  assert.equal(canQueue(EMPTY_TELL, { show: '/etc/passwd' }).ok, false)
  assert.equal(canQueue(EMPTY_TELL, { show: '.hidden' }).ok, false)
  assert.equal(canQueue(EMPTY_TELL, { text: '看这个', show: 'note.md' }).ok, true)
})

test('留话：昨天说过、今天还没说 —— 可以', () => {
  assert.equal(canQueue({ ...EMPTY_TELL, lastDay: '2026-11-24' }, { text: '新的话' }).ok, true)
})

test('送话：没话就不送（而且不记原因，这不是故障）', () => {
  const verdict = canDeliver(EMPTY_TELL, 'session-1')
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, '')
})

test('送话：今天已经送过也照送（一天一次那条删了）', () => {
  const doc = { ...EMPTY_TELL, pending: '想说的', lastDay: TODAY }
  const verdict = canDeliver(doc, 'session-1')
  assert.equal(verdict.ok, true)
})

test('送话：还没说过话的会话 —— 送不出去，要说清为什么', () => {
  const doc = { ...EMPTY_TELL, pending: '想说的' }
  const verdict = canDeliver(doc, '')
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /等他来一次/)
})

test('送话：有话、有地方、今天没说过 —— 送', () => {
  const doc = { ...EMPTY_TELL, pending: '想说的' }
  assert.deepEqual(canDeliver(doc, 'session-1'), { ok: true, text: '想说的', show: '' })
})

test('送话：只说一句这条还在（上一句没送走，不收下一句）', () => {
  assert.equal(canQueue({ ...EMPTY_TELL, pending: '上一句' }, { text: '新的一句' }).ok, false)
})

test('投递提示词：必须拆穿"这条不是他发的"，且不许提系统', () => {
  const prompt = buildTellPrompt('我想问你昨天是不是不太高兴')
  assert.match(prompt, /我想问你昨天是不是不太高兴/, '原话要带上')
  assert.match(prompt, /不是他发来的/, '不拆穿她会以为是他来了')
  assert.match(prompt, /不要说"这是定时消息"/)
  assert.match(prompt, /说完了就停/, '说过了不追问')
})

test('投递提示词：带作品时要说清名字，并告诉他去哪儿看', () => {
  const prompt = buildTellPrompt('我给你写了点东西', 'note.md')
  assert.match(prompt, /note\.md/, '文件名字要带上')
  assert.match(prompt, /她留下的东西/, '要说清他能在哪儿打开')
})

test('投递提示词：给了绝对路径就让她用 present 交出去（他那边能直接点开）', () => {
  const prompt = buildTellPrompt('给你看个东西', 'note.md', '/data/dsh/humanity/room/note.md')
  assert.match(prompt, /\/data\/dsh\/humanity\/room\/note\.md/, '绝对路径要写进去')
  assert.match(prompt, /present/, '要指名 present 这个动作')
  assert.match(prompt, /"path": "\/data\/dsh\/humanity\/room\/note\.md"/, '参数写法要给死，别让她猜')
  assert.match(prompt, /要是 present 用不了/, '备一条退路：至少把名字说出来')
})

test('投递提示词：只给东西不说事也要成立', () => {
  const prompt = buildTellPrompt('', 'note.md')
  assert.match(prompt, /note\.md/)
  assert.match(prompt, /不是他发来的/)
})

test('送话：只给他看东西（没有话）也会送', () => {
  const doc = { ...EMPTY_TELL, pendingShow: 'note.md' }
  assert.deepEqual(canDeliver(doc, 'session-1'), { ok: true, text: '', show: 'note.md' })
})

test('看没看：没送过就不算未读；送过没回过算未读；他之后说过话就算看过', () => {
  assert.equal(unreadOf(EMPTY_TELL), false, '从没主动过 —— 没有未读')
  const delivered = { ...EMPTY_TELL, lastAt: '2026-11-25T08:00:00.000Z', lastText: '找你说一句' }
  assert.equal(unreadOf(delivered), true, '送出去了、他还没说话')
  assert.equal(unreadOf({ ...delivered, seenAt: '2026-11-25T07:00:00.000Z' }), true, '他在这之前说过话不算看过')
  assert.equal(unreadOf({ ...delivered, seenAt: '2026-11-25T09:00:00.000Z' }), false, '他之后说过话 —— 看过了')
})

test('投递记录：存进去读得回来；没存过读成空记录', async () => {
  const documents = fakeDocuments()
  assert.deepEqual(readTell(documents), EMPTY_TELL)
  assert.deepEqual(readTell(undefined), EMPTY_TELL)

  await saveTell(documents, {
    ...EMPTY_TELL,
    pending: '想说的',
    pendingAt: NOW,
    lastDay: '2026-11-24',
    lastText: '昨天说过的',
    lastReason: '',
    taskId: 'schedule-x',
    taskSession: 'session-1',
  })
  const back = readTell(documents)
  assert.equal(back.pending, '想说的')
  assert.equal(back.taskId, 'schedule-x')
  assert.equal(back.taskSession, 'session-1')
  assert.equal(documents.peek(TELL_DOC_KEY).pending, '想说的')
})
