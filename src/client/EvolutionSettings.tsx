/**
 * 自进化设置面板：调度（P-035）、扫描范围（P-036）、预算（P-051）。
 *
 * 写入走顶层 `humanity` 配置（`update` 深合并：每次只发被改的那一小块，其余字段不动）。
 * 数字输入在 **onBlur 时提交**：每次击键发一次 RPC 既吵又容易撞乐观并发修订号。
 * @module deepseek-harness-humanity/client/evolution-settings
 */
import { Input, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { useEffect, useState } from 'react'

import { ChoiceSelect } from './ChoiceSelect.js'
import type { EvolutionConfigView } from './evolution-config-doc.js'
import { InfoHint } from './InfoHint.js'
import { NS } from './locales.js'
import { headingWithHint, panel, panelTitle } from './styles.js'
import { metricLabel, metricRow } from './metric-styles.js'

type Translate = PropsLocale<typeof NS>['t']

/** 四种调度模式（与宿主 `SCHEDULE_MODES` 一致）。 */
const SCHEDULE_MODES = ['idle', 'daily', 'weekly', 'monthly'] as const

export interface EvolutionSettingsProps {
  t: Translate
  config: EvolutionConfigView
  readOnly: boolean
  busy: string
  onPatch(patch: Record<string, unknown>): void
}

/**
 * 一行文本输入：**受控 + 失焦提交**。
 *
 * 为什么不是 `defaultValue + key`（2026-09-26 审计 C2）：非受控输入只在 `value` 变化时靠 key
 * 重挂载，而写入被拒时 `value` 根本不变 —— 输入框继续显示用户敲的草稿，看起来像"已经存进去了"。
 * 受控 + 外部值变化时同步草稿，界面与真值不再可能分叉。
 */
function DraftRow(props: {
  t: Translate
  labelKey: string
  type: 'text' | 'number'
  value: string
  disabled: boolean
  placeholder?: string
  /** 提交草稿；返回 false = 这次输入不被接受，草稿立刻回到真值（不留一个假象在框里）。 */
  onCommit(next: string): boolean
}) {
  const [draft, setDraft] = useState(props.value)
  // 外部真值变了（宿主回读、别人改了配置）⇒ 草稿跟上；用户正在输入时它不会自己跳。
  useEffect(() => setDraft(props.value), [props.value])
  return (
    <div style={metricRow}>
      <span style={metricLabel}>{props.t(props.labelKey as never)}</span>
      <Input
        type={props.type}
        aria-label={props.t(props.labelKey as never)}
        value={draft}
        placeholder={props.placeholder}
        disabled={props.disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft === props.value) return
          if (!props.onCommit(draft)) setDraft(props.value)
        }}
      />
    </div>
  )
}

/**
 * 一行数字设置（失焦提交）。
 *
 * 空串与非有限数一律**丢弃**并回到真值：`Number('')` 是 `0`，照单全收会把"清空输入框"变成
 * "把上限设成 0"（对每日调用上限来说 0 的含义是"不限"，一次误清空就再也不拦了）。
 * @param props - 字典、标签、当前真值与提交回调。
 * @returns 一行数字输入。
 */
function NumberRow(props: { t: Translate; labelKey: string; value: number; disabled: boolean; onCommit(next: number): void }) {
  return (
    <DraftRow
      t={props.t}
      labelKey={props.labelKey}
      type="number"
      value={String(props.value)}
      disabled={props.disabled}
      onCommit={(next) => {
        const text = next.trim()
        const parsed = Number(text)
        if (text === '' || !Number.isFinite(parsed) || parsed === props.value) return false
        props.onCommit(parsed)
        return true
      }}
    />
  )
}

/** 一行文本设置（失焦提交；空串是合法值——例如时区留空表示"用系统时区"）。 */
function TextRow(props: { t: Translate; labelKey: string; value: string; disabled: boolean; placeholder?: string; onCommit(next: string): void }) {
  return (
    <DraftRow
      t={props.t}
      labelKey={props.labelKey}
      type="text"
      value={props.value}
      disabled={props.disabled}
      placeholder={props.placeholder}
      onCommit={(next) => {
        props.onCommit(next)
        return true
      }}
    />
  )
}

