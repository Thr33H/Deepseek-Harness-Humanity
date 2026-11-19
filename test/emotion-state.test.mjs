/**
 * 情绪状态机的回归测试。
 *
 * 钉住的是三条**不变量**（它们一旦破了，症状都是"用一阵子之后越飘越离谱"）：
 * 1. 可复现：同一输入必然同一输出，没有任何随机与外部依赖；
 * 2. 只降不飘：强度只因事件上升、只因时间下降；
 * 3. 时间单调：时钟回拨不参与计算。
 *
 * 数值断言用"半衰期的定义"直接算（2 小时后减半），而不是抄一份实现里的数字 ——
 * 抄数字的测试在改系数时只会跟着一起错。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createInitialEmotionState } from '../lib/emotion/model.js'
import { EMOTION_KINDS } from '../lib/emotion/constants.js'
import { apply as applyPulse, dominantOf, settle, tierOf } from '../lib/emotion/state.js'

/** 这一组用例只关心"情绪增减"，所以把增减数组包成一次脉冲（生产入口是 `pulse`）。 */
const apply = (state, shifts, now) => applyPulse(state, { shifts }, now)

const T0 = '2026-01-01T00:00:00.000Z'
const at = (hours) => new Date(Date.parse(T0) + hours * 3_600_000).toISOString()

test('出厂状态是平静的，且结算点就是诞生时刻', () => {
  const state = createInitialEmotionState(T0)
  assert.deepEqual(state.charges, [])
  assert.equal(state.settledAt, T0)
  assert.equal(state.updatedAt, T0)
  assert.equal(dominantOf(state), undefined)
})

test('愤怒按自己的半衰期衰减：2 小时后剩一半', () => {
  const raised = apply(createInitialEmotionState(T0), [{ kind: 'anger', delta: 80, cause: '被否定' }], T0)
  assert.equal(raised.charges[0]?.intensity, 80)

  const later = settle(raised, at(2))
  assert.equal(Math.round(later.charges[0]?.intensity ?? 0), 40)
})

test('不同情绪的半衰期互不影响（失落比愤怒耐用）', () => {
  const state = apply(
    createInitialEmotionState(T0),
    [
      { kind: 'anger', delta: 80 },
      { kind: 'sadness', delta: 80 },
    ],
    T0,
  )
  const later = settle(state, at(2))
  const anger = later.charges.find((charge) => charge.kind === 'anger')
  const sadness = later.charges.find((charge) => charge.kind === 'sadness')
  // 2 小时：愤怒正好减半；失落（12 小时半衰期）还剩大部分。
  assert.equal(Math.round(anger?.intensity ?? 0), 40)
  assert.ok((sadness?.intensity ?? 0) > 70)
})

test('低于地板就消失：不留 0.4 的残渣', () => {
  const state = apply(createInitialEmotionState(T0), [{ kind: 'annoyance', delta: 2 }], T0)
  assert.equal(state.charges.length, 1)
  // 烦恼 3 小时半衰期：经过 24 小时剩 2 * 2^-8 ≈ 0.008，低于地板。
  const later = settle(state, at(24))
  assert.deepEqual(later.charges, [])
})

test('时间倒流不衰减（宁可少算，不可重算）', () => {
  const state = apply(createInitialEmotionState(T0), [{ kind: 'anger', delta: 60 }], T0)
  const earlier = settle(state, '2025-12-31T22:00:00.000Z')
  assert.equal(earlier, state, '时间更早时应原样返回同一个对象')
  assert.equal(state.charges[0]?.intensity, 60)
})

test('结算点丢失（空串）时补上它，而不是永远不衰减', () => {
  // 实测抓到过的状态：settledAt 为空 ⇒ 每次结算都在这里提前返回 ⇒ 强度被冻住。
  const broken = { ...apply(createInitialEmotionState(T0), [{ kind: 'anger', delta: 60 }], T0), settledAt: '' }
  const fixed = settle(broken, at(2))
  assert.equal(fixed.settledAt, at(2), '缺失的起点要被补成"现在"')
  // 起点未知 ⇒ 这一次不衰减（没法定区间），但下一次就正常了。
  const next = settle(fixed, at(4))
  assert.equal(Math.round(next.charges[0]?.intensity ?? 0), 30, '补上起点之后按半衰期正常衰减')
})

