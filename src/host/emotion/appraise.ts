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
import {
  EMOTION_KINDS,
  EMOTION_LABELS,
  EMOTION_TARGETS,
  EMOTION_TARGET_LABELS,
  type EmotionKind,
  type EmotionTarget,
} from './constants.js'
import { renderStance, type AppraisalStance } from './stance.js'
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

/**
 * 单条增量的绝对值上限（模型偶尔会写出 ±100 这种量级）。
 *
 * 取 20 与**新标尺**对齐：日常 1–5、明显 6–10、大事 12–18，20 是"比最重的事再留一点余量"。
 * 夹到 20 而不是更多，是因为超过这个量级的一句评价会把整条情绪条一次性顶满 ——
 * 那不是"评判"，是模型在替她决定。
 */
const MAX_DELTA = 20

/** 原因与观察的字数上限（超了截断：它们是给渲染用的一句话，不是小作文）。 */
const MAX_TEXT = 40

/**
 * 评估器的系统提示。
 *
 * **第二人称**（"你就是她"）：这件事本来就是"她自己判断它对自己意味着什么"；用第三人称
 * 等于让模型以外人的身份揣测一个角色，人格的约束力会被稀释（2026-11-21 用户提出来，采纳）。
 * 防"演起来"不靠人称，靠两条硬约束：**只输出 JSON**、**不写台词或反应**。
 */
