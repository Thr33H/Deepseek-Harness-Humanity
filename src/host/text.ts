/**
 * 套件共用的**纯文本清理**。
 *
 * 为什么单独一个文件：人格（身份卡/可变层）与记忆（记忆正文）都要"落盘前先洗掉噪音"，
 * 同一份规则写两遍早晚会分叉（一边删了 ANSI、另一边只删 ESC，用户看到的就是
 * "人格里干净、记忆里带 `[31m` 残渣"这种说不清的差异）。
 *
 * 规则（真机反馈缺陷 ④ 定下，两边一致）：
 * 1. 先整体删掉 ANSI 转义序列 —— `ESC[31m`（颜色）、`ESC]0;标题 BEL`（改窗口标题）这类；
 *    只删 ESC 会留下 `[31m` 这种**残渣**，而残渣和原文一样是噪音。
 * 2. 再删剩下的控制字符：C0（U+0000–U+001F）里**保留 `\n` `\r` `\t`**（换行与制表是正常排版），
 *    其余一律删除；额外删掉 DEL（U+007F）。
 *
 * 为什么选"净化"而不是"拒绝"：控制字符几乎总是**粘贴/序列化带进来的噪音**，
 * 不是用户的表达意图；为此让一次正常写入失败，是把噪音的代价转嫁给用户。
 * 为什么必须在**校验之前**做：净化后再校验，才谈得上"校验看到的就是落盘的内容"。
 * @module humanity/text
 */

/**
 * 剥掉文本里的控制字符与 ANSI 转义序列。
 * @param value - 原始文本。
 * @returns 去掉转义序列与控制字符后的文本。
 */
export function stripControlChars(value: string): string {
  return (
    value
      // CSI：ESC [ 参数 中间字节 终止字节（颜色、光标、清屏……）。
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
      // OSC：ESC ] … BEL 或 ST（改窗口/标签标题）。未闭合的 OSC 交给下面的控制字符清理。
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
      // 其余两字符转义（ESC + 单个字符）。
      .replace(/\u001b[@-Z\\-_]/g, '')
      // 剩下的裸控制字符（含上面漏掉的 ESC）与 DEL。
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  )
}

/**
 * 常见否定标记（**极性判据**）。记忆冲突检测与人格去重共用同一份，理由同本模块开头：
 * 判断"这句话是不是那句话的反面"只能有一套词表，两套早晚分叉。
 *
 * 只收**单字/短语级**的常见否定，不收句法结构：我们从"用户说了什么"里读不出严格的极性，
 * 也不该假装读得出。多收一个词就多一类误报。
 */
export const NEGATION_MARKERS = ['不', '别', '没', '无', '避免', '讨厌', '禁止', '拒绝', '莫', '勿'] as const

/**
 * 去掉全部否定标记（用于判断"去掉否定后是不是同一件事"）。
 * @param text - 原始文本。
 * @returns 去掉否定标记后的文本。
 */
export function withoutNegations(text: string): string {
  let out = text
  for (const marker of NEGATION_MARKERS) out = out.split(marker).join('')
  return out
}

/**
 * 是否带否定。
 * @param text - 原始文本。
 * @returns 含任一否定标记时为 true。
 */
export function hasNegation(text: string): boolean {
  return NEGATION_MARKERS.some((marker) => text.includes(marker))
}

/**
 * 两条文本是否**极性相反**（一条带否定、另一条不带）。
 *
 * 这是"反面，不是重复"的最省事判据，两处都在用：
 * - 记忆：去掉否定后同句 ⇒ 判为**冲突**（`conflictsWith`）；
 * - 人格去重：Dice 相似度再高也**不许并**（`isNearDuplicateItem`）。
 *
 * 真机实证为什么人格侧必须有这一条：「不要在我工作时打扰我」与「要在我工作时打扰我」
 * Dice = 0.941，只差一个"不"字 —— 旧逻辑会把后者当重复并掉，等于**替用户改了意思**。
 * @param left - 一条文本。
 * @param right - 另一条文本。
 * @returns 极性相反时为 true。
 */
export function opposesByNegation(left: string, right: string): boolean {
  return hasNegation(left) !== hasNegation(right)
}

/**
 * 把文本里的 `{{` 拆开，避免被系统提示词引擎当成变量引用。
 *
 * 为什么必须有这一步（审计 S1-3）：DSH 的 `assemble()` 会用 `interpolate()` 处理每个
 * section/context 的文本，而它对 `{{` 的处理是**要么解析成变量、要么抛错**：
 * `{{name}}` 未注册会抛、`{{` 之后无论多远只要还有 `}}` 也会抛。抛错没有兜底，
 * 会毁掉整轮 pre-step。人格与记忆都是**用户/模型写的自然语言**，里面完全可能出现
 * 模板语法或代码片段（`{{ ... }}`），所以进入 section 之前必须中和掉。
 *
 * 为什么是拆成 `{ {` 而不是加反斜杠：`interpolate()` 不认转义序列，`\{\{` 里仍是
 * 一个完整的 `{{`，照样会被扫描到。只有让它**不再是 `{{` 这个连续两字符序列**才有效。
 *
 * ⚠️ **三连括号的漏洞**（2026-09-26 审计 P7）：旧实现是 `replaceAll('{{', '{ {')`，而
 * `replaceAll` 是**非重叠**替换 —— `{{{` 会被换成 `{ {{`，里面**仍然有一个 `{{`**，等于没中和。
 * 最坏组合是 Handlebars 的三花括号 `{{{x}}}`（同时有 `{{` 和 `}}`）：`interpolate()` 会拿
 * `{{x}}` 去查变量表，查不到就抛 `unknown prompt variable`，整轮 pre-step 失败。
 * 现在改成"每个后面还跟着 `{` 的 `{` 后面插一个空格"：`{{` ⇒ `{ {`、`{{{` ⇒ `{ { {`、
 * `{{{{` ⇒ `{ { { {`。这个变换**幂等**（处理过的文本里 `{` 后面永远是空格），可以放心重复调用。
 * @param value - 即将进入提示词段的文本。
 * @returns 中和后的文本；连续的 `{` 被空格拆开，其余一字不动。
 */
export function neutralizePromptVars(value: string): string {
  return value.replace(/\{(?=\{)/g, '{ ')
}
