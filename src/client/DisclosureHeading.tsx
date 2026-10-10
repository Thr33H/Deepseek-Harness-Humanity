/**
 * 可折叠分区的**标题行**：整行可点、箭头在**右**。
 *
 * 为什么是这个形状（用户 2026-09-26）：
 * - 「展开的按钮没有了」—— 官方的 `DisclosureRow`（对话流里的那种）把箭头放在**左**边，
 *   放在设置类卡片里就看不见"这里能展开"；
 * - 而 **DSH 自己的设置页**（终端 / Agent 肢体 / Subagent 那些分区）箭头就在**右边**，
 *   整行可点、右侧是控件位。
 *
 * 所以这里照设置页：左标题（可带 `?`），右侧一个**官方 `Button`**（ghost + chevron 图标），
 * 带 `aria-expanded` 与无障碍名。壳仍然是我们用设计令牌画的 —— 0.1.5 里没有 Card/Section 原语（P-058）。
 * @module deepseek-harness-humanity/client/disclosure-heading
 */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactNode } from 'react'

import { IconChevronDown, IconChevronRight } from './icons.js'
import { metricLabel, metricRow } from './metric-styles.js'
import { headingWithHint } from './styles.js'

/** 属性：标题、可选提示、展开状态与切换回调。 */
export interface DisclosureHeadingProps {
  title: string
  /** 标题旁的「?」说明（可选）。 */
  hint?: ReactNode
  open: boolean
  /** 按钮的无障碍名（读屏用户听到的是"展开/收起 高级"，而不是一个光秃秃的箭头）。 */
  label: string
  onToggle(): void
}

/**
 * 渲染一行可折叠标题。
 * @param props - 标题、说明、展开状态与回调。
 * @returns 标题行（右侧是官方的展开按钮）。
 */
export function DisclosureHeading({ title, hint, open, label, onToggle }: DisclosureHeadingProps) {
  return (
    <div style={metricRow}>
      <span style={{ ...metricLabel, ...headingWithHint }}>
        {title}
        {hint}
      </span>
      <Button size="sm" variant="ghost" aria-expanded={open} aria-label={label} onClick={onToggle}>
        {open
          ? IconChevronDown
            ? <IconChevronDown size={14} />
            : <span aria-hidden>▾</span>
          : IconChevronRight
            ? <IconChevronRight size={14} />
            : <span aria-hidden>▸</span>}
      </Button>
    </div>
  )
}
