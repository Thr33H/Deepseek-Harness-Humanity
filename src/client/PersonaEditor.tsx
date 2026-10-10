/**
 * 人格编辑区（M2 步 6 的最小工作台编辑）。
 *
 * 范围按用户裁决 5：固定身份卡 + 可变层标准小标题可编辑、保存前走校验；
 * **不做** diff / 撤销 / 历史 UI / 复杂交互。所以这里没有多级撤销、没有字段级历史，
 * 只有「改动 → 保存（校验失败则原地拒绝）→ 重新加载」这条闭环。
 *
 * 本文件只负责：订阅控制器状态、把四种状态分流、就绪时把两张卡片（见 `PersonaCards.tsx`）与
 * 底栏拼起来。字段级组件在 `PersonaFields.tsx`，样式在 `editor-styles.ts`。
 * @module deepseek-harness-humanity/client/PersonaEditor
 */
import { useEffect, useSyncExternalStore } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import { actions, footer, issueRejected, issueWarning, statusText } from './editor-styles.js'
import { IdentityCardEditor, MutableCardEditor } from './PersonaCards.js'
import { IssueGroup, StatusNotice, type Translate } from './PersonaIssues.js'
import { isDirty, type PersonaIssueView, type PersonaWorkbenchState } from './persona-document.js'
import type { PersonaWorkbenchController } from './persona-controller.js'

/** 组件属性：座位闭包把控制器递进来（`createWorkbenchSeat`）。 */
export interface PersonaEditorProps {
  t: Translate
  controller: PersonaWorkbenchController
}

/**
 * 校验问题与保存失败提示（阻断级 / 警告级 / 宿主拒绝）。
 * @param props - 字典座位、问题清单与出错信息。
 * @returns 提示区元素。
 */
function IssueNotices({
  t,
  issues,
  error,
}: {
  t: Translate
  issues: readonly PersonaIssueView[]
  error: string | undefined
}) {
  const rejected = issues.filter((issue) => issue.severity === 'rejected')
  const warnings = issues.filter((issue) => issue.severity === 'warning')
  return (
    <>
      <IssueGroup
        t={t}
        label={t('persona.blocked', { count: String(rejected.length) })}
        issues={rejected}
        tone={issueRejected}
        alert
      />
      <IssueGroup
        t={t}
        label={t('persona.warnings', { count: String(warnings.length) })}
        issues={warnings}
        tone={issueWarning}
      />
      {error !== undefined ? (
        <p style={{ ...statusText, marginTop: 12 }} role="alert">
          {t('persona.rejected', { message: error })}
        </p>
      ) : null}
    </>
  )
}

/**
 * 底部状态与「重新加载」。
 *
 * 保存按钮**不在这里**（用户 2026-09-26：身份卡与人格卡各自带一个保存按钮）——
 * 底栏只留状态与重新加载，避免同一件事出现三个入口。
 * @param props - 字典、控制器、忙碌与只读状态、脏标记、最近保存时间。
 * @returns 底栏元素。
 */
function EditorFooter({
  t,
  controller,
  busy,
  writable,
  dirty,
  savedAt,
}: {
  t: Translate
  controller: PersonaWorkbenchController
  busy: boolean
  writable: boolean
  dirty: boolean
  savedAt: string
}) {
  const status = !writable ? t('persona.readonly') : dirty ? t('persona.dirty') : savedAt === '' ? '' : t('persona.saved')
  return (
    <div style={footer}>
      <p style={statusText}>{status}</p>
      <div style={actions}>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void controller.load()}>
          {t('persona.reload')}
        </Button>
      </div>
    </div>
  )
}

/**
 * 就绪状态下的编辑区：两张卡片（身份卡 / 人格卡）+ 它们共用的问题清单与保存底栏。
 *
 * 底栏不放进任何一张卡片：保存写的是**整份**人格文档（两张卡片的改动一起落盘）。
 * @param props - 字典座位、控制器与当前快照。
 * @returns 编辑区元素。
 */
function ReadyEditor({
  t,
  controller,
  state,
}: {
  t: Translate
  controller: PersonaWorkbenchController
  state: PersonaWorkbenchState
}) {
  return (
    <>
      <IdentityCardEditor t={t} controller={controller} state={state} />
      <MutableCardEditor t={t} controller={controller} state={state} />
      <IssueNotices t={t} issues={state.issues} error={state.error} />
      <EditorFooter
        t={t}
        controller={controller}
        busy={state.saving}
        writable={state.writable}
        dirty={isDirty(state)}
        savedAt={state.savedAt}
      />
    </>
  )
}

/**
 * 人格编辑区（对外入口）：订阅控制器状态并分流。
 * @param props - 字典座位与状态控制器。
 * @returns 编辑区元素。
 */
export function PersonaEditor({ t, controller }: PersonaEditorProps) {
  // 第三个参数是**服务端快照**，不能省：漏了它，任何 SSR / 预渲染路径都会直接抛错
  // （React 的报错原文：Missing getServerSnapshot…）。这里两端用同一个 getter——
  // 控制器的状态本来就是"当前这一份"，服务端与客户端读的是同一个快照，不存在水合不一致。
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)

  // 挂载即读一次。控制器在 remote 服务 attach 时也会读一次；两次都是幂等的 GET，
  // 但先挂载后 attach 的时序（或反过来）都会因此收敛到"最终读到"。
  useEffect(() => {
    void controller.load()
  }, [controller])

  const notice = StatusNotice({ t, state })
  if (notice !== null) return notice
  return <ReadyEditor t={t} controller={controller} state={state} />
}