test('同一时刻重复结算不会把强度越算越小', () => {
  const state = apply(createInitialEmotionState(T0), [{ kind: 'anger', delta: 60 }], T0)
  const once = settle(state, at(1))
  const twice = settle(once, at(1))
  assert.equal(twice.charges[0]?.intensity, once.charges[0]?.intensity)
})

test('关系温度向基线回归，而不是掉到 0', () => {
  const state = createInitialEmotionState(T0)
  const warmed = apply(
    { ...state, warmth: 100, warmthCause: '聊得很好' },
    [{ kind: 'joy', delta: 10 }],
    T0,
  )
  const week = settle(warmed, at(24 * 7))
  // 7 天=一个半衰期：离基线（50）的距离减半。
  assert.equal(Math.round(week.warmth), 75)
})

test('同一情绪叠加而不是产生两条', () => {
  let state = createInitialEmotionState(T0)
  state = apply(state, [{ kind: 'sadness', delta: 20, cause: '被忽略' }], T0)
  state = apply(state, [{ kind: 'sadness', delta: 25 }], at(0.1))
  assert.equal(state.charges.length, 1)
  // 第二笔同时走两道换算：
  // - 饱和：6 分钟后还剩 19.9，可用空间 80%；
  // - 敏感化：同一处的第二次，第一笔留下了 0.3 的痕迹 ⇒ 增量 ×1.15。
  // 19.9 + 25×1.15×(1−19.9/100) ≈ 43（没有敏感化时是 40）。
  assert.equal(Math.round(state.charges[0]?.intensity ?? 0), 43)
  // 原因沿用第一次那句话（第二次没给 cause）。
  assert.equal(state.charges[0]?.cause, '被忽略')
})

test('负增量可以把情绪削掉（被哄好了）', () => {
  let state = createInitialEmotionState(T0)
  state = apply(state, [{ kind: 'anger', delta: 40 }], T0)
  // 同一时刻施加（`apply` 内部先结算；同一时刻不衰减，所以结果是精确的 40-35）。
  state = apply(state, [{ kind: 'anger', delta: -35 }], T0)
  assert.equal(state.charges.length, 1)
  assert.equal(state.charges[0]?.intensity, 5)

  state = apply(state, [{ kind: 'anger', delta: -5 }], T0)
  assert.deepEqual(state.charges, [])
})

test('强度永远被夹在 0–100', () => {
  let state = createInitialEmotionState(T0)
  state = apply(state, [{ kind: 'joy', delta: 500 }], T0)
  assert.equal(state.charges[0]?.intensity, 100)
})

test('四种情绪可以同时并存，且按 kind 合并后各是一条', () => {
  const kinds = ['joy', 'trust', 'fear', 'anger']
  const state = apply(
    createInitialEmotionState(T0),
    kinds.map((kind, index) => ({ kind, delta: 10 + index * 10 })),
    T0,
  )
  assert.equal(state.charges.length, 4)
  // 主导情绪是最后那条（anger 40）。
  assert.equal(dominantOf(state)?.kind, 'anger')
})

test('并存上限：八种全加进来时只保留最强的四条', () => {
  const state = apply(
    createInitialEmotionState(T0),
    EMOTION_KINDS.map((kind, index) => ({ kind, delta: 10 + index * 5 })),
    T0,
  )
  assert.equal(state.charges.length, 4, '超过上限要裁剪，不能一条都不丢')
  // 最强的是最后加进去的那个（delta 最大）。
  assert.equal(dominantOf(state)?.kind, EMOTION_KINDS[EMOTION_KINDS.length - 1])
  // 最弱的几种被挤掉：强度条再多也读不懂。
  assert.equal(state.charges.some((charge) => charge.kind === EMOTION_KINDS[0]), false)
})

