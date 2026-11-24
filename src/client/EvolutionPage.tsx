/**
 * 自进化页：**她的今天** + **她的日记**。
 *
 * 两件事必须一眼看得出来：
 * 1. 她今天醒了几次、还剩多少力气、下一次什么时候醒（这是"她有自己的日子"唯一的证据）；
 * 2. 日记是**合着的** —— 只显示日期。翻开要走两步（先问、再确认），因为翻开就不可撤销。
 *
 * 文案全部走字典（`workbench.evolution.*`），不在组件里写死。
 * @module deepseek-harness-humanity/client/EvolutionPage
 */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { useState, useSyncExternalStore } from 'react'

import { InfoHint } from './InfoHint.js'
import type { DiaryItemView } from './evolution-channel.js'
import type { EvolutionWorkbenchController } from './evolution-controller.js'
import { NS } from './locales.js'
import { headingWithHint, panel, panelTitle } from './styles.js'

type Translate = PropsLocale<typeof NS>['t']

/** 精力的一句话描述（不显示小数点：她不是仪表盘）。 */
function energyText(t: Translate, energy: number): string {
  const value = Math.max(0, Math.min(100, Math.round(energy)))
  const level = value >= 70 ? 'fresh' : value >= 40 ? 'ok' : value >= 25 ? 'tired' : 'spent'
  return t(`workbench.evolution.energy.${level}` as never).replace('{value}', String(value))
}

