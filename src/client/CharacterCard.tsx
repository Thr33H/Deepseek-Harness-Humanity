/**
 * 「性格」卡片：四根轴的范围（笼子）、此刻的位置、以及当初为什么这么定。
 *
 * ### 为什么单独一张卡
 *
 * 它和底色是两种数据：底色是**她是谁**（一段话，对 Agent 封存），性格是**她能变到哪儿**（四个范围）。
 * 但两者又在同一件事上咬合 —— 笼子是在初始化时**从底色推导出来的**（见 `persona/init.ts`），
 * 所以它与底色、信息排在同一列里，位置在最后。
 *
 * ### 为什么范围只显示、不编辑（用户 2026-11-20 定）
 *
 * 范围是"天生"这一层：初始化时由她读自己的底色推导一次，之后就定住了。
 * 界面上做成输入框会把它变成一个"随时可以调的属性面板"，而它本来的意思是
 * **"像我这样一个人，这辈子只能到这儿"** —— 那是不可调的东西。
 *
 * 理由是唯一可编辑的一格：它解释"这个范围凭什么成立"，会随着她越来越了解自己而写得更准。
 * @module deepseek-harness-humanity/client/CharacterCard
 */
import type { CSSProperties } from 'react'

import { CHARACTER_AXES, CHARACTER_AXIS_TEXT } from '../host/persona/constants.js'
import type { CharacterAxis } from '../host/persona/types.js'
import { CardSaveButton, type CardProps } from './PersonaCards.js'
import { textarea } from './editor-styles.js'
import { InfoHint } from './InfoHint.js'
import { headingWithHint, panel, panelTitle } from './styles.js'

/** 一根轴占一块：标题行（名字 + 范围）→ 轨道 → 理由。 */
const axisBlock: CSSProperties = {
  padding: '10px 0',
  borderTop: '1px solid var(--dsw-alias-border-l2)',
}

/** 标题行：轴名在左，范围在右。 */
const axisHead: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: 12,
  fontSize: 13,
}

/** 轴名。 */
const axisName: CSSProperties = { color: 'var(--dsw-alias-label-primary)' }

/** 右上角那一串范围文字（只读）。 */
const axisRange: CSSProperties = { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 }

/**
 * 轨道：底色是一条浅横线，她天生的那一段用半透明的品牌色铺出来，当前值是一根竖线。
 *
 * 纯展示，不接鼠标事件 —— 它回答"我现在在哪儿、还剩多少余地"，不负责"我要把它拖到哪儿"。
 */
const track: CSSProperties = {
  position: 'relative',
  height: 6,
  margin: '10px 0 10px',
  borderRadius: 3,
  background: 'var(--dsw-alias-border-l2)',
}

/** 她天生能走的那一段。 */
const span: CSSProperties = {
  position: 'absolute',
  top: 0,
  bottom: 0,
  borderRadius: 3,
  background: 'var(--dsw-alias-brand-primary)',
  opacity: 0.4,
}

/** 此刻的位置。 */
const marker: CSSProperties = {
  position: 'absolute',
  top: -4,
  width: 2,
  height: 14,
  borderRadius: 1,
  background: 'var(--dsw-alias-label-primary)',
  transform: 'translateX(-1px)',
}

/** 理由那一格：贴着轨道下方、占满卡片宽度，两行高度起。 */
const reasonBox: CSSProperties = { ...textarea, minHeight: 44 }

/** 都没推导出来时的说明。 */
const pending: CSSProperties = { fontSize: 13, color: 'var(--dsw-alias-label-secondary)', margin: '6px 0 0' }

/** 把 `0–1` 的数变成轨道上的百分比文字。 */
const percent = (value: number): string => `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`

/** 范围的显示文字：两位小数，中间一个连接号。 */
const rangeText = (axis: CharacterAxis): string => `${axis.min.toFixed(2)} – ${axis.max.toFixed(2)}`

/**
 * 一根轴的轨道。
 * @param props - 这根轴。
 * @returns 轨道元素（天生区间 + 此刻位置）。
 */
function AxisTrack({ axis }: { axis: CharacterAxis }) {
  const low = Math.min(axis.min, axis.max)
  const high = Math.max(axis.min, axis.max)
  return (
    <div style={track} aria-hidden>
      <div style={{ ...span, left: percent(low), width: percent(high - low) }} />
      <div style={{ ...marker, left: percent(axis.value) }} />
    </div>
  )
}

/**
 * 渲染性格卡片。
 * @param props - 字典座位、控制器与当前快照。
 * @returns 性格卡片。
 */
export function CharacterCardEditor({ t, controller, state }: CardProps) {
  const readOnly = state.saving || !state.writable
  const character = state.draft.character
  const ready = character.derivedAt !== '' && character.axes.length > 0

  return (
    <section style={panel}>
      <h2 style={{ ...panelTitle, ...headingWithHint }}>
        {t('persona.characterCard')}
        <InfoHint label={t('persona.characterHint')} />
        <CardSaveButton t={t} controller={controller} state={state} />
      </h2>

      {ready ? (
        CHARACTER_AXES.map((key) => {
          const axis = character.axes.find((item) => item.key === key)
          const label = CHARACTER_AXIS_TEXT[key].name
          if (axis === undefined) {
            return (
              <div key={key} style={axisBlock}>
                <div style={axisHead}>
                  <span style={axisName}>{label}</span>
                  <span style={axisRange}>{t('persona.characterAxisMissing')}</span>
                </div>
              </div>
            )
          }
          return (
            <div key={key} style={axisBlock}>
              <div style={axisHead}>
                <span style={axisName}>{label}</span>
                <span style={axisRange}>
                  {t('persona.characterRange')} {rangeText(axis)}
                </span>
              </div>
              <AxisTrack axis={axis} />
              <textarea
                style={reasonBox}
                value={axis.reason}
                rows={2}
                aria-label={`${label} ${t('persona.characterReason')}`}
                placeholder={t('persona.characterReasonPlaceholder')}
                readOnly={readOnly}
                onChange={(event) => controller.setCharacterReason(key, event.target.value)}
              />
            </div>
          )
        })
      ) : (
        <p style={pending}>{t('persona.characterPending')}</p>
      )}
    </section>
  )
}