test('空变化不算一次变化（updatedAt 不动）', () => {
  const state = createInitialEmotionState(T0)
  const same = apply(state, [], at(5))
  assert.equal(same, state)
  assert.equal(same.updatedAt, T0)
})

test('档位边界：不到 30 是平静，30 起轻微，50 起明显，75 起强烈', () => {
  assert.equal(tierOf(0), 'calm')
  assert.equal(tierOf(29.9), 'calm')
  assert.equal(tierOf(30), 'faint')
  assert.equal(tierOf(49.9), 'faint')
  assert.equal(tierOf(50), 'clear')
  assert.equal(tierOf(74.9), 'clear')
  assert.equal(tierOf(75), 'burst')
  assert.equal(tierOf(100), 'burst')
})

test('主导情绪是强度最高的那条（并列时保留先出现的）', () => {
  const state = apply(
    createInitialEmotionState(T0),
    [
      { kind: 'sadness', delta: 40 },
      { kind: 'anger', delta: 60 },
    ],
    T0,
  )
  assert.equal(dominantOf(state)?.kind, 'anger')
})

/* ───────────────────────────── 精力 ─────────────────────────────
 * 用**本地时间**构造时刻再转 ISO：这样"8 点到 20 点"在任何时区下都是同一段本地时间，
 * 断言不会随运行机器的时区漂（"清晨恢复"按本地 6 点算，这是产品语义）。 */

/** 本地时间 → ISO（测试里所有精力用例都走它，保证与 TZ 无关）。 */
const localIso = (day, hour, minute = 0) => new Date(2026, 0, day, hour, minute, 0).toISOString()

test('精力：醒着 12 小时不跨清晨，只掉不涨', () => {
  const state = { ...createInitialEmotionState(T0), energy: 80, settledAt: localIso(1, 8) }
  const later = settle(state, localIso(1, 20))
  // 80 - 12 小时 × 3 = 44
  assert.equal(Math.round(later.energy), 44)
})

test('精力：跨一次清晨算睡了一觉，睡眠那段不消耗', () => {
  const state = { ...createInitialEmotionState(T0), energy: 80, settledAt: localIso(1, 8) }
  const later = settle(state, localIso(2, 8))
  // 24 小时里睡 7 小时 ⇒ 醒 17 小时扣 51，清晨恢复 60 ⇒ 80 - 51 + 60 = 89
  assert.equal(Math.round(later.energy), 89)
})

test('精力：久不联系会回满（跨多天时封顶 100，不会溢出）', () => {
  const state = { ...createInitialEmotionState(T0), energy: 30, settledAt: localIso(1, 8) }
  const later = settle(state, localIso(9, 8))
  assert.equal(later.energy, 100)
})

test('精力：最低 0，不会变成负数', () => {
  const state = { ...createInitialEmotionState(T0), energy: 5, settledAt: localIso(1, 8) }
  const later = settle(state, localIso(1, 20))
  assert.equal(later.energy, 0)
})

test('精力：时间倒流不结算（与情绪同一条时间单调纪律）', () => {
  const state = { ...createInitialEmotionState(T0), energy: 55, settledAt: localIso(2, 8) }
  const earlier = settle(state, localIso(1, 8))
  assert.equal(earlier, state)
})

/* ───────────────────── 跨时区结算（2026-11-19 实机抓到的坑） ─────────────────────
 * 现场：同一进程里改 `process.env.TZ` 之后 `Intl` 变了、`Date` 的本地时间却仍是 UTC，
 * 于是"精力按哪个清晨恢复"与"工作台显示哪个时区"对不上。修法是把时区**显式传进结算**，
 * 用 `Intl` 换算墙钟 —— 下面两条就是拿那次的真实时间戳复现的。
 */