/** 时间戳 → "11-24 10:43"（不显示年份：这一页只看最近）。 */
function stamp(iso: string): string {
  if (iso === '') return '—'
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return '—'
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 自评结果 → 人话。
 *
 * 形如 `applied:2:world,self` / `no-feeling:0:` / `skipped:0:`。
 * 区分"没感觉"与"没跑"很重要：前者是正常结果，后者说明这条路没接上。
 * @param t - 字典。
 * @param raw - 状态里那串。
 * @returns 一句人话。
 */
function appraiseText(t: Translate, raw: string): string {
  const [kind, count, targets] = raw.split(':')
  if (kind === 'applied') {
    return t('workbench.evolution.appraise.applied')
      .replace('{count}', count ?? '0')
      .replace('{targets}', targets ?? '')
  }
  if (kind === 'no-feeling') return t('workbench.evolution.appraise.none')
  return t('workbench.evolution.appraise.skipped')
}

/** 一条日记。 */
function DiaryRow({
  t,
  item,
  onOpen,
}: {
  t: Translate
  item: DiaryItemView
  onOpen(date: string): Promise<boolean>
}) {
  const [confirming, setConfirming] = useState(false)
  return (
    <div style={{ padding: '10px 0', borderBottom: '1px solid var(--dsw-alias-border-l2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{item.date}</span>
        {item.opened ? (
          <span style={{ color: 'var(--dsw-alias-label-secondary)', fontSize: 12 }}>
            {t('workbench.evolution.diary.openedAt').replace('{time}', stamp(item.openedAt))}
            {' · '}
            {item.noticedAt === ''
              ? t('workbench.evolution.diary.unnoticed')
              : t('workbench.evolution.diary.noticed').replace('{time}', stamp(item.noticedAt))}
          </span>
        ) : confirming ? (
          <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>
              {t('workbench.evolution.diary.confirm')}
            </span>
            <button
              type="button"
              onClick={() => {
                setConfirming(false)
                void onOpen(item.date)
              }}
            >
              {t('workbench.evolution.diary.confirmYes')}
            </button>
            <button type="button" onClick={() => setConfirming(false)}>
              {t('workbench.evolution.diary.confirmNo')}
            </button>
          </span>
        ) : (
          <button type="button" onClick={() => setConfirming(true)}>
            {t('workbench.evolution.diary.open')}
          </button>
        )}
      </div>
      {item.opened && item.text !== '' ? (
        <p style={{ margin: '8px 0 0', whiteSpace: 'pre-wrap', lineHeight: 1.75 }}>{item.text}</p>
      ) : null}
    </div>
  )
}

/** 属性。 */
export interface EvolutionPageProps {
  t: Translate
  controller: EvolutionWorkbenchController
}

/**
 * 渲染自进化页。
 * @param props - 字典座位与控制器。
 * @returns 页面。
 */
export function EvolutionPage({ t, controller }: EvolutionPageProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const status = state.doc.status
  /**
   * 三件事都算"暂时读不到"，绝不能说成"人格还没封存"：
   * 1. 还没读到（idle）；
   * 2. 通道不可用；
   * 3. **读到了但是空的** —— 撞上重启窗口时会拿到一份空投影，
   *    旧逻辑据此显示"她还没有开始过日子"，而她其实已经在过了（2026-11-24 真机）。
   */
  const lookedEmpty =
    status.maxPerDay === 0 && status.dayCount === 0 && status.lastWakeAt === '' && status.nextAt === ''
  const unavailable = state.status !== 'ready' || lookedEmpty

  return (
    <div>
      <section style={panel}>
        <h2 style={{ ...panelTitle, ...headingWithHint }}>
          {t('workbench.evolution.today')}
          <InfoHint label={t('workbench.evolution.todayHint')} />
        </h2>
        {unavailable ? (
          <p style={{ margin: 0, color: 'var(--dsw-alias-label-secondary)' }}>
            {t('workbench.metric.unavailable')}
          </p>
        ) : !status.started ? (
          <p style={{ margin: 0, color: 'var(--dsw-alias-label-secondary)' }}>
            {t('workbench.evolution.notStarted')}
          </p>
        ) : (
          <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '8px 16px' }}>
            <dt style={{ color: 'var(--dsw-alias-label-secondary)' }}>{t('workbench.evolution.field.state')}</dt>
            <dd style={{ margin: 0 }}>
              {status.sleeping ? t('workbench.evolution.state.sleeping') : t('workbench.evolution.state.awake')}
            </dd>
            <dt style={{ color: 'var(--dsw-alias-label-secondary)' }}>{t('workbench.evolution.field.energy')}</dt>
            <dd style={{ margin: 0 }}>{energyText(t, status.energy)}</dd>
            <dt style={{ color: 'var(--dsw-alias-label-secondary)' }}>{t('workbench.evolution.field.wakes')}</dt>
            <dd style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>
                {t('workbench.evolution.wakesValue')
                  .replace('{count}', String(status.dayCount))
                  .replace('{max}', String(status.maxPerDay))}
              </span>
              <input
                type="number"
                min={0}
                max={24}
                defaultValue={status.maxPerDay}
                aria-label={t('workbench.evolution.cap.aria')}
                style={{ width: 64 }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return
                  const value = Number((event.target as HTMLInputElement).value)
                  if (Number.isInteger(value) && value >= 0 && value <= 24) void controller.setWakeCap(value)
                }}
              />
            </dd>
            <dt style={{ color: 'var(--dsw-alias-label-secondary)' }}>{t('workbench.evolution.field.lastWake')}</dt>
            <dd style={{ margin: 0, fontVariantNumeric: 'tabular-nums' }}>{stamp(status.lastWakeAt)}</dd>
            <dt style={{ color: 'var(--dsw-alias-label-secondary)' }}>{t('workbench.evolution.field.lastTurn')}</dt>
            <dd style={{ margin: 0 }}>
              {status.lastTurnTools > 0
                ? t('workbench.evolution.lastTurn.tools').replace('{count}', String(status.lastTurnTools))
                : t('workbench.evolution.lastTurn.talk')}
              {status.lastAppraise !== '' ? ` · ${appraiseText(t, status.lastAppraise)}` : ''}
            </dd>
            <dt style={{ color: 'var(--dsw-alias-label-secondary)' }}>{t('workbench.evolution.field.nextWake')}</dt>
            <dd style={{ margin: 0, fontVariantNumeric: 'tabular-nums' }}>
              {stamp(status.nextAt)}
              {status.busy ? (
                <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>
                  {t('workbench.evolution.busy')}
                  {status.busySince !== '' ? ` ${t('workbench.evolution.busySince').replace('{time}', stamp(status.busySince))}` : ''}
                </span>
              ) : null}
            </dd>
          </dl>
        )}
        {status.lastError !== '' ? (
          <p style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>
            {t('workbench.evolution.error').replace('{reason}', status.lastError)}
          </p>
        ) : null}
      </section>

      <section style={{ ...panel, marginTop: 16 }}>
        <h2 style={{ ...panelTitle, ...headingWithHint }}>
          {t('workbench.evolution.diary.title')}
          <InfoHint label={t('workbench.evolution.diary.hint')} />
        </h2>
        {state.doc.notice !== '' ? (
          <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>{state.doc.notice}</p>
        ) : null}
        {status.lastSettleError !== '' ? (
          <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>
            {t('workbench.evolution.diary.settleFailed').replace('{reason}', status.lastSettleError)}
          </p>
        ) : null}
        {state.doc.diary.length === 0 ? (
          <p style={{ margin: 0, color: 'var(--dsw-alias-label-secondary)' }}>{t('workbench.evolution.diary.empty')}</p>
        ) : (
          state.doc.diary.map((item) => (
            <DiaryRow key={item.date} t={t} item={item} onOpen={(date) => controller.open(date)} />
          ))
        )}
      </section>

      <section style={{ ...panel, marginTop: 16 }}>
        <h2 style={{ ...panelTitle, ...headingWithHint }}>
          {t('workbench.evolution.threads.title')}
          <InfoHint label={t('workbench.evolution.threads.hint')} />
        </h2>
        {state.doc.threads.length === 0 ? (
          <p style={{ margin: 0, color: 'var(--dsw-alias-label-secondary)' }}>{t('workbench.evolution.threads.empty')}</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
            {state.doc.threads.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
      </section>

      <section style={{ ...panel, marginTop: 16 }}>
        <h2 style={{ ...panelTitle, ...headingWithHint }}>
          {t('workbench.evolution.works.title')}
          <InfoHint label={t('workbench.evolution.works.hint')} />
        </h2>
        {state.doc.works.length === 0 ? (
          <p style={{ margin: 0, color: 'var(--dsw-alias-label-secondary)' }}>{t('workbench.evolution.works.empty')}</p>
        ) : (
          state.doc.works.map((item) => (
            /**
             * ⚠️ 下载按钮**必须常显**，不能藏在折叠区里。
             * 真机（2026-11-24）：它原来在 `<details>` 展开后才出现，用户「点哪里啊，我没看到」——
             * 一个功能看不见，等于没有。
             */
            <div key={item.name} style={{ padding: '8px 0', borderBottom: '1px solid var(--dsw-alias-border-l2)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <span>{item.name}</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ color: 'var(--dsw-alias-label-secondary)', fontSize: 12 }}>
                    {Math.max(1, Math.round(item.size / 1024))} KB · {stamp(item.updatedAt)}
                  </span>
                  <button type="button" onClick={() => void controller.download(item.name)}>
                    {t('workbench.evolution.works.download')}
                  </button>
                </span>
              </div>
              {item.kind === 'text' && item.preview !== '' ? (
                <details style={{ marginTop: 6 }}>
                  <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>
                    {t('workbench.evolution.works.previewToggle')}
                  </summary>
                  <pre style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.7 }}>
                    {item.preview}
                  </pre>
                </details>
              ) : (
                <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>
                  {t('workbench.evolution.works.noPreview')}
                </p>
              )}
            </div>
          ))
        )}
      </section>
    </div>
  )
}
