/**
 * 模块**页签**的布局样式（人格 / 记忆 / 技能 / 自进化四张卡）。
 *
 * 只剩布局：卡片本体是**官方 `Button`**（用户 2026-09-26：「能用原生就用原生，这样连主题
 * 都不用适配了」），边框、底色、hover、焦点环全由 DSH 的组件自己保证，这里只管
 * "四张等宽、一行排开"。用等宽网格而不是自适应：卡片宽度随文案长短变化时，
 * 切换页签会让整排卡片左右跳动。
 * @module deepseek-harness-humanity/client/tab-styles
 */
import type { CSSProperties } from 'react'

/** 模块页签栏：四张等宽卡片。 */
export const tabBar: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
  gap: 8,
  marginTop: 24,
}
