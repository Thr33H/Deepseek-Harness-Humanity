/**
 * `humanity_recall`：Agent 主动检索记忆的深层入口（P-028"深层记忆走 recall 工具"）。
 *
 * 与自动注入的分工（同一套检索引擎、两套参数）：
 *
 * | | 自动注入（步骤 5） | recall 工具（本文件） |
 * |---|---|---|
 * | 触发 | 每轮自动 | Agent 主动调用 |
 * | 条数 | 0–3（策略 `injectLimit`） | 默认 5、最多 10 |
 * | 深度 | 浅：阈值 0.35，宁缺毋滥 | 深：阈值 0.15，宁可多给几条 |
 * | 用途 | 被动上下文补充 | 主动查找特定信息 |
 *
 * 参数里的 `scope` 与写入工具用**同一套取值**（`long-term` / `workspace` / `session`）：
 * 两个工具让模型学两套词汇，只会换来一次"猜参数"的机会。
 * @module humanity/memory/tools-recall
 */
import type { defineTool as defineToolType } from '@deepseek-ai/dsh-tools'

import { MEMORY_SCOPES } from './constants.js'
import type { MemoryScope } from './constants.js'
import { memoryIdentityOf } from './identity.js'
import { searchMemory } from './search.js'
import {
  RECALL_RESULT_SCHEMA,
  renderRecallValue,
  toRecallValue,
  type RecallToolValue,
} from './tool-result-recall.js'
// 纯文本内容块助手：与写入工具共用同一份（`tool-result.ts` 的 `text`）。
import { text } from './tool-result.js'
// 只借类型：依赖接口由 `tools.ts`（生命周期所有者）定义，两个工具共用一份。
import type { MemoryToolDeps } from './tools.js'

/** 工具名。带前缀，避免与其它插件的工具撞名。 */
export const MEMORY_RECALL_TOOL = 'humanity_recall'

/**
 * `humanity_recall` 的默认条数与硬上限（P-028：深层记忆走 recall 工具）。
 *
 * 比自动注入的 0–3 条多，是因为**发起者不同**：自动注入是"不请自来"，多了就是噪音；
 * recall 是 Agent 为了回答某个具体问题主动去找，少了它就得反复调用。
 */
export const RECALL_DEFAULT_LIMIT = 5

/** recall 的条数硬上限（工具参数只能调小，调不大）。 */
export const RECALL_MAX_LIMIT = 10

/**
 * recall 的相关度阈值：明显低于自动注入的 {@link RELEVANCE_THRESHOLD}。
 *
 * 这就是"浅层 / 深层"的差别：自动注入宁缺毋滥（宁可一条不给，也不塞不相关的）；
 * recall 有明确的查询意图，宁可多给几条让 Agent 自己判断。
 *
 * 注意它**必须与"有交集"的门（`matchesQuery`）配合**：总分里质量信号的底噪就有 ≈0.21，
 * 单靠 0.15 这个阈值，任何活跃记忆都会过线。
 */
export const RECALL_RELEVANCE_THRESHOLD = 0.15

/**
 * 工具描述（模型可见）。
 *
 * 重点说清"什么时候该主动调用"：自动注入只带 0–3 条浅层记忆，**不等于库里已经有**，
 * 问到细节、旧事或"我之前说过"这类问题时必须自己来查。同时说明它查不到什么
 * （归档记忆不在默认检索里）。
 *
 * 2026-09-25 真机事故回归（第二只，round 51）：本描述原先写的是
 * 「当用户提到…**而当前上下文里没有时**」才调用 —— 但自动注入块**永远存在**，
 * 于是条件恒不成立，模型永不调用；真机形态是用户在扮演里问「山里教堂那个嬷嬷姓什么」，
 * 模型演了一段"闭眼翻找"的动作并声称查不到，全程 0 次 tool/call（会话取证 turn3）。
 * 同轮只改了 `MEMORY_GUIDANCE` 的引导语，**漏改了这里**，两者互相矛盾。
 * 故：条件必须去掉，并显式禁止"用叙述性动作代替真正的检索"。
 */
