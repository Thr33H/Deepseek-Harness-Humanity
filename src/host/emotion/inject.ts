/**
 * 沉浸模式下把情绪**接进这一轮对话**（`agent/pre-step`）。
 *
 * ### 为什么走 pre-step 而不是系统提示词
 *
 * 系统提示词一变，DSH 就得在历史里追加一份新的 system 文本；而情绪每几十轮才明显动一次，
 * 塞进系统提示词等于让"几乎不变的东西"反复打断缓存。DSH 自己的时间插件也是这么做的：
 * 在 `agent/pre-step` 里往消息后面追一条，用 `source.kind` 标明来源
 * （`dsh-time-context` 的实现即为此）。
 *
 * ### 三条纪律
 *
 * 1. **只在沉浸模式**：会话跑的是 `Humanity 功能` 时整条路径直接返回（用户 2026-11-17 定：
 *    功能模式不读不写不算）。判断用 `presetOfAgent` —— 与净室 guard **同一个事实源**。
 * 2. **跨档才说**：同一档位连续不重复注入，只有档位变了（或距上次超过
 *    {@link REFRESH_MS}）才补一条。这是"不到阈值藏着"的落点。
 * 3. **评估不阻塞对话**：判断是异步补跑的（`void`），这一轮先用**上一轮**留下的状态。
 *    人也是后知后觉的；为了情绪让用户多等半秒不值得。
 * @module humanity/emotion/inject
 */
import type { Context } from '@deepseek-ai/cordis'

import { createMainAgentJudge } from '../agent-scope.js'
import { presetOfAgent } from '../agent-scope.js'
import type { Log } from '../log.js'
import type { LlmAccess } from '../llm.js'
import { loadOptional } from '../optional.js'
import { HUMANITY_PRESET_ID } from '../presets.js'
import { appraiseMessage } from './appraise.js'
import { renderReminder } from './render.js'
import { settle, type EmotionPulse } from './state.js'
import type { AppraisalStance } from './stance.js'
import type { EmotionState } from './types.js'

/**
 * 同一档位最多隔多久补发一次提醒（毫秒）。
 *
 * 为什么需要它：注入的那条消息会随对话变旧，长会话里还可能被压缩掉。
 * 半小时补一次，既不会让模型忘了状态，也不至于每轮都重复同一句话。
 */
const REFRESH_MS = 30 * 60_000

/** pre-step 的决策形状（只声明我们改得动的那部分）。 */
interface PreStepDecisionLike {
  kind: 'reject' | 'enter'
  messages?: unknown[]
}

/** 一条用户消息里取正文（结构读，不假设具体类）。 */
function textOfMessage(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => (block !== null && typeof block === 'object' && (block as { type?: string }).type === 'text'
      ? String((block as { text?: unknown }).text ?? '')
      : ''))
    .join('\n')
    .trim()
}

/**
 * 取**真正的用户消息**的正文。
 *
 * 为什么要看 `source.kind`：这一轮带给我们的不止对方那句话，还有 DSH 的运行环境说明
 * （"The following information describes your current session…"）、时间注入、以及我们自己的
 * 情绪注入。它们不是"对方说的"，喂给评估器既浪费预算又会误导 —— 实机现场评估器看到的
 * 一大半是那段环境说明。
 * @param message - 消息对象。
 * @returns 正文；不是用户消息时为空串。
 */
function userTextOf(message: unknown): string {
  const source = (message as { source?: { kind?: string } } | undefined)?.source
  if (source?.kind !== 'user') return ''
  return textOfMessage(message)
}

/** 会话历史里我们认得的那个窄面（结构读；DSH 的 Session 有 `seq` 与 `eventAt`）。 */
interface SessionLike {
  seq?: number
  eventAt?(seq: number): { type?: string; data?: unknown } | undefined
}

/** 前文里每句话最多留多少字（两句加起来够用，不挤占评估预算）。 */
const CONTEXT_LINE_CHARS = 120

