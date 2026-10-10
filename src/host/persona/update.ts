/**
 * `humanity_persona_update`：重新生成可变层的完整快照（P-017）。
 *
 * 唯一会"先问再写"的工具：这次快照若会删掉用户已有的内容，必须先在**当前对话**里确认。
 * 语义表（漏传 vs 传空）见工具描述与 `tool-helpers.ts` 的 `completeSections`。
 * @module humanity/persona/update
 */
import type { defineTool as defineToolType } from '@deepseek-ai/dsh-tools'

import { CONFIRMABLE_ISSUES, type ConfirmableIssueCode } from './constants.js'
import { isUntouchedIdentityCard } from './predicates.js'
import { PersonaWriteRejected, type PersonaSection } from './section.js'
import { OUTCOME_REASON, type ApprovalOutcome } from './tool-approval.js'
import { completeSections, NOT_INITIALIZED_REASON } from './tool-helpers.js'
import { RESULT_SCHEMA, refusal, renderValue, success, text, warningsOf, type PersonaToolValue } from './tool-result.js'
import type { MutableSection, PersonaDocument, PersonaIssue, UserDefinedEntry } from './types.js'

/** 可变层整理工具名。 */
export const PERSONA_UPDATE_TOOL = 'humanity_persona_update'

/**
 * 工具描述（模型可见）：把"漏传 vs 传空"讲清楚，免得模型靠猜 —— 真机反馈里这两个操作
 * 差别极大却都很隐晦，是当时最主要的误用来源。
 */
const UPDATE_DESCRIPTION =
  '更新人格可变层（意识与经验层）。参数是快照，语义如下（**漏传与传空是两件不同的事**）：' +
  '① 某个小标题**完全不传** = **不动它**（保留当前内容，不需要回传原值）；' +
  '② 传 `items: []` = **显式清空这一节**——这会删掉用户内容，本工具会在**当前对话**里弹确认框，' +
  '用户点确认后才落盘；用户拒绝、或当前环境没有确认入口时，一律不删；' +
  '③ 传了条目 = 用这份条目替换该节。' +
  '标准小标题（对用户称呼、说话风格、交付格式、行为边界、习惯与偏好、经验教训、情绪、未结修正）' +
  '+ 兜底层「用户定义」；不支持追加补丁（给的是每节的完整条目列表，不是增量）；' +
  '漏传的小标题原样保留，不会被清空。' +
  '固定层已封存，参数里没有它，也不会被本工具修改；「姓名 / 性别 / 人格偏好」等固定层字段名' +
  '**不得**作为小标题或「用户定义」的键（会被拒绝）。' +
  '改变对用户称呼是**普通改动**（一个人可以有多个称呼），直接写即可，不需要任何额外确认。' +
  '「用户定义」里同名键会被拒绝（不静默覆盖）；被取代的旧内容会进入历史，历史不参与人格注入。' +
  '若当前会话的系统提示词里没有任何 Humanity 人格段落（例如极简模式），不要调用本工具。'

/** 一次调用用到的外部能力：人格读写入口 + 在当前对话里请求确认。 */
export interface UpdateContext {
  persona: PersonaSection
  confirm: (exec: ToolExec, reason: string) => Promise<ApprovalOutcome>
}

/** 工具执行上下文里我们真正用到的两个字段（审批要问对人和对话）。 */
export interface ToolExec {
  agent?: unknown
  callId?: string
}

/**
 * 参数契约（模型看得到的说明）。
 *
 * 提成常量而不是写在 `defineTool` 里面：这一块是**给模型读的文案**，与"接线"是两件事；
 * 混在一起时函数长度会被文案淹没，改一句说明也要在几十行里找位置。
 */
const UPDATE_PARAMETERS = {
  sections: {
    type: 'array',
    required: true,
    description:
      '这次要改的小标题（**不是**完整快照）。只写需要改的小标题；没传的 = 不动它、保留当前内容。' +
      '要清空某一节就显式传 items: []（会删内容，工具会在对话里确认）。条目是完整快照，不是追加。',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', required: true, description: '小标题；能归类的请用标准小标题' },
        items: {
          type: 'array',
          required: true,
          description: '该项的短文本条目（完整快照，不是追加）',
          items: { type: 'string' },
        },
      },
    },
  },
  userDefined: {
    type: 'array',
    required: true,
    description: '兜底层「用户定义」的完整键值对列表；能归类进标准小标题的项不要留在这里，没有就传空数组。',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        key: { type: 'string', required: true },
        value: { type: 'string', required: true },
      },
    },
  },
} as const

