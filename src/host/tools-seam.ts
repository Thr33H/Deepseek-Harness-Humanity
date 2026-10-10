/**
 * 接入 DSH 的 **Agent 工具 seam**（`ctx.inject(['tools'], …)` + 动态取 `defineTool`）。
 *
 * 为什么单独一个文件：人格与记忆都要注册工具，而这段接线的两个坑都是踩过的 ——
 * 1. 包缺席时必须只关掉"Agent 工具"这一项，不能拖垮整个插件（G-002 零硬依赖）：
 *    `defineTool` 走 `loadOptional` 动态取，不在模块顶层 import；
 * 2. 服务摘除时要先取消这次注册、再清句柄：否则注册物会继续指向一个已经死了的服务。
 *
 * @module humanity/tools-seam
 */
import type { Context } from '@deepseek-ai/cordis'
// 只借类型：`ctx.tools` 的类型合并由这个包提供；运行期的 `defineTool` 走 `loadOptional`（G-002）。
import type { defineTool as defineToolType, ToolRuntime } from '@deepseek-ai/dsh-tools'

import type { Log } from './log.js'
import { loadOptional } from './optional.js'

/** `defineTool` 的模块形状；用于 `loadOptional` 的结构化声明。 */
interface DefineToolModule {
  defineTool: typeof defineToolType
}

/** 已就位的工具服务（我们只用注册与 guard）。 */
export type ToolsApi = Pick<ToolRuntime, 'register' | 'guard'>

/**
 * 接入工具 seam。
 * @param ctx - 本插件的上下文。
 * @param log - 日志门面。
 * @param onReady - 服务与 `defineTool` 都拿到时的回调。
 * @param onGone - 服务摘除时的回调（由调用方负责把已注册的东西卸掉）。
 */
export function installToolsSeam(
  ctx: Context,
  log: Log,
  onReady: (tools: ToolsApi, defineTool: typeof defineToolType) => void,
  onGone: () => void,
): void {
  ctx.inject(['tools'], (sctx) => {
    let disposed = false

    void (async () => {
      const module = await loadOptional<DefineToolModule>('@deepseek-ai/dsh-tools', log)
      if (module === undefined || disposed) return
      onReady(sctx.tools, module.defineTool)
    })()

    return () => {
      disposed = true
      onGone()
    }
  })
}
