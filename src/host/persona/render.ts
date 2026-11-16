/**
 * 人格的**提示词渲染**（纯函数，不碰 cordis）。
 *
 * 只做一件事：把一份人格文档变成一段可注入的文本（含未初始化时的引导语）。
 * 纯函数意味着它可以被两侧共用、被单测直接调用，也不会因为"注册时机"而行为不同 ——
 * 注册时机那一半在 `prompt.ts`，两边分开是为了让"渲染规则"和"生命周期"各自可读。
 *
 * ### 没有字数上限（2026-11-16 用户裁定）
 * 这里以前有一套"注入预算"（`PROMPT_CHAR_BUDGET`，2400 字）+ 拟合器（`render-fit.ts`）：
 * 超预算的条目**整条不注入**，单条超 120 字**截断加省略号**。对方的要求是取消一切字数限制，
 * 于是整套拟合被删除：**写多少就注入多少**，一条不丢、一字不截。
 *
 * 代价必须写在这里，别让下一个人以为是疏忽：人格段每轮都进系统提示词，内容越长，
 * 每一轮都要付这份 token；一张几万字的卡会挤占上下文窗口，也会稀释注意力。
 * 这是对方明确选择的取舍（"我自己控制长度"），不是本模块忘了做保护。
 * @module humanity/persona/render
 */
import { MUTABLE_OPS_GUIDE, uninitializedPrompt } from './prompt-texts.js'
import { blocksOf, collectPersonaContent } from './render-content.js'
import type { PersonaDocument } from './types.js'

/**
 * 把人格文档渲染成提示词片段。
 *
 * 注入规则（DECISIONS P-028 / §4.2.6）逐条落位：
 * - **可一键关闭**：`enabled === false` ⇒ 空串（上层传的就是 `persona.enabled && 总开关`）；
 * - **低于阈值不注入**：底色没写过、信息也空 ⇒ 空串（占位只会白烧 token 还容易被当成事实）；
 * - **不截断、不丢弃**：内容原样进提示词（2026-11-16 取消字数限制）；
 * - **只作底层倾向**：不写任何行为命令（P-013），开头一句说明它的地位。
 * @param doc - 当前生效的人格文档。
 * @param options - `enabled`：模块开关是否打开；`now`：日期（未初始化那段要写"今天几号"）。
 * @returns 提示词片段；不该注入时返回空串。
 */
export function renderPersonaPrompt(
  doc: PersonaDocument,
  options: { enabled: boolean; now?: Date },
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
 * 2. **已初始化** ⇒ 底色字段 + 信息小节 + 兜底条目，末尾接操作约定段。
 *
 * 「保持你的独立」不在这里：它要排在「你的记忆」之后，是独立的 `humanity:judgment` 段。
 *
 * 逐层用 `?.`/`??` 兜底：**提示词路径上的输入来自设置文档，我们没有权力假设它一定完整**。
 * @param doc - 当前生效的人格文档（可能是形状不对的值）。
 * @param options - `enabled`：模块开关；`now`：日期。
 * @returns 提示词片段；不该注入时返回空串。
 */
function renderPersonaPromptOrThrow(
  doc: PersonaDocument,
  options: { enabled: boolean; now?: Date },
): string {
  if (!options.enabled) return ''

  // 未初始化 ⇒ 注入"第一次见面"。判定**先于**其他一切：未初始化的文档必然是空的，
  // "低于阈值不注入"会把唯一能启动整个流程的话也一起吞掉（鸡生蛋）。
  // 日期在**渲染时**算（`{{变量}}` 只有 provider/model，写别的会让整轮组装抛错）。
  if (doc?.identityCard?.initializedAt === '') return uninitializedPrompt(dayText(options.now))

  const content = collectPersonaContent(doc)
  const hasContent = content.fields.length > 0 || content.sections.length > 0 || content.userDefined.length > 0
  if (!hasContent) return ''

  const blocks = blocksOf(content)
  const lines: string[] = [...blocks.head]
  for (const section of blocks.sections) {
    if (section.items.length === 0) continue
    // 一个小节就是一行（与旧版一致）；这里不再有"只放前 N 条"的中间态。
    lines.push(`- ${section.title}：${section.items.join('；')}`)
  }
  lines.push(...blocks.tail)

  return `${lines.join('\n')}\n\n${MUTABLE_OPS_GUIDE}`
}

/** 本地日期 `YYYY-MM-DD`（未初始化那段开头要写"今天是几号"）。 */
function dayText(now: Date | undefined): string {
  const at = now ?? new Date()
  const month = String(at.getMonth() + 1).padStart(2, '0')
  const day = String(at.getDate()).padStart(2, '0')
  return `${at.getFullYear()}-${month}-${day}`
}
