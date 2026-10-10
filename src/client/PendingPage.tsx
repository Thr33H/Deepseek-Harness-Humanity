/**
 * 待确认**明细**（P-042）：记忆待确认 + 人格/技能/路由提案，一处看完所有待办。
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
  memory: MemoryWorkbenchController
}

/** 记忆待确认区：确认/拒绝走记忆命令槽（复用记忆页的同一批操作）。 */
function PendingMemories(props: { t: Translate; memory: MemoryWorkbenchController }) {
  const { t, memory } = props
  const state = useSyncExternalStore(memory.subscribe, memory.getSnapshot, memory.getSnapshot)
  const pending = memory.visible('pending')

  return (
    <section style={panel}>
      <h2 style={panelTitle}>
        {t('evolution.pending.memory')} <Tag tone={pending.length > 0 ? 'outline' : 'quiet'}>{pending.length}</Tag>
      </h2>
      {pending.length === 0 ? <p style={hint}>{t('evolution.pending.empty')}</p> : null}
      <ul style={cardList}>
        {pending.map((entry) => (
          <li key={entry.fingerprint} style={card}>
            <div style={cardLayout}>
              <div style={cardMeta}>
                <div style={cardTags}>
                  <Tag tone="outline">{t(`memory.scope.${entry.scope}` as never)}</Tag>
                  {entry.sensitive ? <Tag tone="neutral">{t('memory.sensitive')}</Tag> : null}
                </div>
              </div>
              <div style={cardBody}>
                <span style={cardTitle}>{entry.content}</span>
              </div>
              <div style={cardActions}>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={!state.writable || state.busy !== ''}
                  onClick={() => void memory.confirm(entry.fingerprint)}
                >
                  {t('memory.confirm')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!state.writable || state.busy !== ''}
                  onClick={() => void memory.reject(entry.fingerprint)}
                >
                  {t('memory.reject')}
                </Button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * 待确认明细：上一次操作的结论 + 记忆待确认 + 待批准提案。
 * @param props - 字典座位与两个控制器。
 * @returns 明细（不带标题，供卡片展开时渲染）。
 */
export function PendingDetails(props: PendingDetailsProps) {
  const { t, evolution, memory } = props
  const state = useSyncExternalStore(evolution.subscribe, evolution.getSnapshot, evolution.getSnapshot)

  return (
    <div>
      {state.notice === '' ? null : <p style={hint}>{state.notice}</p>}
      <PendingMemories t={t} memory={memory} />
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
