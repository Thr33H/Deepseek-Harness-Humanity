/**
 * **读一句话**：判断它对她的情绪有什么影响（沉浸模式下每轮一次）。
 *
 * ### 为什么这一步必须调模型，而不是关键词
 *
 * 「你这个方案不太行」与「你这个方案有个 bug」，规则都看到"否定词"，但对人的意义完全不同：
 * 前者否定的是**标准**，后者只是指出事实。这正是 OCC 评估模型的核心问题
 * （合意性 / 合乎标准 / 归因于谁），[bhava 的 ADR-004](https://github.com/MacCracken/bhava/blob/main/docs/adr/004-occ-appraisal-model.md)
 * 就是为这件事从硬编码触发器改成评估的 —— 它自述旧做法的后果是"情绪与上下文脱节，
 * 它不知道自己为什么这样感觉"。
 *
 * ### 三条纪律
 *
 * 1. **只输出判断，不输出台词**：结果是一组增减量，不是一句"我很生气"。台词由注入侧按档位决定。
 * 2. **失败就当作没发生**：解析不了、超时、没配模型 —— 全部返回 `undefined`，这一轮不动情绪。
 *    宁可少一次变化，也不要写进一份乱码状态。
 * 3. **不读历史**：只给"它现在的状态 + 对方这一句话"。读全量对话会让每次调用越来越贵，
 *    而情绪需要的因果其实就在当前这一句里（更早的因果已经落在 `cause` 字段上了）。
 * @module humanity/emotion/appraise
 */
import type { LlmAccess } from '../llm.js'
import { EMOTION_KINDS, EMOTION_LABELS, EMOTION_TARGETS, type EmotionKind, type EmotionTarget } from './constants.js'
import { dominantOf, type EmotionPulse, type EmotionShift } from './state.js'
import type { EmotionState } from './types.js'

/**
 * 单次评估的输出上限。
 *
 * ⚠️ 这个数是**实测调上来的**，不是拍脑袋：300 的时候，三条带 `target` 的 shift 加
 * warmth / perceived 会把 JSON 截在半句上（实测抓到截断在 `"warmthCause":"被` 处），
 * 于是整轮评估被丢弃 —— 表面看是"它对这句话没反应"，实际是输出没写完。
 * 三层里最长的组合大约 500 token，800 留足余量。
 */
const APPRAISE_MAX_TOKENS = 800

/** 单次评估的墙钟上限：超过就当作这一轮没判断出来（不拖慢对话）。 */
const APPRAISE_TIMEOUT_MS = 8_000

/** 单条增量的绝对值上限（模型偶尔会写出 ±100 这种量级）。 */
const MAX_DELTA = 40

/** 原因与观察的字数上限（超了截断：它们是给渲染用的一句话，不是小作文）。 */
const MAX_TEXT = 40

/**
 * 评估器的系统提示。
 *
 * 写成"给她打分"而不是"扮演她"：这一步只要判断，冒充角色会让它开始编台词，
 * 而台词的正确来源是状态 + 档位（`render.ts`），不是评估器。
 */
