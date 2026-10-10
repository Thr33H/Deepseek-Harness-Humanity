/**
 * 记忆页面的三块卡片：页头、活跃记忆、已归档。
 *
 * 与页面主体（`MemoryPage.tsx`）分开只为两件事：文件尺寸，以及"组合"与"某一块的渲染细节"
 * 不混在一起读。三块都只吃 props，不自己持有状态 —— 状态在控制器里。
 * @module deepseek-harness-humanity/client/memory-cards
 */
import { Button, Input, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

import { DisclosureHeading } from './DisclosureHeading.js'
import { NS } from './locales.js'
import type { MemoryItemOp } from './MemoryItem.js'
import { MemoryList } from './MemoryList.js'
import type { MemoryEntryView, MemoryWorkbenchState } from './memory-document.js'
import { cardTitleRow, degradedBanner, degradedTech, degradedText, failure, notice, searchRow } from './memory-styles.js'
import { panel, panelTitle, subtitle } from './styles.js'

/** `t` 的类型：与工作台同一个字典座位。 */
type Translate = PropsLocale<typeof NS>['t']

/** 页头：标题 + 一句状态（读取中 / 不可用 / 只读）。 */
function PageHeader({ t, state, readOnly }: { t: Translate; state: MemoryWorkbenchState; readOnly: boolean }) {
  const status =
    state.status === 'loading'
      ? t('memory.loading')
      : state.status === 'failed' || state.status === 'unavailable'
        ? t('memory.unavailable')
        : readOnly
          ? t('memory.readonly')
          : ''
  return (
    <header style={{ marginBottom: 12 }}>
      <h2 style={panelTitle}>{t('memory.title')}</h2>
      <p style={subtitle}>{status}</p>
      {/*
        失败原因**必须显示出来**（G-002）：控制器一直有在写 `state.error`（例如"并发冲突：修订号过期"），
        但页面上从来没渲染过它 —— 用户看到的只是"开关自己弹回去了"，一个字都没有（2026-09-26 审计）。
      */}
      {state.error === undefined || state.error === '' ? null : (
        <p style={failure} role="alert">
          {state.error}
        </p>
      )}
    </header>
  )
}

/**
 * 极简模式警告条。
 *
 * 只在宿主**探测到**注入被丢弃时出现（见 `preset-compat.ts`）：宁缺勿误报 ——
 * 误报会让用户去改一个本来正常的配置。颜色用警示色（warning），不用错误色：
 * 这不是故障，是平台限制。
 */
export function DegradedBanner({ t, degraded }: { t: Translate; degraded: boolean }) {
  if (!degraded) return null
  return (
    <section style={degradedBanner} role="alert">
      <strong>{t('memory.degraded.title')}</strong>
      <p style={degradedText}>{t('memory.degraded.body')}</p>
      <p style={degradedTech}>{t('memory.degraded.tech')}</p>
    </section>
  )
}

/** 活跃记忆卡片：搜索框 + 列表 + 重新加载 + 上一次操作的回执。 */
function ActiveCard(props: {
  t: Translate
  state: MemoryWorkbenchState
  entries: readonly MemoryEntryView[]
  readOnly: boolean
  regions?: readonly string[]
  onRescope?(entry: MemoryEntryView, scope: string, ownerId: string): void
  onOp(op: MemoryItemOp, entry: MemoryEntryView): void
  onQuery(query: string): void
  onReload(): void
}) {
  const { t, state } = props
  return (
    <section style={panel}>
      <div style={cardTitleRow}>
        <h2 style={panelTitle}>{t('memory.active')}</h2>
        <Button size="sm" disabled={state.status === 'loading'} onClick={props.onReload}>
          {t('memory.reload')}
        </Button>
      </div>
      <div style={searchRow}>
        <Input
          aria-label={t('memory.search')}
          placeholder={t('memory.searchPlaceholder')}
          value={state.query}
          onChange={(event) => props.onQuery(event.target.value)}
        />
      </div>
      <MemoryList
        t={t}
        entries={props.entries}
        variant="active"
        emptyKey={state.query.trim() === '' ? 'memory.empty' : 'memory.emptySearch'}
        busy={state.busy}
        readOnly={props.readOnly}
        regions={props.regions}
        onRescope={props.onRescope}
        onOp={props.onOp}
      />
      {state.notice === '' ? null : <p style={notice}>{t('memory.notice') + '：' + state.notice}</p>}
    </section>
  )
}

/** 已归档卡片：默认折叠（归档是"平时不看"的那一堆），展开后给出恢复/永久删除。 */
function ArchivedCard(props: {
  t: Translate
  entries: readonly MemoryEntryView[]
  open: boolean
  busy: string
  readOnly: boolean
  regions?: readonly string[]
  onRescope?(entry: MemoryEntryView, scope: string, ownerId: string): void
  onOp(op: MemoryItemOp, entry: MemoryEntryView): void
  onToggle(): void
}) {
  const { t } = props
  return (
    <section style={panel}>
      <DisclosureHeading
        title={`${t('memory.archived')} (${props.entries.length})`}
        open={props.open}
        label={t(props.open ? 'memory.archived.collapse' : 'memory.archived.expand')}
        onToggle={props.onToggle}
      />
      {props.open ? (
          <MemoryList
            t={t}
            entries={props.entries}
            variant="archived"
            emptyKey="memory.emptyArchived"
            busy={props.busy}
            readOnly={props.readOnly}
            regions={props.regions}
            onRescope={props.onRescope}
            onOp={props.onOp}
          />
      ) : null}
    </section>
  )
}

export { ActiveCard, ArchivedCard, PageHeader }
