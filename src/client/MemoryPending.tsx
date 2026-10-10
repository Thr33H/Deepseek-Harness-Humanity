import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

import { NS } from './locales.js'
import { MemoryList } from './MemoryList.js'
import type { MemoryItemOp } from './MemoryItem.js'
import type { MemoryEntryView } from './memory-document.js'
import { panel, panelTitle } from './styles.js'
import { cardTitleRow } from './memory-styles.js'

type Translate = PropsLocale<typeof NS>['t']

export interface MemoryPendingProps {
  t: Translate
  entries: readonly MemoryEntryView[]
  busy: string
  readOnly: boolean
  regions?: readonly string[]
  onRescope?(entry: MemoryEntryView, scope: string, ownerId: string): void
  onOp(op: MemoryItemOp, entry: MemoryEntryView): void
}

/**
 * 待确认队列（T3 的界面端）。
 *
 * 只在有待确认条目时出现：空队列显示一张空卡片只会让页面更长，用户也不会因此少做一件事。
 * @param props - 待确认条目与操作回调。
 * @returns 待确认卡片；没有条目时返回 `null`。
 */
export function MemoryPending({ t, entries, busy, readOnly, regions, onRescope, onOp }: MemoryPendingProps) {
  if (entries.length === 0) return null
  return (
    <section style={panel}>
      <div style={cardTitleRow}>
        <h2 style={panelTitle}>
          {t('memory.pending')} ({entries.length})
        </h2>
      </div>
      <MemoryList
        t={t}
        entries={entries}
        variant="pending"
        emptyKey="memory.empty"
        busy={busy}
        readOnly={readOnly}
        regions={regions}
        onRescope={onRescope}
        onOp={onOp}
      />
    </section>
  )
}