const APPRAISE_SYSTEM = [
  '你在判断对方的一句话对「她」情绪的影响。只输出一个 JSON 对象，不要解释、不要 Markdown 代码块。',
  '',
  '可用的情绪只有这八种（Plutchik 的八种基本情绪），键名必须逐字使用：',
  'joy=喜悦（好事发生、被认可、被善待）',
  'trust=信任（被关心、被记得、聊得来、可靠）',
  'fear=恐惧（怕失去、怕被抛下、怕做错）',
  'surprise=惊讶（没想到、出乎意料；它本身不带好坏）',
  'sadness=悲伤（期待落空、失去、过往被否定）',
  'disgust=厌恶（被冒犯到底线、觉得低劣或不适）',
  'anger=愤怒（被冒犯、能力被否定、被命令）',
  'anticipation=期待（有盼头、在等什么发生）',
  '',
  '容易混的几对，按这个分：',
  '- 恐惧 vs 愤怒：都强烈，但恐惧怕的是"可能失去"，愤怒针对的是"已经冒犯"。',
  '- 厌恶 vs 愤怒：厌恶是"这东西/这人让我不适"，愤怒是"你对我做了不该做的"。',
  '- 惊讶是中性：它只说"没想到"，好坏要由同时出现的另一种情绪表达。',
  '- 期待 vs 喜悦：期待是"还没发生"，喜悦是"已经发生"。',
  '',
  '输出格式（字段一个都不能少）：',
  '{"shifts":[{"kind":"anger","target":"self","delta":15,"cause":"答应的事没做到"}],"warmth":-2,"warmthCause":"被冷落","perceived":"对方很急躁"}',
  '',
  '每条 shift 都要给 **target**（这股情绪是冲谁的），三选一：',
  '- target="user"：冲对方（"你凭什么这么说"）',
  '- target="self"：冲自己（"我怎么又搞砸了"）',
  '- target="world"：冲事情本身，没有具体的人可以怪（"这事儿真烦"、"今天运气不错"）',
  '',
  'target 最容易判错的一类，单独说清楚（OCC 把这叫 happy-for / sorry-for）：',
  '- **替对方高兴**（他升职了、他今天很好）→ joy + target="user"，不是 world。',
  '- **替对方难过**（他遇到糟心事）→ sadness + target="user"，不是 world。',
  '- 对方让你高兴（夸你、信你、想着你）→ joy + target="user"。',
  '- 对方冒犯你 → anger + target="user"。',
  '- 只有"这件事本身"让你高兴/难过、跟具体的人无关时才用 world（比如天气、运气、一个客观消息）。',
  '判断口诀：问一句「这是冲谁的」。能换成"你让我…"或"我为你…"就是 user；能换成"我对自己…"就是 self；都换不进去才是 world。',
  '',
  '规则：',
  '- shifts 最多 3 条，delta 取 -30 到 30 的整数，表示这句话让该情绪增强或减弱多少（百分制）。没有明显影响就给空数组。',
  '',
  '**delta 的标尺**（这一条最容易给偏，按它来）：',
  '- 5–10：轻轻动了一下（一句普通的客气话）',
  '- 15–22：明显有感（被认真夸了一句、被小冒犯了一下）',
  '- 25–30：强烈（第一次听到天大的好消息、被当面羞辱）',
  '实测偏差：正面情绪容易被压到 10 以下，而关系类（信任）却给到 90 —— 结果"替他高兴"永远够不到说话线。',
  '给正面情绪时**照标尺给**，别因为"她是 AI 不该太高兴"而下调。',
  '- cause 用一句不超过 20 字的话写清"因为什么"。不要写"用户说了难听的话"这种泛泛的话。',
  '- warmth 取 -5 到 5 的整数，表示这句话让"她对对方的感觉"变好或变差多少。',
  '- perceived 用一句不超过 20 字的话写你对"对方此刻状态"的判断；看不出来就写空字符串。',
  '',
  '有些情绪天然连在一起，判断时可以把它们一起给出（各给一条，不要合成一条）：',
  '- 喜悦常带着信任；期待常带着喜悦；恐惧常带着悲伤；厌恶常带着愤怒。',
  '- 反过来，**对立的两种不要同时给**：喜悦↔悲伤、信任↔厌恶、恐惧↔愤怒、惊讶↔期待。',
  '',
  '- 宁可判"没影响"，也不要编造。不要输出任何 JSON 之外的内容。',
].join('\n')

/** 评估的输入。 */
export interface AppraiseInput {
  /** 对方这一句话的正文。 */
  message: string
  /** 她此刻的状态（用于给评估器一个起点）。 */
  state: EmotionState
}

