/**
 * 性格漂移（`persona/drift.ts`）：四根轴怎么被经历推动。
 *
 * 用户 2026-11-23 定的规则是**双向**的：好事让她更稳更开放，坏事让她更不稳更封闭。
 * 这里逐条钉住，防止以后有人改规则时把"只降不升"偷偷加回来。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { accumulate, applyDrift, DRIFT_FLUSH_MS, DRIFT_STEP, dueToFlush, nudgesOf } from '../lib/persona/drift.js'

/** 造一份只有性格层的最小文档。 */
const docWith = (axes) => ({ character: { derivedAt: '2026-11-20T00:00:00.000Z', axes } })

const axis = (key, value, min = 0.2, max = 0.9) => ({ key, min, max, value, reason: '' })

test('推动规则：被刺痛 → 稳定性、宜人性、开放性都往下', () => {
  const step = nudgesOf({ shifts: [{ kind: 'anger', target: 'user', delta: 8 }] })
  assert.equal(step.stability, -DRIFT_STEP)
  assert.equal(step.agreeableness, -DRIFT_STEP)
  assert.equal(step.openness, -DRIFT_STEP)
  assert.equal(step.extraversion, undefined, '被刺痛不直接改外向性')
})

test('推动规则：世界的破事不许推低她的宜人性（设计方案 §6.3）', () => {
  const world = nudgesOf({ shifts: [{ kind: 'disgust', target: 'world', delta: 9 }] })
  assert.equal(world.stability, -DRIFT_STEP, '看多了皮了 ⇒ 稳定性往下')
  assert.equal(world.openness, -DRIFT_STEP, '见多了 ⇒ 开放性往下')
  assert.equal(world.agreeableness, undefined, '一条帖子不该让她对人更坏')

  const self = nudgesOf({ shifts: [{ kind: 'sadness', target: 'self', delta: 7 }] })
  assert.equal(self.agreeableness, undefined, '对自己失望也不改"怎么待人"')
  assert.equal(self.stability, -DRIFT_STEP)

  // 取不到对象时按"人"算：那是唯一会改变她待人的情形。
  const vague = nudgesOf({ shifts: [{ kind: 'anger', delta: 6 }] })
  assert.equal(vague.agreeableness, -DRIFT_STEP)
})
test('推动规则：被安抚（温度明显上升）→ 稳定性和宜人性往上', () => {
  const step = nudgesOf({ shifts: [], warmth: 4 })
  assert.equal(step.stability, DRIFT_STEP)
  assert.equal(step.agreeableness, DRIFT_STEP)
})

test('推动规则：被冷落（温度明显下降）→ 外向性往下；亲密互动 → 外向性往上', () => {
  assert.equal(nudgesOf({ shifts: [], warmth: -4 }).extraversion, -DRIFT_STEP)
  const intimate = nudgesOf({ shifts: [{ kind: 'joy', target: 'user', delta: 8 }] })
  assert.equal(intimate.extraversion, DRIFT_STEP)
})

test('推动规则：没见过的东西（惊讶明显上升）→ 开放性往上', () => {
  assert.equal(nudgesOf({ shifts: [{ kind: 'surprise', delta: 9 }] }).openness, DRIFT_STEP)
})

test('推动规则：回声与替你难过不算发生在她身上的事', () => {
  assert.deepEqual(nudgesOf({ shifts: [{ kind: 'fear', delta: 9, echo: true }] }), {})
  assert.deepEqual(nudgesOf({ shifts: [{ kind: 'sadness', target: 'user', delta: 9, vicarious: true }] }), {})
})

test('推动规则：同一轮同一根轴最多一步（+ 与被刺相遇会抵消，而不是翻倍）', () => {
  const both = nudgesOf({ shifts: [{ kind: 'anger', delta: 6 }], warmth: 5 })
  assert.equal(both.stability, undefined, '一升一降在同一轮里抵消')
  assert.equal(both.agreeableness, undefined)
})

test('落地：夹在范围里，保留三位小数（0.005 一步不能被四舍五入抹掉）', () => {
  const doc = docWith([axis('stability', 0.58, 0.45, 0.7), axis('agreeableness', 0.44, 0.1, 0.45)])
  const { document, changed } = applyDrift(doc, { stability: 0.005, agreeableness: 0.05 })
  assert.equal(changed, true)
  const stability = document.character.axes.find((item) => item.key === 'stability')
  const agreeableness = document.character.axes.find((item) => item.key === 'agreeableness')
  assert.equal(stability.value, 0.585)
  assert.equal(agreeableness.value, 0.45, '撞到上限就停')
})

test('落地：没有性格层的旧文档不动', () => {
  const result = applyDrift({}, { stability: 0.005 })
  assert.equal(result.changed, false)
})

test('累积与入库时机：攒够阈值、且隔够一天才写', () => {
  let acc = accumulate({}, { stability: DRIFT_STEP })
  assert.equal(dueToFlush(acc, true), false, '一步不够')
  acc = accumulate(acc, { stability: DRIFT_STEP })
  acc = accumulate(acc, { stability: DRIFT_STEP })
  assert.equal(dueToFlush(acc, true), true, '三步够了')
  assert.equal(dueToFlush(acc, false), false, '没隔够一天就不写')
  assert.ok(DRIFT_FLUSH_MS >= 24 * 3600 * 1000)
})
