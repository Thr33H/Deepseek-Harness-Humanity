/**
 * 解析调用：摘要 → 一次模型调用 → 严格校验的结构化结果（G-007「增量解析」）。
 *
 * 失败语义（DEV-PLAN §8-R3）：
 * - 路由不可用 / LLM 缺席 → 抛 {@link AnalyzeError}，run.ts 记 failed（不静默、不重试风暴）；
 * - 输出不是合法 JSON 或字段超限 → **重试一次**（附纠错句），仍失败抛错；
 *   调用方对失败会话**不推游标**——宁可下轮重看，不可把坏数据写进人格与记忆；
 * - `finishReason === 'max-tokens'` 视同失败（输出被截断的 JSON 不可信），同样走重试。
 *
 * token 用量跨尝试累计：重试花的钱也要记账（P-051 可见性）。
 * @module humanity/evolution/analyze
 */
import { AnalysisOutputSchema, type AnalysisOutput } from './model.js'
import { buildSystemPrompt, buildUserMessage, type PersonaBudgetState, type PersonaCardSection } from './prompt.js'
import type { LlmAccess } from './llm.js'
import type { ModelRoute, RunMode } from './types.js'

/** 解析失败（结构化原因；run.ts 把它写进运行记录）。 */
export class AnalyzeError extends Error {
  readonly code: 'no-route' | 'llm-failed' | 'bad-output' | 'truncated'
  /**
   * 本次失败尝试**已经花掉**的 token（流走完才失败的形态才有值：截断/坏 JSON）。
   * 重试花的钱也要记账（P-051 可见性）——调用方把它累计进运行记录。
   */
  readonly usage?: { inputTokens: number; outputTokens: number }
  /**
   * 整个解析（含重试）**总共花掉**的账：最终抛出时由 analyzeDigest 填上。
   * 调用方（run-loop）在失败路径上靠它记账——失败不等于没花钱。
   */
  spent?: { inputTokens: number; outputTokens: number; calls: number }

  constructor(code: AnalyzeError['code'], message: string, usage?: { inputTokens: number; outputTokens: number }) {
    super(message)
    this.name = 'AnalyzeError'
    this.code = code
    this.usage = usage
  }
}

/** 一次解析的输入。 */
export interface AnalyzeInput {
  digest: string
  mode: RunMode
  workspaceLabel: string
  /** 人格可变层当前小标题（约束 personaSections 的 section 取值）。 */
  sectionTitles: readonly string[]
  /** 人格卡当前内容（判断「已存在/同义」用；见 PromptContext.personaCard）。 */
  personaCard?: readonly PersonaCardSection[]
  /** 人格**注入预算**读数（见 PromptContext.personaBudget）：超预算时提示词追加"只合并"约束。 */
  personaBudget?: PersonaBudgetState
  maxOutputTokens: number
  /** 单次调用墙钟上限（毫秒）。 */
  timeoutMs: number
  signal?: AbortSignal
}

/** 一次解析的结果（含花费与尝试次数，供运行记录如实展示）。 */
export interface AnalyzeOutcome {
  output: AnalysisOutput
  inputTokens: number
  outputTokens: number
  attempts: number
}

/** 解析依赖。 */
export interface AnalyzeDeps {
  llm: LlmAccess
}

/** 重试时追加的纠错句（只强调合同，不改合同）。 */
const CORRECTION = '上一次输出不是合法的 JSON 对象，或字段取值超出了合同限制。这一次只输出一个符合合同的 JSON 对象。'

/**
 * 从模型正文里抠出 JSON 对象：剥掉可能存在的代码围栏与前后杂讯。
 *
 * 只做**定位**（首个 `{` 到与之配对的最后一个 `}`），不做修复：
 * 修复半截 JSON 等于替模型编造它没说完的话——那种数据进人格比解析失败危险得多。
 */
export function extractJson(text: string): string {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new AnalyzeError('bad-output', '模型输出里没有 JSON 对象')
  return text.slice(start, end + 1)
}

