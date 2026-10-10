/**
 * 人格的**提示词渲染**（纯函数，不碰 cordis）。
 *
 * 只做一件事：把一份人格文档变成一段可注入的文本（含未初始化时的引导语）。
 * 纯函数意味着它可以被两侧共用、被单测直接调用，也不会因为"注册时机"而行为不同 ——
 * 注册时机那一半在 `prompt.ts`，两边分开是为了让"渲染规则"和"生命周期"各自可读。
 * @module humanity/persona/render
 */
import { CORE_IDENTITY_KEYS } from './constants.js'
import { INDEPENDENT_JUDGMENT_PROMPT, MUTABLE_OPS_GUIDE, UNINITIALIZED_PROMPT } from './prompt-texts.js'
import { collectPersonaContent, blocksOf } from './render-content.js'
import { fitPersonaContent, type FitStats } from './render-fit.js'
import type { PersonaDocument } from './types.js'

/**
 * 注入的**硬字符预算**。
 *
 * 为什么不按 token 算：提示词拼装发生在字符层面，而"多少 token"依模型分词器而异，
 * 在这里估一个 token 数只会得到一个**看起来精确、实际会漂**的数字。改用字符预算，
 * 并在注释里给出量级换算（中文约 1–1.5 字符/token ⇒ 2400 字符 ≈ 1600–2400 token）。
 *
 * ⚠️ **2026-09-26 从 1200 上调到 2400**（用户发现某实例的提示词被截断）：1200 里还要扣掉
 * 永不截断的操作约定段（168 字符）与独立判断段（163 字符），留给内容的只剩 ~1030 —— 而一张
 * **写满的人格卡**（7 个固定层字段 + 50 多条可变层条目）本来就有 1900+ 字符。旧预算下
 * 她那 7 个小节里有 3 个整节进不去。人格卡是用户亲手写的东西，"写进去却不生效"是最坏的结果；
 * 2400 让一张正常规模的卡**全部进得去**，超了才降级（降级方式见 `render-fit.ts`）。
 */
export const PROMPT_CHAR_BUDGET = 2400

/**
 * 人格内容与操作约定段之间那一个 `\n\n` 的长度。
 *
 * 为什么单独写出来（2026-09-26 审计 P5）：旧代码在预算里减的是
 * `(anti === '' ? 0 : 2) + 2`，但 `fixed` 已经用 `join('\n\n')` **含进**了独立判断段与操作约定之间
 * 的分隔符 —— 独立判断段在场时那 2 个字符被算了两次，等于白扣掉两个字符的容量（少得可怜，
 * 但它是个"看起来对、其实没有依据"的数字，留着只会让下一个人再推一遍）。
 */
const SEPARATOR_LENGTH = 2

/** 人格内容真正可用的字符数（预算 − 永不截断的固定段 − 一个分隔符）。 */
function contentBudget(fixedLength: number): number {
  return PROMPT_CHAR_BUDGET - fixedLength - SEPARATOR_LENGTH
}
/**
 * 把人格文档渲染成提示词片段。
 *
 * 注入规则（DECISIONS P-028 / §4.2.6）逐条落位：
 * - **可一键关闭**：`enabled === false` ⇒ 空串（上层传的就是 `persona.enabled && 总开关`）；
 * - **低于阈值不注入**：固定层没写过、可变层也空 ⇒ 空串（占位只会白烧 token 还容易被当成事实）；
 * - **只回摘录/摘要**：单值截断到软上限；总长超预算时按"每节保底一条 + 轮转加条"降级并标注；
 * - **硬上限**：总长不超过 {@link PROMPT_CHAR_BUDGET} 字符（含两个永不截断的固定段）；
 * - **只作底层倾向**：不写任何行为命令（P-013），开头一句说明它的地位。
 * @param doc - 当前生效的人格文档。
 * @param options - `enabled`：模块开关是否打开。
 * @returns 提示词片段；不该注入时返回空串。
 */
export function renderPersonaPrompt(
  doc: PersonaDocument,
  options: { enabled: boolean; independentJudgment?: boolean },
): string {
  try {
    return renderPersonaPromptOrThrow(doc, options)
  } catch {
    // **绝不抛**。这个函数会被提示词拼装**直接**调用，而那一层没有 try/catch
    // （`dsh-system-prompt/lib/index.js:339` 逐字是 `section.text(context)`）：
    // 我们抛一次，整轮对话的 pre-step 就失败（真机表现是"点会话 → UI 全塌"）。
    // 形状不对的文档只该导致"这轮没有人格底色"，不该把宿主带崩。
    return ''
  }
}

