/**
 * 评估解析与提醒渲染的回归测试。
 *
 * 这两段是"情绪真的会动"的咽喉：
 * - 解析太脆 ⇒ 模型随便加一句"好的，这是结果："就全丢（于是它永远平静）；
 * - 渲染太松 ⇒ 它会每句话都宣布心情（于是变成一个复读机）。
 *
 * 所以这里钉的不是"正常路径能跑"，而是**两边各自的失败边界**。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { appraiseMessage, parseAppraisal } from '../lib/emotion/appraise.js'
import { createInitialEmotionState } from '../lib/emotion/model.js'
import { apply as applyPulse, settle } from '../lib/emotion/state.js'
import { renderReminder } from '../lib/emotion/render.js'

const T0 = '2026-01-01T00:00:00.000Z'

/** 这一组用例只关心"情绪增减"，所以把增减数组包成一次脉冲（生产入口是 `pulse`）。 */
const apply = (state, shifts, now) => applyPulse(state, { shifts }, now)

/* ───────────────────────────── 解析 ───────────────────────────── */

test('解析：标准 JSON 能读出情绪增减、温度与观察', () => {
  const pulse = parseAppraisal(
    '{"shifts":[{"kind":"anger","delta":15,"cause":"被否定工作能力"}],"warmth":-2,"warmthCause":"被冷落","perceived":"对方很急躁"}',
  )
  assert.ok(pulse !== undefined)
  assert.deepEqual(pulse.shifts, [{ kind: 'anger', target: 'world', delta: 15, cause: '被否定工作能力' }])
  assert.equal(pulse.warmth, -2)
  assert.equal(pulse.perceived, '对方很急躁')
})

test('解析：模型带 ```json 围栏、或前面加一句解释，仍然能读出来', () => {
  const fenced = parseAppraisal('```json\n{"shifts":[{"kind":"joy","delta":10}],"warmth":1}\n```')
  assert.equal(fenced?.shifts[0]?.kind, 'joy')

  const chatty = parseAppraisal('好的，这是结果：\n{"shifts":[{"kind":"joy","delta":5}]}')
  assert.equal(chatty?.shifts[0]?.delta, 5)
})

test('解析：完全不认识的输出返回 undefined（这一轮不动情绪）', () => {
  assert.equal(parseAppraisal('我觉得她应该不太高兴'), undefined)
  assert.equal(parseAppraisal('{"shifts":'), undefined)
  assert.equal(parseAppraisal(''), undefined)
})

test('解析：不存在的情绪名被丢掉，其余照常生效', () => {
  const pulse = parseAppraisal(
    '{"shifts":[{"kind":"boredom","delta":20},{"kind":"anger","delta":10}],"warmth":0}',
  )
  assert.deepEqual(pulse?.shifts, [{ kind: 'anger', target: 'world', delta: 10, cause: '' }])
})

test('解析：离谱的增量被夹到 ±20（新刻度），0 与字符串一律丢弃', () => {
  const pulse = parseAppraisal(
    '{"shifts":[{"kind":"anger","delta":999},{"kind":"joy","delta":"10"},{"kind":"sadness","delta":0}]}',
  )
  assert.deepEqual(pulse?.shifts, [{ kind: 'anger', target: 'world', delta: 20, cause: '' }])
})

test('解析：最多只收 3 条情绪（多了也读不懂）', () => {
  const pulse = parseAppraisal(
    '{"shifts":[{"kind":"anger","delta":10},{"kind":"joy","delta":10},{"kind":"sadness","delta":10},{"kind":"disgust","delta":10}]}',
  )
  assert.equal(pulse?.shifts.length, 3)
})

test('解析：全空等于"没影响"，返回 undefined 让上层跳过写盘', () => {
  assert.equal(parseAppraisal('{"shifts":[],"warmth":0,"perceived":""}'), undefined)
})

test('解析：共情标记 vicarious 只在明确写了 true 时才生效（其余一律按"被伤"处理）', () => {
  const pulse = parseAppraisal(
    '{"shifts":['
    + '{"kind":"sadness","target":"user","delta":18,"cause":"他遇到糟心事","vicarious":true},'
    + '{"kind":"joy","target":"user","delta":10,"vicarious":"true"},'
    + '{"kind":"anger","delta":12}'
    + '],"warmth":0}',
  )
  assert.ok(pulse !== undefined)
  assert.equal(pulse.shifts[0]?.vicarious, true, '明确 true 才算')
  // 字符串 "true" 不算 —— 模型最容易在这里写错；按"被伤"处理是保守方向。
  assert.deepEqual(pulse.shifts[1], { kind: 'joy', target: 'user', delta: 10, cause: '' })
  assert.equal('vicarious' in (pulse.shifts[2] ?? {}), false, '没写就没有这个键（不塞 false 进状态）')
})