export const RECALL_DESCRIPTION =
  '检索记忆库：按关键词查找用户此前说过、或你此前记下的信息。' +
  '凡是要回忆、核对或查证过去的设定、约定、人物与细节，**先调用本工具检索再回答**；' +
  '包括用户直接要求"你查查/查一下"，也包括扮演剧情里被问起旧事。' +
  '自动注入的记忆块只是少数线索，不等于库里已经有，不能拿它当全部。' +
  '不要凭印象编造，也不要用"翻找了一下"这类叙述性动作代替真正的检索。' +
  'query 用自然语言关键词即可（本地匹配，不需要写成搜索语法）；' +
  'scope 可以只看某一层（长期/工作区/会话）；limit 默认 5、最多 10。' +
  '已归档的记忆不在检索范围内。没找到就如实告诉用户，不要脑补。' +
  '若当前会话的系统提示词里没有任何 Humanity 人格段落（例如极简模式），不要调用本工具。'

/** 参数契约（模型看得到的说明）。 */
const RECALL_PARAMETERS = {
  query: {
    type: 'string',
    required: true,
    description: '要查的关键词或短语（自然语言即可）。',
  },
  scope: {
    type: 'string',
    enum: MEMORY_SCOPES,
    description: '只看这一层：long-term 长期 / workspace 工作区 / session 本次会话；不传则全部已知层',
  },
  limit: {
    type: 'number',
    description: `返回条数上限，默认 ${RECALL_DEFAULT_LIMIT}、最多 ${RECALL_MAX_LIMIT}`,
  },
} as const

/**
 * 把模型给的 limit 夹到允许范围。
 *
 * 缺省 = 默认条数；非法值（NaN/小数/越界）一律夹住而不是报错：条数是个提示，
 * 为它让整次检索失败，代价远大于收益。
 * @param raw - 模型给的条数。
 * @returns 生效条数。
 */
function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return RECALL_DEFAULT_LIMIT
  return Math.min(RECALL_MAX_LIMIT, Math.max(1, Math.trunc(raw)))
}

/**
 * 定义记忆检索工具。
 * @param defineTool - 官方工具定义助手（经 `loadOptional` 取得）。
 * @param deps - 存储与策略（每次调用时现取）。
 * @returns 可交给 `tools.register` 的工具定义。
 */
export function defineRecallTool(defineTool: typeof defineToolType, deps: MemoryToolDeps) {
  return defineTool({
    name: MEMORY_RECALL_TOOL,
    description: RECALL_DESCRIPTION,
    parameters: RECALL_PARAMETERS,
    output: {
      schema: RECALL_RESULT_SCHEMA,
      // 结构化结果之外再给一段可读文本：模型按文本决策，工作台按结构化字段展示。
      render: (_args, value) => text(renderRecallValue(value as RecallToolValue)),
    },
    async execute(args, exec): Promise<RecallToolValue> {
      const store = deps.store()
      if (store === undefined) {
        return toRecallValue([], new Date().toISOString(), '记忆存储尚未就绪，暂时查不了。', false)
      }

      const policy = deps.policy()
      const scope = args.scope as MemoryScope | undefined
      if (scope !== undefined && !policy.scopes[scope]) {
        return toRecallValue([], new Date().toISOString(), '这一层记忆已在当前策略里关闭。', false)
      }

      const identity = memoryIdentityOf((exec as { agent?: unknown }).agent)
      const hits = await searchMemory(
        store,
        policy,
        { message: args.query, sessionId: identity.sessionId, workspaceId: identity.workspaceId },
        { scope, limit: clampLimit(args.limit), threshold: RECALL_RELEVANCE_THRESHOLD },
      )
      return toRecallValue(hits, new Date().toISOString())
    },
  })
}