/**
 * 取**最近两轮**对话作为前文（对方的原话 + 她的原话）。
 *
 * 为什么需要它：只给当前这一句时，"你自己随便找找"这种短话会被判成"被随口打发" ——
 * 评估器不知道上一句是她把话头递过去的。前情让它知道"这句话在接什么"。
 *
 * 三条纪律：
 * - 只取**事实**（双方原话），不取注入、工具结果，也不取我们自己的 `cause`（那是上一轮评估的输出，会自我强化）；
 * - 当前这句话本身不重复放进去（它下面会单独给）；
 * - 会话接口读不到就返回 `undefined` —— 退回"只看当前这句"，绝不能让评估因此失败。
 * @param agent - 当前 Agent（pre-step 载荷里那个）。
 * @param currentText - 这一次要判断的正文（用于避免重复）。
 * @returns 多行前文；没有可用历史时 `undefined`。
 */
function recentContext(agent: unknown, currentText: string): string | undefined {
  const session = (agent as { session?: SessionLike } | undefined)?.session
  if (session === undefined || typeof session.eventAt !== 'function') return undefined
  const seq = typeof session.seq === 'number' ? session.seq : 0
  if (seq <= 0) return undefined

  const lines: string[] = []
  for (let index = seq - 1; index >= 0 && lines.length < 4; index -= 1) {
    let event: { type?: string; data?: unknown } | undefined
    try {
      event = session.eventAt(index)
    } catch {
      break
    }
    if (event === undefined) continue
    if (event.type === 'user/message') {
      const text = userTextOf(event.data)
      if (text === '') continue
      // 最后一条就是这一次要判断的那句：不重复放进去。
      if (lines.length === 0 && text === currentText) continue
      lines.push(`对方：${text.slice(0, CONTEXT_LINE_CHARS)}`)
    } else if (event.type === 'assistant/message') {
      const text = textOfMessage((event.data as { message?: unknown } | undefined)?.message)
      if (text === '') continue
      lines.push(`你：${text.slice(0, CONTEXT_LINE_CHARS)}`)
    }
  }
  if (lines.length === 0) return undefined
  return lines.reverse().join('\n')
}

/** 注入需要的外部事实。 */
export interface EmotionInjectDeps {
  /** 模块开关（总开关 × 情绪开关）。 */
  enabled(): boolean
  /** 当前状态（已结算）：用于渲染这一轮的提醒。 */
  snapshot(): EmotionState | undefined
  /** 施加一次评估结果（落盘 + 刷新工作台）。 */
  pulse(input: EmotionPulse): Promise<void>
  /** 后台模型调用入口。 */
  llm: LlmAccess
  /**
   * 现读她的**立场**（人格里会改变"这件事意味着什么"的那几样）。
   *
   * 为什么是函数而不是一份快照：人格随时可改，评估每次都要用当时的那份；
   * 缓存会让人格改完之后，情绪层还按旧立场判（实机表现就是"改了人格，情绪没跟着变"）。
   */
  stance(): AppraisalStance | undefined
}

/**
 * 装上情绪注入。
 * @param ctx - 本插件的上下文。
 * @param log - 日志门面。
 * @param deps - 状态、评估入口与开关。
 * @returns 卸载动作。
 */
