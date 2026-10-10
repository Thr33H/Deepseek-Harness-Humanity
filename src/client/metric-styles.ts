/**
 * **指标行**的样式：「左边一个标签、右边一个当前值」这种一行一对的排版。
 *
 * 为什么从 `styles.ts` 拆出来：指标行在七个页面里复用，是一块能独立成篇的东西 ——
 * "页面外壳怎么排"与"一行指标怎么排"本来也是两件事；而 `styles.ts` 已经贴着
 * 文件行数质量门（≤200 行）。全部走 DSH 设计令牌（P-050），不注入样式表（理由见 `styles.ts` 文件头）。
 * @module deepseek-harness-humanity/client/metric-styles
 */
import type { CSSProperties } from 'react'

/**
 * 指标列表。
 *
 * 用 `dl/dt/dd` 而不是 div：这些行是"指标名 → 当前值"的语义对，读屏与复制粘贴都按对走。
 * `dd` 浏览器默认有 40px 起始缩进，必须显式清零，否则右侧取值会偏离对齐线。
 */
export const metricList: CSSProperties = {
  margin: '0 0 12px',
}

/** 指标行：名称与取值左右分布。 */
export const metricRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  padding: '8px 0',
  borderBottom: '1px solid var(--dsw-alias-border-l2)',
}

/** 指标名：次要色，让右侧的取值（或空态）成为视觉落点。 */
export const metricLabel: CSSProperties = {
  margin: 0,
  color: 'var(--dsw-alias-label-secondary)',
}

/** 指标取值（设置/表单类页面用的小号取值）。 */
export const metricValue: CSSProperties = {
  margin: 0,
  marginInlineStart: 0,
}

/**
 * 总览页的取值：**比标签大、且加粗**（用户 2026-09-26 —— 左侧一行小字、右侧一个醒目数字）。
 *
 * 为什么不直接改 `metricValue`：那个是设置/表单页的行样式（值只是"当前填的数"），
 * 放大加粗会把表单变成仪表盘；总览页才是"一眼看状态"的地方，两种口径各用各的。
 */
export const metricValueStrong: CSSProperties = {
  margin: 0,
  marginInlineStart: 0,
  fontSize: 17,
  fontWeight: 600,
  color: 'var(--dsw-alias-label-primary)',
}

/** 总览页的指标名：比取值小一号，让视觉落点落在右侧的值上。 */
export const metricLabelSmall: CSSProperties = {
  margin: 0,
  fontSize: 13,
  color: 'var(--dsw-alias-label-secondary)',
}
