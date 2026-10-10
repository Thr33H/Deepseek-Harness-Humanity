/**
 * 记忆列表的**展示用纯函数**：相对时间与本地过滤。
 *
 * 与 `memory-document.ts`（值 → 状态）分家的理由只有两条：文件尺寸，以及"解析远端值"与
 * "给界面算显示"是两件事，分开读更清楚。两者都是纯函数，单独可测。
 * @module deepseek-harness-humanity/client/memory-view
 */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

import { NS } from './locales.js'
import type { MemoryEntryView } from './memory-document.js'

/** 字典座位（与记忆各页同一个 NS）。 */
type Translate = PropsLocale<typeof NS>['t']

/**
 * 相对时间（今天 / 昨天 / 3 天前）。
 *
 * 为什么不复用宿主的 `relativeTimeOf`：那个模块会顺着 `write.ts` 把 zod 与整套存储代码
 * 拖进浏览器包。规则很短，客户端自己算一份，只显示"多久以前"这一个用途。
 *
 * ⚠️ 文案走字典（2026-09-26 审计 C4）：旧实现把「今天 / 昨天 / 3天前」硬写在代码里，
 * 英文界面下这一格是页面里唯一的中文 —— 整页都翻了、就它没翻。
 * @param t - 字典座位。
 * @param stamp - ISO 时间戳。
 * @param nowMs - 当前时刻（毫秒）；缺省取现在。
 * @returns 相对时间；无法解析时返回空串（界面宁可不显示，也不显示 "NaN天前"）。
 */
export function formatAge(t: Translate, stamp: string, nowMs: number = Date.now()): string {
  const at = Date.parse(stamp)
  if (!Number.isFinite(at)) return ''
  const days = Math.floor(Math.max(0, nowMs - at) / 86_400_000)
  if (days === 0) return t('memory.age.today')
  if (days === 1) return t('memory.age.yesterday')
  if (days < 30) return t('memory.age.days', { days: String(days) })
  if (days < 365) return t('memory.age.months', { months: String(Math.floor(days / 30)) })
  return t('memory.age.years', { years: String(Math.floor(days / 365)) })
}

/**
 * 本地过滤：按状态分组 + 关键词（正文或标签）。
 *
 * 放在这里（而不是控制器里）是因为它是纯函数：给定列表、状态与搜索词就有确定结果，
 * 不碰通道也不碰状态容器，可以单独测。
 * @param entries - 全部条目。
 * @param status - 要显示的状态（active / pending / archived）。
 * @param query - 搜索词；空白表示不过滤。
 * @returns 过滤后的条目（保持宿主给的顺序）。
 */
export function filterEntries(
  entries: readonly MemoryEntryView[],
  status: string,
  query: string,
): MemoryEntryView[] {
  const needle = query.trim().toLowerCase()
  return entries.filter((entry) => {
    if (entry.status !== status) return false
    if (needle === '') return true
    return (
      entry.content.toLowerCase().includes(needle) ||
      entry.tags.some((tag) => tag.toLowerCase().includes(needle))
    )
  })
}

/**
 * 收集已知的区域（工作区）列表 —— 作用域下拉的候选项。
 *
 * 从**当前条目集**里收集，不硬编码、不猜：区域就是"这条记忆当时所在的工作目录"，
 * 只有库里真的出现过才算已知（列一堆空目录只会误导人）。
 * @param entries - 全部条目（含各分组）。
 * @returns 去重后的区域路径（首次出现顺序）。
 */
export function collectRegions(entries: readonly MemoryEntryView[]): string[] {
  const seen = new Set<string>()
  for (const entry of entries) {
    if (entry.scope === 'workspace' && entry.ownerId !== '') seen.add(entry.ownerId)
  }
  return [...seen]
}
