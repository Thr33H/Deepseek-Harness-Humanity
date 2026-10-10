/**
 * 独立判断底层指令的开关卡片（人格编辑区里的一行，与身份卡字段分开）。
 *
 * 为什么放在身份卡顶部而不是夹在字段之间（用户 2026-09-23 反馈）：它控制的是**整个 AI 的行为底线**，
 * 不是身份卡里的内容。带边框的小卡片 + 显式状态文字（已开启 / 已关闭）把它和字段区分开。
 *
 * 说明文字收进「?」（用户 2026-09-26）：未封存时"当前未注入"这句**跟着提示走**——
 * 它只解释"为什么现在显示已关闭"，不是每次都要读的正文。
 * @module deepseek-harness-humanity/client/IndependentJudgmentRow
 */
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'

import { InfoHint } from './InfoHint.js'
import { headingWithHint, toggleCard, toggleState, toggleText } from './styles.js'
import type { Translate } from './PersonaIssues.js'

/** 开关卡片的属性。 */
export interface IndependentJudgmentRowProps {
  t: Translate
  checked: boolean
  /** 正在写回或整体只读：两种都禁用控件（避免连点在不同修订号上写两次）。 */
  disabled: boolean
  saving: boolean
  /** 固定层是否已封存：未封存时独立判断**不注入**（封存前注入会被模型当成"可以否决用户的设定"），开关只是预告总开关状态。 */
  sealed: boolean
  onChange: (next: boolean) => void
}

/**
 * 渲染开关卡片。
 * @param props - 字典座位、当前状态与回调。
 * @returns 开关卡片元素。
 */
export function IndependentJudgmentRow({ t, checked, disabled, saving, sealed, onChange }: IndependentJudgmentRowProps) {
  const state = saving
    ? t('persona.independentJudgmentSaving')
    : checked
      ? t('persona.independentJudgmentOn')
      : t('persona.independentJudgmentOff')
  // 未封存时把"生效时机"并进提示：否则用户会以为「已关闭」是被人动过开关。
  const hint = sealed
    ? t('persona.independentJudgmentHint')
    : `${t('persona.independentJudgmentHint')} ${t('persona.independentJudgmentPendingSeal')}`

  return (
    <div style={toggleCard}>
      <div style={toggleText}>
        <span style={headingWithHint}>
          {t('persona.independentJudgment')}
          <InfoHint label={hint} />
        </span>
      </div>
      <div style={toggleState}>
        <span>{state}</span>
        <Switch
          checked={checked}
          disabled={disabled}
          label={t('persona.independentJudgment')}
          title={hint}
          onChange={onChange}
        />
      </div>
    </div>
  )
}