/**
 * `renderPersonaPrompt` 的实际实现（允许抛，由外层兜住）。
 *
 * 拼接顺序（从上到下就是提示词里的先后）：
 * 1. **未初始化** ⇒ 只给引导语（此时没有底色可言，先让流程启动起来）；
 * 2. **固定层尚未封存** ⇒ 只给人格内容，**不加独立判断段**（用户 2026-09-24 定）；
 * 3. **已初始化** ⇒ 独立判断底层指令（封存后且开关开着时）+ 人格内容 + 操作约定段。
 *    三者合起来不超过 {@link PROMPT_CHAR_BUDGET}，但**只截人格内容**：两个固定段永不截断。
 *
 * 为什么独立判断要等封存（2026-10-06 正文换稿后依然成立）：真机教训是初始化阶段模型拿"独立判断"
 * 当理由拒绝用户的设定指令（角色扮演被拒）。封存之前那份身份还不存在，此时先谈"不迎合"容易被
 * 误读成"可以否决用户给你的人格"，因此整段不注入；封存之后身份已定，它才作为行为底线生效。
 * （旧版正文自带"你已经有自己的身份和性格（来自人格卡）"作锚点，新版正文不含锚点 —— 这条防线
 * 现在**只由注入时机**承担，改这里之前先想清楚。）
 *
 * 逐层用 `?.`/`??` 兜底：**提示词路径上的输入来自设置文档，我们没有权力假设它一定完整**。
 * @param doc - 当前生效的人格文档（可能是形状不对的值）。
 * @param options - `enabled`：模块开关；`independentJudgment`：是否注入独立判断底层指令（缺省开）。
 * @returns 提示词片段；不该注入时返回空串。
 */
function renderPersonaPromptOrThrow(
  doc: PersonaDocument,
  options: { enabled: boolean; independentJudgment?: boolean },
): string {
  if (!options.enabled) return ''

  // 未初始化 ⇒ 注入引导语。判定**先于**其他一切：未初始化的文档必然是空的，
  // "低于阈值不注入"会把唯一能启动整个流程的话也一起吞掉（鸡生蛋）。
  if (doc?.identityCard?.initializedAt === '') return UNINITIALIZED_PROMPT

  // 独立判断段**只在固定层已封存后**注入（理由见上面的函数注释：封存前注入会让模型拿它拒绝用户的设定）。
  // 判据用 `sealedAt`（P-002：状态由独立标记判定，不比对内容）。
  const sealed = doc?.identityCard?.sealedAt !== '' && doc?.identityCard?.sealedAt !== undefined
  const anti = sealed && options.independentJudgment !== false ? INDEPENDENT_JUDGMENT_PROMPT : ''
  const content = collectPersonaContent(doc)
  const hasContent = content.fields.length > 0 || content.sections.length > 0 || content.userDefined.length > 0

  // 人格内容为空：只留独立判断这一句 —— 它值得注入，且与"有没有填过底色"无关。
  if (!hasContent) return anti

  // 操作约定段与独立判断段同属固定成本：预算只截人格内容。
  const fixed = [anti, MUTABLE_OPS_GUIDE].filter((part) => part !== '').join('\n\n')
  const fitted = fitPersonaContent(blocksOf(content), contentBudget(fixed.length))
  const persona = fitted.lines.join('\n')
  return `${anti === '' ? '' : `${anti}\n\n`}${persona}\n\n${MUTABLE_OPS_GUIDE}`
}

/**
 * 一份人格文档在当前预算下**装得下多少**（供工作台如实显示，不参与提示词拼装）。
 *
 * 为什么要有它（用户 2026-09-26 发现提示词末尾挂着「已截断」）：内容被丢这件事，
 * 旧实现只在**提示词里**说，工作台上一个字都没有 —— 用户在自己的卡片上看不出
 * "写进去的这 20 条里，有 12 条根本不会生效"。这里把同一套拟合账目交给界面，
 * 且**不新增任何投影字段**：文档本来就在客户端手上，算它是纯函数。
 * @param doc - 当前生效的人格文档（可为形状不对的值）。
 * @param options - `independentJudgment`：独立判断段是否注入（它占用同一份预算）。
 * @returns 拟合账目；不该注入时返回 undefined（未初始化 / 内容为空）。
 */
export function personaPromptReport(
  doc: PersonaDocument,
  options: { independentJudgment?: boolean } = {},
): FitStats | undefined {
  try {
    if (doc?.identityCard?.initializedAt === '') return undefined
    const sealed = doc?.identityCard?.sealedAt !== '' && doc?.identityCard?.sealedAt !== undefined
    const anti = sealed && options.independentJudgment !== false ? INDEPENDENT_JUDGMENT_PROMPT : ''
    const content = collectPersonaContent(doc)
    const hasContent = content.fields.length > 0 || content.sections.length > 0 || content.userDefined.length > 0
    if (!hasContent) return undefined
    const fixed = [anti, MUTABLE_OPS_GUIDE].filter((part) => part !== '').join('\n\n')
    return fitPersonaContent(blocksOf(content), contentBudget(fixed.length)).stats
  } catch {
    // 与渲染同一条纪律：这是给界面看的账，形状不对就当"算不出来"，绝不冒泡。
    return undefined
  }
}


