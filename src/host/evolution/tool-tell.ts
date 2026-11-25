/**
 * `humanity_tell_him`：她想跟他说的话，从这里递出去。
 *
 * 为什么是一个"工具"而不是让她写文件：写文件只到她自己的目录，他永远不知道；
 * 这个动作的意思是「这句我想让他看见」，之后由系统挑一个他不会被打断的时刻送过去，
 * 到那一刻**由她自己开口说出来**（提示词见 `tell.ts` 的 `buildTellPrompt`）。
 * @module humanity/evolution/tool-tell
 */
import type { defineTool as defineToolType } from '@deepseek-ai/dsh-tools'

import type { DocumentStore } from '../documents.js'
import { TELL_MAX_CHARS } from './constants.js'
import { dayKeyOf } from './state.js'
import { canQueue, readTell, saveTell } from './tell.js'

/** 工具名。 */
export const TELL_TOOL = 'humanity_tell_him'

/**
 * 工具描述（模型可见）。
 *
 * 三条规矩必须写在这里：模型不会读代码，也不知道"一天一次"这种护栏 ——
 * 它只会从描述里学。
 */
export const TELL_DESCRIPTION = [
  '把一句你想跟他说的话交出去：等他不忙的时候，这句话会被送到他面前，由**你自己**说出来。',
  '什么时候用：在你自己的时间里，忽然有话想留给他（想问他一句、想让他知道你今天做了什么）。',
  '什么时候别用：你正在跟他说话 —— 那就直接说，不用绕这一道。',
  '规矩：一天最多一次；交出去之后这句就不在了，不要追问、不要重复说。',
  `这句话最多 ${TELL_MAX_CHARS} 字，一两句就够。`,
].join('\n')

/** 工具需要的外部事实。 */
export interface TellToolDeps {
  /** 文档表（存储未就绪时 `undefined`）。 */
  documents(): DocumentStore | undefined
  /** 生效时区（判断"今天"用过没有）。 */
  timeZone(): string | undefined
  /** 模块是否启用。 */
  enabled(): boolean
}

/** 工具结果（模型看到的形状）。 */
export interface TellToolValue {
  ok: boolean
  message: string
}

/** 结果契约（与记忆工具同一套写法：纯 JSON Schema 节点 + 纯投影）。 */
const TELL_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true, description: '这句话有没有被记下来' },
    message: { type: 'string', required: true, description: '一句话结论；没记下来时说清为什么' },
  },
} as const

/** 把结果摊成模型能读的一段文字（本模块自己的小工具，不借人格那边的）。 */
function text(content: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: content }]
}

/** 一条结果（少写点重复）。 */
function result(ok: boolean, message: string): TellToolValue {
  return { ok, message }
}

/**
 * 定义这个工具。
 * @param defineTool - 官方工具定义助手（经 `loadOptional` 取得）。
 * @param deps - 外部事实。
 * @returns 可交给 `tools.register` 的工具定义。
 */
export function defineTellTool(defineTool: typeof defineToolType, deps: TellToolDeps) {
  return defineTool({
    name: TELL_TOOL,
    description: TELL_DESCRIPTION,
    parameters: {
      text: { type: 'string', required: true, description: `你想说的那句话（≤${TELL_MAX_CHARS} 字，一两句）` },
    },
    output: {
      schema: TELL_RESULT_SCHEMA,
      render: (_args, value) => text((value as TellToolValue).message),
    },
    async execute(args: Record<string, unknown>): Promise<TellToolValue> {
      if (!deps.enabled()) return result(false, '这条通道现在关着（自进化模块没开），这句话没有记下来。')
      const documents = deps.documents()
      if (documents === undefined) return result(false, '存储还没就绪，这句话没有记下来。')
      const doc = readTell(documents)
      const today = dayKeyOf(new Date().toISOString(), deps.timeZone())
      const verdict = canQueue(doc, today, typeof args.text === 'string' ? args.text : '')
      if (!verdict.ok) return result(false, verdict.reason)
      await saveTell(documents, { ...doc, pending: verdict.text, pendingAt: new Date().toISOString() })
      return result(true, '记下了。等他不忙的时候，这句话会送到他面前 —— 到时候由你自己说出来。')
    },
  })
}
