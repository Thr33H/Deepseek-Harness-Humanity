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

test('愤怒：静默期之内按自己的半衰期退（20 分钟剩 71）', () => {
  const raised = apply(createInitialEmotionState(T0), [{ kind: 'anger', delta: 80, cause: '被否定' }], T0)
  assert.equal(raised.charges[0]?.intensity, 80)

  const later = settle(raised, at(20 / 60))
  // 80 × 2^-(20/120) ≈ 71.3 —— 还没过 30 分钟的静默期，自调节不参与。
  assert.equal(Math.round(later.charges[0]?.intensity ?? 0), 71)
})

test('愤怒：静默半小时后自己加快，2 小时后剩 24 而不是 40', () => {
  const raised = apply(createInitialEmotionState(T0), [{ kind: 'anger', delta: 80, cause: '被否定' }], T0)
  const later = settle(raised, at(2))
  // 前 30 分钟按自己的半衰期（×2^-0.25）；之后 90 分钟按加快的半衰期 1 小时（×2^-1.5）
  // ⇒ 80 × 0.8409 × 0.3536 ≈ 23.8。纯被动衰减会是 40 —— 差的这 16 分就是"她自己冷静下来了"。
  assert.equal(Math.round(later.charges[0]?.intensity ?? 0), 24)
  assert.ok((later.charges[0]?.intensity ?? 0) < 40, '必须低于纯半衰期的结果')
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
  // 2 小时后：愤怒（2 小时半衰期 + 静默加速）剩 24；失落（12 小时半衰期 + 静默加速）剩 65。
  assert.equal(Math.round(anger?.intensity ?? 0), 24)
  assert.ok((sadness?.intensity ?? 0) > 60 && (sadness?.intensity ?? 0) < 80, '失落比愤怒耐用，但也在退')
})

test('低于地板就消失：不留 0.4 的残渣', () => {
  // 用真实的情绪（惊讶，半衰期 60 分钟）：24 小时 = 24 个半衰期，2 × 2^-24 ≈ 1e-7。
  const state = apply(createInitialEmotionState(T0), [{ kind: 'surprise', delta: 2 }], T0)
  assert.equal(state.charges.length, 1)
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
  // 这条愤怒最后一次被碰到是 T0，结算起点（2 小时）早就过了静默期 ⇒ 这两小时全按加快的半衰期：
  // 60 × 2^-2 = 15（纯半衰期会是 30）。
  const next = settle(fixed, at(4))
  assert.equal(Math.round(next.charges[0]?.intensity ?? 0), 15, '补上起点之后按（可能已加速的）半衰期正常衰减')
})

/* ───────────────────────── 自调节：没人再戳，气消得快一倍 ─────────────────────────
 * 这一组钉的是"它会自己冷静"的三条性质：
 * 1. 静默期内**不**加速（不能在对话进行中偷偷打折）；
 * 2. 过了静默期才按加快的半衰期退，而且只作用于负面情绪；
 * 3. 结果只取决于时间、不取决于被结算了几次（工作台每 30 秒读一次）。
 */

test('自调节：再被戳一次，静默期重新计时（不该提前进入加速档）', () => {
  let state = apply(createInitialEmotionState(T0), [{ kind: 'anger', delta: 80 }], T0)
  // 30 分钟时又被戳了一下：lastAt 刷新到这一刻，静默期要从这里重新数。
  state = apply(state, [{ kind: 'anger', delta: 10 }], at(0.5))
  const atHalf = state.charges[0]?.intensity ?? 0

  const later = settle(state, at(1))
  // 从 30 分钟到 1 小时都在新的静默期内 ⇒ 只按正常半衰期退（愤怒 2 小时 ⇒ 30 分钟 ×2^-0.25）。
  assert.ok(Math.abs((later.charges[0]?.intensity ?? 0) - atHalf * Math.pow(0.5, 30 / 120)) < 1e-9)
})

test('自调节：结算次数不影响结果（拆成两次结算 == 一次算完）', () => {
  const state = apply(createInitialEmotionState(T0), [{ kind: 'anger', delta: 80 }], T0)
  const once = settle(state, at(2))
  const split = settle(settle(state, at(1.5)), at(2))
  // 如果实现成"每次结算打一次折"，这里会差出一截（工作台读得勤就会先消气）。
  assert.ok(Math.abs((once.charges[0]?.intensity ?? 0) - (split.charges[0]?.intensity ?? 0)) < 1e-9)
})