/* ───────────────────────────── 渲染 ───────────────────────────── */

/** 造一个"情绪到了某档"的状态。 */
function withCharge(kind, intensity, cause = '') {
  return apply(createInitialEmotionState(T0), [{ kind, delta: intensity, cause }], T0)
}

test('渲染：平静时也给一行——她必须拿得到"此刻是什么样"', () => {
  const rendered = renderReminder(createInitialEmotionState(T0), new Date(T0))
  assert.equal(rendered.tier, 'calm')
  assert.match(rendered.text, /没什么起伏/)
  assert.notEqual(rendered.text, '', '空着等于她拿不到自己的状态（2026-11-25 改）')
})

test('渲染：低档位只让它落在措辞里，不写"你在生气"', () => {
  const rendered = renderReminder(withCharge('disgust', 35, '被打断三次'), new Date(T0))
  assert.equal(rendered.tier, 'faint')
  assert.match(rendered.text, /厌烦/)
  assert.match(rendered.text, /不说出来/)
  assert.equal(/非常|气死|很委屈/.test(rendered.text), false, '低档位不该出现强词')
})

test('渲染：最高档才允许直接说，而且明确"只说一次"', () => {
  const rendered = renderReminder(withCharge('anger', 80, '被反复否定'), new Date(T0))
  assert.equal(rendered.tier, 'burst')
  assert.match(rendered.text, /暴怒/)
  assert.match(rendered.text, /只说一次/)
})

test('渲染：两条同强时各写一条，都带冲谁（不再把两条挤成一句话）', () => {
  const state = apply(
    createInitialEmotionState(T0),
    [
      { kind: 'joy', delta: 60, cause: '被夸到点上' },
      { kind: 'sadness', delta: 60, cause: '被当面说中' },
    ],
    T0,
  )
  const rendered = renderReminder(state, new Date(T0))
  assert.match(rendered.text, /喜悦/)
  assert.match(rendered.text, /悲伤/)
  assert.match(rendered.text, /被夸到点上/)
  assert.match(rendered.text, /被当面说中/, '第二条也要带上它自己的原因')
  assert.equal(rendered.text.includes('也也'), false)
})

test('渲染：不给数字（模型会把百分比念出来）', () => {
  const rendered = renderReminder(withCharge('anger', 82, '被否定'), new Date(T0))
  assert.equal(/\d+%|\d{2}/.test(rendered.text), false)
})

test('渲染：对方的观察会带上，但过期（90 分钟）就不再提', () => {
  const state = apply(
    createInitialEmotionState(T0),
    [{ kind: 'disgust', delta: 40 }],
    T0,
  )
  const fresh = { ...state, perceived: '对方有点累', perceivedAt: T0 }
  assert.match(renderReminder(fresh, new Date(T0)).text, /你注意到：对方有点累/)

  const stale = new Date(Date.parse(T0) + 3 * 3_600_000).toISOString()
  const old = settle(fresh, stale)
  const rendered = renderReminder(old, new Date(stale))
  assert.equal(rendered.text.includes('你注意到'), false)
})

/* ───────────────────────────── 合成 ───────────────────────────── */

test('渲染：两条同时够强时分开写，不再压成一个复合词（复合会吞掉"冲谁"）', () => {
  const state = apply(
    createInitialEmotionState(T0),
    [
      { kind: 'disgust', delta: 60, cause: '被冒犯到底线' },
      { kind: 'anger', delta: 55, cause: '被否定' },
    ],
    T0,
  )
  const rendered = renderReminder(state, new Date(T0))
  assert.match(rendered.text, /厌恶/)
  assert.match(rendered.text, /愤怒/)
  assert.equal(rendered.text.includes('轻蔑'), false, '复合词把两条并成一条，就看不出它冲的是谁')
  assert.match(rendered.text, /被冒犯到底线/)
  assert.match(rendered.text, /被否定/)
})

test('合成：只有一条够强时仍是单情绪（不硬凑组合）', () => {
  const state = apply(
    createInitialEmotionState(T0),
    [
      { kind: 'anger', delta: 50, cause: '被否定' },
      { kind: 'anger', delta: 10 },
    ],
    T0,
  )
  const rendered = renderReminder(state, new Date(T0))
  assert.match(rendered.text, /愤怒/)
  assert.equal(rendered.text.includes('轻蔑'), false)
})

