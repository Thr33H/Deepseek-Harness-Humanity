/**
 * 情绪**敏感化**的回归测试。
 *
 * 这一层要钉的不是"某个数算得对"，而是四件容易悄悄坏掉的事：
 * 1. **第一次不能被自己放大** —— 放大系数必须读"记账前"的痕迹，否则同一笔事件会被放两次；
 * 2. **记账要用原始增量** —— 用放大后的增量记账会形成"越敏感越敏感"的正反馈；
 * 3. **边界不糊**：不同的情绪/对象不算同一处；好事、回声都不记账；
 * 4. **会退、有顶**：一天剩一半，磨到顶也只有 1.5 倍 —— 没有这两条，几十轮后它会变成一点就炸。
 *
 * 数值断言尽量写成"按定义算出来的那种数"（半衰期、饱和公式），而不是抄一份实现里的数字。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  EMOTION_KINDS,
  EMOTION_STING_DIRECTION,
  MAX_SENSITIVITIES,
  SENSITIVITY_FLOOR,
  SENSITIVITY_MAX_BOOST,
  SENSITIVITY_REFERENCE_DELTA,
  SENSITIVITY_STEP,
} from '../lib/emotion/constants.js'
import { EmotionStateSchema, createInitialEmotionState } from '../lib/emotion/model.js'
import { renderReminder } from '../lib/emotion/render.js'
import { decaySensitivity, isSting, recordSting, sensitivityFactor } from '../lib/emotion/sensitivity.js'
import { apply as applyPulse, settle } from '../lib/emotion/state.js'
import { viewOf } from '../lib/emotion/view.js'
import { MOOD_TONE } from '../lib/memory/constants.js'

const T0 = '2026-01-01T00:00:00.000Z'
const at = (hours) => new Date(Date.parse(T0) + hours * 3_600_000).toISOString()

/** 这一组用例只关心"情绪增减"，所以把增减数组包成一次脉冲（生产入口是 `pulse`）。 */
const apply = (state, shifts, now) => applyPulse(state, { shifts }, now)

/** 取出某条情绪的强度（不存在时 `undefined`）。 */
const intensityOf = (state, kind, target) =>
  state.charges.find((charge) => charge.kind === kind && charge.target === target)?.intensity

/** 取出某一处的痕迹（不存在时 `undefined`）。 */
const levelOf = (state, kind, target) =>
  state.sensitivities.find((entry) => entry.kind === kind && entry.target === target)?.level

/* ───────────────────────── 方向表：什么算"被刺痛" ───────────────────────── */

test('刺痛的方向表与八种情绪一一对应，且正负划分与记忆侧不许分叉', () => {
  assert.deepEqual(Object.keys(EMOTION_STING_DIRECTION).sort(), [...EMOTION_KINDS].sort())
  // 两种表说的不是一件事（那边是"心情颜色偏向哪边"，这边是"哪一向的变化算伤害"），
  // 但它们对"谁是正面情绪"必须一致 —— 分叉了说明有一边写错了。
  // （用 `===` 而不是 `assert.equal`：后者对 0 与 -0 也要求同号，而这里只关心正负。）
  for (const kind of EMOTION_KINDS) {
    assert.ok(EMOTION_STING_DIRECTION[kind] === -MOOD_TONE[kind], `${kind} 的正负划分与记忆侧不一致`)
  }
})

test('isSting：负面情绪升上来算伤，正面情绪被削下去算伤，惊讶两向都不算', () => {
  assert.equal(isSting('anger', 15), true, '被冒犯')
  assert.equal(isSting('anger', -15), false, '火气退了不是伤')
  assert.equal(isSting('sadness', 12), true)
  assert.equal(isSting('fear', 20), true)
  assert.equal(isSting('disgust', 8), true)
  assert.equal(isSting('joy', -10), true, '开心被浇灭')
  assert.equal(isSting('trust', -20), true, '信任被打折')
  assert.equal(isSting('anticipation', -5), true, '盼头被掐掉')
  assert.equal(isSting('joy', 10), false, '被夸不是伤')
  assert.equal(isSting('trust', 20), false)
  assert.equal(isSting('surprise', 20), false, '惊讶是中性，两向都不算')
  assert.equal(isSting('surprise', -20), false)
  assert.equal(isSting('anger', 0), false)
})

/* ───────────────────────── 记账：痕迹怎么长 ───────────────────────── */