test('自调节只作用于负面情绪：好心情照自己的半衰期退', () => {
  const state = apply(createInitialEmotionState(T0), [{ kind: 'joy', delta: 80 }], T0)
  const later = settle(state, at(4))
  // 喜悦半衰期 4 小时：4 小时后正好一半，不参与"冷静"（好心情本来就该慢慢淡）。
  assert.equal(Math.round(later.charges[0]?.intensity ?? 0), 40)
})

test('旧数据没有 lastAt：按原半衰期算，不猜', () => {
  const raised = apply(createInitialEmotionState(T0), [{ kind: 'anger', delta: 80 }], T0)
  const legacy = { ...raised, charges: [{ ...raised.charges[0], lastAt: '' }] }
  const later = settle(legacy, at(2))
  // 不知道最后一次被碰到是什么时候 ⇒ 不用加速档：纯半衰期 = 40。
  assert.equal(Math.round(later.charges[0]?.intensity ?? 0), 40)
})

test('每次被戳都会刷新 lastAt（自调节的计时起点）', () => {
  let state = apply(createInitialEmotionState(T0), [{ kind: 'anger', delta: 30 }], T0)
  assert.equal(state.charges[0]?.lastAt, T0)
  state = apply(state, [{ kind: 'anger', delta: 30 }], at(0.1))
  assert.equal(state.charges[0]?.lastAt, at(0.1))
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

/* ───────────────────────── 适应：同样的好事反复发生会变淡 ─────────────────────────
 * 现场（2026-11-21）：13:39 还是"接纳"，13:43 变"信任"，13:52 已经爆档 —— 中间聊的只是公园和天鹅。
 * 原因是当时只有"剩余空间"一道刹车：到 80 分时 +20 还能加 4 分，于是一段闲聊就能把信任顶满。
 * 这一组钉住第二道刹车：同一段里同类好事越推越轻；大事与隔久了除外。
 */

test('适应：同一段里，同样的好事越推越轻（六笔 5 分只推得到十几）', () => {
  let state = createInitialEmotionState(T0)
  const gains = []
  for (let i = 0; i < 6; i += 1) {
    const before = state.charges[0]?.intensity ?? 0
    state = apply(state, [{ kind: 'trust', target: 'user', delta: 5 }], at(i * 0.02))
    gains.push((state.charges[0]?.intensity ?? 0) - before)
  }
  assert.equal(Math.round(gains[0] ?? 0), 5, '第一笔满额')
  assert.ok((gains[5] ?? 0) < (gains[1] ?? 0) / 2, '第六次的增益应当不到第二次的一半')
  // 没有适应时六笔 5 分是 5 + 4.75 + 4.51 + 4.29 + 4.07 + 3.87 ≈ 26.5；有适应只剩 ~15。
  assert.ok((state.charges[0]?.intensity ?? 0) < 18, '六笔日常好话推不到"明显"档')
  assert.equal(state.charges[0]?.recentGains, 6, '计数记了六次')
})

test('适应：大事不算"又来了"（单次增量到顶时重置计数，照常满额算）', () => {
  let state = createInitialEmotionState(T0)
  for (let i = 0; i < 5; i += 1) state = apply(state, [{ kind: 'trust', target: 'user', delta: 20 }], at(i * 0.01))
  const before = state.charges[0]?.intensity ?? 0
  // 与第五笔同一时刻（不跨时间），这样只检验"适应被重置"，不掺入衰减。
  state = apply(state, [{ kind: 'trust', target: 'user', delta: 30 }], at(0.04))
  const bigGain = (state.charges[0]?.intensity ?? 0) - before
  // 只吃"剩余空间"，不吃适应：30 × (1 − 当前/100)。
  assert.ok(Math.abs(bigGain - 30 * (1 - before / 100)) < 1e-9)
  assert.equal(state.charges[0]?.recentGains, 1, '大事之后重新从 1 数')
})

test('适应：隔久了（超过窗口）重新满额', () => {
  let state = apply(createInitialEmotionState(T0), [{ kind: 'trust', target: 'user', delta: 20 }], T0)
  // 2 小时后（超过 90 分钟窗口）：信任先按 24 小时半衰期衰减，然后这一笔只吃剩余空间。
  state = apply(state, [{ kind: 'trust', target: 'user', delta: 20 }], at(2))
  const decayed = 20 * Math.pow(0.5, 2 / 24)
  const expected = decayed + 20 * (1 - decayed / 100)
  assert.ok(Math.abs((state.charges[0]?.intensity ?? 0) - expected) < 1e-9)
})

test('适应只管好事：负面情绪的上升不打折（那是敏感化的地盘）', () => {
  let state = createInitialEmotionState(T0)
  for (let i = 0; i < 3; i += 1) state = apply(state, [{ kind: 'anger', target: 'user', delta: 10 }], at(i * 0.01))
  assert.equal(state.charges[0]?.recentGains, 0, '负面情绪不记适应')
})

test('适应：回声不算"又一次好事"（想起旧事不该把好事记淡）', () => {
  let state = apply(createInitialEmotionState(T0), [{ kind: 'trust', target: 'user', delta: 20 }], T0)
  const before = state.charges[0]?.intensity ?? 0
  state = apply(state, [{ kind: 'trust', target: 'user', delta: 6, echo: true }], T0)
  // 回声照常加（只吃剩余空间），但不动适应计数。
  assert.ok(Math.abs(((state.charges[0]?.intensity ?? 0) - before) - 6 * (1 - before / 100)) < 1e-9)
  assert.equal(state.charges[0]?.recentGains, 1, '回声没有把计数推上去')
})

/* ───────────── 工作台的"比上次多/少"：增减记录（用户 2026-11-22 要的箭头） ───────────── */

test('增减：一次评估给每一处记下净变化（正数=多）', () => {
  const raised = apply(createInitialEmotionState(T0), [{ kind: 'anger', delta: 12, cause: '被否定' }], T0)
  const entry = raised.lastDeltas?.find((item) => item.kind === 'anger' && item.target === 'world')
  assert.ok(entry !== undefined, '这一轮动过愤怒，就该有一条增减记录')
  assert.equal(Math.round(entry.delta), 12)

  // 再削一笔：同一处应当**累加**成净变化，而不是各记一条。
  const lowered = apply(raised, [{ kind: 'anger', delta: -5, cause: '被哄' }], at(1 / 60))
  const after = lowered.lastDeltas?.find((item) => item.kind === 'anger' && item.target === 'world')
  assert.equal(Math.round(after.delta), -5, '这一次的净变化是 -5')
})

test('增减：被削到消失的那一条也要留下"掉了多少"（否则最该看见的减少恰好看不到）', () => {
  const raised = apply(createInitialEmotionState(T0), [{ kind: 'anger', delta: 20, cause: '被否定' }], T0)
  const wiped = apply(raised, [{ kind: 'anger', delta: -20, cause: '说开了' }], at(1 / 60))
  assert.equal(wiped.charges.some((charge) => charge.kind === 'anger'), false, '已经归零移除')
  const gone = wiped.lastDeltas?.find((item) => item.kind === 'anger')
  assert.ok(gone !== undefined, '归零之后仍要有增减记录')
  assert.ok(gone.delta < 0)
})

test('增减：视图把增减带给界面，归零的那条用原来的对象（不是补成"对事"）', async () => {
  const { viewOf } = await import('../lib/emotion/view.js')
  const raised = apply(createInitialEmotionState(T0), [{ kind: 'anger', target: 'user', delta: 9, cause: '被命令' }], T0)
  const live = viewOf(raised).charges.find((charge) => charge.kind === 'anger')
  assert.equal(live.target, 'user')
  assert.equal(Math.round(live.delta), 9)

  const wiped = apply(raised, [{ kind: 'anger', target: 'user', delta: -9, cause: '说开了' }], at(1 / 60))
  const gone = viewOf(wiped).charges.find((charge) => charge.kind === 'anger')
  assert.equal(gone.target, 'user', '归零之后仍指向"对TA"，不是补出来的"对事"')
  assert.equal(Math.round(gone.intensity), 0)
  assert.ok(gone.delta < 0, '箭头要指向减少')
})

test('增减：记下"上一次评估之前"的值（时间流逝后要能显示为减少）', () => {
  const raised = apply(createInitialEmotionState(T0), [{ kind: 'joy', delta: 6, cause: '被夸' }], T0)
  const first = raised.lastDeltas?.find((item) => item.kind === 'joy')
  assert.equal(Math.round(first.before), 0, '第一次出现：之前是 0')
  assert.equal(Math.round(first.delta), 6)

  const again = apply(raised, [{ kind: 'joy', delta: 5, cause: '又被夸' }], at(1 / 60))
  const second = again.lastDeltas?.find((item) => item.kind === 'joy')
  assert.ok(Math.round(second.before) > 0, '第二次要记下"之前"那个值，界面才能算出净变化')
})
