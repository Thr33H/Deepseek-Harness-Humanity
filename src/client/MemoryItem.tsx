import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'

import {
  card,
  cardActions,
  cardBody,
  cardLayout,
  cardLine,
  cardList,
  cardMeta,
  cardNote,
  cardTags,
  cardTitle,
} from './card-styles.js'
import { ChoiceSelect } from './ChoiceSelect.js'
import { NS } from './locales.js'
import type { MemoryEntryView } from './memory-document.js'
import { formatAge } from './memory-view.js'
import { SCOPE_COLORS } from './memory-styles.js'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

type Translate = PropsLocale<typeof NS>['t']

/** 这条记忆在界面上属于哪一组（决定给出哪些操作）。 */
export type MemoryItemVariant = 'pending' | 'active' | 'archived'

/** 一条记忆可发起的操作（与宿主的 `MEMORY_OPS` 同名）。 */
export type MemoryItemOp = 'confirm' | 'reject' | 'archive' | 'restore' | 'pin' | 'unpin' | 'remove'

export interface MemoryItemProps {
  t: Translate
  entry: MemoryEntryView
  variant: MemoryItemVariant
  /** 正在进行的操作标记；与这条相关时按钮禁用（避免连点）。 */
  busy: string
  readOnly: boolean
  /** 已知的区域（工作区路径）列表：作用域下拉的候选项，从当前条目集收集，不硬编码。 */
  regions?: readonly string[]
  onOp(op: MemoryItemOp, entry: MemoryEntryView): void
  /** 改归属（长期 ⇄ 区域）；缺省时下拉只读。 */
  onRescope?(entry: MemoryEntryView, scope: string, ownerId: string): void
}

/** 按分组给出操作按钮：待确认先确认/拒绝，活跃可固定/归档/删除，归档可恢复/永久删除。 */
function actionsFor(variant: MemoryItemVariant): MemoryItemOp[] {
  if (variant === 'pending') return ['confirm', 'reject']
  if (variant === 'archived') return ['restore', 'remove']
  return ['pin', 'archive', 'remove']
}

/** 操作 → 文案键（固定/取消固定共用两个键，按当前状态选）。 */
function labelKeyOf(op: MemoryItemOp, entry: MemoryEntryView): string {
  if (op === 'pin') return entry.pinned ? 'memory.unpin' : 'memory.pin'
  return `memory.${op}`
}

/** 区域路径的显示名（取最后一段：`/<DSH_HOME>/home/TEST` → `TEST`）。 */
function regionLabel(region: string): string {
  return region.split(/[/\\]/).filter((part) => part !== '').at(-1) ?? region
}

/**
 * 作用域下拉：把「长期 ⇄ 区域」的选择权交还用户。
 *
 * 为什么要有它（用户 2026-09-26）：作用域判断目前 100% 由模型做出（按"这段对话发生在哪个目录"分），
 * 判错了用户在工作台只能干看着 —— 纠错权不该也交给模型。会话记忆照旧显示，也可借此升级成持久记忆。
 *
 * 控件用官方 `ChoiceSelect`（`Button` + `Menu`），不再用浏览器 `<select>`：后者不吃 DSH 令牌，
 * 深色主题下是一块白底补丁（用户 2026-09-26 的界面批注）。归属仍用颜色区分（长期=品牌色、
 * 区域=成功色、会话=次要色），颜色加在官方按钮的文字上。
 */
function ScopePicker(props: {
  t: Translate
  entry: MemoryEntryView
  regions: readonly string[]
  disabled: boolean
  onRescope?: (entry: MemoryEntryView, scope: string, ownerId: string) => void
}) {
  const { t, entry } = props
  const value = entry.scope === 'workspace' ? `workspace\u0000${entry.ownerId}` : entry.scope
  const choices: Array<{ id: string; label: string }> = [
    { id: 'long-term', label: t('memory.scope.long-term') },
    ...props.regions.map((region) => ({
      id: `workspace\u0000${region}`,
      label: `${t('memory.scope.workspace')}：${regionLabel(region)}`,
    })),
    // 会话记忆没有可改的归属上下文，只能显示（转成长期/区域要先由 Agent 或用户另择归属）。
    ...(entry.scope === 'session' ? [{ id: 'session', label: t('memory.scope.session') }] : []),
  ]
  return (
    <ChoiceSelect
      label={t('memory.rescope')}
      value={value}
      choices={choices}
      color={SCOPE_COLORS[entry.scope] ?? 'inherit'}
      disabled={props.disabled || props.onRescope === undefined}
      onChange={(id) => {
        const [scope = '', ownerId = ''] = id.split('\u0000')
        props.onRescope?.(entry, scope, ownerId)
      }}
    />
  )
}

/**
 * 一条记忆 —— **标准卡**（骨架见 `card-styles.ts`）。
 *
 * 左元信息：归属（可改的下拉）+ 重要度/时间；中内容：记忆正文；右操作：固定/归档/删除。
 * 归属放在左列而不是塞进正文后面：它是这条记忆**唯一可改的属性**，位置固定才找得到。
 * @param props - 字典、条目、分组、忙碌标记、区域列表与操作回调。
 * @returns 条目卡。
 */
export function MemoryItem({ t, entry, variant, busy, readOnly, regions, onRescope, onOp }: MemoryItemProps) {
  const disabled = readOnly || busy !== ''
  const marks: string[] = [`${t('memory.importance')} ${entry.importance}`, formatAge(t, entry.updatedAt)]
  if (entry.sensitive) marks.push(t('memory.sensitive'))
  if (entry.conflictCount > 0) marks.push(t('memory.conflict'))

  return (
    <li style={card}>
      <div style={cardLayout}>
        <div style={cardMeta}>
          <div style={cardTags}>
            <ScopePicker t={t} entry={entry} regions={regions ?? []} disabled={disabled} onRescope={onRescope} />
            {entry.pinned ? <Tag tone="quiet">{t('memory.pin')}</Tag> : null}
          </div>
          <span style={cardNote}>{marks.join(' · ')}</span>
        </div>
        <div style={cardBody}>
          <span style={cardTitle}>{entry.content}</span>
          {/* 矛盾标记是"要不要现在处理这条"的判断依据，不是装饰：单独一行说出来。 */}
          {entry.conflictCount > 0 ? <p style={cardLine}>{t('memory.conflict')}</p> : null}
        </div>
        <div style={cardActions}>
          {actionsFor(variant).map((op) => (
            <Button key={op} size="sm" variant="outline" disabled={disabled} onClick={() => onOp(op, entry)}>
              {t(labelKeyOf(op, entry) as never)}
            </Button>
          ))}
        </div>
      </div>
    </li>
  )
}

/** 记忆列表：卡片之间留 8px（所有列表共用同一种排布）。 */
export const memoryList = cardList
