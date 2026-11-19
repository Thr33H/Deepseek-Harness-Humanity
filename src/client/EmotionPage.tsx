/**
 * 情绪页：**只读**的观察窗（用户 2026-11-17 定的定位）。
 *
 * 页面自己不做任何计算：强度、档位、中文名、原因全部由宿主投影过来
 * （`view.ts` 是唯一的一处换算）。这里只负责把它排成人能一眼看懂的样子——
 * 同一档位在工作台与注入里必须是同一个值，不能在两边各判一次。
 * @module deepseek-harness-humanity/client/emotion-page
 */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { useEffect, useSyncExternalStore } from 'react'

import type { EmotionChargeView } from '../host/emotion/view.js'
import type { EmotionWorkbenchController } from './emotion-controller.js'
import { NS } from './locales.js'
import { column, hint, page, panel, panelTitle, subtitle, title, titleRow } from './styles.js'

/** 情绪页属性。 */
export interface EmotionPageProps extends PropsLocale<typeof NS> {
  controller: EmotionWorkbenchController
}

/** 强度条的底槽。 */
const barTrack = {
  height: 6,
  borderRadius: 3,
  background: 'var(--dsw-alias-border-l1)',
  overflow: 'hidden',
} as const

/** 一条情绪的整行（名字 | 条 | 档位）。名字那列要放得下"对自己悲伤"这种带对象的写法。 */
const chargeRow = {
  display: 'grid',
  gridTemplateColumns: '96px 1fr 56px',
  alignItems: 'center',
  gap: 12,
  marginTop: 10,
} as const

/** 一条敏感痕迹的整行（名字 | 条）。只有两栏：这一层不需要档位，也不需要原因。 */
const sensitivityRow = {
  display: 'grid',
  gridTemplateColumns: '96px 1fr',
  alignItems: 'center',
  gap: 12,
  marginTop: 10,
} as const

/** 补充说明的次级文字。 */
const meta = {
  margin: '4px 0 0',
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: '0.9em',
} as const

/** 档位键（t 的键是字面量联合，动态拼字符串过不了类型检查）。 */
const TIER_KEYS = {
  burst: 'emotion.tier.burst',
  clear: 'emotion.tier.clear',
  faint: 'emotion.tier.faint',
  calm: 'emotion.tier.calm',
} as const

/** 精力档位键（同上）。 */
const ENERGY_KEYS = {
  fresh: 'emotion.energy.fresh',
  tired: 'emotion.energy.tired',
  exhausted: 'emotion.energy.exhausted',
} as const

/** 两个时刻之间隔了多少分钟（无法判断时 `undefined`）。 */
function minutesBetween(iso: string, now: number): number | undefined {
  const at = Date.parse(iso)
  if (iso === '' || Number.isNaN(at)) return undefined
  return Math.max(0, Math.round((now - at) / 60_000))
}

/** 一段时长说成人话（分钟 / 小时 / 天）。 */
function spanText(t: EmotionPageProps['t'], minutes: number): string {
  if (minutes < 60) return t('emotion.duration.minutes', { n: String(minutes) })
  if (minutes < 60 * 24) return t('emotion.duration.hours', { n: String(Math.round(minutes / 60)) })
  return t('emotion.duration.days', { n: String(Math.round(minutes / (60 * 24))) })
}

/**
 * 把"多久之前"说成人话。
 * @param t - 字典。
 * @param since - 起始时刻（ISO 8601；空串表示未知）。
 * @param now - 当前时刻（毫秒）。
 * @returns 例如 `已经 3 小时`；不足一分钟返回 `刚刚`；无法判断时返回空串。
 */
function durationText(t: EmotionPageProps['t'], since: string, now: number): string {
  const minutes = minutesBetween(since, now)
  if (minutes === undefined) return ''
  // 不足一分钟时说"已经 0 分钟"很别扭 —— 这里就是"刚刚"。
  if (minutes < 1) return t('emotion.agoNow')
  return t('emotion.since', { duration: spanText(t, minutes) })
}

