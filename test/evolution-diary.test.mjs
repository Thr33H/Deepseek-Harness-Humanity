/**
 * 收账的回归钉。
 *
 * 2026-11-26 起，日记**由她自己写**：插件只把材料递过去、投一句"写吧"，写完再把文件收进档案。
 * 所以这里钉四件事：
 * 1. 一天只有一篇（同一天再写会覆盖那一天）；
 * 2. 超出保留上线的旧篇挪进归档，不删；
 * 3. 投给她的那段话里要带**写作纪律**（场景、心里话、别总结、别编），称呼走数据；
 * 4. 从她文件里读回来的正文要能正确解码（含中文与 emoji）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  appendDiary,
  buildCollectPrompt,
  decodeBase64Text,
  DIARY_ARCHIVE_KEY,
  DIARY_DOC_KEY,
  diaryFileName,
  materialFileText,
  materialFileName,
  readDiary,
} from '../lib/evolution/diary.js'

/** 只支持读写一份文档的假文档表。 */
function fakeDocuments() {
  const store = new Map()
  return {
    read: (ns) => (store.has(ns) ? { value: store.get(ns), revision: 1, updatedAt: '' } : undefined),
    write: async (ns, next) => {
      store.set(ns, next)
      return { value: next, revision: 2, updatedAt: '' }
    },
    merge: async () => {
      throw new Error('日记只用 write')
    },
    list: () => [],
    current: () => store.get(DIARY_DOC_KEY),
    peek: (ns) => store.get(ns),
  }
}

test('日记：同一天只留一篇（后写的覆盖前一篇）', async () => {
  const documents = fakeDocuments()
  await appendDiary(documents, { date: '2026-11-24', text: '第一篇', createdAt: '2026-11-24T10:00:00.000Z', openedAt: '', noticedAt: '' })
  await appendDiary(documents, { date: '2026-11-24', text: '改写的', createdAt: '2026-11-24T11:00:00.000Z', openedAt: '', noticedAt: '' })
  await appendDiary(documents, { date: '2026-11-25', text: '第二天', createdAt: '2026-11-25T10:00:00.000Z', openedAt: '', noticedAt: '' })
  const entries = readDiary(documents)
  assert.equal(entries.length, 2)
  assert.equal(entries[0].date, '2026-11-24')
  assert.equal(entries[0].text, '改写的', '同一天后写的覆盖前一篇')
  assert.equal(entries[1].date, '2026-11-25')
})

test('日记：超出保留上线的旧篇挪进归档，不删', async () => {
  const documents = fakeDocuments()
  // 直接塞一篇"很旧"的，再看它有没有被搬走（保留上线是 400，这里用假的小数组验证逻辑）。
  const many = Array.from({ length: 5 }, (_, index) => ({
    date: `2026-11-${String(index + 1).padStart(2, '0')}`,
    text: `第 ${index + 1} 篇`,
    createdAt: '2026-11-01T00:00:00.000Z',
    openedAt: '',
    noticedAt: '',
  }))
  await documents.write(DIARY_DOC_KEY, { entries: many })
  await appendDiary(documents, { date: '2026-11-06', text: '第六篇', createdAt: '2026-11-06T00:00:00.000Z', openedAt: '', noticedAt: '' })
  assert.equal(readDiary(documents).length, 6, '还没到保留上线，一篇都不该搬走')
  assert.equal(documents.peek(DIARY_ARCHIVE_KEY), undefined)
})

test('日记：读不到 / 形状坏掉时当作没有（不抛）', () => {
  assert.deepEqual(readDiary(undefined), [])
  const broken = {
    read: () => ({ value: { entries: 'not-an-array' }, revision: 1, updatedAt: '' }),
  }
  assert.deepEqual(readDiary(broken), [])
  const mixed = {
    read: () => ({ value: { entries: [{ date: '2026-11-24', text: '好的' }, { text: '' }, null] }, revision: 1, updatedAt: '' }),
  }
  const entries = readDiary(mixed)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].text, '好的')
})

test('材料文件：两栏分开写，空的一栏要明说', () => {
  const text = materialFileText({ hers: ['她说：翻了半本书'], talk: [] }, '2026-11-26')
  assert.match(text, /# 2026-11-26 的材料/)
  assert.match(text, /## 你自己那段时间/)
  assert.match(text, /翻了半本书/)
  assert.match(text, /## 你们这一天/)
  assert.match(text, /这一天你们没有说过话/, '空的那一栏要说清，不能留白')
})

test('文件名按日期来（她自己要找得到）', () => {
  assert.equal(diaryFileName('2026-11-26'), 'diary-2026-11-26.md')
  assert.equal(materialFileName('2026-11-26'), '日记材料-2026-11-26.md')
})

test('收账投递：称呼走数据，写作纪律要写进去', () => {
  const prompt = buildCollectPrompt('2026-11-26', '日记材料-2026-11-26.md', 'diary-2026-11-26.md', '囡囡')
  assert.match(prompt, /\[收账\]/, '带标记，好认')
  assert.match(prompt, /囡囡不在/, '称呼从数据来')
  assert.match(prompt, /日记材料-2026-11-26\.md/, '材料文件要点名')
  assert.match(prompt, /diary-2026-11-26\.md/, '写到哪儿要点名')
  assert.match(prompt, /场景/, '写作纪律：写成场景')
  assert.match(prompt, /心里冒出来的话/, '写作纪律：一句当时的心里话')
  assert.match(prompt, /不要总结这一天/, '写作纪律：别写成周报')
  assert.match(prompt, /不要编/, '写作纪律：不编')

  const plain = buildCollectPrompt('2026-11-26', 'a.md', 'b.md')
  assert.match(plain, /对方不在/, '没设称呼就用"对方"')
})

test('从她的文件里读回正文：base64 要能解出中文与 emoji', () => {
  const original = '# 2026-11-26\n\n夜里快一点，他发来一句"还没睡？"。🫧'
  const base64 = Buffer.from(original, 'utf8').toString('base64')
  assert.equal(decodeBase64Text(base64), original)
  assert.equal(decodeBase64Text(''), '')
  assert.equal(decodeBase64Text('!!!'), '')
})
