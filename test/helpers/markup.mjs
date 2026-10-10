/**
 * 渲染结果（HTML 字符串）的**读法**：界面纪律的机械判据。
 *
 * 为什么单独一个文件：不止一处要断言同一条纪律 ——「说明收进 `?` 里，不铺在正文里」
 * （用户 2026-09-26）。两处各抄一份实现，等于给同一条裁决留两个会各自漂移的口径。
 *
 * 前提：客户端 bundle 的原语替身把 `Tooltip` 画成 `data-tooltip="…"`、
 * 把圈问号画成 `data-icon="question"`（见 `client-bundle.mjs` 与 `client-bundle.test.mjs`）。
 */

/**
 * 数一数界面上有几个「带圆圈的 ?」。
 * @param markup - `renderToStaticMarkup` 的输出。
 * @returns 圈问号的个数。
 */
export function countHints(markup) {
  return markup.split('data-icon="question"').length - 1
}

/**
 * 去掉提示气泡与无障碍标签，剩下的就是**用户直接看得见**的文字。
 * @param markup - `renderToStaticMarkup` 的输出。
 * @returns 剥离提示与 aria-label 之后的正文。
 */
export function visibleText(markup) {
  return markup.replace(/data-tooltip="[^"]*"/g, '').replace(/aria-label="[^"]*"/g, '')
}

/**
 * 卡片骨架的**渲染特征串**（`card-styles.cardLayout` 的 grid 列定义）。
 *
 * 为什么钉这个：用户 2026-09-26 要求"所有条目风格统一"—— 统一在实现上就是**同一组列宽**。
 * 三个页面（记忆 / 技能 / 自进化）的条目卡都必须渲染出这一串，才算真的走同一副骨架。
 * 改 `card-styles.ts` 的列定义时，这里要一起改（测试会当场变红，这正是它存在的意义）。
 */
export const CARD_SKELETON = 'grid-template-columns:minmax(96px, 160px) minmax(0, 1fr) max-content'
