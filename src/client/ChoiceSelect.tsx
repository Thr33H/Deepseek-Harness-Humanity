/**
 * 「从几个里选一个」的下拉：**DSH 原生样式**（官方 `Button` 触发 + 官方 `Menu` 列表）。
 *
 * 为什么不用浏览器原生 `<select>`（用户 2026-09-26：「能用原生就用原生，这样连主题都不用适配了」）：
 * `<select>` 由系统绘制，只认 `color-scheme`，不认 DSH 的设计令牌 —— 深色主题下它就是一块
 * 白底黑字的补丁（真机截图里最扎眼的一处），而且 hover / 焦点环 / 键盘导航全都另成一套。
 * 换成官方原语之后，主题、间距、圆角、焦点环、选中勾、外点关闭、Esc 与方向键全由 DSH 自己保证。
 *
 * `portal` 把列表挂到 `document.body`：工作台整页是一个**滚动容器**，就地绝对定位的列表会被
 * 容器底边裁掉（记忆列表几十条，最后几条必然中招）。
 * @module deepseek-harness-humanity/client/choice-select
 */
import { Button, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CSSProperties } from 'react'
import { useState } from 'react'

import { IconChevronDown } from './icons.js'

/** 一个候选项：`id` 是回传值，`label` 是给人看的。 */
export interface Choice {
  id: string
  label: string
}

/** 下拉的属性。 */
export interface ChoiceSelectProps {
  /** 无障碍名（读屏念它，而不是当前值）。 */
  label: string
  /** 当前选中项的 id；不在候选项里时按钮如实显示这个值（不假装选中了别人）。 */
  value: string
  choices: readonly Choice[]
  disabled?: boolean
  /** 触发按钮的文字色：作用域那类"颜色即归属"的场合用。 */
  color?: string
  onChange(id: string): void
}

/**
 * 渲染一个原生风格的下拉。
 * @param props - 无障碍名、当前值、候选项与改值回调。
 * @returns `Button` 触发的 `Menu`。
 */
export function ChoiceSelect({ label, value, choices, disabled = false, color, onChange }: ChoiceSelectProps) {
  const [open, setOpen] = useState(false)
  const current = choices.find((choice) => choice.id === value)
  const style: CSSProperties | undefined = color === undefined ? undefined : { color }

  return (
    <Menu
      open={open}
      portal
      anchor={
        <Button
          size="sm"
          variant="outline"
          style={style}
          disabled={disabled}
          aria-label={label}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((was) => !was)}
        >
          {current?.label ?? value}
          {IconChevronDown ? <IconChevronDown size={14} /> : <span aria-hidden>▾</span>}
        </Button>
      }
      items={choices.map((choice) => ({ id: choice.id, label: choice.label }))}
      selectedId={value}
      onSelect={(id) => {
        setOpen(false)
        onChange(id)
      }}
      onClose={() => setOpen(false)}
    />
  )
}