test('第一次伤害不会被自己放大：强度就是原始增量', () => {
  const state = apply(createInitialEmotionState(T0), [{ kind: 'anger', target: 'user', delta: 30 }], T0)
  assert.equal(intensityOf(state, 'anger', 'user'), 30)
  // 一笔 30 分的伤按当量 20 折算 ⇒ 满权重 ⇒ 痕迹正好一步。
  assert.ok(Math.abs((levelOf(state, 'anger', 'user') ?? 0) - SENSITIVITY_STEP) < 1e-9)
})

test('同一处第二次明显更重；换对象或换情绪都不算同一处', () => {
  const base = apply(createInitialEmotionState(T0), [{ kind: 'anger', target: 'user', delta: 30 }], T0)

  const same = apply(base, [{ kind: 'anger', target: 'user', delta: 30 }], at(1))
  const otherTarget = apply(base, [{ kind: 'anger', target: 'self', delta: 30 }], at(1))
  const otherKind = apply(base, [{ kind: 'sadness', target: 'user', delta: 30 }], at(1))

  // 一小时前那一股愤怒还剩 21.2（半衰期 2 小时）；痕迹剩 0.2914 ⇒ 放大 1.146 倍。
  // 21.2 + 30×1.146×(1−21.2/100) ≈ 48.3 —— 不比的话只有 44.8。
  assert.equal(Math.round(intensityOf(same, 'anger', 'user') ?? 0), 48, '同一处的第二次更重')
  assert.equal(Math.round(intensityOf(otherTarget, 'anger', 'self') ?? 0), 30, '换对象就不是同一处')
  assert.equal(Math.round(intensityOf(otherKind, 'sadness', 'user') ?? 0), 30, '换情绪就不是同一处')
})

test('隔一天：火气已经退了，痕迹还在 —— 第二天同样一句话更扎人', () => {
  let worn = createInitialEmotionState(T0)
  for (let i = 0; i < 3; i += 1) worn = apply(worn, [{ kind: 'anger', target: 'user', delta: 30 }], T0)
  // 三次记账：0.3 → 0.51 → 0.657；再过一天（痕迹半衰期 24 小时）剩 0.3285。
  const tomorrow = settle(worn, at(24))
  assert.deepEqual(tomorrow.charges, [], '24 小时后那股火早就退干净了（愤怒半衰期 2 小时）')

  const fresh = apply(createInitialEmotionState(T0), [{ kind: 'anger', target: 'user', delta: 30 }], at(24))
  const hurt = apply(worn, [{ kind: 'anger', target: 'user', delta: 30 }], at(24))
  assert.equal(Math.round(intensityOf(fresh, 'anger', 'user') ?? 0), 30, '没被磨过的人：还是 30')
  assert.equal(Math.round(intensityOf(hurt, 'anger', 'user') ?? 0), 35, '被磨过的人：同样一句是 35')
})

test('一次事件里的两笔只记一次账，而且两笔都不被这次记账放大', () => {
  // 这里不经过上面的 `apply` 包装（它收的是增减数组），直接给一条完整脉冲。
  const state = applyPulse(
    createInitialEmotionState(T0),
    {
      shifts: [
        { kind: 'anger', target: 'user', delta: 40 },
        { kind: 'anger', target: 'user', delta: 20 },
      ],
    },
    T0,
  )
  assert.equal(state.sensitivities.length, 1, '同一处只有一条痕迹')
  // 取绝对值最大的那笔当刺激大小（40 ⇒ 满权重），而不是把两笔各记一遍。
  assert.ok(Math.abs((levelOf(state, 'anger', 'user') ?? 0) - SENSITIVITY_STEP) < 1e-9)
  // 放大系数读的是"记账前"的空痕迹 ⇒ 两笔都按原值走饱和：40 + 20×(1−40/100) = 52。
  assert.equal(Math.round(intensityOf(state, 'anger', 'user') ?? 0), 52)
})

test('轻的事留下的痕迹更浅（20 分算一次完整的）', () => {
  const light = recordSting([], 'anger', 'user', 5)
  const heavy = recordSting([], 'anger', 'user', 30)
  assert.ok(Math.abs((light[0]?.level ?? 0) - SENSITIVITY_STEP * (5 / SENSITIVITY_REFERENCE_DELTA)) < 1e-9)
  assert.ok((light[0]?.level ?? 0) < (heavy[0]?.level ?? 0), '轻轻一句不该和当面羞辱留一样深的痕')
})