/**
 * "多久之前"的简短说法（底部结算时间用）。
 *
 * 为什么不用绝对时间：`settledAt` 存的是 UTC，直接截断显示会让人看到比自己手表早 8 小时的时间；
 * 而相对时间在任何时区都不会错。
 * @param t - 字典。
 * @param iso - 时刻（ISO 8601）。
 * @param now - 当前时刻（毫秒）。
 */
function agoText(t: EmotionPageProps['t'], iso: string, now: number): string {
  const minutes = minutesBetween(iso, now)
  if (minutes === undefined) return ''
  if (minutes < 1) return t('emotion.agoNow')
  return t('emotion.ago', { duration: spanText(t, minutes) })
}

/**
 * 一条情绪的展示（名字、强度条、档位、原因、多久了）。
 *
 * 强度为 0 的是"这种情绪现在没有"：仍然占一行（让人知道有这一种），
 * 但压成三级文字、不显示原因 —— 它没有原因可言。
 * @param props - 字典、情绪视图与当前时刻。
 */
function ChargeRow({ t, charge, now }: { t: EmotionPageProps['t']; charge: EmotionChargeView; now: number }) {
  const absent = charge.intensity <= 0
  const duration = absent ? '' : durationText(t, charge.since, now)
  const cause = charge.cause === '' ? t('emotion.noCause') : charge.cause
  const color = absent ? 'var(--dsw-alias-label-tertiary)' : 'var(--dsw-alias-label-primary)'
  return (
    <div>
      <div style={chargeRow}>
        <span style={{ fontWeight: absent ? 400 : 600, color, whiteSpace: 'nowrap' }}>
          {charge.targetLabel}
          {charge.label}
        </span>
        <span style={barTrack}>
          <span
            style={{
              display: 'block',
              height: '100%',
              width: `${Math.max(0, Math.min(100, charge.intensity))}%`,
              borderRadius: 3,
              // 强度越高越不透明：同一块颜色就能看出轻重，不必再读数字。
              background: `color-mix(in srgb, ${color} ${Math.max(25, Math.round(charge.intensity))}%, transparent)`,
            }}
          />
        </span>
        <span style={{ ...meta, margin: 0, textAlign: 'right' }}>
          {absent ? t('emotion.absent') : t(TIER_KEYS[charge.tier as keyof typeof TIER_KEYS] ?? 'emotion.tier.calm')}
        </span>
      </div>
      {absent ? null : (
        <p style={{ ...meta, marginLeft: 76 }}>
          {t('emotion.cause')}：{cause}
          {duration === '' ? '' : ` · ${duration}`}
        </p>
      )}
    </div>
  )
}

/**
 * 情绪页。
 * @param props - 字典座位与情绪控制器。
 */
