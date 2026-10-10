/**
 * 自进化页面**容器**：订阅控制器状态，把点击翻译成控制器调用（与 `MemoryPage.tsx` 同一分层）。
 *
 * 布局从上到下：运行状态与花费 → 手动触发（含回扫）→ 调度/扫描/预算设置 → 提案 → 运行时间线。
 * 数据只有一个来源：控制器快照（背后是 `humanity-evolution` 投影 + 顶层配置）。
 * @module deepseek-harness-humanity/client/evolution-page
 */
import { Button, Input, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { useCallback, useState, useSyncExternalStore } from 'react'

import { ChoiceSelect } from './ChoiceSelect.js'
import type { EvolutionWorkbenchController, RescanSelection } from './evolution-controller.js'
import type { EvolutionWorkbenchState } from './evolution-document.js'
import { EvolutionSettings } from './EvolutionSettings.js'
import { InfoHint } from './InfoHint.js'
import { NS } from './locales.js'
import { ProposalList } from './ProposalList.js'
import { RunTimeline } from './RunTimeline.js'
import { headingWithHint, hint, panel, panelTitle } from './styles.js'
import { metricLabel, metricRow, metricValue } from './metric-styles.js'

type Translate = PropsLocale<typeof NS>['t']

export interface EvolutionPageProps extends PropsLocale<typeof NS> {
  controller: EvolutionWorkbenchController
}

/** 回扫的四个范围档（顺序即下拉里的顺序）。 */
const RESCAN_KINDS = ['days', 'workspace', 'session', 'all'] as const

/** 状态行：五项就绪灯（降级原因如实展示，G-002「说清楚」）。 */
function StatusPanel({ t, state }: { t: Translate; state: EvolutionWorkbenchState }) {
  const flags = [
    ['evolution.status.enabled', state.evolutionStatus.enabled],
    ['evolution.status.store', state.evolutionStatus.storeReady],
    ['evolution.status.scan', state.evolutionStatus.scanReady],
    ['evolution.status.model', state.evolutionStatus.modelReady],
    ['evolution.status.skills', state.evolutionStatus.skillsReady],
  ] as const
  const nextRun = state.nextRunAt > 0 ? new Date(state.nextRunAt).toLocaleString() : t('evolution.nextRun.none')
  return (
    <section style={panel}>
      <h2 style={{ ...panelTitle, ...headingWithHint }}>
        {t('evolution.status.title')}
        <InfoHint label={t('evolution.subtitle')} />
      </h2>
      <div style={metricRow}>
        {flags.map(([key, ready]) => (
          <Tag key={key} tone={ready ? 'quiet' : 'neutral'}>
            {t(key)}: {ready ? t('evolution.status.ok') : t('evolution.status.off')}
          </Tag>
        ))}
      </div>
      <div style={metricRow}>
        <span style={metricLabel}>{t('evolution.usage')}</span>
        <span style={metricValue}>
          {state.dailyCalls} / {state.dailyCallCap === 0 ? '∞' : state.dailyCallCap}
        </span>
        <span style={metricLabel}>{t('evolution.nextRun')}</span>
        <span style={metricValue}>{nextRun}</span>
      </div>
      <div style={metricRow}>
        <span style={metricLabel}>{t('evolution.baseline')}</span>
        <span style={metricValue}>{state.baselineAt === '' ? t('evolution.baseline.none') : state.baselineAt}</span>
      </div>
      {state.notice === '' ? null : <p style={hint}>{state.notice}</p>}
      {state.error === undefined ? null : <p style={hint}>⚠️ {state.error}</p>}
    </section>
  )
}

/** 手动触发区：立即整理 / 做梦 / 回扫四档（P-035 手动始终保留；P-037 回扫入口）。 */
function ActionPanel({ t, state, controller }: { t: Translate; state: EvolutionWorkbenchState; controller: EvolutionWorkbenchController }) {
  const [rescan, setRescan] = useState<RescanSelection>({ kind: 'days', value: '7' })
  const disabled = !state.writable || state.busy !== ''
  const onRescan = useCallback(() => void controller.rescan(rescan), [controller, rescan])

  return (
    <section style={panel}>
      <h2 style={{ ...panelTitle, ...headingWithHint }}>
        {t('evolution.actions')}
        <InfoHint label={t('evolution.action.hint')} />
      </h2>
      <div style={metricRow}>
        <Button size="sm" disabled={disabled} onClick={() => void controller.runNow()}>
          {t('evolution.action.run')}
        </Button>
        <Button size="sm" disabled={disabled} onClick={() => void controller.dream()}>
          {t('evolution.action.dream')}
        </Button>
      </div>
      <h2 style={{ ...panelTitle, ...headingWithHint }}>
        {t('evolution.rescan')}
        <InfoHint label={t('evolution.rescan.hint')} />
      </h2>
      <div style={metricRow}>
        <ChoiceSelect
          label={t('evolution.rescan')}
          value={rescan.kind}
          choices={RESCAN_KINDS.map((kind) => ({ id: kind, label: t(`evolution.rescan.${kind}` as never) }))}
          disabled={disabled}
          onChange={(kind) => setRescan({ ...rescan, kind: kind as RescanSelection['kind'] })}
        />
        {rescan.kind === 'all' ? null : (
          <Input
            aria-label={t('evolution.rescan.go')}
            type={rescan.kind === 'days' ? 'number' : 'text'}
            value={rescan.value}
            disabled={disabled}
            onChange={(event) => setRescan({ ...rescan, value: event.target.value })}
          />
        )}
        <Button size="sm" disabled={disabled} onClick={onRescan}>
          {t('evolution.rescan.go')}
        </Button>
      </div>
    </section>
  )
}

/**
 * 自进化页面。
 * @param props - 字典座位与控制器。
 */
export function EvolutionPage(props: EvolutionPageProps) {
  const { t, controller } = props
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const readOnly = !state.writable

  if (state.status === 'unavailable' || state.status === 'idle') {
    return (
      <section style={panel}>
        <h2 style={panelTitle}>{t('evolution.title')}</h2>
        <p style={hint}>
          {state.status === 'unavailable' ? t('workbench.state.unavailable') : t('workbench.state.loading')}
        </p>
      </section>
    )
  }

  return (
    <div>
      <StatusPanel t={t} state={state} />
      <ActionPanel t={t} state={state} controller={controller} />
      <EvolutionSettings t={t} config={state.config} readOnly={readOnly} busy={state.busy} onPatch={(patch) => void controller.setEvolutionConfig(patch)} />
      <ProposalList
        t={t}
        proposals={state.proposals}
        readOnly={readOnly}
        busy={state.busy}
        onApprove={(id) => void controller.approve(id)}
        onReject={(id) => void controller.reject(id)}
        onDelete={(id) => void controller.delete(id)}
      />
      <RunTimeline t={t} runs={state.runs} />
    </div>
  )
}
