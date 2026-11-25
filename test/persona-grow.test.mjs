/**
 * 「她自己整理自己」的回归钉。
 *
 * 钉六件事：
 * 1. 同一件事只留一条，且**极性相反不算同一件**（爱吃 / 不爱吃）；
 * 2. 升级要**够次数 + 跨够多天**（一天连说三遍不算）；
 * 3. 久不再提就作废（冷候选 7 天、热候选 15 天）；
 * 4. 写入**不许丢旧条目**、不许新造小节 —— 这是机器校验，不是靠模型自觉；
 * 5. 已经在信息层里的观察**不进队列**（省得攒到升级才发现白攒）；
 * 6. 模型坏了只留痕迹，不写、不抛。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  GROW_DOC_KEY,
  SAME_TOPIC,
  dueCandidates,
  mergeObservation,
  pruneQueue,
  readGrowQueue,
  sameTopic,
} from '../lib/persona/grow-queue.js'
import { applySections, growDay, lostItems, parseGrow } from '../lib/persona/grow.js'

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

/** 一份已封存的人格文档。 */
function personaDoc() {
  return {
    schemaVersion: 7,
    identityCard: { fields: [], initializedAt: '2026-11-20T00:00:00.000Z', sealedAt: '2026-11-20T00:00:00.000Z' },
    mutableLayer: {
      sections: [
        { title: '对TA的称呼', items: ['「火火」'] },
        { title: '说话风格', items: ['不使用官腔官话'] },
        { title: '关系', items: ['火火是我的主人'] },
      ],
      userDefined: [],
    },
    character: { derivedAt: '', axes: [] },
  }
}

/** 假的写入入口：只记最后一次写进去的文档。 */
function fakeSection(document) {
  const box = { current: document, writes: 0 }
  return {
    box,
    read: () => box.current,
    write: async (next) => {
      box.current = next
      box.writes += 1
    },
  }
}

/** 假的模型调用：固定回一段原文。 */
function fakeLlm(payload) {
  return {
    route: () => ({ provider: 'p', model: 'm' }),
    streamText: async () => ({ text: payload, inputTokens: 0, outputTokens: 0, finishReason: 'stop' }),
  }
}

/** 空队列。 */
function emptyQueue() {
  return { candidates: [], lastRun: { at: '', wrote: [], queued: [], note: '' } }
}

const DAY = '2026-11-25'
const NOW = '2026-11-25T15:00:00.000Z'

test('队列：同一件事再说一次只加次数，不新起一条', () => {
  let queue = emptyQueue()
  queue = mergeObservation(queue, { text: '爱吃糖葫芦', about: 'user', section: '关系' }, '2026-11-24', '2026-11-24T10:00:00.000Z')
  queue = mergeObservation(queue, { text: '想吃糖葫芦', about: 'user', section: '关系' }, DAY, NOW)
  assert.equal(queue.candidates.length, 1)
  assert.equal(queue.candidates[0].count, 2)
  assert.deepEqual(queue.candidates[0].days, ['2026-11-24', DAY])
})

test('队列：极性相反不算同一件事（爱吃 / 不爱吃）', () => {
  assert.equal(sameTopic('爱吃糖葫芦', '不爱吃糖葫芦'), false)
  let queue = emptyQueue()
  queue = mergeObservation(queue, { text: '爱吃糖葫芦', about: 'user', section: '关系' }, DAY, NOW)
  queue = mergeObservation(queue, { text: '不爱吃糖葫芦', about: 'user', section: '关系' }, DAY, NOW)
  assert.equal(queue.candidates.length, 2)
})

test('队列：够三次且跨三天才到条件', () => {
  const oneDay = {
    ...emptyQueue(),
    candidates: [{
      text: '爱吃糖葫芦', about: 'user', section: '关系', count: 3,
      days: [DAY, DAY, DAY], firstAt: NOW, lastAt: NOW,
    }],
  }
  assert.equal(dueCandidates(oneDay, 1).length, 0, '一天里连说三遍不算' + SAME_TOPIC)
  const threeDays = {
    ...emptyQueue(),
    candidates: [{
      text: '爱吃糖葫芦', about: 'user', section: '关系', count: 3,
      days: ['2026-11-23', '2026-11-24', DAY], firstAt: NOW, lastAt: NOW,
    }],
  }
  assert.equal(dueCandidates(threeDays, 1).length, 1)
  assert.equal(dueCandidates(threeDays, 0).length, 0, '每日上限为 0 时一条都不写')
})

test('队列：久不再提就作废（冷 7 天、热 15 天）', () => {
  const queue = {
    ...emptyQueue(),
    candidates: [
      { text: '冷的一提', about: 'self', section: '关系', count: 1, days: ['2026-11-01'], firstAt: '2026-11-01T10:00:00.000Z', lastAt: '2026-11-01T10:00:00.000Z' },
      { text: '热的提过两次', about: 'self', section: '关系', count: 2, days: ['2026-11-18', '2026-11-19'], firstAt: '2026-11-18T10:00:00.000Z', lastAt: '2026-11-19T10:00:00.000Z' },
    ],
  }
  const after = pruneQueue(queue, '2026-11-25T10:00:00.000Z')
  assert.deepEqual(after.candidates.map((item) => item.text), ['热的提过两次'], '冷的第 8 天就该走')
  const muchLater = pruneQueue(queue, '2026-12-10T10:00:00.000Z')
  assert.equal(muchLater.candidates.length, 0, '热候选也会作废（不是永久）')
})

