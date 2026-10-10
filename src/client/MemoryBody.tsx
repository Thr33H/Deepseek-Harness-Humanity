/**
 * 记忆页的**主体**：策略 / 待确认 / 活跃 / 已归档四块 + 兼容性警告条。
 *
 * 与 `MemoryPage.tsx` 分开：容器只负责"订阅状态 + 把点击翻译成控制器调用"，主体只负责布局。
 * 两块各自短到能一眼读完；归档区的展开状态属于**布局**，所以留在主体里（不上升为控制器状态）。
 * @module deepseek-harness-humanity/client/memory-body
 */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { useState } from 'react'

import { NS } from './locales.js'
import { ActiveCard, ArchivedCard, DegradedBanner, PageHeader } from './MemoryCards.js'
import type { MemoryItemOp } from './MemoryItem.js'
import { MemoryPending } from './MemoryPending.js'
import { MemoryPolicy } from './MemoryPolicy.js'
import type { MemoryWorkbenchController } from './memory-controller.js'
import type { MemoryEntryView, MemoryWorkbenchState } from './memory-document.js'
import { collectRegions } from './memory-view.js'

/** `t` 的类型：与工作台同一个字典座位。 */
type Translate = PropsLocale<typeof NS>['t']

export interface MemoryBodyProps {
  t: Translate
  controller: MemoryWorkbenchController
  state: MemoryWorkbenchState
  onOp(op: MemoryItemOp, entry: MemoryEntryView): void
}

/** 上半部分：生效策略 + 待确认队列（都是"用户要先看一眼再决定"的东西）。 */
function Controls(props: {
  t: Translate
  controller: MemoryWorkbenchController
  state: MemoryWorkbenchState
  readOnly: boolean
  regions: readonly string[]
  onRescope(entry: MemoryEntryView, scope: string, ownerId: string): void
  onOp(op: MemoryItemOp, entry: MemoryEntryView): void
}) {
  const { t, controller, state, readOnly, regions, onRescope, onOp } = props
  return (
    <>
      <MemoryPolicy
        t={t}
        policy={state.policy}
        advanced={state.advanced}
        readOnly={readOnly}
        busy={state.busy}
        configBusy={state.configBusy}
        onMode={(mode) => void controller.setMode(mode)}
        onAdvanced={(patch) => controller.setAdvanced(patch)}
        onDecay={() => void controller.runDecay()}
        onDedupe={() => void controller.dedupe()}
        onUndoDedupe={() => void controller.undoDedupe()}
      />
      <MemoryPending
        t={t}
        entries={controller.visible('pending')}
        busy={state.busy}
        readOnly={readOnly}
        regions={regions}
        onRescope={onRescope}
        onOp={onOp}
      />
    </>
  )
}

/**
 * 记忆页主体。
 * @param props - 字典座位、控制器、当前状态与操作回调。
 * @returns 四块卡片（已归档默认折叠）。
 */
export function MemoryBody({ t, controller, state, onOp }: MemoryBodyProps) {
  const [showArchived, setShowArchived] = useState(false)
  const readOnly = !state.writable
  // 作用域下拉的候选：从当前条目集收集（用户 2026-09-26 —— 归属不能只由模型定，人得能改）。
  const regions = collectRegions(state.entries)
  const onRescope = (entry: MemoryEntryView, scope: string, ownerId: string): void => {
    void controller.rescope(entry.fingerprint, scope, ownerId)
  }

  return (
    <div>
      <DegradedBanner t={t} degraded={state.degraded} />
      <PageHeader t={t} state={state} readOnly={readOnly} />
      <Controls
        t={t}
        controller={controller}
        state={state}
        readOnly={readOnly}
        regions={regions}
        onRescope={onRescope}
        onOp={onOp}
      />
      <ActiveCard
        t={t}
        state={state}
        regions={regions}
        onRescope={onRescope}
        entries={controller.visible('active')}
        readOnly={readOnly}
        onOp={onOp}
        onQuery={(query) => controller.setQuery(query)}
        onReload={() => void controller.load()}
      />
      <ArchivedCard
        t={t}
        entries={controller.visible('archived')}
        regions={regions}
        onRescope={onRescope}
        open={showArchived}
        busy={state.busy}
        readOnly={readOnly}
        onOp={onOp}
        onToggle={() => setShowArchived((open) => !open)}
      />
    </div>
  )
}
