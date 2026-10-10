/**
 * `humanity_persona_init`：首次唤醒时写入固定层并封存（P-003）。
 *
 * 为什么单独一个文件：工具的**参数契约**（模型看得到的说明）与它的**执行逻辑**总是一起改，
 * 放在一个文件里能一次读完；两个工具分开也让"改 init 误伤 update"在结构上不可能发生。
 * @module humanity/persona/init
 */
import type { defineTool as defineToolType } from '@deepseek-ai/dsh-tools'

import { CORE_IDENTITY_KEYS } from './constants.js'
import { isUntouchedIdentityCard } from './predicates.js'
import { PersonaWriteRejected, type PersonaSection } from './section.js'
import { mergeIdentityFields, SEALED_REASON } from './tool-helpers.js'
import { RESULT_SCHEMA, refusal, renderValue, success, text, warningsOf, type PersonaToolValue } from './tool-result.js'
import type { PersonaDocument } from './types.js'

/** 初始化工具名。带前缀，避免与其它插件的工具撞名。 */
export const PERSONA_INIT_TOOL = 'humanity_persona_init'

/**
 * 工具描述（模型可见）：说清**什么时候写、写什么、写完就封存**。
 *
 * ⚠️ 这里必须逐条写明"哪些信息**不属于**固定层"：真机反馈（2026-09-24）——AI 在首次初始化里
 * 把「对用户的称呼」当成了身份属性写进固定层自定义字段。根因就是这段描述只说了"引导用户描述
 * 他希望这个 AI 是什么样的人"，没有划清固定层（**这个 AI 是什么**）与可变层（**怎么和用户相处**）
 * 的界线。工具描述是模型唯一能看到的规则来源，含糊一句，它就会按语义最近的方式归类。
 *
 * 核心字段名从 {@link CORE_IDENTITY_KEYS} 派生：手抄一份就会在增减核心字段时与实现分叉
 * （round 23 新增「主语言」时，这段描述就漏了它）。
 */
export const INIT_DESCRIPTION =
  '首次唤醒时写入人格固定层（身份卡）并封存。' +
  `固定层只放"这个 AI 是什么"的稳定事实：${CORE_IDENTITY_KEYS.join(' / ')}，` +
  '以及用户主动提供的自定义属性（如归属地、职业、父母、生日）。' +
  '以下**不属于**固定层，不要放进 fields —— 它们属于可变层，初始化完成后用 humanity_persona_update 写入：' +
  '对用户的称呼（可变层「对用户称呼」）、说话风格、交付格式、行为边界、习惯与偏好、经验教训、情绪、未结修正。' +
  '用法：先在对话里引导用户描述他希望这个 AI 是什么样的人（姓名、性格、风格偏好），收集完后调用本工具' +
  '一次性写入固定层并封存，不要为此再等一次确认；随后调用 humanity_persona_update 把称呼、风格等写入可变层。' +
  '写完后用户会在本工具结果里看到实际写入的内容。' +
  '封存后本工具永远拒绝再次调用，Agent 也不能修改固定层；只有用户能在 Humanity 工作台修改。' +
  '若当前会话的系统提示词里没有任何 Humanity 人格段落（例如极简模式），不要主动发起人格初始化流程。'

/**
 * 定义初始化工具。
 * @param defineTool - 官方工具定义助手（经 `loadOptional` 取得）。
 * @param persona - 人格读写入口。
 * @returns 可交给 `tools.register` 的工具定义。
 */
export function defineInitTool(defineTool: typeof defineToolType, persona: PersonaSection) {
  return defineTool({
    name: PERSONA_INIT_TOOL,
    description: INIT_DESCRIPTION,
    parameters: {
      fields: {
        type: 'array',
        required: true,
        description: '身份卡字段的**完整**列表，不是增量补丁。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            key: { type: 'string', required: true, description: '字段名，例如 姓名、性别、人格偏好、归属地' },
            value: { type: 'string', required: true, description: '自然语言短文本，建议 120 字以内' },
          },
        },
      },
    },
    output: {
      schema: RESULT_SCHEMA,
      render: (_args, value) => text(renderValue(value as PersonaToolValue)),
    },
    execute(args): Promise<PersonaToolValue> {
      return initialize(persona, args.fields)
    },
  })
}

/**
 * `humanity_persona_init` 的一次调用。
 *
 * 失败一律返回**结构化结果**而不是抛异常：这条路径的读者是模型，"为什么没写入"要能进同一段文案。
 * @param persona - 人格读写入口。
 * @param rawFields - 模型给的字段列表。
 * @returns 工具结果。
 */
async function initialize(
  persona: PersonaSection,
  rawFields: readonly { key: string; value: string }[],
): Promise<PersonaToolValue> {
  const current = persona.read()
  if (!isUntouchedIdentityCard(current.identityCard)) return refusal('init', current, SEALED_REASON)

  const fields = mergeIdentityFields(rawFields)
  if (fields.every((field) => field.value.trim() === '')) {
    return refusal(
      'init',
      current,
      '固定层是空的，封存一张什么都没有的身份卡没有意义：请先在对话里了解用户想要的人格，再来写入。',
    )
  }

  const now = new Date().toISOString()
  const next: PersonaDocument = { ...current, identityCard: { fields, initializedAt: now, sealedAt: now } }

  try {
    await persona.write(next, 'agent')
  } catch (error) {
    if (error instanceof PersonaWriteRejected) {
      return refusal('init', current, '固定层校验未通过，没有写入。', error.issues)
    }
    throw error
  }

  const written = persona.read()
  return success('init', written, '已写入固定层并对其封存。', warningsOf(written))
}
