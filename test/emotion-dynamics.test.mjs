/**
 * 情绪对冲的回归测试。
 *
 * 这一层最容易出的不是崩溃，而是**穿帮**：愤怒 70 的时候它还在说"我挺开心的"。
 * 所以这里钉的是四个可观察的性质：
 * 1. 对立面压得住（愤怒压喜悦）；
 * 2. 相邻的不互压（喜悦与信任可以同时满格 —— 它们本来就该合成"爱"）；
 * 3. 压制**可逆** —— 愤怒消退后，高兴自己回来，不需要任何"解压"事件；
 * 4. 同分不互压（避免两个中等情绪互相抵消成两个零）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { EMOTION_ANGLE, EMOTION_KINDS } from '../lib/emotion/constants.js'
import { oppositionBetween, reconcile } from '../lib/emotion/dynamics.js'

const T0 = '2026-01-01T00:00:00.000Z'

/** 造一条情绪。 */
const charge = (kind, intensity, cause = '') => ({ kind, intensity, cause, since: T0 })

/** 从结果里取一条的强度。 */
const intensityOf = (result, kind) => result.find((entry) => entry.kind === kind)?.intensity

test('八种情绪都有轮上角度（漏一种 = 它对谁都不对冲）', () => {
  assert.deepEqual(Object.keys(EMOTION_ANGLE).sort(), [...EMOTION_KINDS].sort())
})

test('对立度：对极是 1，相隔 90° 约 0.71，相邻是 0（不构成对立）', () => {
  assert.equal(oppositionBetween('joy', 'sadness'), 1)
  // 喜悦 0°、愤怒 270°：最短弧 90°，弧比 0.5，开方后约 0.707。
  assert.ok(Math.abs(oppositionBetween('joy', 'anger') - Math.SQRT1_2) < 0.001)
  // 喜悦 0°、信任 45°：相邻，不算对立。
  assert.equal(oppositionBetween('joy', 'trust'), 0)
})

test('对冲：愤怒 70 压得住喜悦 85（愤怒更强，所以它压）', () => {
  const result = reconcile([charge('anger', 70), charge('joy', 85)])
  // 喜悦 85 更强，所以反过来了：这里真正被压的是愤怒。
  assert.ok((intensityOf(result, 'anger') ?? 0) < 70, '更弱的那条被压')
  assert.equal(intensityOf(result, 'joy'), 85, '强者本身不受影响')
})

test('对冲：愤怒 85 压得住喜悦 70', () => {
  const result = reconcile([charge('anger', 85), charge('joy', 70)])
  assert.ok((intensityOf(result, 'joy') ?? 0) < 70, '气头上那股高兴该被压')
  assert.equal(intensityOf(result, 'anger'), 85)
})

test('对冲可逆：愤怒退了，喜悦自己回来（存储没被改过）', () => {
  const angry = reconcile([charge('anger', 85), charge('joy', 70)])
  const calm = reconcile([charge('anger', 20), charge('joy', 70)])
  assert.ok((intensityOf(calm, 'joy') ?? 0) > (intensityOf(angry, 'joy') ?? 0))
  // 20 分压不动太多：喜悦基本回到原值附近。
  assert.ok((intensityOf(calm, 'joy') ?? 0) > 65)
})

test('相邻的不互压：喜悦与信任可以同时满格（它们该合成"爱"）', () => {
  const result = reconcile([charge('joy', 70), charge('trust', 70)])
  assert.equal(intensityOf(result, 'trust'), 70)
  assert.equal(intensityOf(result, 'joy'), 70)
})

test('同分不互压（避免两个中等情绪互相抵消成两个零）', () => {
  const result = reconcile([charge('anger', 50), charge('joy', 50)])
  assert.equal(intensityOf(result, 'anger'), 50)
  assert.equal(intensityOf(result, 'joy'), 50)
})

test('压制后低于地板就消失（不留下一条看不见的残渣）', () => {
  // 愤怒 100 把本就只有 1 分的喜悦压到 0.5 上下，低于地板 ⇒ 整条滤掉。
  const result = reconcile([charge('anger', 100), charge('joy', 1)])
  assert.equal(intensityOf(result, 'joy'), undefined)
})

test('输入不被修改，输出按强度降序', () => {
  const input = [charge('joy', 85), charge('anger', 70)]
  const result = reconcile(input)
  assert.equal(input[0].intensity, 85, '原数组必须原样')
  assert.equal(result[0].kind, 'joy', '喜悦更强，排第一')
})
test('本轮刚动的情绪豁免被压制：被当场冒犯时，愤怒不该被历史信任压掉', () => {
  // 实测场景：信任攒到 73，被骂一句生出 28 分愤怒。
  const charges = [
    { kind: 'trust', target: 'user', intensity: 73, cause: '', since: T0 },
    { kind: 'anger', target: 'user', intensity: 28, cause: '', since: T0 },
  ]
  const plain = reconcile(charges)
  assert.ok((intensityOf(plain, 'anger') ?? 0) < 28, '不豁免时愤怒会被信任压下去（这就是缺陷现场）')

  const shielded = reconcile(charges, new Set(['anger:user']))
  assert.equal(intensityOf(shielded, 'anger'), 28, '本轮刚生成的愤怒不该被压')
  assert.equal(intensityOf(shielded, 'trust'), 73, '信任本身也不会被它压（28 < 73）')
})

test('豁免只挡"被压"，不挡它去压别人', () => {
  // 愤怒 80（本轮刚生成）应当照常压住旧的喜悦 30。
  const charges = [
    { kind: 'joy', target: 'user', intensity: 30, cause: '', since: T0 },
    { kind: 'anger', target: 'user', intensity: 80, cause: '', since: T0 },
  ]
  const result = reconcile(charges, new Set(['anger:user']))
  assert.ok((intensityOf(result, 'joy') ?? 0) < 30, '大愤怒照样压住喜悦')
})
