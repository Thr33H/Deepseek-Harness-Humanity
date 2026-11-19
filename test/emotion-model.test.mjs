/**
 * 情绪**模型本身**的完整性穷举。
 *
 * 前面几个测试文件钉的是"某个机制的行为"，这个文件钉的是"整套数据结构闭不闭合"。
 * 为什么值得单独一组：这些表都是手写的常量，漏一项不会报错，只会**静默失效**——
 * 少一个角度，那种情绪就永远不被对冲；少一条复合，那对组合就永远显示成并列。
 *
 * 覆盖方式是真的**穷举**，不是抽样：
 * - 8 种情绪 × 4 张表（标签/角度/半衰期/词表）；
 * - 28 种两两组合（8 选 2）逐个检查：要么有复合名，要么是那 4 对对极；
 * - 4 对对极、8 组相邻、8 组隔一格、8 组隔两格，对立度逐个核对。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  EMOTION_ANGLE,
  EMOTION_BLENDS,
  EMOTION_HALF_LIFE_MINUTES,
  EMOTION_KINDS,
  EMOTION_LABELS,
  EMOTION_TARGETS,
  EMOTION_TARGET_LABELS,
  EMOTION_WORDS,
  MAX_CHARGES,
} from '../lib/emotion/constants.js'
import { oppositionBetween } from '../lib/emotion/dynamics.js'
import { compositeOf } from '../lib/emotion/view.js'

/** 造一条视图条目（只有合成需要 kind / label / tier）。 */
const view = (kind, intensity = 50) => ({
  kind,
  label: EMOTION_LABELS[kind],
  target: 'world',
  targetLabel: '',
  intensity,
  tier: intensity >= 30 ? 'clear' : 'calm',
  cause: '',
  since: '2026-01-01T00:00:00.000Z',
})

test('八种情绪在四张表里都齐（漏一项 = 那种情绪某条路走不通）', () => {
  for (const table of [EMOTION_LABELS, EMOTION_ANGLE, EMOTION_HALF_LIFE_MINUTES, EMOTION_WORDS]) {
    assert.deepEqual(Object.keys(table).sort(), [...EMOTION_KINDS].sort())
  }
})

test('三种对象都有前缀（漏一项 = 那种对象在提示词里没有称呼）', () => {
  assert.deepEqual(Object.keys(EMOTION_TARGET_LABELS).sort(), [...EMOTION_TARGETS].sort())
  // `world` 必须是空串：对事的情绪不该在句子里插一个"对这件事"。
  assert.equal(EMOTION_TARGET_LABELS.world, '')
})

test('每种情绪的三档词互不相同（同词 = 档位形同虚设）', () => {
  for (const kind of EMOTION_KINDS) {
    const [, faint, clear, burst] = EMOTION_WORDS[kind]
    const distinct = new Set([faint, clear, burst])
    assert.equal(distinct.size, 3, `${kind} 的三档词有重复：${faint}/${clear}/${burst}`)
    for (const word of [faint, clear, burst]) assert.ok(word.length > 0, `${kind} 有空词`)
  }
})

test('半衰期都是正数', () => {
  for (const kind of EMOTION_KINDS) {
    assert.ok(EMOTION_HALF_LIFE_MINUTES[kind] > 0, `${kind} 的半衰期必须为正`)
  }
})

/* ───────────────────────── 24 组复合：逐个穷举 ───────────────────────── */

test('二十四组复合：每一组都能被认出来（顺序无关）', () => {
  for (const [left, right, label] of EMOTION_BLENDS) {
    const forward = compositeOf([view(left), view(right)])
    assert.equal(forward?.label, label, `${left}+${right} 正向没认出来`)
    const backward = compositeOf([view(right), view(left)])
    assert.equal(backward?.label, label, `${left}+${right} 反向没认出来`)
  }
})

test('复合表覆盖 8 选 2 的全部 28 对：24 对有名字，4 对是对极', () => {
  // 对极也走 `sort().join()` 生成：手写字面量会因为顺序不同而假阴性（本文件第一版就踩过）。
  const opposite = new Set(
    [
      ['joy', 'sadness'],
      ['trust', 'disgust'],
      ['fear', 'anger'],
      ['surprise', 'anticipation'],
    ].map((pair) => [...pair].sort().join('|')),
  )
  const named = new Set(EMOTION_BLENDS.map(([left, right]) => [left, right].sort().join('|')))

  assert.equal(named.size, 24, '复合表里有重复或漏项')
  let pairs = 0
  for (let i = 0; i < EMOTION_KINDS.length; i += 1) {
    for (let j = i + 1; j < EMOTION_KINDS.length; j += 1) {
      pairs += 1
      const key = [EMOTION_KINDS[i], EMOTION_KINDS[j]].sort().join('|')
      const hasName = named.has(key)
      const isOpposite = opposite.has(key)
      assert.ok(hasName !== isOpposite, `${key} 应为「有名字」或「对极」二者之一，实际 hasName=${hasName}`)
    }
  }
  assert.equal(pairs, 28, '八种情绪的两两组合必须是 28 对')
})

