/**
 * 「带圆圈的 ?」：卡片 / 条目旁边的**功能介绍入口**（用户 2026-09-26 定）。
 *
 * 为什么把解释文字收进提示气泡：一段段灰色说明文字会把真正要看的数据挤下去，而它们大多
 * "看一次就够"。收进 `?` 之后界面上只剩数据与控件；想了解的人悬停（或键盘聚焦）就能看到。
 *
 * 为什么用官方的 `Tooltip` 而不是自己写 hover：它已经处理了定位、翻转、边缘夹取与
 * 焦点可达性，并且只吃 DSH 的设计令牌 —— 自己再写一套只会多一份会漂移的实现（P-050）。
 * 提示内容同时写进 `aria-label`：读屏用户不必悬停也能听到同一句话。
 * @module deepseek-harness-humanity/client/info-hint
 */
import { Button, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TooltipSide } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CSSProperties } from 'react'

import { IconQuestion } from './icons.js'

/**
 * 图标按钮的**尺寸覆盖**：用官方 `Button`（拿到它的 hover 底色、焦点环、禁用态），
 * 只把内边距与高度压到与文字同级 —— 一个 `?` 不该把标题行撑高。
 */
const anchor: CSSProperties = {
  padding: '0 2px',
  height: 18,
  minHeight: 18,
  color: 'var(--dsw-alias-label-tertiary)',
  cursor: 'help',
  lineHeight: 0,
}

/** 提示气泡的属性。 */
export interface InfoHintProps {
  /** 这个卡片 / 条目是做什么的（纯文本；气泡里不渲染 Markdown）。 */
  label: string
  /** 气泡出现的方向，默认在上方（标题旁的位置不会被页面滚动区裁掉）。 */
  side?: TooltipSide
  /** 悬停多久才出现（毫秒）。默认 0：主动去点问号的人不需要再等。 */
  delayMs?: number
}

/**
 * 渲染一个圈问号。
 * @param props - 说明文案与气泡方向。
 * @returns 悬停 / 聚焦即显示说明的图标按钮。
 */
export function InfoHint({ label, side = 'top', delayMs = 0 }: InfoHintProps) {
  return (
    <Tooltip label={label} side={side} delayMs={delayMs} maxWidth={360}>
      <Button size="sm" variant="ghost" style={anchor} aria-label={label}>
        {/* 图标跨版本解析（见 icons.ts）：两版都没有时退回文字问号，绝不让 undefined 进 JSX（React #130）。 */}
        {IconQuestion ? <IconQuestion size={14} /> : <span aria-hidden>?</span>}
      </Button>
    </Tooltip>
  )
}