test('结算：显式给时区时，"清晨"按那个时区算，与进程时区无关', () => {
  // 昨晚 22:48（北京时间）睡下、今早 10:53 才说话：中间跨过了北京时间 06:00。
  const base = {
    ...createInitialEmotionState('2026-11-18T14:48:32.737Z'),
    energy: 74,
    settledAt: '2026-11-18T14:48:32.737Z',
  }
  const now = '2026-11-19T02:53:09.824Z'
  // 北京时区：睡眠 7 小时不消耗 + 恢复 60 ⇒ 74 - 5.08×3 + 60 = 118.8 ⇒ 封顶 100。
  assert.equal(Math.round(settle(base, now, 'Asia/Shanghai').energy), 100)
  // UTC：这段里没有跨过 UTC 的 06:00 ⇒ 全程醒着，74 - 12.08×3 ≈ 37.8。
  assert.equal(Math.round(settle(base, now, 'UTC').energy), 38)
})

test('结算：时区选项可以是任意 IANA 名（不是只认识东八区）', () => {
  const base = {
    ...createInitialEmotionState('2026-11-18T14:48:32.737Z'),
    energy: 74,
    settledAt: '2026-11-18T14:48:32.737Z',
  }
  const now = '2026-11-19T02:53:09.824Z'
  // 纽约此刻是 11-18 09:48 → 21:53：这一段**没有**跨过纽约的 06:00，所以不恢复。
  assert.equal(Math.round(settle(base, now, 'America/New_York').energy), 38)
  // 基里巴斯（UTC+14）此刻是 11-19 04:48 → 16:53：跨过了当地 06:00，恢复一次。
  assert.equal(Math.round(settle(base, now, 'Pacific/Kiritimati').energy), 100)
})
test('被裁剪掉的情绪不会留在 lastTouched 里（脏 key）', () => {
  // 五条同向刺激：超过四条上限时最弱的被裁掉，名单必须跟着清。
  // 注意本文件的 `apply` 包装器收的是**数组**（它自己包成 pulse），别再套一层。
  const state = apply(
    createInitialEmotionState(T0),
    [
      { kind: 'trust', target: 'user', delta: 80 },
      { kind: 'joy', target: 'user', delta: 70 },
      { kind: 'sadness', target: 'self', delta: 30 },
      { kind: 'anticipation', target: 'world', delta: 20 },
      { kind: 'anger', target: 'user', delta: 5 },
    ],
    T0,
  )
  assert.equal(state.charges.length, 4, '上限是四条')
  const kept = new Set(state.charges.map((charge) => `${charge.kind}:${charge.target}`))
  for (const key of state.lastTouched) {
    assert.ok(kept.has(key), `lastTouched 里的 ${key} 在 charges 里不存在`)
  }
  assert.equal(state.lastTouched.includes('anger:user'), false, '被裁掉的愤怒不该留在名单里')
})
test('边际递减：同样的好话，越到后面推力越小（渐近 100 而不真的到）', () => {
  let state = createInitialEmotionState(T0)
  const gains = []
  for (let i = 0; i < 5; i += 1) {
    const before = state.charges[0]?.intensity ?? 0
    state = apply(state, [{ kind: 'trust', target: 'user', delta: 30 }], T0)
    gains.push(Math.round((state.charges[0]?.intensity ?? 0) - before))
  }
  // 0→30→51→66→77→85：每一步都比上一步小。
  for (let i = 1; i < gains.length; i += 1) {
    assert.ok(gains[i] < gains[i - 1], `第 ${i + 1} 次增量 ${gains[i]} 应小于第 ${i} 次的 ${gains[i - 1]}`)
  }
  assert.ok((state.charges[0]?.intensity ?? 0) < 100, '永远不该真的到 100（到了就再也没法更高兴）')
})

test('削弱不打折：坏消息总是全额生效（哄回来才该慢）', () => {
  const state = apply(createInitialEmotionState(T0), [{ kind: 'trust', target: 'user', delta: 90 }], T0)
  const before = state.charges[0]?.intensity ?? 0
  const after = apply(state, [{ kind: 'trust', target: 'user', delta: -30 }], T0)
  assert.equal(Math.round((after.charges[0]?.intensity ?? 0)), Math.round(before - 30), '负增量不该被打折')
})
