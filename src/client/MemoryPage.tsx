/**
 * 记忆工作台：**一条时间线**。
 *
 * 这一版做两件事：**让记忆看得见**，以及**让她记得的东西由你清得掉**。
 * 每条显示四件事：发生了什么、什么时候、关于谁、现在还有多牢。
 * "多牢"用一条细轨 + 位置表示（和性格页同一套画法）—— 数字只有调试时才有意义，
 * 一眼看出"这条快没了"才是界面该干的事。
 * @module deepseek-harness-humanity/client/MemoryPage
 */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { useCallback, useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react'

import { useVisibleRefresh } from './use-visible-refresh.js'

import { NS } from './locales.js'
import type { MemoryWorkbenchController } from './memory-controller.js'
import type { Translate } from './PersonaIssues.js'
import type { MemoryEntryView } from './memory-document.js'

/**
 * 秘密的门槛：与宿主 `memory/constants.ts` 的 `DISCLOSURE_THRESHOLD` 同一个值。
 *
 * 这里重复一个字面量而不是 import 宿主模块（那会把整棵宿主树打进浏览器 bundle）。
 * 界面只负责"遮不遮"，判定权仍在宿主 —— 客户端写成什么都不会改变她说不说。
 */
const DISCLOSURE_THRESHOLD = 0.5
import { headingWithHint, panel, panelTitle, title } from './styles.js'

export interface MemoryPageProps extends PropsLocale<typeof NS> {
  controller: MemoryWorkbenchController
}

/** 页面外层。 */
const page: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12 }

/** 顶部统计那一行。 */
const stats: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 16,
  fontSize: 13,
  color: 'var(--dsw-alias-label-secondary)',
}

/** 一条记忆。 */
const row: CSSProperties = {
  padding: '10px 0',
  borderTop: '1px solid var(--dsw-alias-border-l2)',
}

/** 每条顶部的小字。 */
const meta: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'baseline',
  gap: 10,
  fontSize: 12,
  color: 'var(--dsw-alias-label-secondary)',
}

/** 正文。 */
const what: CSSProperties = {
  margin: '6px 0 8px',
  fontSize: 13,
  lineHeight: 1.6,
  color: 'var(--dsw-alias-label-primary)',
  overflowWrap: 'anywhere',
}

/** 强度轨道。 */
const track: CSSProperties = {
  position: 'relative',
  height: 5,
  borderRadius: 3,
  background: 'var(--dsw-alias-border-l2)',
}

/** 强度填充。 */
const fill: CSSProperties = {
  position: 'absolute',
  top: 0,
  bottom: 0,
  left: 0,
  borderRadius: 3,
  background: 'var(--dsw-alias-brand-primary)',
}

/** 秘密条目那一行的遮罩文字。 */
const secretMask: CSSProperties = { color: 'var(--dsw-alias-label-secondary)', fontStyle: 'italic' }

/** 二次确认时的提醒。 */
const secretWarn: CSSProperties = { color: 'var(--dsw-alias-state-warn-label)', fontSize: 12 }

/** 删除确认时的提醒（比秘密那道更轻：删除是不可撤销的，但不会牵动她）。 */
const deleteWarn: CSSProperties = { color: 'var(--dsw-alias-state-warn-label)', fontSize: 12 }

/** 每行右侧的动作区：靠右，不跟正文挤在一起。 */
const rowActions: CSSProperties = { marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'baseline' }

/** 上一次动作的结论。 */
const noticeLine: CSSProperties = { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', margin: '4px 0' }

/** 「上一次她为什么想起」那一块：单独框起来，跟时间线分开。 */
const whyBox: CSSProperties = {
  margin: '10px 0 6px',
  padding: '10px 12px',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-1)',
  border: '1px solid var(--dsw-alias-border-l2)',
}

