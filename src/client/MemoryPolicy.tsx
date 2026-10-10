import { Button, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

import { ChoiceSelect } from './ChoiceSelect.js'
import { InfoHint } from './InfoHint.js'
import { NS } from './locales.js'
import type { MemoryAdvancedView, MemoryPolicyView } from './memory-document.js'
import { AdvancedSection } from './MemoryAdvanced.js'
import { headingWithHint, panel, panelTitle, tabRow, toggleState } from './styles.js'
import { metricLabel, metricList, metricRow, metricValue } from './metric-styles.js'

type Translate = PropsLocale<typeof NS>['t']

/** 三层的展示顺序（长期 / 区域 / 会话）。 */
const SCOPES = ['long-term', 'workspace', 'session'] as const

/** 四个预设模式（与宿主 `MEMORY_MODES` 一致；模式切换写的是顶层配置）。 */
const MODES = ['off', 'session', 'balanced', 'manual'] as const

export interface MemoryPolicyProps {
  t: Translate
  policy: MemoryPolicyView
  advanced: MemoryAdvancedView
  readOnly: boolean
  /**
   * 忙碌标记。默认就是"条目操作"那一个（整理记忆 / 清理重复条目 / 撤销）；
   * 模式下拉另外用 `configBusy`（见 {@link ModeRow}）。
   */
  busy: string
  /** 配置写入标记：只给模式下拉用（高级开关各行自管 busy，见 `MemoryAdvanced`）。 */
  configBusy?: string
  onMode(mode: string): void
  onAdvanced(patch: Partial<MemoryAdvancedView>): Promise<void>
  onDecay(): void
  onDedupe(): void
  onUndoDedupe(): void
}

/** 模式下拉的候选项：四个预设 + 调过高级开关时的「自定义」（当前值不在表里就补上）。 */
function modeChoices(t: Translate, policy: MemoryPolicyView): Array<{ id: string; label: string }> {
  const choices: Array<{ id: string; label: string }> = MODES.map((mode) => ({
    id: mode,
    label: t(`memory.mode.${mode}` as never),
  }))
  if (policy.customized && !MODES.includes(policy.mode as never)) {
    choices.push({ id: policy.mode, label: t('memory.mode.custom') })
  }
  return choices
}

/** 模式行：预设下拉（官方 `Menu`）+ 记忆维护按钮组。 */
function ModeRow(props: {
  t: Translate
  policy: MemoryPolicyView
  readOnly: boolean
  busy: string
  configBusy: string
  onMode(mode: string): void
  onDecay(): void
  onDedupe(): void
  onUndoDedupe(): void
}) {
  // 各管各的：拨开关（advanced）不该让模式下拉变灰，改模式（mode）也不该让维护按钮变灰 ——
  // "整块一起变灰"正是用户看到的"闪一下"。
  const disabled = props.readOnly || props.busy !== ''
  const modeDisabled = props.readOnly || props.configBusy === 'mode'
  return (
    <div style={metricRow}>
      <span style={metricLabel}>{props.t('memory.policy.mode')}</span>
      <ChoiceSelect
        label={props.t('memory.policy.mode')}
        value={props.policy.mode}
        choices={modeChoices(props.t, props.policy)}
        disabled={modeDisabled}
        onChange={props.onMode}
      />
      <div style={tabRow}>
        <Button size="sm" variant="primary" disabled={disabled} onClick={props.onDecay}>
          {props.t('memory.decayAction')}
        </Button>
        <Button size="sm" variant="outline" disabled={disabled} onClick={props.onDedupe}>
          {props.t('memory.dedupeAction')}
        </Button>
        {/* 合并判据是一段"要不要信它"的说明：挂在按钮旁边，而不是在卡片底下铺一行灰字。 */}
        <InfoHint label={props.t('memory.dedupeHint')} />
        <Button size="sm" variant="ghost" disabled={disabled} onClick={props.onUndoDedupe}>
          {props.t('memory.undoDedupeAction')}
        </Button>
      </div>
    </div>
  )
}

/**
 * 一行"开关"展示：这两个开关由模式推导，不可单独拨。
 *
 * 用**官方 `Switch`**（禁用）+ 状态词：和能拨的那些行长得一样，一眼看出"这是同一类东西、
 * 只是这里不让动"。状态词放在滑块**左边**（与独立判断模式那张卡同一版式），免得文字贴着滑块读成一坨。
 */
function StateRow({ t, labelKey, on }: { t: Translate; labelKey: string; on: boolean }) {
  return (
    <div style={metricRow}>
      <dt style={metricLabel}>{t(labelKey as never)}</dt>
      <dd style={{ ...metricValue, ...toggleState }}>
        <span>{on ? t('memory.state.on') : t('memory.state.off')}</span>
        <Switch checked={on} disabled label={t(labelKey as never)} onChange={() => undefined} />
      </dd>
    </div>
  )
}

/**
 * 记忆策略卡片：显示**当前生效**策略（P-030），并允许切换模式。
 *
 * 为什么自动注入 / 衰减归档只显示不单独开关：它们是模式推导出来的（`resolveMemoryPolicy`），
 * 单独放一个开关就会出现"模式说关、这个开关说开"的矛盾。细项开关属于步骤 9 的配置 schema。
 * @param props - 策略、忙碌标记与模式切换回调。
 * @returns 策略卡片。
 */
export function MemoryPolicy(props: MemoryPolicyProps) {
  const { t, policy, readOnly, busy, configBusy = '', onMode } = props
  return (
    <section style={panel}>
      <h2 style={{ ...panelTitle, ...headingWithHint }}>
        {t('memory.policy')}
        <InfoHint label={t('memory.policy.hint')} />
      </h2>
      <ModeRow
        t={t}
        policy={policy}
        readOnly={readOnly}
        busy={busy}
        configBusy={configBusy}
        onMode={onMode}
        onDecay={props.onDecay}
        onDedupe={props.onDedupe}
        onUndoDedupe={props.onUndoDedupe}
      />
      <dl style={metricList}>
        <StateRow t={t} labelKey="memory.policy.autoInject" on={policy.autoInject} />
        <StateRow t={t} labelKey="memory.policy.decay" on={policy.decay} />
        <div style={metricRow}>
          <dt style={metricLabel}>{t('memory.policy.scopes')}</dt>
          <dd style={metricValue}>
            {/* 只列**生效中**的层（用户 2026-09-26：「关掉了直接不显示就行」）——
                摆一排灰标签只是把"没开"这件事重复说一遍。 */}
            {SCOPES.filter((scope) => policy.scopes[scope]).map((scope) => (
              <Tag key={scope} tone="quiet">
                {t(`memory.scope.${scope}` as never)}
              </Tag>
            ))}
            {SCOPES.some((scope) => policy.scopes[scope]) ? null : (
              <span style={metricLabel}>{t('memory.policy.scopesNone')}</span>
            )}
          </dd>
        </div>
      </dl>
      <AdvancedSection t={t} advanced={props.advanced} readOnly={readOnly} onAdvanced={props.onAdvanced} />
    </section>
  )
}
