/**
 * 校验问题的**展示**：一条问题怎么取文案、一组问题怎么画。
 *
 * 为什么从 `PersonaFields.tsx` 拆出来：字段组件关心"一行怎么编辑"，这里关心"问题怎么读"，
 * 两者的改动原因不同（字段类型变了 / 文案与问题代码变了）。规则真源在宿主，这里只做本地化。
 * @module deepseek-harness-humanity/client/PersonaIssues
 */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { CSSProperties } from 'react'

import { issueList, issuePath, statusText } from './editor-styles.js'
import { hint } from './styles.js'
import { NS, zh } from './locales.js'
import type { PersonaIssueView, PersonaWorkbenchState } from './persona-document.js'

/** `t` 的类型：与工作台同一个字典座位。 */
export type Translate = PropsLocale<typeof NS>['t']

/**
 * 一条校验问题的本地化文案。
 *
 * 校验结论给的是**稳定代码**（P-011），工作台按代码取文案；万一代码比字典新（宿主升级、
 * bundle 未更新），退回显示宿主给的原句 —— 宁可显示一句宿主中文，也不要显示一个裸代码。
 * @param t - 字典座位。
 * @param issue - 一条结构化问题。
 * @returns 展示用的一句话。
 */
export function issueText(t: Translate, issue: PersonaIssueView): string {
  const key = `persona.issue.${issue.code}`
  if (!(key in zh)) return issue.message
  return t(key as keyof typeof zh)
}

/**
 * 一组校验问题（阻断级 / 警告级）。
 *
 * 两级只有色调与标题不同，合成一个组件是为了避免"改了一处忘了另一处"；没有问题时整块不渲染。
 * @param props - 字典、标题、问题列表、色调与是否按 alert 朗读。
 * @returns 问题列表元素；没有问题时为 null。
 */
export function IssueGroup({
  t,
  label,
  issues,
  tone,
  alert,
}: {
  t: Translate
  label: string
  issues: readonly PersonaIssueView[]
  tone: CSSProperties
  alert?: boolean
}) {
  if (issues.length === 0) return null
  return (
    <>
      <p style={{ ...statusText, marginTop: 16 }} {...(alert === true ? { role: 'alert' } : {})}>
        {label}
      </p>
      <ul style={issueList}>
        {issues.map((issue, index) => (
          <li key={`issue-${index}`} style={tone}>
            {issueText(t, issue)} <span style={issuePath}>{issue.path}</span>
          </li>
        ))}
      </ul>
    </>
  )
}

/**
 * 未就绪的三种状态（加载中 / 通道不可用 / 读取失败）各自一句话。
 *
 * 与"问题列表"放在一起：两者都是"这一轮界面要告诉用户什么"，只是来源不同（状态机 vs 校验结论）。
 * 单独一个组件是为了让 `PersonaEditor` 只剩"订阅 + 分流 + 拼装"三件事。
 * @param props - 字典座位与当前状态。
 * @returns 提示元素；状态为就绪时返回 null。
 */
export function StatusNotice({ t, state }: { t: Translate; state: PersonaWorkbenchState }) {
  if (state.status === 'loading' || state.status === 'idle') return <p style={hint}>{t('persona.loading')}</p>
  if (state.status === 'unavailable') return <p style={hint}>{t('persona.unavailable')}</p>
  if (state.status === 'failed') {
    return (
      <p style={hint} role="alert">
        {t('persona.failed', { message: state.error ?? '' })}
      </p>
    )
  }
  return null
}