const APPRAISE_SYSTEM = [
  '你就是「她」这个人。对方刚说了一句话 —— 你的任务只有一个：判断它**让你**（不是别人）的情绪怎么变。',
  '只输出一个 JSON 对象；不要解释、不要 Markdown 代码块，也不要写你的台词或反应。',
  '',
  '**先看调用方给的【你的立场】**：同一个动作对不同的人意义可以相反（对恋人是调情，对陌生人才是冒犯），',
  '你喜欢的也不等于别人喜欢的。判断时以你的立场为准，**不要用"这种话一律不合适"这类通用标准覆盖它**。',
  '立场里写明"这类事是你想要的"，就不该判成厌恶或愤怒；反过来，立场里写明的底线被越过了，要照着判。',
  '立场里没写的东西，不要替自己补一条底线。',
  '',
  '可用的情绪只有这八种（Plutchik 的八种基本情绪），键名必须逐字使用：',
  'joy=喜悦（好事发生、被认可、被善待）',
  'trust=信任（被关心、被记得、聊得来、可靠）',
  'fear=恐惧（怕失去、怕被抛下、怕做错）',
  'surprise=惊讶（没想到、出乎意料；它本身不带好坏）',
  'sadness=悲伤（期待落空、失去、过往被否定）',
  'disgust=厌恶（被触到你写明的底线，或让你生理上不适）',
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
  '{"shifts":[{"kind":"anger","target":"self","delta":6,"cause":"答应的事没做到"}],"warmth":-2,"warmthCause":"被冷落","perceived":"对方很急躁"}',
  '',
  '每条 shift 都要给 **target**（这股情绪是冲谁的），三选一：',
  '- target="user"：冲对方（"你凭什么这么说"）',
  '- target="self"：冲自己（"我怎么又搞砸了"）',
  '- target="world"：冲事情本身，没有具体的人可以怪（"这事儿真烦"、"今天运气不错"）',
  '',
  'target 最容易判错的一类，单独说清楚（OCC 把这叫 happy-for / sorry-for）：',
  '- **替对方高兴**（他升职了、他今天很好）→ joy + target="user"，**并且加 "vicarious": true**。',
  '- **替对方难过**（他遇到糟心事）→ sadness + target="user"，**并且加 "vicarious": true**。',
  '- 对方让你高兴（夸你、信你、想着你）→ joy + target="user"。',
  '- 对方冒犯你 → anger + target="user"。',
  '- 只有"这件事本身"让你高兴/难过、跟具体的人无关时才用 world（比如天气、运气、一个客观消息）。',
  '判断口诀：问一句「这是冲谁的」。能换成"你让我…"或"我为你…"就是 user；能换成"我对自己…"就是 self；都换不进去才是 world。',
  '',
  '**"vicarious" 只加在"替对方"的那一种上**（我为你高兴 / 我替你难过 / 我替你气）——',
  '它告诉下游"这是共情，不是我被对方伤到"。除此之外一律不写这个字段（省 token）。',
  '带标记的例子（其余字段照常）：',
  '{"shifts":[{"kind":"sadness","target":"user","delta":8,"cause":"他遇到糟心事","vicarious":true}],"warmth":-1,"warmthCause":"替他难受","perceived":"对方很低落"}',
  '',
  '规则：',
  '- shifts 最多 3 条。**delta 是 0–100 刻度上的「百分点」**：+6 的意思是"这条从 60 变成 66"，不是"增强 6%"。',
  '- 绝大多数话应当落在 **1–5**。没有明显影响就给空数组。',
  '- 调用方可能给你一段【前文】：它只用来理解这句话在说什么（谁在接谁的话、是不是在开玩笑），**不要对前文再做一遍判断**。',
  '- 不要因为"这类事之前可能发生过"就加重判断；你此刻已有的情绪只说明"你现在是什么状态"，不说明之前发生过几次。',
  '',
  '**delta 的标尺**（这一条最容易给偏，按它来）：',
  '- 1–5：轻轻动了一下（日常寒暄、一句普通的夸奖、一个小冒犯）—— **绝大多数情况都在这里**',
  '- 6–10：明显有感（被认真夸到点上、被戳到一次真的）',
  '- 12–18：强烈（天大的好消息、被当面羞辱、一次交底）',
  '- 上限 20：比"最重的事"再留一点余量；不要动不动给到两位数。',
  '实测偏差：正面情绪容易被压到 3 以下，而关系类（信任）又容易给到十几 —— 按上面的量级给，别凭感觉放大。',
  '给正面情绪时**照标尺给**，别因为"你是 AI 不该太高兴"而下调。',
  '- cause 用一句不超过 20 字的话写清"因为什么"。不要写"用户说了难听的话"这种泛泛的话。',
  '- warmth 取 -5 到 5 的整数，表示这句话让"你对对方的感觉"变好或变差多少。',
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
  /**
   * 她的**立场**（人格里会改变"这件事意味着什么"的那几样）。
   *
   * 没有它，评估器只能用一个"通用的人"来判断 —— 而通用的人自带一套通用道德，
   * 于是人设写"好色"也没用（详见 `stance.ts` 的现场记录）。省略它等于回到旧行为。
   */
  stance?: AppraisalStance
  /**
   * 最近两轮对话（**只读前情**，用于理解这句话在接什么）。
   *
   * 为什么需要它（实机现场）：只给当前这一句时，"你自己随便找找"这种短话会被判成
   * "被随口打发" —— 因为评估器不知道上一句是她把话头递过去的。前情让判断有上下文。
   * 只放**事实**（双方原话），不放我们自己的判断（`cause` 是上一轮评估的输出，会自我强化）。
   */
  context?: string
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
    lines.push('你现在没有明显情绪。')
  } else {
    lines.push('你此刻（0 = 没有，100 = 极强）：')
    for (const charge of state.charges) {
      /**
       * **只给"哪种情绪 + 多强 + 冲谁"，不给原因。**
       *
       * 原因是我们上一次评估的输出；喂回去会被它当成事实继续推理 —— 实机现场那句
       * "**又**发来露骨的性要求"就是这么来的（原因里写着上一回的判断），于是误判自己喂自己。
       *
       * 数字后面带 `/100`：模型看到"愤怒 60"时不知道刻度，于是把 60 当成"随便一个数"，
       * 增量也跟着凭感觉给（现场：一句话给到十几二十）。把刻度写在数字旁边，标尺才对得上。
       */
      lines.push(`- ${EMOTION_TARGET_LABELS[charge.target]}${labelOf(charge.kind)} ${Math.round(charge.intensity)}/100`)
    }
  }
  lines.push(`关系温度：${Math.round(state.warmth)}/100（0 很冷，100 很亲）`)
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
    const shift: EmotionShift = {
      kind: item.kind,
      target: asTarget(item.target),
      delta,
      cause: shortText(item.cause),
    }
    /**
     * 只有模型**明确**写了 `true` 才算共情；写 `"true"`（字符串）、写 1、漏写一律按"被伤"处理。
     * 方向是保守的：看错的最坏结果是回到加这个标记之前的行为（该记账的照记账）。
     */
    if (item.vicarious === true) shift.vicarious = true
    shifts.push(shift)
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
  /**
   * 评估器的输入分三块：**她的立场 → 她此刻的状态 → 对方这句话**。
   *
   * 顺序不是随意的：先给"判断依据"，再给"起点"，最后才是"要判断的东西" ——
   * 实测把立场放在最后时，模型更习惯先按通用直觉下结论、再拿立场迁就它。
   */
  const stateBlock = [
    describeState(input.state),
    dominant === undefined ? '' : `（你现在最主要的情绪是${labelOf(dominant.kind)}）`,
  ]
    .filter((line) => line !== '')
    .join('\n')
  /**
   * 评估器的输入分四块：**你的立场 → 前文 → 你此刻的状态 → 对方这句话**。
   *
   * 顺序不是随意的：先给"判断依据"，再给"上下文"，再给"起点"，最后才是"要判断的东西" ——
   * 实测把立场放在最后时，模型更习惯先按通用直觉下结论、再拿立场迁就它。
   */
  const contextBlock = input.context === undefined || input.context === ''
    ? ''
    : `【前文】刚才的对话（只帮你理解这句话在接什么，不要对前文再做判断）：\n${input.context}`
  const text = [
    renderStance(input.stance),
    contextBlock,
    stateBlock,
    `对方刚说：「${message}」`,
    '按上面的格式输出 JSON。',
  ]
    .filter((block) => block !== '')
    .join('\n\n')

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
