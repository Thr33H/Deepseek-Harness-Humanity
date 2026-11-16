/**
 * 解析管线的提示词：一次调用的**输出合同**（G-003：抽象规则、逐字段结论、无单点示例）。
 *
 * 设计纪律：
 * - 每个字段独立给出"什么算证据、没有证据给什么默认值"——注意力不许只集中在某一个字段；
 * - 敏感类别按 P-033 的**类别枚举**描述（那是规则，不是示例）；不举任何领域的单点例子；
 * - 「没有证据 = 空数组/空串」写进总则：幻觉出来的"发现"比没有发现更贵；
 * - 梦境与增量的差别只在洞察/叙事的产量要求（P-034：梦境偏联想/重组/叙事），合同同一份。
 * @module humanity/evolution/prompt
 */
import type { RunMode } from './types.js'

/** 一个小节的当前内容（提示词里用来判断"是不是已经写过"与"有没有同义条目"）。 */
export interface PersonaCardSection {
  title: string
  items: readonly string[]
}

/**
/** 提示词上下文。 */
export interface PromptContext {
  mode: RunMode
  /** 当前工作区标签（会话 cwd；读不到为空串）。 */
  workspaceLabel: string
  /** 人格信息的当前小标题（约束 personaSections.section 的合法取值）。 */
  sectionTitles: readonly string[]
  /**
   * 信息的**当前内容**（P-056）。
   *
   * 为什么必须给模型看：`sectionConsolidations` 要求它**逐字**指出要并掉哪几条，
   * 而"这条是不是已经写过""这两条是不是同义"都判不了 —— 只给标题清单，模型只能瞎猜。
   * 上限见 {@link PERSONA_CARD_PROMPT_CAP}：这是后台调用，但仍然不许无限长。
   */
  personaCard?: readonly PersonaCardSection[]
}

/**
 * 提示词里信息的字符上限（超出就整节截断并注明）。
 *
 * 取值理由：这是**后台**调用（一轮整理 1–2 次），不是每轮对话都带的注入，所以可以比注入预算宽松；
 * 但也不能没有上限 —— 一张失控的信息会把对话摘要挤到看不见。
 */
const PERSONA_CARD_PROMPT_CAP = 3000

/**
 * 渲染信息的当前内容（带上限，超了如实标注）。
 * @param card - 各小节标题与条目。
 * @returns 提示词行（空卡返回空数组）。
 */
function renderPersonaCard(card: readonly PersonaCardSection[]): string[] {
  const lines: string[] = []
  let used = 0
  for (const section of card) {
    const items = section.items.filter((item) => item.trim() !== '')
    if (items.length === 0) continue
    const line = `- ${section.title}：${items.map((item) => item.trim().slice(0, 120)).join('；')}`
    if (used + line.length > PERSONA_CARD_PROMPT_CAP) {
      lines.push('（信息过长，其余小节未列出）')
      break
    }
    used += line.length
    lines.push(line)
  }
  return lines
}

/**
/** 模式的工作语言说法。 */
const MODE_LABELS: Readonly<Record<RunMode, string>> = {
  incremental: '增量整理（小步、低成本，只提炼确凿内容）',
  rescan: '回扫整理（对方指定的历史范围，标准同增量）',
  dream: '梦境（长窗口联想整理：允许跨主题重组与反思，产出洞察与叙事）',
}

/** 系统段：身份 + 总则 + 逐字段规则。 */
export function buildSystemPrompt(context: PromptContext): string {
  const titles = context.sectionTitles.length > 0 ? context.sectionTitles.join('、') : '（暂无人格小节）'
  const card = renderPersonaCard(context.personaCard ?? [])
  return [
    '你是 Humanity 套件的后台整理管线，不是对话参与者，也不面向对方输出。',
    '你的唯一任务：阅读对话摘要，提炼有长期价值的内容，输出一个 JSON 对象。',
    '',
    '总则（对每个字段都成立）：',
    '- 只输出一个 JSON 对象；不要 markdown 代码围栏、不要解释、不要 JSON 之外的任何字符。',
    '- 每个字段独立判断、独立给结论；某字段证据不足就给它的默认值（空数组或空串），绝不编造。',
    '- 证据只来自摘要里的对话原文；不推测对话之外的事实。',
    '- 一次性内容、寒暄、临时任务细节不属于任何字段。',
    '',
    '字段规则：',
    '- memories：对方明确表达的长期偏好、对TA的称呼、稳定事实、长期目标、固定约定。',
    '  每条：content=一句话短摘要（保留对方自己的说法，不加修饰）；',
    '  scope="long-term"（跨项目稳定）或 "workspace"（只对当前工作区成立）；',
    '  tags=0 到 3 个分类词；sensitive=是否属于密码、密钥、财务、健康、隐私地址、身份号码等敏感类别。',
    '  证据模糊的内容不要输出——宁缺毋滥。',
    '- personaSections：对你可变人格层（「你的信息」）的更新建议。section 只能从「当前小标题清单」里选；',
    '  items=要在该小节补充的条目（自然语言短句）。只提交有对话证据的小节；已存在的内容不重复提交。',
    '  **同义条目也算已存在**：换个说法复述同一条规矩不算新内容，不要提交。',
    '  如果你发现该小节里已有**多条在说同一件事**（措辞不同、意思相同），用',
    '  sectionConsolidations 提交合并建议，而不是再补一条。',
    '- sectionConsolidations：对**已有**条目的整合建议。section=小节名；keep=保留的那条（原样抄写）；',
    '  drop=要并掉的条目（原样抄写，必须与该小节现有条目逐字一致）；reason=为什么它们是同一件事。',
    '  只合并**确实同义**的条目：互相包含但各是一条规矩的（例如"不跳过指定情节"与"不跳过指定情节、不代替对方做选择"）',
    '  不是重复，不要提交。这一项合并的是措辞完全不同的同义句（字符串相似度判不出来的那些）。',
    '- personaFixed：对你底色（「你是谁」）的修改建议。仅当对方明确陈述或纠正了你的姓名、性别、',
    '  人格偏好、主语言或其自定义字段时提交。fieldKey=字段名；fieldValue=建议值（短文本）；reason=对话依据。',
    '- insights：跨对话的联想、模式与反思，每条一句话。梦境模式给 3 到 8 条；其余模式没有就给空数组。',
    '- narrative：仅梦境模式输出——以第一人称把这段时间的经历复述成一段短叙事（不超过 800 字）；',
    '  其余模式给空串。',
    '',
    `当前模式：${MODE_LABELS[context.mode]}`,
    `当前工作区：${context.workspaceLabel === '' ? '（未识别）' : context.workspaceLabel}`,
    `当前小标题清单（personaSections.section 的合法取值）：${titles}`,
    ...(card.length === 0
      ? []
      : ['', '当前信息内容（信息；判断"已存在"与"同义重复"以此为准，引用时必须逐字一致）：', ...card]),
  ].join('\n')
}

/**
 * 对方段：摘要正文 + 输出提醒。
 *
 * 重试用第二参数追加纠错要求（第一次输出坏 JSON 后，把"只要 JSON"再说一遍，
 * 不改合同本身——合同改了会让两次尝试的输出不可比）。
 * @param digest - 对话摘要（digest.ts 产出）。
 * @param correction - 重试时的纠错附注；首次为空串。
 */
export function buildUserMessage(digest: string, correction = ''): string {
  const parts = ['以下是一段对话摘要（[user] 与 [assistant] 标注说话方）：', '', digest]
  if (correction !== '') parts.push('', correction)
  parts.push('', '现在输出 JSON 对象。')
  return parts.join('\n')
}
