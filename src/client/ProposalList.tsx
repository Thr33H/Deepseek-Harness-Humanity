/**
 * 提案列表：待确认在前、已处理在后（顺序由宿主投影给出）。
 *
 * 每条提案是**一张标准卡**（骨架见 `card-styles.ts`）：左元信息（状态 / 类别 / 时间）｜
 * 中内容（标题 + 理由）｜右操作（批准 / 拒绝 / 删除，或已处理项的展开箭头）。
 *
 * 两条版式决定（2026-09-26）：
 * - **待确认的正文摊开**（要据此决定，信息不藏）；**已处理的收进箭头后面**（历史备查，不该占满屏幕）；
 * - **差异横跨整卡**（`cardSpan`）—— 它是关于整条的补充，塞进中列会看起来像标题的一部分。
 *
 * 界面纪律：**不做乐观更新**——点了批准，按钮进入 busy，等宿主投影回来才改状态；
 * 应用失败（校验拒绝/技能重名）时提案仍是待确认，notice 里是宿主给的原因（P-011）。
 * @module deepseek-harness-humanity/client/proposal-list
 */
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { useState } from 'react'

import { IconChevronDown, IconChevronRight } from './icons.js'

import {
  card,
  cardActions,
  cardBody,
  cardLayout,
  cardLine,
  cardList,
  cardMeta,
  cardNote,
  cardPre,
  cardSpan,
  cardTags,
  cardTitle,
} from './card-styles.js'
import type { ProposalView } from './evolution-document.js'
import { shortStamp } from './evolution-views.js'
import { InfoHint } from './InfoHint.js'
import { NS } from './locales.js'
import { headingWithHint, hint, panel, panelTitle } from './styles.js'

type Translate = PropsLocale<typeof NS>['t']

export interface ProposalListProps {
  t: Translate
  proposals: readonly ProposalView[]
  readOnly: boolean
  busy: string
  onApprove(id: string): void
  onReject(id: string): void
  onDelete(id: string): void
}

/** 这条提案"什么时候来的 / 什么时候处理的"（左列的细节行）。 */
function stampOf(proposal: ProposalView): string {
  const decided = proposal.decidedAt === '' ? '' : shortStamp(proposal.decidedAt)
  return decided === '' ? shortStamp(proposal.createdAt) : decided
}

/** 一条提案卡。 */
function ProposalCard(
  props: { t: Translate; proposal: ProposalView; readOnly: boolean; busy: string } & Pick<
    ProposalListProps,
    'onApprove' | 'onReject' | 'onDelete'
  >,
) {
  const { t, proposal, readOnly, busy } = props
  const [open, setOpen] = useState(false)
  const pending = proposal.status === 'pending'
  const disabled = readOnly || busy !== ''
  // 待确认的正文默认摊开（决定要据此做）；已处理的收进箭头后面。
  const expanded = pending || open

  return (
    <li style={card}>
      <div style={cardLayout}>
        <div style={cardMeta}>
          <div style={cardTags}>
            <Tag tone={pending ? 'outline' : 'quiet'}>
              {t(`evolution.proposal.status.${proposal.status}` as never)}
            </Tag>
            <Tag tone="quiet">{t(`evolution.proposal.kind.${proposal.kind}` as never)}</Tag>
          </div>
          <span style={cardNote} title={proposal.decidedAt === '' ? proposal.createdAt : proposal.decidedAt}>
            {stampOf(proposal)}
          </span>
        </div>
        <div style={cardBody}>
          <strong style={cardTitle}>{proposal.title}</strong>
          {expanded && proposal.reason !== '' ? <p style={cardLine}>{proposal.reason}</p> : null}
        </div>
        <div style={cardActions}>
          {pending ? (
            <>
              <Button size="sm" variant="primary" disabled={disabled} onClick={() => props.onApprove(proposal.id)}>
                {t('evolution.proposal.approve')}
              </Button>
              <Button size="sm" variant="outline" disabled={disabled} onClick={() => props.onReject(proposal.id)}>
                {t('evolution.proposal.reject')}
              </Button>
              <Button size="sm" variant="ghost" disabled={disabled} onClick={() => props.onDelete(proposal.id)}>
                {t('evolution.proposal.delete')}
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={open}
              aria-label={t('evolution.proposal.details')}
              onClick={() => setOpen((was) => !was)}
            >
              {open
                ? IconChevronDown
                  ? <IconChevronDown size={14} />
                  : <span aria-hidden>▾</span>
                : IconChevronRight
                  ? <IconChevronRight size={14} />
                  : <span aria-hidden>▸</span>}
            </Button>
          )}
        </div>
        {expanded && proposal.diff !== '' ? (
          <div style={cardSpan}>
            <pre style={cardPre}>{proposal.diff}</pre>
          </div>
        ) : null}
      </div>
    </li>
  )
}

/**
 * 提案面板。
 * @param props - 字典座位、提案（宿主投影：pending 在前）与命令回调。
 * @returns 提案列表；没有提案时给出空态而不是空白。
 */
export function ProposalList(props: ProposalListProps) {
  const { t, proposals } = props
  return (
    <section style={panel}>
      <h2 style={{ ...panelTitle, ...headingWithHint }}>
        {t('evolution.proposals')}
        <InfoHint label={t('evolution.proposals.hint')} />
      </h2>
      {proposals.length === 0 ? <p style={hint}>{t('evolution.proposals.empty')}</p> : null}
      <ul style={cardList}>
        {proposals.map((proposal) => (
          <ProposalCard
            key={proposal.id}
            t={t}
            proposal={proposal}
            readOnly={props.readOnly}
            busy={props.busy}
            onApprove={props.onApprove}
            onReject={props.onReject}
            onDelete={props.onDelete}
          />
        ))}
      </ul>
    </section>
  )
}
