/**
 * 记忆策略的**高级折叠区**：三层独立开关 + 注入条数 + 衰减开关。
 *
 * 与 `MemoryPolicy.tsx`（模式行与状态展示）分家的理由只有两条：文件尺寸，以及"大多数用户只看模式，
 * 少数用户才展开高级"这件事值得在结构上体现出来。改动任意一项都会由控制器打开 `customized`，
 * 模式显示随之变成「自定义」。
 * @module deepseek-harness-humanity/client/memory-advanced
 */
import { Input, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { useState } from 'react'

import { DisclosureHeading } from './DisclosureHeading.js'
import { NS } from './locales.js'
import type { MemoryAdvancedView } from './memory-document.js'
import { InfoHint } from './InfoHint.js'
import { metricLabel, metricRow } from './metric-styles.js'

type Translate = PropsLocale<typeof NS>['t']

/** 四个可切换项（键 → 文案键）。提成常量，让渲染函数只讲结构。 */
const ADVANCED_TOGGLES: ReadonlyArray<[keyof MemoryAdvancedView, string]> = [
  ['longTerm', 'memory.advanced.longTerm'],
  ['work', 'memory.advanced.work'],
  ['session', 'memory.advanced.session'],
  ['decay', 'memory.advanced.decay'],
]

/**
 * 一行可编辑开关 —— **照官方 `DeveloperToolsRow` 的写法**（用户 2026-09-26：
 * 「为啥不像人格的开关按钮一样？或者说像 dsh 设置里的开关按钮一样？是不是可以参考一下 dsh 原生的写法」）。
 *
 * 官方那一行是这么写的（DSH 源码 `ui-settings-general/DeveloperToolsRow.tsx`）：
 * ```tsx
 * const [busy, setBusy] = useState(false)
 * <Switch checked={enabled} disabled={busy} onChange={(next) => {
 *   setBusy(true); void setEnabled(next).finally(() => setBusy(false))
 * }} />
 * ```
 * 关键是 **busy 是每一行自己的 `useState`**，不是整页共享的标记 —— 拨一个开关只影响它自己；
 * 也不加"正在保存…"文字（官方没有，文字一进一出反而让整行抖一下）。
 */
function ToggleRow(props: {
  t: Translate
  labelKey: string
  checked: boolean
  disabled: boolean
  onChange(next: boolean): Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  return (
    <div style={metricRow}>
      <span style={metricLabel}>{props.t(props.labelKey as never)}</span>
      <Switch
        checked={props.checked}
        disabled={props.disabled || busy}
        label={props.t(props.labelKey as never)}
        title={props.t('memory.advanced.switchHint')}
        onChange={(next) => {
          setBusy(true)
          void props.onChange(next).finally(() => setBusy(false))
        }}
      />
    </div>
  )
}

/** 参数：高级开关当前值 + 是否只读 + 改值回调。 */
export interface MemoryAdvancedProps {
  t: Translate
  advanced: MemoryAdvancedView
  readOnly: boolean
  /** 每一行自己管 busy（官方写法），所以这里既不需要整页的 busy，也不需要配置写入标记。 */
  onAdvanced(patch: Partial<MemoryAdvancedView>): Promise<void>
}

/** 高级区的展开内容：三层独立开关 + 注入条数 + 衰减开关 + 恒关的向量项。 */
function AdvancedBody(props: {
  t: Translate
  advanced: MemoryAdvancedView
  disabled: boolean
  onAdvanced(patch: Partial<MemoryAdvancedView>): Promise<void>
}) {
  const { t, advanced, disabled, onAdvanced } = props
  return (
    <div>
      {ADVANCED_TOGGLES.map(([key, labelKey]) => (
        <ToggleRow
          key={key}
          t={t}
          labelKey={labelKey}
          checked={Boolean(advanced[key])}
          disabled={disabled}
          onChange={(next) => onAdvanced({ [key]: next })}
        />
      ))}
      <div style={metricRow}>
        <span style={metricLabel}>{t('memory.advanced.maxInject')}</span>
        {/* 官方 `Input`（不是裸 `<input>`）：边框、底色、焦点环都跟着 DSH 主题走。 */}
        <Input
          type="number"
          min={0}
          max={3}
          aria-label={t('memory.advanced.maxInject')}
          value={advanced.maxInject}
          disabled={disabled}
          onChange={(event) => {
            const next = Number(event.target.value)
            if (Number.isFinite(next)) onAdvanced({ maxInject: next })
          }}
        />
      </div>
      <div style={metricRow}>
        <span style={metricLabel}>{t('memory.advanced.vector')}</span>
        <Tag tone="outline">{t('memory.state.off')}</Tag>
      </div>
    </div>
  )
}

/**
 * 高级折叠区：三层独立开关 + 注入条数 + 衰减开关。
 *
 * 默认收起（P-030：绝大多数用户只需要选模式）；改动任意一项都由控制器打开 `customized`，
 * 模式显示随之变成「自定义」。向量检索只显示、不可用（P-027：MVP 恒关闭）。
 */
export function AdvancedSection({ t, advanced, readOnly, onAdvanced }: MemoryAdvancedProps) {
  const [open, setOpen] = useState(false)
  // 这里不再有"整块一起禁用"：每一行管自己的 busy（见 ToggleRow）。
  const disabled = readOnly
  return (
    <div>
      <DisclosureHeading
        title={t('memory.advanced')}
        hint={<InfoHint label={t('memory.advanced.hint')} />}
        open={open}
        label={t(open ? 'memory.advanced.collapse' : 'memory.advanced.expand')}
        onToggle={() => setOpen((value) => !value)}
      />
      {open ? <AdvancedBody t={t} advanced={advanced} disabled={disabled} onAdvanced={onAdvanced} /> : null}
    </div>
  )
}