test('校验：旧条目变长可以，消失不行', () => {
  assert.deepEqual(lostItems(['不使用官腔官话'], ['不使用「我认」「明白了」等官腔官话']), [])
  assert.deepEqual(lostItems(['关系很好'], ['关系不错']), ['关系很好'])
  assert.deepEqual(lostItems([], ['新的一条']), [])
})

test('写入：正常合并（变长）会写进去', () => {
  const document = personaDoc()
  const { next, applied, rejected } = applySections(document, [
    { title: '说话风格', items: ['不使用官腔官话，也不用「我认」「明白了」', '喜欢反问'] },
  ])
  assert.deepEqual(applied, ['说话风格'])
  assert.deepEqual(rejected, [])
  assert.deepEqual(next.mutableLayer.sections[1].items, ['不使用官腔官话，也不用「我认」「明白了」', '喜欢反问'])
  // 别的小节原样不动
  assert.deepEqual(next.mutableLayer.sections[0].items, ['「火火」'])
})

test('写入：会丢旧条目 / 新造小节 / 交空 —— 整节不写', () => {
  const document = personaDoc()
  const result = applySections(document, [
    { title: '说话风格', items: ['换成别的说法'] },
    { title: '喜欢的食物', items: ['糖葫芦'] },
    { title: '关系', items: [] },
  ])
  assert.deepEqual(result.applied, [])
  assert.equal(result.rejected.length, 3)
  assert.deepEqual(result.next.mutableLayer.sections[1].items, ['不使用官腔官话'], '拒绝的那节保持原样')
})

test('写入：一节里加太多条也拒（这不是整理，是重写）', () => {
  const result = applySections(personaDoc(), [
    { title: '说话风格', items: ['不使用官腔官话', 'a', 'b', 'c', 'd', 'e'] },
  ])
  assert.deepEqual(result.applied, [])
  assert.match(result.rejected[0], /一次加太多/)
})

test('解析：坏 JSON / 空对象都不算成功', () => {
  assert.equal(parseGrow('这不是 JSON'), undefined)
  assert.deepEqual(parseGrow('{}'), { sections: [], candidates: [] })
  const parsed = parseGrow('{"sections":[{"title":"关系","items":["火火是我的主人"]}],"candidates":[{"about":"user","section":"关系","text":"爱吃糖葫芦"}]}')
  assert.equal(parsed.sections.length, 1)
  assert.equal(parsed.candidates[0].text, '爱吃糖葫芦')
})

test('整理一次：明确要求当天落地，观察进队列', async () => {
  const documents = fakeDocuments()
  const section = fakeSection(personaDoc())
  const llm = fakeLlm(JSON.stringify({
    sections: [{ title: '说话风格', items: ['不使用官腔官话，也不用「我认」「明白了」'] }],
    candidates: [{ about: 'user', section: '关系', text: '爱吃糖葫芦' }],
  }))
  await growDay({ documents: () => documents, section, llm, log: { info() {}, warn() {} } }, {
    material: { hers: [], talk: ['他说：以后别总说我认了', '他说：想吃糖葫芦'] },
    date: DAY,
    nowIso: NOW,
  })
  assert.equal(section.box.writes, 1, '该写一次')
  assert.match(section.box.current.mutableLayer.sections[1].items[0], /我认/)
  const queue = readGrowQueue(documents)
  assert.deepEqual(queue.candidates.map((item) => item.text), ['爱吃糖葫芦'])
  assert.deepEqual(queue.lastRun.wrote, ['说话风格'])
})

test('整理一次：已经在信息层里的观察不进队列（不白攒）', async () => {
  const documents = fakeDocuments()
  const section = fakeSection(personaDoc())
  const llm = fakeLlm(JSON.stringify({ sections: [], candidates: [{ about: 'self', section: '关系', text: '官腔官话' }] }))
  await growDay({ documents: () => documents, section, llm, log: { info() {}, warn() {} } }, {
    material: { hers: [], talk: ['他说：你老是官腔官话'] },
    date: DAY,
    nowIso: NOW,
  })
  assert.equal(section.box.writes, 0)
  assert.equal(readGrowQueue(documents).candidates.length, 0)
})

test('整理一次：到期的那条写进去之后从队列里消失', async () => {
  const documents = fakeDocuments({
    [GROW_DOC_KEY]: {
      candidates: [{
        text: '想去看海', about: 'self', section: '关系', count: 3,
        days: ['2026-11-23', '2026-11-24', DAY], firstAt: '2026-11-23T10:00:00.000Z', lastAt: NOW,
      }],
      lastRun: { at: '', wrote: [], queued: [], note: '' },
    },
  })
  const section = fakeSection(personaDoc())
  const llm = fakeLlm(JSON.stringify({
    sections: [{ title: '关系', items: ['火火是我的主人', '想去看海'] }],
    candidates: [],
  }))
  await growDay({ documents: () => documents, section, llm, log: { info() {}, warn() {} } }, {
    material: { hers: ['她说：想去看海'], talk: [] },
    date: DAY,
    nowIso: NOW,
  })
  assert.equal(readGrowQueue(documents).candidates.length, 0, '写成了就别再攒着')
  assert.match(section.box.current.mutableLayer.sections[2].items.join(''), /想去看海/)
})

test('整理一次：模型坏了只留痕迹，不写、不抛', async () => {
  const documents = fakeDocuments()
  const section = fakeSection(personaDoc())
  const llm = fakeLlm('我今天不想输出 JSON')
  await growDay({ documents: () => documents, section, llm, log: { info() {}, warn() {} } }, {
    material: { hers: [], talk: ['他说：在吗'] },
    date: DAY,
    nowIso: NOW,
  })
  assert.equal(section.box.writes, 0)
  assert.match(readGrowQueue(documents).lastRun.note, /没法用/)
})
