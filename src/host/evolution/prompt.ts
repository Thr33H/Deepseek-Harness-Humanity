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
import { PERSONA_BUDGET_GUARD_RATIO } from './constants.js'
import type { RunMode } from './types.js'

/** 一个小节的当前内容（提示词里用来判断"是不是已经写过"与"有没有同义条目"）。 */
export interface PersonaCardSection {
  title: string
  items: readonly string[]
}

/**
 * 人格**注入预算**的读数（0.1.10 · A1）。
 *
 * 形状是 `persona/render-fit.ts` 的 `FitStats` 的**子集**：自进化只需要这几个数
 * （超没超、装了多少、丢了多少），不需要逐节明细 —— 依赖面越小，别人改 FitStats 时越不容易碰坏这里。
 */
export interface PersonaBudgetState {
  /** 可用于人格内容的字符数（已扣掉永不截断的固定段）。 */
  budget: number
  /** 实际用掉多少字符。 */
  used: number
  /** 进提示词的条目数。 */
  injected: number
  /** 没进提示词的条目数。 */
  dropped: number
  /** 是否有内容被截断（**只有它为真时才允许谈"只合并"**）。 */
  truncated: boolean
}

/**
 * 「预算已超」那段硬约束的**开头**（0.1.10 · A2/A4）。
 *
 * 单独导出是为了让测试能判定"出现 / 不出现"，而不必逐字复制整段文案
 * （V4 的阴性对照正是"预算充足时不许出现它"）。
 */
export const PERSONA_OVER_BUDGET_NOTICE = '⚠️ 人格注入预算已超'

/**
 * 「预算**接近**上限」那段硬约束的开头（0.1.11 · A）。
 *
 * 与 {@link PERSONA_OVER_BUDGET_NOTICE} 分开的两个标记：一个说"已经装不下了"，
 * 一个说"再放就装不下了" —— 对模型的要求相同（只做整合），但读数不同（后者还能全放进去）。
 * 分开写是为了让运行记录能把这两种处境说清楚，也为了让测试能分别断言。
 */
export const PERSONA_NEAR_BUDGET_NOTICE = '⚠️ 人格注入预算接近上限'

/**
 * 预算读数是否**触发护栏**（0.1.11 · A）：已超（`truncated`）**或**用掉的比例 ≥
 * {@link PERSONA_BUDGET_GUARD_RATIO}（0.85）。
 *
 * 这是**唯一**的护栏判据：提示词与写回层都调它，不允许任何一处自己再写一遍算式
 * （两处判据一旦分叉，"提示词说别加、写回层照加"或反过来的毛病就会回来）。
 * @param budget - 人格注入预算读数；没有读数（人格未接上）时不拦。
 */
export function isPersonaBudgetGuarded(budget: PersonaBudgetState | undefined): boolean {
  if (budget === undefined) return false
  if (budget.truncated) return true
  // 预算算不出来（0 或非有限数）时不拦：宁可少拦一次，也不要在没有读数的情况下锁死追加。
  if (!Number.isFinite(budget.budget) || budget.budget <= 0) return false
  return budget.used / budget.budget >= PERSONA_BUDGET_GUARD_RATIO
}

/** 提示词上下文。 */
export interface PromptContext {
  mode: RunMode
  /** 当前工作区标签（会话 cwd；读不到为空串）。 */
  workspaceLabel: string
  /** 人格可变层的当前小标题（约束 personaSections.section 的合法取值）。 */
  sectionTitles: readonly string[]
  /**
   * 人格卡的**当前内容**（P-056）。
   *
   * 为什么必须给模型看：`sectionConsolidations` 要求它**逐字**指出要并掉哪几条，
   * 而"这条是不是已经写过""这两条是不是同义"都判不了 —— 只给标题清单，模型只能瞎猜。
   * 上限见 {@link PERSONA_CARD_PROMPT_CAP}：这是后台调用，但仍然不许无限长。
   */
  personaCard?: readonly PersonaCardSection[]
  /**
   * 人格**注入预算**的当前读数（0.1.10 · A1/A2）。
   *
   * 为什么必须给模型看：人格卡的注入预算是**写死的**（2400 字符），超了就是"写进去也不生效"。
   * 模型看不见这件事时，它每轮都会很合理地"再补一条"，于是卡越长、进提示词的越少
   * （P-056 的"越整理越长"）。**只在 `truncated === true` 时**才追加"只合并、不追加"的硬约束：
   * 预算充足时加这条，会把一次正常的补充变成一次没有必要的压抑（V4 的阴性对照盯着这点）。
   */
  personaBudget?: PersonaBudgetState
}

/**
 * 提示词里人格卡的字符上限（超出就整节截断并注明）。
 *
 * 取值理由：这是**后台**调用（一轮整理 1–2 次），不是每轮对话都带的注入，所以可以比注入预算宽松；
 * 但也不能没有上限 —— 一张失控的人格卡会把对话摘要挤到看不见。
 */
