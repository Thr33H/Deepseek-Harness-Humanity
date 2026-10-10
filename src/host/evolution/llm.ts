/**
 * 后台模型调用的 seam 封装：**路由解析 + 单次流式调用**。
 *
 * ### 对着 DSH 0.1.5-rc.2 核实过的事实（升级时按 DEV-PLAN §3 的行号重核）
 *
 * 1. `ctx.llm.stream(options)` 是官方公开的模型调用口（编译 `dsh-llm/lib/types/index.d.ts:406`）；
 *    第一方 `dsh-session-title-llm` 就用它做辅助调用（`createUserMessage` + `for await`，
 *    源码 `packages/session/session-title-llm/src/index.ts:255,281`）——本文件是同一模式的窄化。
 * 2. `GenerateOptions.purpose` 只接受 `'compaction' | 'session-title'`（源码 `types.ts:525`），
 *    自进化调用**留空不传**：伪造 purpose 会让重试/回放语义张冠李戴。
 * 3. 消息必须用 `createUserMessage` 造（内部赋 id 并冻结，编译 `dsh-llm/lib/index.js:37-53`）——
 *    手搓消息对象缺 id 会被适配器的校验拒掉。包本身经 `loadOptional` 载入（G-002：缺席降级不抛）。
 * 4. 路由来自 `ctx.agentDefaultModel.currentSelection()`（编译 `dsh-agent-default-model/.../index.d.ts:47`），
 *    并用 `llm.listProviders()` 核验 provider 已注册——没配模型的部署**不猜不乱选**（P-046 同一精神）。
 *
 * 所有服务都 `ctx.get` 现读不缓存（快照语义，服务后挂载也能用上），失败一律抛给 run.ts
 * 记进运行记录——这里不做"静默降级"，花了钱/没花钱必须留下明确痕迹（P-051）。
 * @module humanity/evolution/llm
 */
import type { Context } from '@deepseek-ai/cordis'

import { loadOptional } from '../optional.js'
import type { Log } from '../log.js'
import type { DefaultModelLike, LlmLike, ModelRoute, StreamChunkLike, StreamTextResult } from './types.js'

/** 插件在消息 `source` 里的署名（与第一方辅助调用同款字段）。 */
const PLUGIN_SOURCE = { kind: 'plugin', plugin: 'deepseek-harness-humanity' } as const

/** `@deepseek-ai/dsh-llm` 包里我们用到的唯一函数（结构声明，不固化它的类型面）。 */
interface LlmModuleLike {
  createUserMessage(input: { content: Array<{ type: string; text: string }>; source: unknown }): unknown
}

/** 一次调用的输入。 */
export interface StreamTextInput {
  route: ModelRoute
  /** 系统提示（解析规则在这，正文在 text）。 */
  system: string
  /** 用户消息正文（会话摘要）。 */
  text: string
  maxTokens: number
  /** 单次调用的墙钟上限（毫秒）。 */
  timeoutMs: number
  /** 外部取消（运行被停止时传入）。 */
  signal?: AbortSignal
}

/** 后台模型调用入口。 */
export interface LlmAccess {
  /**
   * 解析当前可用的调用路由；不可用（服务缺席/未配置/provider 未注册）返回 `undefined`。
   * 每次现读：用户改了默认模型，下一次运行就用新路由。
   */
  route(): ModelRoute | undefined
  /** 发起一次流式调用并收集完整结果；任何失败都抛（调用方负责记账）。 */
  streamText(input: StreamTextInput): Promise<StreamTextResult>
}

/**
 * 解析默认模型路由并核验 provider 已注册。
 * @param ctx - 插件上下文（只读查找，不声明依赖——`agents` 事故的同款纪律）。
 * @returns 路由；任何一环缺失返回 `undefined`。
 */
function resolveRoute(ctx: Context): ModelRoute | undefined {
  const defaults = ctx.get('agentDefaultModel') as DefaultModelLike | undefined
  const llm = ctx.get('llm') as LlmLike | undefined
  if (defaults === undefined || llm === undefined) return undefined
  try {
    const selection = defaults.currentSelection()
    if (typeof selection?.provider !== 'string' || selection.provider === '') return undefined
    if (typeof selection?.model !== 'string' || selection.model === '') return undefined
    // ⚠️ 路由键在 `LlmProviderInfo.id`（不是 `.provider`——那个字段不存在，
    // 2026-09-25 TEST 真机 modelReady 恒 false 的根因）。
    const known = llm.listProviders().some((entry) => entry.id === selection.provider)
    return known ? { provider: selection.provider, model: selection.model } : undefined
  } catch {
    // 选择/目录读取抛错与"没有配置"同等对待：降级不抛（读取路径可能在投影里）。
    return undefined
  }
}

/** 收流：累计正文、用量与结束原因（块形状见 types.ts 的 StreamChunkLike）。 */
async function collectStream(stream: AsyncIterable<StreamChunkLike>): Promise<StreamTextResult> {
  let text = ''
  let inputTokens = 0
  let outputTokens = 0
  let finishReason = ''
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') text += chunk.text ?? ''
    else if (chunk.type === 'usage' && chunk.usage !== undefined) {
      inputTokens = chunk.usage.inputTokens
      outputTokens = chunk.usage.outputTokens
    } else if (chunk.type === 'finish') finishReason = chunk.reason ?? ''
  }
  return { text, inputTokens, outputTokens, finishReason }
}

/**
 * 造后台模型调用入口。
 * @param ctx - 插件上下文。
 * @param log - 日志门面（只用于可选包载入失败的一次性告警）。
 */
export function createLlmAccess(ctx: Context, log: Log): LlmAccess {
  // 可选包只载一次（loadOptional 自带失败日志）；载入失败缓存 undefined，不反复重试。
  let modulePromise: Promise<LlmModuleLike | undefined> | undefined
  const loadModule = (): Promise<LlmModuleLike | undefined> => {
    modulePromise ??= loadOptional<LlmModuleLike>('@deepseek-ai/dsh-llm', log)
    return modulePromise
  }

  return {
    route: () => resolveRoute(ctx),
    streamText: async (input) => {
      const llm = ctx.get('llm') as LlmLike | undefined
      if (llm === undefined) throw new Error('LLM 服务不可用（ctx.llm 缺席）')
      const module = await loadModule()
      if (module === undefined) throw new Error('@deepseek-ai/dsh-llm 不可用，无法构造调用消息')

      const messages = [
        module.createUserMessage({ content: [{ type: 'text', text: input.text }], source: PLUGIN_SOURCE }),
      ]
      // 墙钟上限 + 外部取消合成一个信号（两者都是标准 API，三平台可用，G-006）。
      const deadline = AbortSignal.timeout(input.timeoutMs)
      const signal = input.signal === undefined ? deadline : AbortSignal.any([input.signal, deadline])
      return collectStream(
        llm.stream({
          provider: input.route.provider,
          model: input.route.model,
          messages,
          system: input.system,
          maxTokens: input.maxTokens,
          signal,
        }),
      )
    },
  }
}
