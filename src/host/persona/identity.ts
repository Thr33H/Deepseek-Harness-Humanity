/**
 * `humanity_persona_identity`：**封存之后**修正底色的唯一通道。
 *
 * ### 它解决什么
 * 底色封存后 agent 改不了，原来的唯一出口是「自进化提案 → 对方去工作台批准」。于是出现这种场面：
 * 它在对话里发现名字记错了，只能说"你去 Humanity 工作台改一下" —— 一句话把陪伴打断成运维。
 *
 * 现在：先**在当前对话里问一句**，对方点头才写。封存的语义没有松动 —— 仍然是"只有对方能改"，
 * 只是确认入口从工作台挪到了对话里。
 *
 * ### 为什么单独一个工具，不并进 `humanity_persona_update`
 * update 的契约是"信息层快照"，它的描述明确写着"底色不在这里"。把底色改动的入口塞进去，
 * 模型会在整理信息时顺手改身份 —— 那正是封存要防的事。两个工具、两条风险等级，分开更安全。
 *
 * ### 安全边界（每条都有对应的测试）
 * - **先问再写**：`identity.sealed` 是唯一的可确认项；没有审批入口时**一律不写**（fail-closed）。
 * - **只改点名的那几个键**：不重传整张卡，避免"漏传 = 删除"这类事故。
 * - **不能删核心字段**：`remove` 只接受自定义字段（`custom: true`）；核心四项删不掉。
 * - **其它校验问题不确认**：只要还有别的 rejected（重复键、空键名…），直接拒绝并让模型改对。
 * @module humanity/persona/identity
 */
import type { defineTool as defineToolType } from '@deepseek-ai/dsh-tools'

import { CORE_IDENTITY_KEYS } from './constants.js'
import { isUntouchedIdentityCard } from './predicates.js'
import { IDENTITY_NAME_LIMIT } from './render-content.js'
import { PersonaWriteRejected, type PersonaSection } from './section.js'
import { OUTCOME_REASON, type ApprovalOutcome } from './tool-approval.js'
import { NOT_INITIALIZED_REASON } from './tool-helpers.js'
import { RESULT_SCHEMA, refusal, renderValue, success, text, warningsOf, type PersonaToolValue } from './tool-result.js'
import type { PersonaDocument, PersonaIssue } from './types.js'

/** 底色修正工具名。 */
export const PERSONA_IDENTITY_TOOL = 'humanity_persona_identity'

/** 唯一被允许在"对方点头"之后放行的拒绝代码（见 `constants.ts` 的白名单）。 */
const SEALED_ISSUE = 'identity.sealed'

/**
 * 工具描述（模型可见）。
 *
 * 措辞纪律：只描述"什么时候用、会发生什么"，不鼓励频繁调用 —— 底色是慢变的，
 * 每次改都会打断对话去问对方。
 */
export const IDENTITY_DESCRIPTION =
  '修正已封存的人格底色（你是谁：姓名 / 性别 / 人格偏好 / 主语言，以及对方自己加的字段）。' +
  '**只在对方明确说出或纠正了底色事实时**使用；不要自己推断、不要为了"更符合设定"而改。' +
  '调用后会在**当前对话**里弹一次确认框：对方点确认才写入，拒绝或没有确认入口时一律不写。' +
  '参数只给要改的那几个键（不是整张卡）：set 逐项改/加，remove 只删**自定义**字段（核心四项删不掉）。' +
  // ⚠️ 这条是 2026-11-17 真机补的：模型把"旧名已更换"这类说明也塞进了姓名（35 字），
  // 于是标题退回「## 你是谁」，而且姓名变成了备忘录。姓名是**一个名字**，不是备注框。
  `「姓名」只写名字本身（不超过 ${IDENTITY_NAME_LIMIT} 字，否则标题用不上它）；` +
  '来龙去脉（旧名、出处、谁起的）写进记忆或「自定义」字段，不要塞进姓名的值里。' +
  '没提到变化时不要调用。' +
  '若当前会话的系统提示词里没有任何 Humanity 人格段落（例如极简模式），不要调用本工具。'

/** 一次调用用到的外部能力：人格读写入口 + 在当前对话里请求确认。 */
export interface IdentityContext {
  persona: PersonaSection
  confirm: (exec: IdentityExec, reason: string) => Promise<ApprovalOutcome>
}

