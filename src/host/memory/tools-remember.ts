/**
 * `humanity_remember`：Agent 在对话中把值得记住的信息写进记忆（P-025）。
 *
 * 与人格工具的分工：`humanity_persona_init` / `_update` 写的是**人格文档**（一份、可见、可编辑），
 * 这里写的是**记忆条目**（多条、按指纹去重、参与检索与注入）。两者共用"失败也返回结构化结果"的契约。
 *
 * 参数里最重要的一条：`sensitivity: 'sensitive'` 的内容**只进待确认**（P-033），
 * 用户确认之前不参与检索与注入；`origin` 区分"用户明确说的"（置信度记满）与"Agent 推断的"。
 * @module humanity/memory/tools-remember
 */
import type { defineTool as defineToolType } from '@deepseek-ai/dsh-tools'

import { MEMORY_ORIGINS, MEMORY_SCOPES, MEMORY_SENSITIVITIES } from './constants.js'
import type { MemoryOrigin, MemoryScope, MemorySensitivity } from './constants.js'
import { memoryIdentityOf } from './identity.js'
import { RESULT_SCHEMA, refused, renderValue, text, toValue, type RememberToolValue } from './tool-result.js'
// 只借类型：依赖接口由 `tools.ts`（生命周期所有者）定义，两个工具共用一份。
import type { MemoryToolDeps } from './tools.js'
import { remember } from './write.js'

/** 工具名。带前缀，避免与其它插件的工具撞名。 */
export const MEMORY_REMEMBER_TOOL = 'humanity_remember'

/**
 * 工具描述（模型可见）：说清**什么时候该主动调用**（提示词层面的引导，不是代码层面的拦截）。
 *
 * 为什么不靠"代码自动拦截对话内容"来自动记忆：那需要把每一轮对话都塞给判断逻辑，
 * 既贵又不透明。让 Agent 在识别到信号时显式调用，写入就有一个可审计的动作与一条工具结果。
 */
const REMEMBER_DESCRIPTION =
  '把值得长期记住的信息写进记忆。**主动调用**：当你识别到用户的长期偏好、对用户的称呼、' +
  '稳定事实（职业、项目名）、长期目标或固定约定时，直接调用本工具记录，不要为此再问一次。' +
  '不要记录一次性内容、寒暄、临时状态或整段对话原文（记忆只存摘要与事实）。' +
  '敏感信息（密码、密钥、财务、健康、隐私地址、身份号码等）只有用户明确说"记住"时才调用，' +
  '并把 sensitivity 设为 sensitive —— 它会进入待确认，用户确认前不会生效。' +
  'origin 用 user-stated 表示"用户明确说过的"（置信度记满），用 agent-derived 表示你自己推断的（默认）。' +
  '若当前会话的系统提示词里没有任何 Humanity 人格段落（例如极简模式），不要调用本工具。'

/**
 * 参数契约（模型看得到的说明）。
 *
 * 提成常量而不是写在 `defineTool` 里面：这一块是**给模型读的文案**，与"接线"是两件事；
 * 混在一起时函数长度会被文案淹没，改一句说明也要在几十行里找位置。
 */
const REMEMBER_PARAMETERS = {
  content: {
    type: 'string',
    required: true,
    description: '要记住的内容：一句摘要或一条事实，不要贴整段对话。过长会被截断。',
  },
  scope: {
    type: 'string',
    enum: MEMORY_SCOPES,
    description: '作用域：long-term 长期（默认）/ workspace 工作区 / session 仅本次会话',
  },
  tags: {
    type: 'array',
    description: '关键词标签（可选），用于之后的检索',
    items: { type: 'string', description: '一个关键词' },
  },
  sensitivity: {
    type: 'string',
    enum: MEMORY_SENSITIVITIES,
    description: 'normal 普通（默认）/ sensitive 敏感（进待确认，用户确认前不生效）',
  },
  origin: {
    type: 'string',
    enum: MEMORY_ORIGINS,
    description: 'user-stated 用户明确说过 / agent-derived 你自己推断（默认）',
  },
} as const

/**
 * 定义记忆写入工具。
 * @param defineTool - 官方工具定义助手（经 `loadOptional` 取得）。
 * @param deps - 存储与策略（每次调用时现取）。
 * @returns 可交给 `tools.register` 的工具定义。
 */
export function defineRememberTool(defineTool: typeof defineToolType, deps: MemoryToolDeps) {
  return defineTool({
    name: MEMORY_REMEMBER_TOOL,
    description: REMEMBER_DESCRIPTION,
    parameters: REMEMBER_PARAMETERS,
    output: {
      schema: RESULT_SCHEMA,
      render: (_args, value) => text(renderValue(value as RememberToolValue)),
    },
    async execute(args, exec): Promise<RememberToolValue> {
      const store = deps.store()
      if (store === undefined) return refused('记忆存储尚未就绪，本次没有写入；请稍后重试。')

      const caller = memoryIdentityOf((exec as { agent?: unknown }).agent)
      if (caller.sessionId === '') {
        return refused('读不到当前会话身份，无法记录来源，本次没有写入。')
      }

      const result = await remember(store, deps.policy(), {
        content: args.content,
        scope: (args.scope ?? 'long-term') as MemoryScope,
        tags: args.tags,
        sensitivity: (args.sensitivity ?? 'normal') as MemorySensitivity,
        origin: (args.origin ?? 'agent-derived') as MemoryOrigin,
        sessionId: caller.sessionId,
        workspaceId: caller.workspaceId,
      })
      // 真源（存储表）已经变了 ⇒ 让工作台的投影跟上，否则界面上看不到刚写进去的这条。
      if (result.ok) deps.changed?.()
      return toValue(result)
    },
  })
}