/** 单条消息送进评估的最大字数。 */
const MAX_MESSAGE_CHARS = 600

/**
 * 把过长的消息压到 {@link MAX_MESSAGE_CHARS} 以内。
 *
 * 为什么必须做：评估调用是把原话整段塞进提示词的。用户贴一份几千字的需求文档时，
 * 整段进去会撞上下文上限 —— 调用失败，而失败的表现和"这句话没有情绪"完全一样。
 *
 * 为什么**头尾各留一半**而不是只截前面：情绪线索经常在结尾（"……结果居然是良性的！"），
 * 只保留开头会把最关键的那半句丢掉。中间被省略的部分对判断语气的用处最小。
 * @param message - 已经 trim 过的原文。
 * @returns 可能被压短的消息。
 */
function clipMessage(message: string): string {
  if (message.length <= MAX_MESSAGE_CHARS) return message
  const half = Math.floor(MAX_MESSAGE_CHARS / 2)
  return `${message.slice(0, half)}……${message.slice(-half)}`
}

/** 调用参数（测试与注入侧都可能改写）。 */
export interface AppraiseOptions {
  maxTokens?: number
  timeoutMs?: number
  signal?: AbortSignal
  /**
   * 异常情况的出口（截断 / 输出用不了）。
   *
   * 为什么保留这个回调而不是静默丢弃：这两种失败在现象上一模一样——
   * **"它对这句话没反应"**。没有一条日志，就分不清是"判了没影响"还是"根本没读出结果"，
   * 而这两种情况的修法完全不同（前者调提示词，后者调 maxTokens）。
   */
  onWarn?(message: string): void
}

/** 情绪中文名（评估器提示里已经给了对照表，这里只用于渲染当前状态）。 */
function labelOf(kind: EmotionKind): string {
  return EMOTION_LABELS[kind]
}

/**
 * 把当前状态写成评估器能读的一小段。
 *
 * 为什么给数字：评估器要做的是"加多少"，没有起点就没法判断"再加会不会过火"。
 * （对话模型那边相反 —— 那边给数字会被念出来，所以注入侧只给档位词。）
 * @param state - 当前状态。
 */
function describeState(state: EmotionState): string {
  const lines: string[] = []
  if (state.charges.length === 0) {
    lines.push('她现在没有明显情绪。')
  } else {
    lines.push('她此刻：')
    for (const charge of state.charges) {
      const cause = charge.cause === '' ? '' : `（${charge.cause}）`
      lines.push(`- ${labelOf(charge.kind)} ${Math.round(charge.intensity)}${cause}`)
    }
  }
  lines.push(`关系温度：${Math.round(state.warmth)}（0 很冷，100 很亲）`)
  return lines.join('\n')
}

/** 把任意值收敛成一段短文本（去换行、截断）。 */
function shortText(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT)
}

/** 是否是我们认识的某种情绪。 */
function isKind(value: unknown): value is EmotionKind {
  return typeof value === 'string' && (EMOTION_KINDS as readonly string[]).includes(value)
}

/** 是否是我们认识的对象档位；不认识的一律按 `world`（最中性）。 */
function asTarget(value: unknown): EmotionTarget {
  return typeof value === 'string' && (EMOTION_TARGETS as readonly string[]).includes(value)
    ? (value as EmotionTarget)
    : 'world'
}

/** 把任意值收敛成 [-MAX_DELTA, MAX_DELTA] 里的整数；不是有限数就返回 `undefined`。 */
function clampDelta(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const rounded = Math.round(value)
  if (rounded === 0) return undefined
  return Math.max(-MAX_DELTA, Math.min(MAX_DELTA, rounded))
}

/**
 * 解析评估器输出（**导出是为了能单独测**：这段代码的容错比它的正常路径重要得多）。
 *
 * 容错点：模型常带 ```json 围栏、前后加一句解释、把 delta 写成字符串、给出不存在的情绪名。
 * 这些都不该让这一轮失败，只该让"那一部分"被丢掉。
 * @param raw - 模型返回的全文。
 * @returns 可施加的脉冲；完全读不出来时 `undefined`。
 */