test('最多记六条，超了丢最浅的那条旧痕迹', () => {
  const keys = [
    ['anger', 'user'],
    ['anger', 'self'],
    ['anger', 'world'],
    ['fear', 'user'],
    ['fear', 'self'],
    ['fear', 'world'],
    ['sadness', 'user'],
    ['sadness', 'self'],
    ['sadness', 'world'],
  ]
  let entries = []
  // 刺激一次比一次重 ⇒ 先记下的那几条总是最浅的。
  keys.forEach(([kind, target], index) => {
    entries = recordSting(entries, kind, target, 4 + index)
  })
  assert.equal(entries.length, MAX_SENSITIVITIES)
  assert.equal(
    entries.some((entry) => entry.kind === 'anger' && entry.target === 'user'),
    false,
    '最浅的那条（第一个记的）该被挤掉',
  )
  assert.ok(
    entries.some((entry) => entry.kind === 'sadness' && entry.target === 'world'),
    '最深的那条必须留着',
  )
})

/* ───────────────────────── 边界：不记账的东西 ───────────────────────── */

test('好事不记账，也不放大：反复被夸只会越夸越淡（饱和），不会越夸越重', () => {
  let state = createInitialEmotionState(T0)
  const gains = []
  for (let i = 0; i < 5; i += 1) {
    const before = intensityOf(state, 'joy', 'user') ?? 0
    state = apply(state, [{ kind: 'joy', target: 'user', delta: 20 }], at(i * 0.5))
    gains.push(Math.round((intensityOf(state, 'joy', 'user') ?? 0) - before))
  }
  assert.deepEqual(state.sensitivities, [], '好事不该在敏感化里留下任何痕迹')
  assert.ok((gains[4] ?? 0) < (gains[0] ?? 0), '第五次的增益应当比第一次小（饱和曲线）')
})

test('回声不算"又发生了一次"：不改痕迹，也不被放大', () => {
  const once = apply(
    createInitialEmotionState(T0),
    [{ kind: 'anger', target: 'user', delta: 30, cause: '被否定' }],
    T0,
  )
  const levelBefore = levelOf(once, 'anger', 'user')
  const echoed = apply(once, [{ kind: 'anger', target: 'user', delta: 6, echo: true }], T0)
  assert.equal(levelOf(echoed, 'anger', 'user'), levelBefore, '想起一件事不是又被打了一次')
  // 6 × (100−30)/100 = 4.2 ⇒ 34.2（若被放大 1.15 倍会是 35.0）。
  assert.equal(Math.round(intensityOf(echoed, 'anger', 'user') ?? 0), 34)

  const clean = apply(createInitialEmotionState(T0), [{ kind: 'anger', delta: 6, echo: true }], T0)
  assert.deepEqual(clean.sensitivities, [], '从平静里想起一件旧事，不该磨出痕迹')
})

test('被反复辜负时，信任掉得更快（伤害方向的削减也照常放大）', () => {
  const start = apply(createInitialEmotionState(T0), [{ kind: 'trust', target: 'user', delta: 80 }], T0)
  const first = apply(start, [{ kind: 'trust', target: 'user', delta: -20 }], at(0.1))
  const second = apply(first, [{ kind: 'trust', target: 'user', delta: -20 }], at(0.2))
  // 第一次：80 → 59.8（20 分全额）。第二次的 20 分被放大到 23 ⇒ 36.6。
  assert.equal(Math.round(intensityOf(first, 'trust', 'user') ?? 0), 60)
  assert.equal(Math.round(intensityOf(second, 'trust', 'user') ?? 0), 37)
})

/* ───────────────────────── 时间与上限 ───────────────────────── */

test('痕迹按天退：一天剩一半，几天后浅到没有意义就消失', () => {
  const entries = recordSting([], 'anger', 'user', 20)
  const halved = decaySensitivity(entries, 0.5)
  assert.ok(Math.abs((halved[0]?.level ?? 0) - (entries[0]?.level ?? 0) * 0.5) < 1e-12)

  const state = apply(createInitialEmotionState(T0), [{ kind: 'anger', delta: 20 }], T0)
  const tomorrow = settle(state, at(24))
  assert.ok(Math.abs((levelOf(tomorrow, 'anger', 'world') ?? 0) - SENSITIVITY_STEP * 0.5) < 1e-9)
  // 六天后：0.3 的一半的六次方 ≈ 0.0047，低于地板 ⇒ 整条丢掉（不留看不见的残渣）。
  assert.deepEqual(settle(state, at(24 * 6)).sensitivities, [])
  assert.ok(SENSITIVITY_FLOOR > 0)
})