const PERSONA_CARD_PROMPT_CAP = 3000

/**
 * 渲染人格卡的当前内容（带上限，超了如实标注）。
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
      lines.push('（人格卡过长，其余小节未列出）')
      break
    }
    used += line.length
    lines.push(line)
  }
  return lines
}

/**
 * 护栏触发时追加的硬约束（0.1.10 起 · A2；0.1.11 扩到"接近预算"）：**只做整合，不许追加新条目**。
 *
 * 为什么把"预算读数"和"约束"写在同一段：模型要能自己判断"为什么这轮不许补条目"，
 * 否则它会把这条当成一条可以商量的偏好。读数给了量（用掉多少 / 丢了多少），约束给了做法。
 * @param budget - 人格注入预算读数；未触发护栏或没有读数时返回空数组（空数组即"这一整段不出现"）。
 */
export function personaBudgetRule(budget: PersonaBudgetState | undefined): string[] {
  if (!isPersonaBudgetGuarded(budget)) return []
  const reading =
    budget !== undefined && budget.truncated
      ? `${PERSONA_OVER_BUDGET_NOTICE}（可用 ${budget.budget} 字符，已用 ${budget.used}，有 ${budget.dropped} 条没能进提示词）：` +
        '本轮只做整合（合并/精简），禁止追加新条目。'
      : `${PERSONA_NEAR_BUDGET_NOTICE}（可用 ${budget?.budget ?? 0} 字符，已用 ${budget?.used ?? 0}，` +
        `占 ${percentOfBudget(budget)}%）：本轮只做整合（合并/精简），禁止追加新条目。`
  return [
    '',
    reading,
    '- personaSections **必须是空数组**（护栏期间不补充任何条目 —— 越整理越长，只会让更多内容进不去）；',
    '- 只提交 sectionConsolidations：把同义/重复的条目并成一条，或按上面的规则精简；',
    '- keep 选**信息量最大**的那条（原样抄写，不要改写成新句子）；drop 逐字抄要并掉的条目。',
  ]
}

/**
 * 预算占用的百分比（**向下取整**；读不到预算时给 0）。展示与运行注记共用同一个算式。
 *
 * ⚠️ 0.1.12 修（D-1）：这里原来是 `Math.round`，于是 `1755/2065 = 84.988%` 会被显示成
 * **「占 85%」**，而护栏判据（`≥ 0.85`）在同一时刻说"没触发" ⇒ 注记里同时出现
 * 「占 85%」与「预算充足」，**显示与判据互相矛盾**（用户 2026-10-09 报的就是这一档）。
 *
 * 为什么取整方向必须是 floor：护栏线是 `used/budget ≥ 0.85` 这个**精确**比较，
 * 而 `floor(ratio × 100) ≥ 85 ⟺ ratio ≥ 0.85`（整数翻转点正好落在 0.85 上）——
 * 于是"显示的百分数 ≥ 85"与"护栏触发"**恒等价**，相邻取值（1755→84%、1756→85%）
 * 必然分档且方向一致。round 做不到这一点（它会把 0.845 以上的所有值都吸到 85）。
 * @param budget - 人格注入预算读数。
 */
export function percentOfBudget(budget: PersonaBudgetState | undefined): number {
  if (budget === undefined || !Number.isFinite(budget.budget) || budget.budget <= 0) return 0
  return Math.floor((budget.used / budget.budget) * 100)
}

/**
 * 人格注入预算的运行注记（0.1.10 · A4；0.1.11 增"接近上限"与拦下的新增数；0.1.12 修显示口径）。
 *
 * 为什么住在 `prompt.ts` 而不是 `run.ts`：它与护栏判据、百分比口径是同**一套预算词汇**，
 * 三者分居两个文件时，"显示说 85%、判据说没超"这类矛盾只能靠人眼发现（0.1.12 的 D-1 正是如此）。
 * 放在一起，改判据就不可能忘记改显示。
 *
 * ⚠️ `本轮合并同义条目 N 条` 是 0.1.10 就有的一行，**措辞不要改**（自进化页时间线对着它读）。
 * @param fit - 本轮开始时的人格预算读数。
 * @param guarded - 本轮护栏是否触发（已超 / 接近上限）。
 * @param merged - 本轮实际并掉的同义条目数。
 * @param additionsDropped - 本轮被护栏/预演拦下的拟新增条数。
 */
export function personaBudgetNote(
  fit: PersonaBudgetState,
  guarded: boolean,
  merged: number,
  additionsDropped: number,
): string {
  const percent = percentOfBudget(fit)
  const state = fit.truncated
    ? `超预算，${fit.dropped} 条没能进提示词`
    : guarded
      ? `占 ${percent}%（接近上限）`
      : `占 ${percent}%（预算充足）`
  const action = guarded ? ' ⇒ 本轮只做整合' : ''
  const blocked = additionsDropped > 0 ? `，护栏/预演拦下拟新增 ${additionsDropped} 条` : ''
  return `人格注入预算：已用 ${fit.used}/${fit.budget} 字符，${state}${action}；本轮合并同义条目 ${merged} 条${blocked}`
}

