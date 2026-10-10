/**
 * 记忆 Agent 工具的**生命周期**：何时注册、何时卸载（业务在 `tools-remember.ts`）。
 *
 * 与人格工具同构，但**没有 guard**：人格需要"封存后不许 Agent 改固定层"这类结构上的越权拦截，
 * 记忆没有对应的越权概念 —— 它唯一的硬约束（敏感内容只进待确认）在写入管线里实现，
 * 不是在工具边界上再拦一道。少一层防御就少一处会自己出错的地方。
 * @module humanity/memory/tools
 */
import type { Context } from '@deepseek-ai/cordis'
// 只借类型：运行期由 `tools-seam` 经 loadOptional 取（G-002）。
import type { defineTool as defineToolType } from '@deepseek-ai/dsh-tools'

import type { Log } from '../log.js'
import { installToolsSeam, type ToolsApi } from '../tools-seam.js'
import type { MemoryStore } from './store.js'
import { defineRecallTool, MEMORY_RECALL_TOOL } from './tools-recall.js'
import { defineRememberTool, MEMORY_REMEMBER_TOOL } from './tools-remember.js'
import type { MemoryPolicy } from './types.js'

/** 工具运行期需要的外部事实（存储与策略都由调用方现取，避免把死句柄闭进工具）。 */
export interface MemoryToolDeps {
  store(): MemoryStore | undefined
  policy(): MemoryPolicy
  /**
   * 一次写入成功后的通知（工作台据此重新投影）。
   *
   * 为什么工具要管这件事：工作台读的是 `humanity-memory` 命名空间的投影，而真源是存储表。
   * `humanity_remember` 直接写表，不经过命令槽；没有这个通知，工作台就会停在旧列表上
   * （真机症状：存储里已有记忆，`entries` 仍是 `[]`）。缺失时静默跳过（测试与只读组合）。
   */
  changed?(): void
}

/** 工具定义助手与工具服务；两者都拿到才谈得上注册。 */
interface ToolsApiLoaded {
  tools: ToolsApi
  defineTool: typeof defineToolType
}

/** 卸载动作。与 cordis `ctx.effect` 的返回值同形。 */
type Disposer = () => void

/** 记忆工具句柄。`setEnabled` 与 `dispose` 都是幂等的（配置每次变化都会调用一次）。 */
export interface MemoryToolsHandle {
  setEnabled(enabled: boolean): void
  dispose(): void
}

/** 注册状态：开关、已加载的工具入口、以及当前那次注册的卸载动作。 */
interface ToolsState {
  enabled: boolean
  api?: ToolsApiLoaded
  registered?: Disposer
}

/**
 * 让"开关状态"与"已注册状态"收敛到同一个目标上（幂等，可反复调用）。
 * @param state - 当前注册状态。
 * @param log - 日志门面。
 * @param deps - 工具运行期依赖。
 */
function sync(state: ToolsState, log: Log, deps: MemoryToolDeps): void {
  const api = state.api
  const want = state.enabled && api !== undefined
  if (want && state.registered === undefined) {
    const definitions = [defineRememberTool, defineRecallTool].map((define) => api.tools.register(define(api.defineTool, deps)))
    state.registered = () => {
      for (const dispose of definitions.splice(0)) dispose()
    }
    log.info(`记忆 Agent 工具已注册（${MEMORY_REMEMBER_TOOL} / ${MEMORY_RECALL_TOOL}）`)
    return
  }
  if (!want && state.registered !== undefined) {
    state.registered()
    state.registered = undefined
    log.info('记忆 Agent 工具已卸载')
  }
}

/**
 * 安装记忆的 Agent 工具。
 * @param ctx - 本插件的上下文（同时是注册的 owner fiber）。
 * @param log - 日志门面。
 * @param deps - 存储与策略（由工具在每次调用时现取，避免把死句柄闭进工具）。
 * @returns 带开关把手的句柄；调用方负责在配置变更与卸载时驱动它。
 */
export function installMemoryTools(ctx: Context, log: Log, deps: MemoryToolDeps): MemoryToolsHandle {
  const state: ToolsState = { enabled: true }

  installToolsSeam(
    ctx,
    log,
    (tools, defineTool) => {
      state.api = { tools, defineTool }
      sync(state, log, deps)
    },
    () => {
      state.api = undefined
      state.registered?.()
      state.registered = undefined
    },
  )

  return {
    setEnabled(next) {
      state.enabled = next
      sync(state, log, deps)
    },
    dispose() {
      state.enabled = false
      sync(state, log, deps)
    },
  }
}