/**
 * 定义可变层整理工具。
 * @param defineTool - 官方工具定义助手（经 `loadOptional` 取得）。
 * @param context - 人格读写入口与确认回调。
 * @returns 可交给 `tools.register` 的工具定义。
 */
export function defineUpdateTool(defineTool: typeof defineToolType, context: UpdateContext) {
  return defineTool({
    name: PERSONA_UPDATE_TOOL,
    description: UPDATE_DESCRIPTION,
    parameters: UPDATE_PARAMETERS,
    output: {
      schema: RESULT_SCHEMA,
      render: (_args, value) => text(renderValue(value as PersonaToolValue)),
    },
    execute(args, exec): Promise<PersonaToolValue> {
      return update(context, args.sections, args.userDefined, exec)
    },
  })
}

/**
 * 一次调用：先整理快照，再写；被拒且**全部**是"会丢内容"这类可确认项时，问一次再写。
 * @param context - 人格读写入口与确认回调。
 * @param rawSections - 模型给的要改的小标题（可只给一部分）。
 * @param rawUserDefined - 模型给的兜底层完整快照。
 * @returns 工具结果。
 */
async function update(
  context: UpdateContext,
  rawSections: readonly MutableSection[],
  rawUserDefined: readonly UserDefinedEntry[],
  exec: ToolExec,
): Promise<PersonaToolValue> {
  const { persona } = context
  const current = persona.read()
  if (isUntouchedIdentityCard(current.identityCard)) {
    return refusal('update', current, NOT_INITIALIZED_REASON)
  }

  const next: PersonaDocument = {
    ...current,
    // 固定层**原样带回**：不是"我们保证不改"，而是这里根本没有改它的入口。
    identityCard: current.identityCard,
    mutableLayer: {
      sections: completeSections(rawSections, current),
      userDefined: rawUserDefined.map((entry) => ({ key: entry.key, value: entry.value })),
    },
  }

  try {
    await persona.write(next, 'agent')
  } catch (error) {
    if (!(error instanceof PersonaWriteRejected)) throw error
    return confirmThenWrite(context, exec, next, current, error.issues)
  }

  const written = persona.read()
  return success('update', written, '可变层已重新生成完整快照。', warningsOf(written))
}

/**
 * 被拒之后：只有"会删用户内容"这一类可确认项才去问，其余直接返回拒绝。
 *
 * 为什么要比对"全部 rejected 都是可确认项"：混着结构错误时先让 Agent 把文档改对，
 * 否则用户点完确认仍然写不进去 —— 那是一次无意义的打扰。
 */
async function confirmThenWrite(
  context: UpdateContext,
  exec: ToolExec,
  next: PersonaDocument,
  current: PersonaDocument,
  issues: readonly PersonaIssue[],
): Promise<PersonaToolValue> {
  const rejected = issues.filter((issue) => issue.severity === 'rejected')
  const confirmable = rejected.filter((issue): issue is PersonaIssue & { code: ConfirmableIssueCode } =>
    (CONFIRMABLE_ISSUES as readonly string[]).includes(issue.code),
  )
  if (confirmable.length === 0 || confirmable.length !== rejected.length) {
    return refusal('update', current, '可变层校验未通过，没有写入。', issues)
  }

  const outcome = await context.confirm(
    exec,
    `这次整理会删掉用户已有的内容：${confirmable.map((issue) => issue.path).join('、')}。是否继续？`,
  )
  if (outcome !== 'allowed-once') return refusal('update', current, OUTCOME_REASON[outcome], issues)

  try {
    await context.persona.write(next, 'agent', { confirmed: confirmable.map((issue) => issue.code) })
  } catch (retry) {
    if (retry instanceof PersonaWriteRejected) {
      // 已确认却仍被拒：说明还有别的 rejected 项（理论上不会走到，上面已比对过）。
      return refusal('update', current, '可变层校验未通过，没有写入。', retry.issues)
    }
    throw retry
  }

  const written = context.persona.read()
  return success('update', written, '已按用户在对话里的确认，删除了那一节的内容。', warningsOf(written))
}
