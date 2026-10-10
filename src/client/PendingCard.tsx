/**
 * 待确认**卡片**（用户 2026-09-26 定的信息架构）：常驻工作台顶部，**不藏在页签里**。
 *
 * 为什么这样改：待确认是"等你处理的事" —— 打开工作台十次有九次是为它来的，
 * 藏在页签里等于每次都要多切一次。所以它占了顶部一张卡片，**在哪个页签下都看得见**；
 * 有积压时展开就地处理（明细见 `PendingDetails`），没积压时也明确说一句"没有积压"，
 * 让人一眼知道不用管。
 *
 * 后续新增的页面照旧加在下面的页签里（用户原话：「后续如有增加也加在下面」）。
 * @module deepseek-harness-humanity/client/pending-card
 */
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { useSyncExternalStore, useState } from 'react'

import type { EvolutionWorkbenchController } from './evolution-controller.js'
import { emptyEvolutionState } from './evolution-document.js'
import { InfoHint } from './InfoHint.js'
import type { MemoryWorkbenchController } from './memory-controller.js'
import { NS } from './locales.js'
import { PendingDetails } from './PendingPage.js'
import { headingWithHint, panel, panelTitle, tabRow } from './styles.js'

type Translate = PropsLocale<typeof NS>['t']

/** 控制器缺席时的替身：**崩溃防线** —— 宿主只接上部分视图时，卡片显示"没有积压"而不是抛。 */
const NOOP_SUBSCRIBE = (): (() => void) => () => {}
const DETACHED_STATE = emptyEvolutionState()
const DETACHED = { subscribe: NOOP_SUBSCRIBE, getSnapshot: () => DETACHED_STATE }

export interface PendingCardProps extends PropsLocale<typeof NS> {
  /** 自进化控制器（待办计数与提案都从它来）；缺席时卡片退化为一句"没有积压"。 */
  evolution?: EvolutionWorkbenchController
  /** 记忆控制器（明细里的记忆待确认用它）。 */
  memory?: MemoryWorkbenchController
}

/** 一个计数标签（只显示非零项：零值摆出来只是噪音）。 */
function CountTag(props: { t: Translate; labelKey: string; count: number }) {
  if (props.count === 0) return null
  return (
    <Tag tone="quiet">
      {props.t(props.labelKey as never)} {props.count}
    </Tag>
  )
}

/**
 * 待确认卡片。
 * @param props - 字典座位与两个控制器（记忆与自进化的待办都在这里汇总）。
 * @returns 常驻卡片；有积压时可展开处理。
 */
export function PendingCard(props: PendingCardProps) {
  const { t, evolution, memory } = props
  const [open, setOpen] = useState(false)
  const source = evolution ?? DETACHED
  const state = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
  const counts = state.pendingCounts
  const total = counts.total
  // 展开要两个控制器都在场；缺席时总数必为 0 ⇒ 根本不会出现展开按钮。
  const canExpand = evolution !== undefined && memory !== undefined

  return (
    <section style={panel}>
      <h2 style={{ ...panelTitle, ...headingWithHint }}>
        {t('evolution.pending.title')}
        <InfoHint label={t('evolution.pending.hint')} />
      </h2>
      <div style={{ ...tabRow, alignItems: 'center', flexWrap: 'wrap' }}>
        {total === 0 || !canExpand ? (
          <Tag tone="quiet">{t('pending.none')}</Tag>
        ) : (
          <>
            <Tag tone="outline">{t('evolution.badge').replace('{count}', String(total))}</Tag>
            <CountTag t={t} labelKey="evolution.pending.memory" count={counts.memory} />
            <CountTag t={t} labelKey="evolution.proposal.kind.persona" count={counts.persona} />
            <CountTag t={t} labelKey="evolution.proposal.kind.skill" count={counts.skill} />
            <Button size="sm" onClick={() => setOpen((was) => !was)}>
              {open ? t('pending.hide') : t('pending.show')}
            </Button>
          </>
        )}
      </div>
      {total === 0 || !open || !canExpand ? null : (
        <div style={{ marginTop: 12 }}>
          <PendingDetails t={t} evolution={evolution} memory={memory} />
        </div>
      )}
    </section>
  )
}