/** 单次尝试：调用 + 解析 + 校验；任何一环失败抛 AnalyzeError（流走完的失败带上已花用量）。 */
async function attempt(deps: AnalyzeDeps, route: ModelRoute, input: AnalyzeInput, correction: string) {
  const result = await deps.llm.streamText({
    route,
    system: buildSystemPrompt({
      mode: input.mode,
      workspaceLabel: input.workspaceLabel,
      sectionTitles: input.sectionTitles,
      ...(input.personaCard === undefined ? {} : { personaCard: input.personaCard }),
      ...(input.personaBudget === undefined ? {} : { personaBudget: input.personaBudget }),
    }),
    text: buildUserMessage(input.digest, correction),
    maxTokens: input.maxOutputTokens,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  })
  const usage = { inputTokens: result.inputTokens, outputTokens: result.outputTokens }
  if (result.finishReason === 'max-tokens') {
    throw new AnalyzeError('truncated', `输出被截断（max-tokens），已消耗 ${result.outputTokens} output tokens`, usage)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(extractJson(result.text))
  } catch (error) {
    const reason = error instanceof AnalyzeError ? error.message : `模型输出不是合法 JSON：${(error as Error).message}`
    throw new AnalyzeError('bad-output', reason, usage)
  }
  const validated = AnalysisOutputSchema.safeParse(parsed)
  if (!validated.success) {
    throw new AnalyzeError('bad-output', `输出未通过合同校验：${validated.error.issues[0]?.message ?? '未知字段问题'}`, usage)
  }
  return { outcome: validated.data, result }
}

/**
 * 解析一段摘要（最多两次尝试）。
 * @param deps - LLM 入口。
 * @param input - 摘要与预算。
 * @throws AnalyzeError 路由不可用、调用失败或两次尝试都没产出合法输出。
 */
export async function analyzeDigest(deps: AnalyzeDeps, input: AnalyzeInput): Promise<AnalyzeOutcome> {
  const route = deps.llm.route()
  if (route === undefined) {
    throw new AnalyzeError('no-route', '没有可用的模型路由（默认模型未配置或 provider 未注册），本轮跳过')
  }

  let inputTokens = 0
  let outputTokens = 0
  let attempts = 0
  let lastError: AnalyzeError | undefined

  for (let attemptIndex = 0; attemptIndex < 2; attemptIndex += 1) {
    attempts += 1
    try {
      const { outcome, result } = await attempt(deps, route, input, attemptIndex === 0 ? '' : CORRECTION)
      return {
        output: outcome,
        inputTokens: inputTokens + result.inputTokens,
        outputTokens: outputTokens + result.outputTokens,
        attempts: attemptIndex + 1,
      }
    } catch (error) {
      // 调用层的失败（网络/适配器/取消）也收敛成 AnalyzeError：run.ts 只需要一种失败形状。
      const mapped =
        error instanceof AnalyzeError
          ? error
          : new AnalyzeError('llm-failed', `模型调用失败：${error instanceof Error ? error.message : String(error)}`)
      // 流已经走完的失败（截断/坏 JSON）带着真实用量：花了的钱必须进账（P-051）。
      if (mapped.usage !== undefined) {
        inputTokens += mapped.usage.inputTokens
        outputTokens += mapped.usage.outputTokens
      }
      // 被外部取消不重试：取消是用户的决定，不是输出质量问题。
      if (input.signal?.aborted === true) throw withSpent(mapped, inputTokens, outputTokens, attempts)
      lastError = mapped
      if (mapped.code === 'llm-failed') break
    }
  }
  throw withSpent(lastError ?? new AnalyzeError('bad-output', '解析失败（未知原因）'), inputTokens, outputTokens, attempts)
}

/** 给最终抛出的错误盖上"总共花了多少"（失败不等于没花钱——账要跟着错误一起回去）。 */
function withSpent(error: AnalyzeError, inputTokens: number, outputTokens: number, attempts: number): AnalyzeError {
  error.spent = { inputTokens, outputTokens, calls: attempts }
  return error
}