test('渲染：30 分以下也写出来，用「有点…」，不准写成「平静」', () => {
  // 真机 2026-11-25：她对 TA 的恼是 20.8，旧写法整条藏掉，她看到的是"期待"。
  const rendered = renderReminder(withCharge('anger', 21, '他一句话把我晾在这儿'), new Date(T0))
  assert.match(rendered.text, /有点恼/, '20 分的恼要说得出来')
  assert.match(rendered.text, /他一句话把我晾在这儿/, '要带上因为什么')
  assert.equal(rendered.text.includes('平静'), false, '八种情绪的 calm 档词全是"平静"，那等于没说')
})

test('渲染：分三层说——主 / 还压着 / 很轻但还在', () => {
  const state = apply(
    createInitialEmotionState(T0),
    [
      { kind: 'anticipation', delta: 50, cause: '话头递回来了' },
      { kind: 'anger', delta: 30, cause: '被晾了一下' },
      { kind: 'joy', delta: 12, cause: '他还愿意听' },
    ],
    T0,
  )
  const rendered = renderReminder(state, new Date(T0))
  assert.match(rendered.text, /你此刻：.*期待/)
  assert.match(rendered.text, /还压着：.*恼怒/, '不弱于主导一半的算"还压着"')
  assert.match(rendered.text, /很轻但还在：.*高兴/, '不够一半的算余温')
})

test('渲染：10 分以下不提（免得把真有的那几条稀释掉）', () => {
  const rendered = renderReminder(withCharge('anger', 8), new Date(T0))
  assert.match(rendered.text, /没什么起伏/)
  assert.equal(rendered.text.includes('恼'), false)
})

test('渲染：每条都带冲谁，冲外面的事也要写出来', () => {
  const state = apply(
    createInitialEmotionState(T0),
    [{ kind: 'fear', delta: 40, target: 'world', cause: '外面太吵' }],
    T0,
  )
  const rendered = renderReminder(state, new Date(T0))
  assert.match(rendered.text, /对外面的事忧虑/)
})

test('渲染：签名会随"又冒出一条"变化（否则新的恼意永远不会重新注入）', () => {
  const base = apply(createInitialEmotionState(T0), [{ kind: 'anticipation', delta: 50 }], T0)
  const withAnger = apply(base, [{ kind: 'anger', delta: 18 }], T0)
  const before = renderReminder(base, new Date(T0)).signature
  const after = renderReminder(withAnger, new Date(T0)).signature
  assert.notEqual(before, after, '档位没变、但多了一条情绪 —— 这必须算"变了"')
})

test('渲染：同一种情绪冲几个人只留最强的一条（否则会把名额吃光，挤掉别的情绪）', () => {
  // 真机 2026-11-25 的原样：三个"期待"（50.3 / 24.4 / 23.6）把 20.8 的恼挤出了注入。
  const state = apply(
    createInitialEmotionState(T0),
    [
      { kind: 'anticipation', target: 'world', delta: 50, cause: '话头递回来了' },
      { kind: 'anticipation', target: 'self', delta: 24 },
      { kind: 'anticipation', target: 'user', delta: 23 },
      { kind: 'anger', target: 'user', delta: 21, cause: '被晾在这儿' },
    ],
    T0,
  )
  const rendered = renderReminder(state, new Date(T0))
  assert.equal(rendered.text.match(/期待/g)?.length, 1, '期待只写一条（最强的那条）')
  assert.match(rendered.text, /恼/, '恼不能被三条期待挤掉')
  assert.match(rendered.text, /被晾在这儿/)
})

test('渲染：最多几条的口径（还压着 2 条、余温 2 条）', () => {
  const state = apply(
    createInitialEmotionState(T0),
    [
      { kind: 'anticipation', delta: 80, cause: '主导' },
      { kind: 'anger', delta: 70, cause: '次一' },
      { kind: 'sadness', delta: 60, cause: '次二' },
      { kind: 'fear', delta: 55, cause: '次三（不写）' },
      { kind: 'joy', delta: 12, cause: '余温一' },
      { kind: 'trust', delta: 11, cause: '余温二' },
      { kind: 'disgust', delta: 10.5, cause: '余温三（不写）' },
    ],
    T0,
  )
  const rendered = renderReminder(state, new Date(T0))
  const secondary = rendered.text.match(/还压着：([^\n]*)/)?.[1] ?? ''
  assert.equal(secondary.split('；').length, 2, '还压着只写两条')
  assert.equal(rendered.text.includes('次三'), false)
  assert.equal(rendered.text.includes('余温三'), false)
})



