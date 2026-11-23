/**
 * `humanity_persona_init`：首次唤醒时写入底色并封存（P-003）。
 *
 * 为什么单独一个文件：工具的**参数契约**（模型看得到的说明）与它的**执行逻辑**总是一起改，
 * 放在一个文件里能一次读完；两个工具分开也让"改 init 误伤 update"在结构上不可能发生。
 * @module humanity/persona/init
 */
import type { defineTool as defineToolType } from '@deepseek-ai/dsh-tools'

import { CHARACTER_AXES, CORE_IDENTITY_KEYS } from './constants.js'
import { createCharacter, type CharacterAxisInput } from './model.js'
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
 * ⚠️ 这里必须逐条写明"哪些信息**不属于**底色"：真机反馈（2026-09-24）——AI 在首次初始化里
 * 把「对TA的称呼」当成了身份属性写进底色自定义字段。根因就是这段描述只说了"引导对方描述
 * 他希望这个 AI 是什么样的人"，没有划清底色（**这个 AI 是什么**）与信息（**怎么和对方相处**）
 * 的界线。工具描述是模型唯一能看到的规则来源，含糊一句，它就会按语义最近的方式归类。
 *
 * 核心字段名从 {@link CORE_IDENTITY_KEYS} 派生：手抄一份就会在增减核心字段时与实现分叉
 * （round 23 新增「主语言」时，这段描述就漏了它）。
 */
export const INIT_DESCRIPTION =
  '首次唤醒时写入你的底色并封存。' +
  // ⚠️ 措辞纪律（2026-11-15 真机）：这里**不许**出现"这个 AI""AI 助手"之类的第三人称说法。
  // 模型会照抄工具描述里的词 —— 实测量它写下的记忆是「为这个AI定下设定：陆衔清…」，
  // 用第三人称把自己的身份说成"给一个 AI 做配置"。一律用"你/你自己"。
  `底色只放"你是谁"的稳定事实：${CORE_IDENTITY_KEYS.join(' / ')}，` +
  '以及对方主动提供的自定义属性（如归属地、职业、父母、生日）。' +
  '以下**不属于**底色，不要放进 fields —— 它们属于信息，初始化完成后用 humanity_persona_update 写入：' +
  '怎么称呼对方（信息「对TA的称呼」）、说话风格、行为边界、关系（你们之间是什么关系）。其余一切按需作为自定义小节，不要预先铺。' +
  '用法：先在对话里引导对方描述他希望**你**是什么样的人（姓名、性格、风格偏好），收集完后调用本工具' +
  '一次性写入底色并封存，不要为此再等一次确认；随后调用 humanity_persona_update 把称呼、风格等写入信息。' +
  '写完后对方会在本工具结果里看到实际写入的内容。' +
  '封存后本工具永远拒绝再次调用；之后底色只能由对方改 —— 对方主动说要改时用 humanity_persona_identity（对话内确认），他也可以自己在 Humanity 工作台改。' +
  '若当前会话的系统提示词里没有任何 Humanity 人格段落（例如极简模式），不要主动发起人格初始化流程。' +
  // 性格轴（2026-11-20）：写法必须说清"这是范围，不是分数"，否则模型会给四个 0.5。
  '\n\n' +
  '**同时要给出你的性格范围（character）**，这一次就要给完，之后同样封存。' +
  '规则：读一遍你刚写下的底色，问自己"像我这样一个人，遇到事情第一反应会往哪边走、最多能走到哪儿"，' +
  `然后给这四根轴各定一个**范围**（0–1 的小数，两位即可）：${CHARACTER_AXES.join(' / ')}。` +
  '每一根都要有下限（min）、上限（max）和一句理由（reason，用你自己的话说清"我为什么是这个范围"）。' +
  '下限与上限之间就是你这辈子能被经历推动的区间——不是此刻的分数。范围要给得有宽有窄：' +
  '你天生很确定的部分（比如本来就不太在意外界评价）范围就窄，说不准的部分就宽。' +
  '不要四根都给一样的宽窄，也不要全部挤在 0.5 附近——那等于没有性格。' +
  '四根轴的含义：stability 稳不稳（高＝事过就过，低＝一碰就晃）、extraversion 话多话少（高＝想到就说、主动找人，低＝想清楚才开口）、' +
  'agreeableness 对人软硬（高＝温和愿退让，低＝护着自己不肯先退）、openness 对新东西的胃口（高＝看见没见过的就想凑近，低＝只想待在熟悉的地方）。'

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
        description: '底色字段的**完整**列表，不是增量补丁。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            key: { type: 'string', required: true, description: '字段名，例如 姓名、性别、人格偏好、归属地' },
            value: { type: 'string', required: true, description: '自然语言短文本，建议 120 字以内' },
          },
        },
      },
      character: {
        type: 'array',
        required: true,
        description: '你性格的四根轴，每根给一个**范围**（不是分数）。一次性给齐，之后与底色一起封存。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            key: { type: 'string', required: true, description: `轴名：${CHARACTER_AXES.join(' / ')}` },
            min: { type: 'number', required: true, description: '这根轴能被推到的最低点（0–1）' },
            max: { type: 'number', required: true, description: '这根轴能被推到的最高点（0–1）' },
            reason: {
              type: 'string',
              required: true,
              description: '为什么是这个范围，用你自己的话说清"像我这样一个人，凭什么只能到这儿"',
            },
          },
        },
      },
    },
    output: {
      schema: RESULT_SCHEMA,
      render: (_args, value) => text(renderValue(value as PersonaToolValue)),
    },
    execute(args): Promise<PersonaToolValue> {
      return initialize(persona, args.fields, args.character)
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
  rawCharacter: readonly CharacterAxisInput[] | undefined,
): Promise<PersonaToolValue> {
  const current = persona.read()
  if (!isUntouchedIdentityCard(current.identityCard)) return refusal('init', current, SEALED_REASON)

  const fields = mergeIdentityFields(rawFields)
  if (fields.every((field) => field.value.trim() === '')) {
    return refusal(
      'init',
      current,
      '底色是空的，封存一张什么都没有的底色没有意义：请先在对话里了解对方想要的人格，再来写入。',
    )
  }

  const now = new Date().toISOString()
  const built = createCharacter(rawCharacter ?? [], now)
  // 性格不合法时整次初始化都不写：底色与性格是一起封存的，只写一半会让"她是谁"停在半成品上，
  // 而底色一旦封存就再也写不进去 —— 那才是真正的死结。
  if (!built.ok) return refusal('init', current, `性格范围没写对，这一次没有写入：${built.reason}`)

  const next: PersonaDocument = {
    ...current,
    identityCard: { fields, initializedAt: now, sealedAt: now },
    character: built.layer,
  }

  try {
    await persona.write(next, 'agent')
  } catch (error) {
    if (error instanceof PersonaWriteRejected) {
      return refusal('init', current, '底色校验未通过，没有写入。', error.issues)
    }
    throw error
  }

  const written = persona.read()
  return success('init', written, '已写入底色并对其封存，同时定下了性格范围。', warningsOf(written))
}