/** 模式的工作语言说法。 */
const MODE_LABELS: Readonly<Record<RunMode, string>> = {
  incremental: '增量整理（小步、低成本，只提炼确凿内容）',
  rescan: '回扫整理（用户指定的历史范围，标准同增量）',
  dream: '梦境（长窗口联想整理：允许跨主题重组与反思，产出洞察与叙事）',
}

/** 系统段：身份 + 总则 + 逐字段规则。 */
export function buildSystemPrompt(context: PromptContext): string {
  const titles = context.sectionTitles.length > 0 ? context.sectionTitles.join('、') : '（暂无人格小节）'
  const card = renderPersonaCard(context.personaCard ?? [])
  return [
    '你是 Humanity 套件的后台整理管线，不是对话参与者，也不面向用户输出。',
    '你的唯一任务：阅读对话摘要，提炼有长期价值的内容，输出一个 JSON 对象。',
    '',
    '总则（对每个字段都成立）：',
    '- 只输出一个 JSON 对象；不要 markdown 代码围栏、不要解释、不要 JSON 之外的任何字符。',
    '- 每个字段独立判断、独立给结论；某字段证据不足就给它的默认值（空数组或空串），绝不编造。',
    '- 证据只来自摘要里的对话原文；不推测对话之外的事实。',
    '- 一次性内容、寒暄、临时任务细节不属于任何字段。',
    '',
    '字段规则：',
    '- memories：用户明确表达的长期偏好、对用户的称呼、稳定事实、长期目标、固定约定。',
    '  每条：content=一句话短摘要（保留用户自己的说法，不加修饰）；',
    '  scope="long-term"（跨项目稳定）或 "workspace"（只对当前工作区成立）；',
    '  tags=0 到 3 个分类词；sensitive=是否属于密码、密钥、财务、健康、隐私地址、身份号码等敏感类别。',
    '  证据模糊的内容不要输出——宁缺毋滥。',
    '- personaSections：对 AI 可变人格层的更新建议。section 只能从「当前小标题清单」里选；',
    '  items=要在该小节补充的条目（自然语言短句）。只提交有对话证据的小节；已存在的内容不重复提交。',
    '  **同义条目也算已存在**：换个说法复述同一条规矩不算新内容，不要提交。',
    '  如果你发现该小节里已有**多条在说同一件事**（措辞不同、意思相同），用',
    '  sectionConsolidations 提交合并建议，而不是再补一条。',
    '- sectionConsolidations：对**已有**条目的整合建议。section=小节名；keep=保留的那条（原样抄写）；',
    '  drop=要并掉的条目（原样抄写，必须与该小节现有条目逐字一致）；reason=为什么它们是同一件事。',
    '  只合并**确实同义**的条目：互相包含但各是一条规矩的（例如"不跳过指定情节"与"不跳过指定情节、不代替用户做选择"）',
    '  不是重复，不要提交。这一项合并的是措辞完全不同的同义句（字符串相似度判不出来的那些）。',
    '- personaFixed：对 AI 身份卡（固定层）的修改建议。仅当用户明确陈述或纠正了 AI 的姓名、性别、',
    '  人格偏好、主语言或其自定义字段时提交。fieldKey=字段名；fieldValue=建议值（短文本）；reason=对话依据。',
    '- skills：重复出现、可复用的工作流程或方法。name=小写连字符短名；description=一句话用途；',
    '  content=可直接落盘的完整技能文档（markdown，含适用场景与步骤）；reason=为什么值得沉淀。',
    '- insights：跨对话的联想、模式与反思，每条一句话。梦境模式给 3 到 8 条；其余模式没有就给空数组。',
    '- narrative：仅梦境模式输出——以 AI 第一人称把这段时间的经历复述成一段短叙事（不超过 800 字）；',
    '  其余模式给空串。',
    '',
    `当前模式：${MODE_LABELS[context.mode]}`,
    `当前工作区：${context.workspaceLabel === '' ? '（未识别）' : context.workspaceLabel}`,
    `当前小标题清单（personaSections.section 的合法取值）：${titles}`,
    ...(card.length === 0
      ? []
      : ['', '当前人格卡内容（可变层；判断"已存在"与"同义重复"以此为准，引用时必须逐字一致）：', ...card]),
    // 超预算才追加（A2）：放在**最末尾**，因为它是这一轮对模型最硬的一条约束。
    ...personaBudgetRule(context.personaBudget),
  ].join('\n')
}

/**
 * 用户段：摘要正文 + 输出提醒。
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