/** 工具执行上下文里我们真正用到的两个字段（审批要问对人和对话）。 */
export interface IdentityExec {
  agent?: unknown
  callId?: string
}

/** 参数契约（模型看得到的说明）。 */
const IDENTITY_PARAMETERS = {
  set: {
    type: 'array',
    required: true,
    description: '要改或要加的底色字段（**只给这几个**，不是整张卡）。键已存在则更新，不存在则新增为自定义字段。',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        key: { type: 'string', required: true, description: '字段名，例如「姓名」「人格偏好」' },
        value: { type: 'string', required: true, description: '新的值（短文本）' },
      },
    },
  },
  remove: {
    type: 'array',
    description: '要删掉的**自定义**字段名（核心四项：姓名 / 性别 / 人格偏好 / 主语言，删不掉）。没有就传空数组。',
    items: { type: 'string' },
  },
} as const

/** 工具参数。 */
interface IdentityArgs {
  set: Array<{ key: string; value: string }>
  remove?: string[]
}

/**
 * 定义底色修正工具。
 * @param defineTool - 官方工具定义助手（经 `loadOptional` 取得）。
 * @param context - 人格读写入口与确认回调。
 * @returns 可交给 `tools.register` 的工具定义。
 */
export function defineIdentityTool(defineTool: typeof defineToolType, context: IdentityContext) {
  return defineTool({
    name: PERSONA_IDENTITY_TOOL,
    description: IDENTITY_DESCRIPTION,
    parameters: IDENTITY_PARAMETERS,
    output: {
      schema: RESULT_SCHEMA,
      render: (_args, value) => text(renderValue(value as PersonaToolValue)),
    },
    execute(args: IdentityArgs, exec): Promise<PersonaToolValue> {
      return applyIdentity(context, args, exec)
    },
  })
}

/** 一处的改动（用于告诉对方"从什么改成什么"）。 */
interface Change {
  key: string
  before: string | undefined
  after: string | undefined
}

/**
 * 一次调用：算出新底色 → 先写成 agent 写入看是否被拒 → 只对"封存"这一条问一次 → 确认后才是 user 级写入。
 * @param context - 人格读写入口与确认回调。
 * @param args - `set` 与 `remove`。
 * @param exec - 工具执行上下文。
 * @returns 工具结果。
 */
async function applyIdentity(context: IdentityContext, args: IdentityArgs, exec: IdentityExec): Promise<PersonaToolValue> {
  const { persona } = context
  const current = persona.read()
  if (isUntouchedIdentityCard(current.identityCard)) {
    return refusal('identity', current, NOT_INITIALIZED_REASON)
  }

  const built = buildNext(current, args)
  if (built.changes.length === 0) {
    // 没有实际变化：不打扰对方、也不写盘（写一次等于在历史里留一条无意义的记录）。
    return success('identity', current, '底色没有任何变化（给出的值与现值相同，或要删的字段本来就不存在）。')
  }

  try {
    // 先用 agent 身份试写：被 `identity.sealed` 拒是**预期路径**，它不是错误，而是"该问一句"的信号。
    await persona.write(built.next, 'agent')
  } catch (error) {
    if (!(error instanceof PersonaWriteRejected)) throw error
    return confirmThenWrite(context, exec, built, current, error.issues)
  }

  // 走到这里说明文档当时**还没封存**（或内容其实没变），按普通写入成功即可。
  const written = persona.read()
  return success('identity', written, '底色已更新。', warningsOf(written))
}

/**
 * 构造下一份文档：只动点名的那几处。
 * @param current - 当前生效文档。
 * @param args - `set` / `remove`。
 * @returns 新文档与逐处改动（改动为空表示什么都没变）。
 */
