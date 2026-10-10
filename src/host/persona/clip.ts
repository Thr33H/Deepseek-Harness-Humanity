/**
 * 单条内容的**软上限裁剪**：超过 {@link VALUE_SOFT_LIMIT} 的条目裁短并留省略号。
 *
 * 为什么单独一个文件：`clip` 被"挑内容"（`render-content`）与"排字"（`render-fit`）两侧共用，
 * 而"裁多长、留什么标记"是产品口径（P-015：只警告不硬拒绝，但注入时不能无限长）——
 * 它不该跟着拟合算法或渲染顺序一起改。`isClippedItem` 是同一口径的**判据**，
 * 与 `clip` 放在一起，才不可能出现"裁了但没人知道"（2026-09-26 审计 P1）。
 * @module humanity/persona/clip
 */
import { VALUE_SOFT_LIMIT } from './constants.js'

/** 单条值超过 `VALUE_SOFT_LIMIT` 时的截断标记。 */
export const ELLIPSIS = '…'

/**
 * 把一条内容裁到软上限。
 * @param value - 原始条目。
 * @returns 裁剪后的文本。
 */
export function clip(value: string): string {
  const text = value.trim()
  return text.length <= VALUE_SOFT_LIMIT ? text : `${text.slice(0, VALUE_SOFT_LIMIT)}${ELLIPSIS}`
}

/**
 * 该条进提示词时是否会被 {@link clip} 裁短。
 *
 * 为什么要有它（2026-09-26 审计 P1）：被裁的条目**照样进得去**，于是账目上 `injected` 照加、
 * `dropped` 是 0，工作台显示"24/24 条全部进提示词"—— 而其中一条的尾巴其实没进去。
 * @param item - 原始条目。
 * @returns 会被裁短时为 true。
 */
export function isClippedItem(item: string): boolean {
  return item.trim().length > VALUE_SOFT_LIMIT
}
