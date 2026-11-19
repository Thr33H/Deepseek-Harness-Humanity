/**
 * 净室预设排除 guard：极简（净室）会话里 Humanity 的四个工具一律拒绝执行。
 *
 * 为什么需要（2026-09-25 真机取证）：complete 只吞提示词、不吞工具目录，而我们的工具注册在
 * root scope（全局可见）——极简净室因此能调用 Humanity 工具，甚至照工具描述模仿引导流程。
 * 净室的语义是「不携带 Humanity」：prompt 层由平台 complete 保证，工具层由本 guard 保证。
 *
 * 为什么用 guard 而不是按作用域注册：按 preset 作用域注册工具需要 agent 生命周期接线
 * （agent 创建时注册、销毁时清理），复杂度高且引入新的时序面；guard 是工具管线的**同步**
 * 单 choke point，判据只读两个同步真源：会话投影 `agentPreset`（含切换后的值）与
 * 会话头 meta（创建时的值，投影缺席时的回退）。
 *
 * 拒绝而不是隐藏目录：模型仍会看见工具（描述里已有净室自约句劝退），但调用会被干净拒绝；
 * 彻底隐藏目录留待按作用域注册的下一次迭代。
 * @module humanity/exclusion-guard
 */
import type { Context } from '@deepseek-ai/cordis'

import { presetOfAgent } from './agent-scope.js'
import type { Log } from './log.js'
import { MEMORY_RECALL_TOOL } from './memory/tools-recall.js'
import { MEMORY_REMEMBER_TOOL } from './memory/tools-remember.js'
import { PERSONA_INIT_TOOL } from './persona/init.js'
import { PERSONA_UPDATE_TOOL } from './persona/update.js'

/** Humanity 全部模型可见工具；排除判定只对它们生效，其它工具一律放行。 */
const HUMANITY_TOOLS = new Set<string>([
  PERSONA_INIT_TOOL,
  PERSONA_UPDATE_TOOL,
  MEMORY_REMEMBER_TOOL,
  MEMORY_RECALL_TOOL,
])

/**
 * 净室预设清单：这些预设的会话不携带 Humanity（平台设计语义：固定提示词、最小工具面）。
 * 平台将来若新增同类净室预设，加在这里；丰富预设（标准等）不加，Humanity 对它们默认可用。
 */
const CLEAN_ROOM_PRESETS = new Set<string>(['minimal'])

/** 净室拒绝文案：说清「为什么」与「怎么办」，不把对方指向任何页面。 */
export const CLEAN_ROOM_REASON =
  '当前会话运行在极简（净室）预设下：按该预设的设计语义，Humanity 的人格与记忆能力不启用。' +
  '如需携带人格与记忆，请改用标准模式会话。'

/** 本 guard 看得到的执行形状：工具名与 agent（agent loop 设置），其余一律不碰。 */
interface ExecutionLike {
  name: string
  agent?: unknown
}

/**
 * 挂上净室排除 guard；工具服务或投影服务缺席时安静跳过（G-002）。
 * @param ctx - 本插件的上下文。
 * @param log - 日志门面。
 */
export function installExclusionGuard(ctx: Context, log: Log): void {
  // 只硬接 tools：投影服务缺席时 guard 仍要工作（回退会话头 meta），不能因它整条不挂（G-002）。
  ctx.inject(['tools'], (tctx) => {
    const dispose = tctx.tools.guard((execution: ExecutionLike) => {
      if (!HUMANITY_TOOLS.has(execution.name)) return undefined
      const preset = presetOfAgent(execution.agent, ctx)
      return preset !== undefined && CLEAN_ROOM_PRESETS.has(preset) ? CLEAN_ROOM_REASON : undefined
    })
    log.info('净室排除 guard 已注册（极简会话拒绝 Humanity 工具）')
    return dispose
  })
}