test('复合只在两条都到档位时才出现', () => {
  // 一条到、一条没到：不合成。
  assert.equal(compositeOf([view('joy', 50), view('trust', 10)]), undefined)
  assert.equal(compositeOf([view('joy', 10), view('trust', 10)]), undefined)
  // 两条都到：合成。
  assert.equal(compositeOf([view('joy', 30), view('trust', 30)])?.label, '爱')
})

test('复合只看最强的两条（第三条不参与）', () => {
  // 喜悦 60 与信任 55 是"爱"；多一条愤怒 50 不该改变结果。
  const result = compositeOf([view('joy', 60), view('trust', 55), view('anger', 50)])
  assert.equal(result?.label, '爱')
})

test('复合带上的是两条的中文名', () => {
  const result = compositeOf([view('disgust', 60), view('anger', 55)])
  assert.deepEqual(result?.parts, ['厌恶', '愤怒'])
})

/* ───────────────────── 对冲距离：4 对 + 8 组 × 3 层 ───────────────────── */

test('四对对极的对立度都是 1', () => {
  for (const [a, b] of [
    ['joy', 'sadness'],
    ['trust', 'disgust'],
    ['fear', 'anger'],
    ['surprise', 'anticipation'],
  ]) {
    assert.equal(oppositionBetween(a, b), 1, `${a}↔${b} 应当是完全对立`)
  }
})

test('相邻八组（primary dyad 那八个）对立度都是 0，不互压', () => {
  for (const [a, b] of EMOTION_BLENDS.slice(0, 8)) {
    assert.equal(oppositionBetween(a, b), 0, `${a}↔${b} 相邻，不该互压`)
  }
})

test('相隔 90° 的八组对立度约 0.71', () => {
  for (const [a, b] of EMOTION_BLENDS.slice(8, 16)) {
    assert.ok(Math.abs(oppositionBetween(a, b) - Math.SQRT1_2) < 0.001, `${a}↔${b} 应为 90°`)
  }
})

test('相隔 135° 的八组对立度约 0.87', () => {
  for (const [a, b] of EMOTION_BLENDS.slice(16, 24)) {
    assert.ok(Math.abs(oppositionBetween(a, b) - Math.sqrt(0.75)) < 0.001, `${a}↔${b} 应为 135°`)
  }
})

test('自己与自己对立度为 0', () => {
  for (const kind of EMOTION_KINDS) assert.equal(oppositionBetween(kind, kind), 0)
})

test('并存上限是四条（八种同时来也只留四条）', () => {
  assert.equal(MAX_CHARGES, 4)
})
test('本轮刚冒出对立情绪时，复合被否决（被骂"你只是个工具"不该显示「爱」）', () => {
  const joyTrust = [view('joy', 76), view('trust', 52), view('anger', 22)]
  // 不传 touched：老行为，只看前两条 → 合出「爱」。
  assert.equal(compositeOf(joyTrust)?.label, '爱')
  // 传了 touched（愤怒是本轮刚冒出来的）→ 否决。
  assert.equal(compositeOf(joyTrust, new Set(['anger:user'])), undefined)
})

test('复合的两条自己本轮被改，不构成否决', () => {
  const joyTrust = [view('joy', 76), view('trust', 52)]
  assert.equal(compositeOf(joyTrust, new Set(['joy:user', 'trust:user']))?.label, '爱')
})

test('期待与信任相隔 90°：也算对立，会否决「爱」', () => {
  // 我一开始以为"期待与喜悦相邻"就等于"和这一对同侧"，实测发现它和**信任**正好差 90°。
  // 这条留着提醒：判断"同侧"要同时看复合的两条，不能只看一条。
  const charges = [view('joy', 76), view('trust', 52)]
  assert.equal(compositeOf(charges, new Set(['anticipation:world'])), undefined)
})

test('惊讶与喜悦相隔 135°：更该否决', () => {
  const charges = [view('joy', 76), view('trust', 52)]
  assert.equal(compositeOf(charges, new Set(['surprise:world'])), undefined)
})
