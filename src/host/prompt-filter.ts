/**
 * 提示词过滤：把**工具使用说明**那批段（`tool:*`）从组装结果里去掉。
 *
 * ### 它们是什么
 * `dsh-tool-fs` / `dsh-tool-fs-search` / `dsh-tool-web` 这些插件在注册工具的同时，
 * 顺手注册一段英文说明（`tool:read` / `tool:glob` / `tool:grep` / `tool:web_search` /
 * `tool:web_fetch`）。它们没有单独的开关：`read?: boolean` 是"工具 + 说明"的联动开关，
 * 想只关说明是不可能的。
 *
 * ### 为什么用瀑布
 * `system-prompt/assemble` 是 DSH 明文的组装瀑布（`dsh-system-prompt` 的 `@mode waterfall`），
 * 段在交给下游之前可以被改写。这是"官方接缝"，不是劫持内部方法 —— 后者（`defineProperty`
 * 包 `assemble`）一升级就崩，本项目明令禁止。
 *
 * ### 为什么是全局而不是按预设
 * 瀑布的上下文只有 `scope: ScopeKey`，没有 agent，也就拿不到"这个会话用的是哪个预设"。
 * 因此这里对**所有**预设生效。代价：功能预设也看不到那几句操作提示；工具 schema 自带
 * 的 description 仍在，所以"怎么调用"不是无据可依。
 * @module humanity/prompt-filter
 */
import type { Context } from '@deepseek-ai/cordis'

import type { Log } from './log.js'

/** 只声明用到的那一小片（不固化官方类型面）。 */
interface PromptSectionLike {
  name: string
  text: string
}
interface AssemblyLike {
  sections: PromptSectionLike[]
}
type Waterfall = (
  assembly: AssemblyLike,
  context: unknown,
  next: () => Promise<unknown>,
) => Promise<unknown>

/** 被丢掉的段名前缀：工具使用说明全部是 `tool:<名字>`。 */
const DROPPED_PREFIX = 'tool:'

/**
 * 装上过滤。
 * @param ctx - 宿主的 cordis 上下文。
 * @param log - 日志门面（用于一次性汇报丢了几段，便于升级后核对）。
 */
export function installPromptFilter(ctx: Context, log: Log): void {
  const on = ctx.on as unknown as (
    event: string,
    listener: Waterfall,
  ) => () => void

  let reported = false
  const off = on('system-prompt/assemble', async (assembly, _context, next) => {
    const before = assembly.sections.length
    if (before > 0) {
      assembly.sections = assembly.sections.filter((section) => !section.name.startsWith(DROPPED_PREFIX))
    }
    if (!reported && before !== assembly.sections.length) {
      reported = true
      log.info(`提示词过滤：已去掉 ${before - assembly.sections.length} 段工具使用说明（${DROPPED_PREFIX}*）`)
    }
    return next()
  })

  ctx.effect(() => off, 'humanity: 提示词过滤卸载')
}
