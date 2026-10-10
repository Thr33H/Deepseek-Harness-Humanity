import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

import { NS } from './locales.js'
import { hint } from './styles.js'
import { MemoryItem, type MemoryItemOp, type MemoryItemVariant } from './MemoryItem.js'
import type { MemoryEntryView } from './memory-document.js'
import { cardList } from './card-styles.js'

type Translate = PropsLocale<typeof NS>['t']

/** 空态：一句次要色的话（全部列表共用同一口径）。 */
const emptyNote = hint

export interface MemoryListProps {
  t: Translate
  entries: readonly MemoryEntryView[]
  variant: MemoryItemVariant
  /** 列表为空时显示哪句文案（空库与"搜索无结果"是两回事）。 */
  emptyKey: string
  busy: string
  readOnly: boolean
  /** 已知区域（作用域下拉候选）；缺省则下拉只读。 */
  regions?: readonly string[]
  onOp(op: MemoryItemOp, entry: MemoryEntryView): void
  onRescope?(entry: MemoryEntryView, scope: string, ownerId: string): void
}

/**
 * 一组记忆（活跃 / 待确认 / 已归档共用）。
 * @param props - 条目、分组与操作回调。
 * @returns 列表或空态。
 */
export function MemoryList({ t, entries, variant, emptyKey, busy, readOnly, regions, onRescope, onOp }: MemoryListProps) {
  if (entries.length === 0) return <p style={emptyNote}>{t(emptyKey as never)}</p>
  return (
    <ul style={cardList}>
      {entries.map((entry) => (
        <MemoryItem
          key={entry.fingerprint}
          t={t}
          entry={entry}
          variant={variant}
          busy={busy}
          readOnly={readOnly}
          regions={regions}
          onRescope={onRescope}
          onOp={onOp}
        />
      ))}
    </ul>
  )
}
