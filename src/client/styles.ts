import type { CSSProperties } from 'react'

/**
 * 工作台的排布样式。
 *
 * 为什么用内联样式 + CSS 变量，而不是注入一张样式表：
 * 1. 变量全部来自 DSH 自己的设计令牌（`--dsw-*` / `--dsh-*`），所以跟随主题与深色模式，
 *    不另造视觉系统（P-050）；
 * 2. 客户端插件 bundle 的 CSS 副作用要在 factory 物化时注入、卸载时收回，而面板结构还在演进；
 *    内联样式没有注入点、没有全局类名，也就没有泄漏和清理问题。
 *    等到需要 hover 与媒体查询时，再统一引入样式表。
 */

/** 页面外壳：可滚动、限宽，背景交给框架（自己刷底色会和主题打架）。 */
export const page: CSSProperties = {
  boxSizing: 'border-box',
  height: '100%',
  overflowY: 'auto',
  padding: '32px 32px 56px',
  background: 'transparent',
  color: 'var(--dsw-alias-label-primary)',
  fontFamily: 'var(--dsw-font-family)',
  fontSize: 'var(--dsh-content-font-size, 14px)',
  lineHeight: 1.6,
}

/** 内容列：限宽以保证可读性，居中。 */
export const column: CSSProperties = {
  maxWidth: 880,
  margin: '0 auto',
}

/** 标题行：标题与右侧操作按钮同排。 */
export const titleRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
}

/** 页面主标题。 */
export const title: CSSProperties = {
  margin: 0,
  fontSize: 22,
  fontWeight: 600,
  letterSpacing: '0.01em',
}

/** 标题下的一句说明。 */
export const subtitle: CSSProperties = {
  margin: '8px 0 0',
  color: 'var(--dsw-alias-label-secondary)',
}

/** 一块内容面板：细边框 + 卡片底色，与 DSH 的层叠关系一致。 */
export const panel: CSSProperties = {
  marginTop: 24,
  padding: '16px 20px',
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: 12,
  background: 'var(--dsw-alias-bg-layer-1)',
}

/** 面板内的小标题。 */
export const panelTitle: CSSProperties = {
  margin: '0 0 8px',
  fontSize: 14,
  fontWeight: 600,
  color: 'var(--dsw-alias-label-primary)',
}

/**
 * 标题与它的「?」同一行（用户 2026-09-26：解释文字收进提示气泡，标题旁只留一个圈问号）。
 * 用 flex 而不是 `verticalAlign`：SVG 图标的基线在不同字号下会飘，flex 对齐是确定的。
 */
export const headingWithHint: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
}

/** 字段下方的辅助说明（次要字号）。 */
export const hint: CSSProperties = {
  margin: 0,
  color: 'var(--dsw-alias-label-secondary)',
}

/**
 * 独立功能开关的卡片：一个带边框的小行，与人格编辑区**视觉分隔**。
 *
 * 与列表里的卡片（`card-styles.ts`）分开：那是"一条数据"，这里是"一个能改变行为的功能"，
 * 需要更像控件、能一眼看出与旁边内容不是同一类东西。
 */
export const toggleCard: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 16,
  marginTop: 16,
  padding: '12px 16px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 10,
  background: 'var(--dsw-alias-bg-layer-1)',
}

/** 开关卡片左侧的文案块（标签 + 一句说明）。 */
export const toggleText: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
}

/** 开关卡片右侧的状态文字（已开启 / 已关闭 / 保存中）。 */
export const toggleState: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: '0.9em',
}

/** 页内的按钮组（模块页签本身已改用 `tab-styles.ts` 的卡片）。 */
export const tabRow: CSSProperties = { display: 'flex', gap: 8 }