test('磨到顶也只有 1.5 倍：水平到 1 就停，放大系数到 1.5 就停', () => {
  let entries = []
  for (let i = 0; i < 200; i += 1) entries = recordSting(entries, 'anger', 'user', 40)
  const level = entries[0]?.level ?? 0
  // 饱和累积：`0.7^200` 早就低于双精度能表示的最小差值，所以水平最终停**在** 1 上（不会越过）。
  assert.ok(level <= 1, '水平不许越过 1')
  assert.ok(sensitivityFactor(entries, 'anger', 'user') <= 1 + SENSITIVITY_MAX_BOOST, '放大不许超过 1.5 倍')
  // 第 200 次与第 20 次几乎没差别 —— 上限是结构性的，不是靠事后夹一下。
  let twenty = []
  for (let i = 0; i < 20; i += 1) twenty = recordSting(twenty, 'anger', 'user', 40)
  assert.ok((twenty[0]?.level ?? 0) > 0.99, '二十次就该接近顶了')
})

/* ───────────────────────── 工作台与旧数据 ───────────────────────── */

test('工作台能看到痕迹：按深浅降序，带中文名与对象前缀', () => {
  const state = apply(
    createInitialEmotionState(T0),
    [
      { kind: 'anger', target: 'user', delta: 30, cause: '被否定' },
      { kind: 'sadness', target: 'self', delta: 10, cause: '又搞砸了' },
    ],
    T0,
  )
  const view = viewOf(state)
  assert.equal(view.sensitivities.length, 2)
  assert.deepEqual(
    view.sensitivities.map((entry) => [entry.kind, entry.target, entry.label, entry.targetLabel]),
    [
      ['anger', 'user', '愤怒', '对TA'],
      ['sadness', 'self', '悲伤', '对自己'],
    ],
  )
  assert.ok((view.sensitivities[0]?.level ?? 0) > (view.sensitivities[1]?.level ?? 0), '深的排前面')
})

test('旧状态没有这个字段：读成空数组，不重置整份心情', () => {
  const legacy = {
    version: 2,
    charges: [{ kind: 'joy', target: 'user', intensity: 40, cause: '被夸', since: T0 }],
    warmth: 60,
    warmthCause: '',
    energy: 80,
    settledAt: T0,
    perceived: '',
    perceivedAt: '',
    lastTouched: [],
    updatedAt: T0,
  }
  const parsed = EmotionStateSchema.parse(legacy)
  assert.deepEqual(parsed.sensitivities, [])
  assert.equal(parsed.charges.length, 1, '旧心情照常读出来')
})

/* ───────────────────────── 它最后落到哪里：注入的话 ─────────────────────────
 * 这一层如果只改了数字、没改"她被告知什么"，那和没做一样：注入里只有档位词，
 * 数字大不大不改变任何措辞。所以终点必须钉在 `renderReminder` 的输出上。
 */

test('同样一句话：没被磨过时什么都不说，被磨过之后才够到"轻微"这一档', () => {
  const fresh = renderReminder(
    apply(createInitialEmotionState(T0), [{ kind: 'anger', target: 'user', delta: 22, cause: '被否定' }], T0),
    new Date(T0),
  )
  assert.equal(fresh.tier, 'calm', '22 分不到 30 的档位线')
  assert.equal(fresh.text, '', '不到档位就什么都不说（这是既定的表达纪律）')

  // 同一处被磨到 0.8：22 × (1 + 0.5×0.8) = 30.8 ⇒ 刚好跨过 30。
  const wornBase = {
    ...createInitialEmotionState(T0),
    sensitivities: [{ kind: 'anger', target: 'user', level: 0.8 }],
  }
  const worn = renderReminder(
    apply(wornBase, [{ kind: 'anger', target: 'user', delta: 22, cause: '被否定' }], T0),
    new Date(T0),
  )
  assert.equal(worn.tier, 'faint', '同样 22 分，这次到 30.8')
  assert.match(worn.text, /恼怒/, '注入里给的是"恼怒"这一档的词')
  assert.match(worn.text, /不说出来/, '低档位照旧不许说破')
})