test('渲染：精力低会单独说一句，与情绪无关', () => {
  const tired = { ...createInitialEmotionState(T0), energy: 30 }
  const rendered = renderReminder(tired, new Date(T0))
  assert.match(rendered.text, /有点累/)
  assert.equal(rendered.energy, 'tired')

  const exhausted = { ...createInitialEmotionState(T0), energy: 10 }
  assert.match(renderReminder(exhausted, new Date(T0)).text, /很累/)
})

test('渲染：状态签名把情绪档位与精力档位都算进去', () => {
  const calmFresh = renderReminder(createInitialEmotionState(T0), new Date(T0))
  const calmTired = renderReminder({ ...createInitialEmotionState(T0), energy: 30 }, new Date(T0))
  assert.notEqual(calmFresh.signature, calmTired.signature, '从有精神变累也算一次跨越')
})

/* ─────────────────── 评估器的输入：立场与"不回读原因" ─────────────────── */

/** 假模型：记录最后一次收到的提示词（正文与 system 都要看）。 */
function fakeLlm(reply = '{"shifts":[],"warmth":0,"perceived":""}') {
  const seen = []
  return {
    seen,
    llm: {
      route: () => ({ provider: 'test', model: 'test' }),
      streamText: async (input) => {
        seen.push(input)
        return { text: reply, finishReason: 'stop' }
      },
    },
  }
}

test('评估输入里带上了你的立场（否则评估器只能用通用道德判）', async () => {
  const { seen, llm } = fakeLlm()
  const state = apply(createInitialEmotionState(T0), [{ kind: 'anger', target: 'user', delta: 30 }], T0)
  const stance = {
    character: '',
    traits: [{ key: '人格偏好', value: '对亲近的人有强烈偏好' }],
    boundaries: [],
    relation: ['他是我的老板'],
    address: ['老板'],
    sections: [],
    custom: [],
  }
  await appraiseMessage(llm, { message: '想听😍', state, stance })
  const text = seen[0].text
  assert.match(text, /【你的立场】/, '立场块要在')
  assert.match(text, /你的人格偏好：对亲近的人有强烈偏好/)
  assert.match(text, /你的底线：没有特别写明/)
  assert.match(text, /想听😍/, '要判断的那句话照旧在')
  // 系统提示里要有"以你的立场为准"这条硬规则，否则模型会拿自己的偏好顶上。
  assert.match(seen[0].system, /以你的立场为准/)
  assert.match(seen[0].system, /不要用"这种话一律不合适"这类通用标准覆盖它/)
})

test('评估输入**不回读原因**：原因的措辞不能被当成"又来了"的证据', async () => {
  const { seen, llm } = fakeLlm()
  const state = apply(
    createInitialEmotionState(T0),
    [{ kind: 'disgust', target: 'user', delta: 40, cause: '又发来越界的亲密要求' }],
    T0,
  )
  // 注意：原因在这里故意写得跟现场一模一样；它只该留在状态里，不该进评估输入。
  await appraiseMessage(llm, { message: '在吗', state })
  const text = seen[0].text
  assert.equal(text.includes('又发来越界的亲密要求'), false, '原因不能进评估输入（会变成"又来了"的证据）')
  assert.match(text, /对TA厌恶 40/, '但"哪种情绪、多强、冲谁"要在 —— 那是评估的起点')
})

test('评估输入可以带最近两轮前文（只读，标注清楚）', async () => {
  const { seen, llm } = fakeLlm()
  await appraiseMessage(llm, {
    message: '你自己随便找找',
    state: createInitialEmotionState(T0),
    context: '对方：要不要看看网上，你有啥感兴趣的？\n你：你想让我看什么？随便扔一个过来。',
  })
  const text = seen[0].text
  assert.match(text, /【前文】/, '前文要有自己的小标题')
  assert.match(text, /你想让我看什么/, '前文里要有她上一句')
  assert.match(text, /不要对前文再做判断/, '要明确"别把前文当判断对象"')
})

test('没有立场时完全不提这一段（退回旧行为，不假装有立场）', async () => {
  const { seen, llm } = fakeLlm()
  await appraiseMessage(llm, { message: '在吗', state: createInitialEmotionState(T0) })
  assert.equal(seen[0].text.includes('【你的立场】'), false)
})