function buildNext(current: PersonaDocument, args: IdentityArgs): { next: PersonaDocument; changes: Change[] } {
  const next = structuredClone(current)
  const fields = next.identityCard.fields
  const changes: Change[] = []
  const coreKeys = new Set<string>(CORE_IDENTITY_KEYS)

  for (const entry of args.set ?? []) {
    const key = entry.key.trim()
    if (key === '') continue
    const existing = fields.find((field) => field.key === key)
    if (existing === undefined) {
      fields.push({ key, value: entry.value, custom: !coreKeys.has(key) })
      changes.push({ key, before: undefined, after: entry.value })
      continue
    }
    if (existing.value === entry.value) continue
    changes.push({ key, before: existing.value, after: entry.value })
    existing.value = entry.value
  }

  for (const raw of args.remove ?? []) {
    const key = raw.trim()
    const existing = fields.find((field) => field.key === key)
    // 核心四项不是"字段"而是"身份"，删掉它会让工作台与注入都缺一角 —— 直接跳过。
    if (existing === undefined || !existing.custom) continue
    const index = fields.indexOf(existing)
    fields.splice(index, 1)
    changes.push({ key, before: existing.value, after: undefined })
  }

  return { next, changes }
}

/**
 * 被拒之后：只有"底色封存"这一条可确认项才去问。
 *
 * 混着别的问题（重复键、空键名…）时直接拒绝 —— 否则对方点完确认仍然写不进去，那是一次无意义的打扰。
 */
async function confirmThenWrite(
  context: IdentityContext,
  exec: IdentityExec,
  built: { next: PersonaDocument; changes: Change[] },
  current: PersonaDocument,
  issues: readonly PersonaIssue[],
): Promise<PersonaToolValue> {
  const rejected = issues.filter((issue) => issue.severity === 'rejected')
  const allSealed = rejected.length > 0 && rejected.every((issue) => issue.code === SEALED_ISSUE)
  if (!allSealed) {
    return refusal('identity', current, '底色校验未通过，没有写入。', issues)
  }

  const outcome = await context.confirm(exec, describeChanges(built.changes))
  if (outcome !== 'allowed-once') return refusal('identity', current, OUTCOME_REASON[outcome], issues)

  try {
    // ⚠️ 仍然以 `agent` 写入，只把 `identity.sealed` 这一条标记为"对方已确认" ——
    // 不是换成 `user` 身份：来源要如实反映"这是 agent 代对方发起的改动"。
    await context.persona.write(built.next, 'agent', { confirmed: [SEALED_ISSUE] })
  } catch (retry) {
    if (retry instanceof PersonaWriteRejected) {
      return refusal('identity', current, '底色校验未通过，没有写入。', retry.issues)
    }
    throw retry
  }

  const written = context.persona.read()
  return success('identity', written, `已按对方在对话里的确认，更新了底色。${nameMemoHint(written)}`, warningsOf(written))
}

/**
 * 姓名写成了"备忘录"时的提示（不拒绝，只提醒）。
 *
 * 真机形态（2026-11-17）：模型把「伊瑟（Yseult 的短形；旧名梅露辛已由主人更换，不再使用）」
 * 整句写进姓名 —— 那是 35 个字，标题的准入门槛是 {@link IDENTITY_NAME_LIMIT}，
 * 于是它连自己的名字都不显示（退回「## 你是谁」），而姓名成了越积越长的考古笔记。
 * 这里只提醒：对方的真实名字完全可能超过 24 字，拒绝写入会把正常情况也拦掉。
 * @param doc - 写入后的文档。
 * @returns 提示串（不需要提示时为空串）。
 */
function nameMemoHint(doc: PersonaDocument): string {
  const name = doc.identityCard.fields.find((field) => field.key === CORE_IDENTITY_KEYS[0])
  if (name === undefined || name.value.length <= IDENTITY_NAME_LIMIT) return ''
  return (
    `（提示：姓名为 ${name.value.length} 字，超过 ${IDENTITY_NAME_LIMIT} 字的标题上限，` +
    '提示词里会显示「你是谁」而不是名字。如果那不是有意的，把姓名只留名字本身，' +
    '来龙去脉写进记忆或「自定义」字段。）'
  )
}

/**
 * 给确认框看的改动说明（对方要能一眼判断"它在改我哪一条"）。
 * @param changes - 逐处改动。
 * @returns 一句话。
 */
function describeChanges(changes: readonly Change[]): string {
  const parts = changes.map((change) => {
    if (change.before === undefined) return `新增「${change.key}」：${change.after ?? ''}`
    if (change.after === undefined) return `删除「${change.key}」（原：${change.before}）`
    return `「${change.key}」：${change.before} → ${change.after}`
  })
  return `这次会改动你的底色（封存后只有你能改）：${parts.join('；')}。确认修改吗？`
}