export function installEmotionInjection(ctx: Context, log: Log, deps: EmotionInjectDeps): () => void {
  const isMainAgent = createMainAgentJudge(ctx, log)
  /**
   * 上一次注入时的**状态签名**（情绪档位 + 精力档位）。
   *
   * 为什么不是只记情绪档位：累不累也是一个会变的维度，"从有点累变成很累"同样值得说一句。
   * 把两者拼成签名，跨任意一维都算一次跨越。
   */
  let lastSignature: string | undefined
  /** 上一次注入的时刻（epoch 毫秒）。 */
  let lastInjectedAt = 0

  /** `createUserMessage`（`@deepseek-ai/dsh-llm` 可能缺席，惰性载入一次）。 */
  let factory: ((input: unknown) => unknown) | undefined
  let factoryLoading = false
  const ensureFactory = (): void => {
    if (factory !== undefined || factoryLoading) return
    factoryLoading = true
    void loadOptional<{ createUserMessage(input: unknown): unknown }>('@deepseek-ai/dsh-llm', log)
      .then((module) => {
        factory = module?.createUserMessage
      })
      .finally(() => {
        factoryLoading = false
      })
  }
  ensureFactory()

  /** 造一条注入消息（形状与第一方 time-context 一致：`form: 'snapshot'` + `sections`）。 */
  const makeMessage = (text: string): unknown | undefined => {
    if (factory === undefined) return undefined
    const body = `<system-reminder>\n${text}\n</system-reminder>`
    return factory({
      content: [{ type: 'text', text: body }],
      source: { kind: 'humanity-emotion', form: 'snapshot', sections: [{ name: 'humanity-emotion', text: body }] },
    })
  }

  /** 补跑一次判断：失败只记日志，绝不影响这一轮对话。 */
  const evaluate = async (message: string, state: EmotionState, context?: string): Promise<void> => {
    try {
      const pulse = await appraiseMessage(deps.llm, { message, state, stance: deps.stance(), context }, {
        onWarn: (warning) => log.warn(warning),
      })
      if (pulse !== undefined) await deps.pulse(pulse)
    } catch (error) {
      log.warn('情绪判断失败：这一轮不更新心情（不影响对话）', error)
    }
  }

  const on = ctx.on as unknown as (
    name: string,
    listener: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>,
  ) => () => void

  const off = on('agent/pre-step', async (payload, next) => {
    const decision = (await next()) as PreStepDecisionLike
    // 被别的监听器拒绝的这一步不再加工：它根本不会发生。
    if (decision === null || typeof decision !== 'object' || decision.kind !== 'enter') return decision

    try {
      const { agent, step } = (payload ?? {}) as { agent?: unknown; step?: number }
      // 只对主 Agent 生效（子代理不该带着别人的心情干活）。
      if (agent === null || typeof agent !== 'object' || !isMainAgent(agent)) return decision
      // **功能模式完全不介入**：这是用户定的边界，也是"人格魅力但不被情绪左右"的落点。
      if (presetOfAgent(agent, ctx) !== HUMANITY_PRESET_ID) return decision
      if (!deps.enabled()) return decision

      const state = deps.snapshot()
      if (state === undefined) return decision

      const now = new Date()
      const rendered = renderReminder(settle(state, now.toISOString()), now)
      const messages = Array.isArray(decision.messages) ? [...decision.messages] : []

      const crossed = rendered.signature !== lastSignature
      const stale = now.getTime() - lastInjectedAt >= REFRESH_MS
      if (rendered.text !== '' && (crossed || stale)) {
        const injected = makeMessage(rendered.text)
        if (injected !== undefined) {
          messages.push(injected)
          lastSignature = rendered.signature
          lastInjectedAt = now.getTime()
        }
      } else if (rendered.text === '' && crossed) {
        // 回到"没话说"的状态（平静且不累）：只记下来，不注入。
        // 不记的话，下次从平静再变回累时会因为签名没动而漏发一次。
        lastSignature = rendered.signature
      }

      // 每轮只在第一步判断一次；读写都在异步尾巴上，用户不必等它。
      if (step === 1) {
        // 只取**对方说的**：环境说明、时间注入、我们自己的情绪注入都不是"对方刚说"。
        const text = (decision.messages ?? [])
          .map(userTextOf)
          .filter((line) => line !== '')
          .join('\n')
        // 前文（最近两轮）只给事实：让评估器知道这句话在接什么，避免"短句被判成敷衍"。
        if (text !== '') void evaluate(text, state, recentContext(agent, text))
      }

      return { ...decision, messages }
    } catch (error) {
      // 注入路径上任何异常都收敛成"这一轮不注入"：它比对话本身次要得多。
      log.warn('情绪注入失败：这一轮不注入（不影响对话）', error)
      return decision
    }
  })

  log.info('情绪注入已接入（只在 Humanity 沉浸模式下生效，跨档才注入）')
  return off
}