export function EmotionPage({ t, controller }: EmotionPageProps) {
  // 第三个参数是服务端渲染用的快照：缺了它 SSR 会直接报错（与 `MemoryPage` 同一条约定）。
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)

  // 情绪是在**别处**（对话里）变的，这一页不会收到任何推送 —— 0.1.7 之后第三方没有
  // `settings/document-updated` 那种事件可用。所以：切到这一页时重读一次，页面开着时每 30 秒
  // 重读一次。少了这一步，用户会看到一份"永远停在上次打开时"的旧心情（真机实测踩过）。
  useEffect(() => {
    void controller.load({ quiet: true })
    const timer = setInterval(() => {
      void controller.load({ quiet: true })
    }, 30_000)
    return () => {
      clearInterval(timer)
    }
  }, [controller])

  const now = Date.now()
  const document = state.document

  return (
    <div style={page}>
      <div style={column}>
        <header>
          <div style={titleRow}>
            <h1 style={title}>{t('emotion.title')}</h1>
          </div>
          <p style={subtitle}>{t('emotion.hint')}</p>
        </header>

        {state.status === 'loading' && <p style={{ ...subtitle, marginTop: 16 }}>{t('emotion.loading')}</p>}
        {state.status === 'unavailable' && (
          <p style={{ ...subtitle, marginTop: 16 }}>{t('emotion.unavailable')}</p>
        )}
        {state.status === 'failed' && (
          <p style={{ ...subtitle, marginTop: 16 }}>{t('emotion.failed', { message: state.error ?? '' })}</p>
        )}

        {document !== undefined && (
          <>
            <section style={panel}>
              {document.charges.length === 0 ? (
                <p style={{ ...hint, margin: 0 }}>{t('emotion.empty')}</p>
              ) : (
                // 全部列出来：这一页是观察窗，藏起弱的那几条等于让人以为它情绪很少。
                document.charges.map((charge) => (
                  <ChargeRow key={`${charge.kind}-${charge.since}`} t={t} charge={charge} now={now} />
                ))
              )}
              {document.compositeLabel === '' ? null : (
                <p style={{ ...meta, marginTop: 16 }}>
                  {t('emotion.composite')}：
                  <strong style={{ color: 'var(--dsw-alias-label-primary)' }}>{document.compositeLabel}</strong>
                  {document.compositeParts.length === 2 ? `（${document.compositeParts.join(' + ')}）` : ''}
                </p>
              )}
              {document.charges.some((charge) => charge.tier === 'burst') && (
                <p style={{ ...meta, marginTop: 12 }}>{t('emotion.tier.burstHint')}</p>
              )}
            </section>

            <section style={panel}>
              <h2 style={panelTitle}>{t('emotion.sensitivity')}</h2>
              <p style={{ ...meta, marginTop: 0 }}>{t('emotion.sensitivityHint')}</p>
              {document.sensitivities.length === 0 ? (
                <p style={{ ...meta, marginTop: 8 }}>{t('emotion.sensitivityEmpty')}</p>
              ) : (
                document.sensitivities.map((entry) => (
                  <div key={`${entry.kind}-${entry.target}`} style={sensitivityRow}>
                    <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
                      {entry.targetLabel}
                      {entry.label}
                    </span>
                    <span style={barTrack}>
                      <span
                        style={{
                          display: 'block',
                          height: '100%',
                          width: `${Math.round(Math.max(0, Math.min(1, entry.level)) * 100)}%`,
                          borderRadius: 3,
                          background: 'var(--dsw-alias-label-primary)',
                        }}
                      />
                    </span>
                  </div>
                ))
              )}
            </section>

            <section style={panel}>
              <h2 style={panelTitle}>{t('emotion.warmth')}</h2>
              <p style={{ ...meta, marginTop: 0 }}>{t('emotion.warmthHint')}</p>
              <div style={{ ...barTrack, marginTop: 10 }}>
                <span
                  style={{
                    display: 'block',
                    height: '100%',
                    width: `${Math.max(0, Math.min(100, document.warmth))}%`,
                    borderRadius: 3,
                    background: 'var(--dsw-alias-label-primary)',
                  }}
                />
              </div>
              {document.warmthCause === '' ? null : <p style={meta}>{document.warmthCause}</p>}
            </section>

            <section style={panel}>
              <h2 style={panelTitle}>{t('emotion.energy')}</h2>
              <p style={{ ...meta, marginTop: 0 }}>{t('emotion.energyHint')}</p>
              <div style={{ ...barTrack, marginTop: 10 }}>
                <span
                  style={{
                    display: 'block',
                    height: '100%',
                    width: `${Math.max(0, Math.min(100, document.energy))}%`,
                    borderRadius: 3,
                    background: 'var(--dsw-alias-label-primary)',
                  }}
                />
              </div>
              <p style={meta}>{t(ENERGY_KEYS[document.energyLevel] ?? 'emotion.energy.fresh')}</p>
            </section>

            {document.perceived === '' ? null : (
              <section style={panel}>
                <h2 style={panelTitle}>{t('emotion.perceived')}</h2>
                <p style={{ ...meta, marginTop: 0 }}>{t('emotion.perceivedHint')}</p>
                <p style={{ margin: '8px 0 0' }}>{document.perceived}</p>
              </section>
            )}

            <p style={{ ...subtitle, marginTop: 16 }}>
              {t('emotion.settledAt', { time: agoText(t, document.settledAt, now) })}
              {' · '}
              {t('emotion.globalHint')}
            </p>
          </>
        )}
      </div>
    </div>
  )
}
