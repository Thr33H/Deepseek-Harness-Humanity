/**
 * 待确认**明细**（P-042）：记忆待确认 + 人格/路由提案，一处看完所有待办。
 *
 * 数据来自两个控制器（记忆与自进化各自的命名空间投影）——这里只合并展示，
 * 不搬数据：记忆条目确认仍走记忆命令槽，提案批准仍走自进化命令槽，
 * 任一端确认后另一端由宿主投影同步消失（同源性质，见 `memory/confirm.ts` 文件头）。
 *
 * 与 `PendingCard` 的分工：卡片负责"常驻 + 摘要 + 展开"，本模块只管明细本身，
 * 所以它不自带标题与计数（那是卡片的头部）。
 * @module deepseek-harness-humanity/client/pending-details
 */
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { useSyncExternalStore } from 'react'

import type { EvolutionWorkbenchController } from './evolution-controller.js'
import type { MemoryWorkbenchController } from './memory-controller.js'
import { NS } from './locales.js'
import { ProposalList } from './ProposalList.js'
import { card, cardActions, cardBody, cardLayout, cardList, cardMeta, cardTags, cardTitle } from './card-styles.js'
import { hint, panel, panelTitle } from './styles.js'

type Translate = PropsLocale<typeof NS>['t']

export interface PendingDetailsProps extends PropsLocale<typeof NS> {
  evolution: EvolutionWorkbenchController
}

/**
 * 待确认明细：上一次操作的结论 + 待批准提案。
 *
 * 2026-11-21：记忆的待确认区随记忆重构删除 —— 那条路把"可能是模糊/敏感的信息"隔离起来
 * 等对方点头，新设计里这件事变成了「说出来要付多大代价」，由她自己决定说不说。
 * 所以这里只剩提案。
 * @param props - 字典座位与自进化控制器。
 * @returns 明细（不带标题，供卡片展开时渲染）。
 */
export function PendingDetails(props: PendingDetailsProps) {
  const { t, evolution } = props
  const state = useSyncExternalStore(evolution.subscribe, evolution.getSnapshot, evolution.getSnapshot)

  return (
    <div>
      {state.notice === '' ? null : <p style={hint}>{state.notice}</p>}
      <ProposalList
        t={t}
        proposals={state.proposals.filter((proposal) => proposal.status === 'pending')}
        readOnly={!state.writable}
        busy={state.busy}
        onApprove={(id) => void evolution.approve(id)}
        onReject={(id) => void evolution.reject(id)}
        onDelete={(id) => void evolution.delete(id)}
      />
    </div>
  )
}