/**
 * 设置面板。
 * @param props - 字典座位、当前配置与写入回调。
 */
export function EvolutionSettings(props: EvolutionSettingsProps) {
  const { t, config, readOnly, busy, onPatch } = props
  const disabled = readOnly || busy !== ''
  const mode = config.schedule.mode
  const scheduled = mode !== 'idle'

  return (
    <section style={panel}>
      <h2 style={{ ...panelTitle, ...headingWithHint }}>
        {t('evolution.schedule')}
        <InfoHint label={t('evolution.schedule.hint')} />
      </h2>
      <div style={metricRow}>
        <span style={metricLabel}>{t('evolution.schedule.mode')}</span>
        <ChoiceSelect
          label={t('evolution.schedule.mode')}
          value={mode}
          choices={SCHEDULE_MODES.map((option) => ({ id: option, label: t(`evolution.schedule.${option}` as never) }))}
          disabled={disabled}
          onChange={(next) => onPatch({ schedule: { mode: next } })}
        />
      </div>

      {scheduled ? (
        <div>
          <TextRow
            t={t}
            labelKey="evolution.schedule.timeOfDay"
            value={config.schedule.timeOfDay}
            disabled={disabled}
            placeholder="03:00"
            onCommit={(next) => onPatch({ schedule: { timeOfDay: next } })}
          />
          {mode === 'weekly' ? (
            <NumberRow t={t} labelKey="evolution.schedule.weekday" value={config.schedule.weekday} disabled={disabled} onCommit={(next) => onPatch({ schedule: { weekday: next } })} />
          ) : null}
          {mode === 'monthly' ? (
            <NumberRow t={t} labelKey="evolution.schedule.monthDay" value={config.schedule.monthDay} disabled={disabled} onCommit={(next) => onPatch({ schedule: { monthDay: next } })} />
          ) : null}
          <TextRow
            t={t}
            labelKey="evolution.schedule.timezone"
            value={config.schedule.timezone}
            disabled={disabled}
            placeholder="Asia/Shanghai"
            onCommit={(next) => onPatch({ schedule: { timezone: next } })}
          />
        </div>
      ) : (
        <NumberRow
          t={t}
          labelKey="evolution.schedule.idleMinutes"
          value={config.schedule.idleMinutes}
          disabled={disabled}
          onCommit={(next) => onPatch({ schedule: { idleMinutes: next } })}
        />
      )}

      <h2 style={panelTitle}>{t('evolution.scan')}</h2>
      <div style={metricRow}>
        <span style={metricLabel}>{t('evolution.scan.subSessions')}</span>
        <Switch
          checked={config.scan.includeSubSessions}
          disabled={disabled}
          label={t('evolution.scan.subSessions')}
          onChange={(next: boolean) => onPatch({ scan: { includeSubSessions: next } })}
        />
      </div>

      <h2 style={{ ...panelTitle, ...headingWithHint }}>
        {t('evolution.budget')}
        <InfoHint label={t('evolution.budget.hint')} />
      </h2>
      <NumberRow t={t} labelKey="evolution.budget.maxSessionsPerRun" value={config.budget.maxSessionsPerRun} disabled={disabled} onCommit={(next) => onPatch({ budget: { maxSessionsPerRun: next } })} />
      <NumberRow t={t} labelKey="evolution.budget.maxEventsPerSession" value={config.budget.maxEventsPerSession} disabled={disabled} onCommit={(next) => onPatch({ budget: { maxEventsPerSession: next } })} />
      <NumberRow t={t} labelKey="evolution.budget.maxInputBytesPerCall" value={config.budget.maxInputBytesPerCall} disabled={disabled} onCommit={(next) => onPatch({ budget: { maxInputBytesPerCall: next } })} />
      <NumberRow t={t} labelKey="evolution.budget.maxOutputTokensPerCall" value={config.budget.maxOutputTokensPerCall} disabled={disabled} onCommit={(next) => onPatch({ budget: { maxOutputTokensPerCall: next } })} />
      <NumberRow t={t} labelKey="evolution.budget.dailyCallCap" value={config.budget.dailyCallCap} disabled={disabled} onCommit={(next) => onPatch({ budget: { dailyCallCap: next } })} />
    </section>
  )
}