export function parseAppraisal(raw: string): EmotionPulse | undefined {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined

  let data: unknown
  try {
    data = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (data === null || typeof data !== 'object') return undefined

  const source = data as Record<string, unknown>
  const shifts: EmotionShift[] = []
  const rawShifts = Array.isArray(source.shifts) ? source.shifts : []
  for (const entry of rawShifts.slice(0, 3)) {
    if (entry === null || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>
    if (!isKind(item.kind)) continue
    const delta = clampDelta(item.delta)
    if (delta === undefined) continue
    shifts.push({ kind: item.kind, target: asTarget(item.target), delta, cause: shortText(item.cause) })
  }

  const warmthValue = typeof source.warmth === 'number' && Number.isFinite(source.warmth)
    ? Math.max(-5, Math.min(5, Math.round(source.warmth)))
    : 0

  const pulse: EmotionPulse = {
    shifts,
    warmth: warmthValue,
    warmthCause: shortText(source.warmthCause),
    perceived: shortText(source.perceived),
  }
  // 三样全空等于"没影响"：返回 undefined 让上层跳过写盘（与 `apply` 的空脉冲判定一致）。
  if (pulse.shifts.length === 0 && pulse.warmth === 0 && pulse.perceived === '') return undefined
  return pulse
}

/**
 * 判断一句话对她的影响。
 *
 * 永不抛：调用点在 pre-step 的异步尾巴上（`void` 调用），一次未处理的 rejection
 * 会在日志里刷出 UnhandledPromiseRejection，而这一轮对话本身并没有失败。
 * @param llm - 后台模型调用入口。
 * @param input - 这句话与当前状态。
 * @param options - 调用参数覆盖。
 * @returns 可施加的脉冲；任何环节不可用或读不出来时 `undefined`。
 */
export async function appraiseMessage(
  llm: LlmAccess,
  input: AppraiseInput,
  options: AppraiseOptions = {},
): Promise<EmotionPulse | undefined> {
  const dominated = input.message.trim()
  if (dominated === '') return undefined
  const route = llm.route()
  if (route === undefined) return undefined

  // 超长消息先压短：整段塞进去会撞上下文上限，而失败的样子和"没情绪"一模一样。
  const message = clipMessage(dominated)

  const dominant = dominantOf(input.state)
  const text = [
    describeState(input.state),
    '',
    dominant === undefined ? '' : `（她此刻最主要的情绪是${labelOf(dominant.kind)}）`,
    `对方刚说：「${message}」`,
    '',
    '按上面的格式输出 JSON。',
  ]
    .filter((line) => line !== '')
    .join('\n')

  let raw: string
  let finishReason = ''
  try {
    const result = await llm.streamText({
      route,
      system: APPRAISE_SYSTEM,
      text,
      maxTokens: options.maxTokens ?? APPRAISE_MAX_TOKENS,
      timeoutMs: options.timeoutMs ?? APPRAISE_TIMEOUT_MS,
      ...options.signal === undefined ? {} : { signal: options.signal },
    })
    raw = result.text
    finishReason = result.finishReason
  } catch (error) {
    options.onWarn?.(`情绪评估调用失败：${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }

  // 被截断的输出一定解析不了，但报出来的原因必须准确：是"没写完"，不是"模型乱答"。
  if (finishReason === 'length') {
    options.onWarn?.(`情绪评估的输出被截断（maxTokens=${options.maxTokens ?? APPRAISE_MAX_TOKENS} 不够）`)
    return undefined
  }

  const parsed = parseAppraisal(raw)
  if (parsed === undefined) {
    options.onWarn?.(`情绪评估的输出无法使用：${raw.slice(0, 200)}`)
  }
  return parsed
}
