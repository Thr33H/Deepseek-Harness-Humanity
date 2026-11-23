/**
 * 模型输出 → 领域取值的**收窄**（纯函数，不碰存储）。
 *
 * 为什么单独一个文件：写入（`write.ts`）与归拢（`consolidate.ts`）都在读模型吐出来的
 * JSON 数组，两边要守的规矩一模一样 —— 认不出来就跳过这一条，绝不因为一个字段写错
 * 让整批被丢，也绝不把脏值写进库。规矩只写一遍，两边就不会慢慢长歪。
 * @module humanity/memory/parse
 */
import { MEMORY_ABOUTS, MEMORY_CERTAINTIES } from './constants.js'
import type { MemoryAbout, MemoryCertainty } from './constants.js'

/**
 * 从模型输出里抠出 JSON 数组（模型偶尔会带代码围栏或前后白话）。
 * @param text - 模型输出的正文。
 * @returns 解析出的数组；找不到或不是数组时 `undefined`。
 */
export function extractJsonArray(text: string): unknown[] | undefined {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return undefined
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1))
    return Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * 只认白名单里的 `about`。
 * @param value - 模型给的原始值。
 * @returns 合法取值；不合法时 `undefined`。
 */
export const asAbout = (value: unknown): MemoryAbout | undefined =>
  (MEMORY_ABOUTS as readonly string[]).includes(String(value)) ? (value as MemoryAbout) : undefined

/**
 * 只认白名单里的 `certain`。
 * @param value - 模型给的原始值。
 * @returns 合法取值；不合法时 `undefined`。
 */
export const asCertain = (value: unknown): MemoryCertainty | undefined =>
  (MEMORY_CERTAINTIES as readonly string[]).includes(String(value)) ? (value as MemoryCertainty) : undefined

/**
 * 把代价夹到 0–1。
 * @param value - 模型给的原始值。
 * @returns 合法数字；写不出数字时 `undefined`。
 */
export const asCost = (value: unknown): number | undefined => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : undefined
}
