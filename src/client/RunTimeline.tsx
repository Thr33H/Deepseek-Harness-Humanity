/**
 * 运行时间线：整理/梦境运行的历史列表（P-034「自进化模块下可以包含梦境页或时间线」的落地）。
 *
 * 每条运行是**一张标准卡**（骨架见 `card-styles.ts`）：左元信息（状态/形态/触发）｜中内容
 * （时刻 + 统计）｜右操作（展开叙事）。数据全部来自宿主投影（`RunView`）——
 * 界面不推算、不美化：花掉的 token 原样显示（P-051）。
 * @module deepseek-harness-humanity/client/run-timeline
 */
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { useState } from 'react'

import {
  card,
  cardActions,
  cardBody,
  cardLayout,
  cardLine,
  cardList,
  cardMeta,
  cardProse,
  cardSpan,
  cardTags,
  cardTitle,
} from './card-styles.js'
import type { RunView } from './evolution-document.js'
import { shortStamp } from './evolution-views.js'
import { InfoHint } from './InfoHint.js'
import { NS } from './locales.js'
import { headingWithHint, hint, panel, panelTitle } from './styles.js'

type Translate = PropsLocale<typeof NS>['t']

/** 状态 → Tag 色调（失败与跳过要一眼能看出来）。 */
const STATUS_TONES: Record<string, 'neutral' | 'quiet' | 'outline'> = {
  running: 'outline',
  completed: 'quiet',
  failed: 'neutral',
  skipped: 'neutral',
}

/** 统计行：把占位符替换成真实数字（字典值是带 {name} 占位的一句话）。 */
function statsLine(t: Translate, run: RunView): string {
  return t('evolution.run.stats')
    .replace('{sessions}', String(run.scannedSessions))
    .replace('{events}', String(run.parsedEvents))
    .replace('{memories}', String(run.memoriesWritten))
    .replace('{proposals}', String(run.proposalsCreated))
    .replace('{calls}', String(run.calls))
    .replace('{inTok}', String(run.inputTokens))
    .replace('{outTok}', String(run.outputTokens))
}

/** 一条运行卡（梦境的叙事/洞察可展开）。 */
function RunCard({ t, run }: { t: Translate; run: RunView }) {
  const [open, setOpen] = useState(false)
  const expandable = run.narrative !== '' || run.insights.length > 0

  return (
    <li style={card}>
      <div style={cardLayout}>
        <div style={cardMeta}>
          <div style={cardTags}>
            <Tag tone={STATUS_TONES[run.status] ?? 'neutral'}>{t(`evolution.run.status.${run.status}` as never)}</Tag>
            <Tag tone="quiet">{t(`evolution.run.mode.${run.mode}` as never)}</Tag>
            <Tag tone="quiet">{t(`evolution.run.trigger.${run.trigger}` as never)}</Tag>
          </div>
        </div>
        <div style={cardBody}>
          {/* 短时刻是这一条的"名字"，完整 ISO 留在 title 与 dateTime 上（悬停可核对）。 */}
          <time style={cardTitle} dateTime={run.startedAt} title={run.startedAt}>
            {shortStamp(run.startedAt)}
          </time>
          <p style={cardLine}>{statsLine(t, run)}</p>
        </div>
        <div style={cardActions}>
          {expandable ? (
            <Button size="sm" variant="outline" aria-expanded={open} onClick={() => setOpen(!open)}>
              {t('evolution.run.narrative')}
            </Button>
          ) : null}
        </div>
        {run.error === '' ? null : (
          <div style={cardSpan}>
            <p style={cardProse}>
              【{t('evolution.run.notes')}】{run.error}
            </p>
          </div>
        )}
        {open ? (
          <div style={cardSpan}>
            {run.narrative === '' ? null : <p style={cardProse}>{run.narrative}</p>}
            {run.insights.length === 0 ? null : (
              <ul style={{ margin: '6px 0 0', paddingInlineStart: 20 }}>
                {run.insights.map((insight) => (
                  <li key={insight}>{insight}</li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </div>
    </li>
  )
}

export interface RunTimelineProps {
  t: Translate
  runs: readonly RunView[]
}

/**
 * 运行时间线面板。
 * @param props - 字典座位与运行记录（宿主投影，最新在前）。
 * @returns 时间线面板；没有记录时给空态。
 */
export function RunTimeline({ t, runs }: RunTimelineProps) {
  return (
    <section style={panel}>
      <h2 style={{ ...panelTitle, ...headingWithHint }}>
        {t('evolution.timeline')}
        <InfoHint label={t('evolution.timeline.hint')} />
      </h2>
      {runs.length === 0 ? <p style={hint}>{t('evolution.timeline.empty')}</p> : null}
      <ul style={cardList}>
        {runs.map((run) => (
          <RunCard key={run.id} t={t} run={run} />
        ))}
      </ul>
    </section>
  )
}