/** 那一块的标题。 */
const whyTitle: CSSProperties = { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', margin: '0 0 6px' }

/** 触发这次回忆的那句话。 */
const whyCue: CSSProperties = {
  fontSize: 13,
  margin: '0 0 6px',
  color: 'var(--dsw-alias-label-primary)',
  overflowWrap: 'anywhere',
}

/** 想起的那几条。 */
const whyList: CSSProperties = {
  margin: 0,
  paddingLeft: 18,
  fontSize: 13,
  lineHeight: 1.6,
  color: 'var(--dsw-alias-label-primary)',
}

/** 相关度的说法（很相关 / 有点相关 / 沾了点边）。 */
const whyMatch: CSSProperties = { marginLeft: 8, fontSize: 11, color: 'var(--dsw-alias-label-secondary)' }

/** 空态/错误提示。 */
const notice: CSSProperties = {
  fontSize: 13,
  color: 'var(--dsw-alias-label-secondary)',
  padding: '12px 0',
}

/** 把 `about` 翻成人话。 */
const aboutText = (about: string, t: Translate): string => {
  switch (about) {
    case 'self':
      return t('memory.about.self')
    case 'user':
      return t('memory.about.user')
    case 'us':
      return t('memory.about.us')
    default:
      return t('memory.about.world')
  }
}

/** 把时间戳说成日期（时间线只需要到天）。 */
function dayOf(iso: string): string {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return ''
  const date = new Date(at)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/**
 * 渲染一条记忆。
 *
 * 秘密（`cost` 高于门槛）不显示正文，只给一行"不想说"和一个**要走两步**的入口：
 * 第一次点是"我要看"，第二次点才是"确认要看" —— 这道坎就是"翻她东西"的分量。
 * 删除同样走两步：删掉是真的没了，误会点一下就没有了。
 * @param props - 这条记忆、字典与各动作回调。
 * @returns 一行。
 */
function EntryRow({
  entry,
  t,
  pending,
  onAsk,
  onConfirm,
  deleting,
  onDeleteAsk,
  onDeleteConfirm,
}: {
  entry: MemoryEntryView
  t: Translate
  pending: boolean
  onAsk(): void
  onConfirm(): void
  deleting: boolean
  onDeleteAsk(): void
  onDeleteConfirm(): void
}) {
  const percent = `${Math.round(Math.min(1, Math.max(0, entry.strength)) * 100)}%`
  const secret = entry.cost > DISCLOSURE_THRESHOLD
  return (
    <div style={row}>
      <div style={meta}>
        <span>{dayOf(entry.when)}</span>
        <span>{aboutText(entry.about, t)}</span>
        <span>{t(`memory.tier.${entry.tier}` as never)}</span>
        {entry.feltLabel !== '' ? <span>{t('memory.felt').replace('{label}', entry.feltLabel)}</span> : null}
        {entry.covers > 0 ? <span>{t('memory.covers').replace('{count}', String(entry.covers))}</span> : null}
        {entry.recalled > 0 ? <span>{t('memory.recalled').replace('{count}', String(entry.recalled))}</span> : null}
        <div style={rowActions}>
          {deleting ? (
            <>
              <span style={deleteWarn}>{t('memory.delete.warn')}</span>
              <Button size="sm" variant="outline" onClick={onDeleteConfirm}>
                {t('memory.delete.confirm')}
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={onDeleteAsk}>
              {t('memory.delete.ask')}
            </Button>
          )}
        </div>
      </div>
      {secret ? (
        <p style={what}>
          <span style={secretMask}>🔒 {t('memory.secret')}</span>{' '}
          {pending ? (
            <>
              <span style={secretWarn}>{t('memory.reveal.warn')}</span>{' '}
              <Button size="sm" variant="primary" onClick={onConfirm}>
                {t('memory.reveal.confirm')}
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={onAsk}>
              {t('memory.reveal.ask')}
            </Button>
          )}
        </p>
      ) : (
        <p style={what}>{entry.what}</p>
      )}
      <div style={track} aria-hidden>
        <div style={{ ...fill, width: percent }} />
      </div>
    </div>
  )
}

/**
 * 记忆工作台。
 * @param props - 字典座位与控制器。
 * @returns 页面。
 */
export function MemoryPage({ t, controller }: MemoryPageProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  /** 已经点了"我要看"、正在等第二次确认的那一条。 */
  const [pendingId, setPendingId] = useState('')
  /** 已经点了"删掉"、正在等第二次确认的那一条。 */
  const [deletingId, setDeletingId] = useState('')

  useEffect(() => {
    void controller.load()
  }, [controller])

  // 切回本页时静默重取一次：记忆是"对话里长出来的"，钉在挂载那一刻就会一直是旧列表
  // （2026-11-22 真机现场：左边聊天、右边工作台，聊完切回来还是旧值）。
  const reload = useCallback(() => {
    void controller.load({ quiet: true })
  }, [controller])
  useVisibleRefresh(reload)

  const { doc } = state
  const ready = state.status === 'ready'

  return (
    <div style={page}>
      <section style={panel}>
        <h2 style={{ ...panelTitle, ...headingWithHint }}>
          {t('memory.title')}
          <Button size="sm" variant="ghost" onClick={() => void controller.load()}>
            {t('memory.reload')}
          </Button>
        </h2>

        {state.status === 'loading' ? <p style={notice}>{t('memory.loading')}</p> : null}
        {state.status === 'unavailable' ? <p style={notice}>{t('memory.unavailable')}</p> : null}
        {state.status === 'failed' ? <p style={notice}>{state.error ?? t('memory.failed')}</p> : null}
        {ready && doc.notice !== '' ? <p style={noticeLine}>{doc.notice}</p> : null}

        {ready ? (
          <>
            <div style={stats}>
              <span>{t('memory.total').replace('{count}', String(doc.stats.total))}</span>
              <span>{t('memory.tier.episode')} {doc.stats.episode}</span>
              {doc.stats.period > 0 ? <span>{t('memory.tier.period')} {doc.stats.period}</span> : null}
              {doc.stats.chapter > 0 ? <span>{t('memory.tier.chapter')} {doc.stats.chapter}</span> : null}
              <span>{t('memory.recalledTotal').replace('{count}', String(doc.stats.recalled))}</span>
            </div>

            {doc.lastRecall.items.length > 0 ? (
              <div style={whyBox}>
                <p style={whyTitle}>{t('memory.why.title')}</p>
                {doc.lastRecall.cue !== '' ? (
                  <p style={whyCue}>{t('memory.why.cue').replace('{cue}', doc.lastRecall.cue)}</p>
                ) : null}
                <ul style={whyList}>
                  {doc.lastRecall.items.map((item, index) => (
                    <li key={`${index}-${item.what}`}>
                      {item.withheld ? t('memory.why.withheld') : item.what}
                      {item.match !== '' ? (
                        <span style={whyMatch}>{t(`memory.why.match.${item.match}` as never)}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {doc.entries.length === 0 ? (
              <p style={notice}>{doc.dormant ? t('memory.dormant') : t('memory.empty')}</p>
            ) : (
              doc.entries.map((entry) => (
                <EntryRow
                  key={entry.id}
                  entry={entry}
                  t={t}
                  pending={pendingId === entry.id}
                  onAsk={() => setPendingId(entry.id)}
                  onConfirm={() => {
                    setPendingId('')
                    void controller.reveal(entry.id).then((ok) => {
                      if (ok) void controller.load({ quiet: true })
                    })
                  }}
                  deleting={deletingId === entry.id}
                  onDeleteAsk={() => setDeletingId(entry.id)}
                  onDeleteConfirm={() => {
                    setDeletingId('')
                    void controller.remove(entry.id).then((ok) => {
                      if (ok) void controller.load({ quiet: true })
                    })
                  }}
                />
              ))
            )}
          </>
        ) : null}
      </section>
    </div>
  )
}
