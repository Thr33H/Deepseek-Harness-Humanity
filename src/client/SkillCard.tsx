/**
 * 单条技能卡（从 `SkillsPage.tsx` 拆出：那份文件已贴着文件行数质量门）。
 *
 * 卡片只负责**显示 + 把点击交出去**；它不判断"能不能改"（`editable` 由页面按宿主状态算好），
 * 也不猜状态（四态与停用标记都来自宿主投影）。
 *
 * 版式是**标准卡**（骨架见 `card-styles.ts`）：左元信息（状态 / 停用 / 文件路径）｜
 * 中内容（技能名 + 说明 + 来源）｜右操作（编辑 / 停用·恢复）。警告（没落盘、文件被改过、
 * 依赖某个插件）横跨整卡 —— 它们是关于整条的提醒，不是内容的一部分。
 *
 * 按钮只有两个（用户 2026-09-26 定的）：「编辑」与「停用/恢复」——
 * **不再有「看正文」**：编辑展开后正文就在表单里，两个按钮做同一件事是多余的。
 * @module deepseek-harness-humanity/client/skill-card
 */
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

import {
  card,
  cardActions,
  cardBody,
  cardLayout,
  cardLine,
  cardMeta,
  cardNote,
  cardSpan,
  cardSpanLine,
  cardTags,
  cardTitle,
} from './card-styles.js'
import type { SkillView } from './evolution-document.js'
import { InfoHint } from './InfoHint.js'
import { NS } from './locales.js'

type Translate = PropsLocale<typeof NS>['t']

/** 状态标签色调：落盘＝正常，仅运行时＝要提醒，没生效＝同样要提醒，其余中性。 */
const STATUS_TONE: Record<string, 'quiet' | 'outline' | 'neutral'> = {
  'on-disk': 'quiet',
  'runtime-only': 'outline',
  unregistered: 'outline',
}

export interface SkillCardProps {
  t: Translate
  skill: SkillView
  /** 宿主的写入能力就绪且当前不忙（页面算好传进来）。 */
  editable: boolean
  onEdit(): void
  onToggleDisabled(): void
}

/** 这条技能要提醒的事（没落盘 / 没生效 / 文件被改过 / 依赖某插件）——横跨整卡。 */
function SkillAlerts({ t, skill }: { t: Translate; skill: SkillView }) {
  const alerts: Array<{ key: string; text: string }> = []
  if (skill.status === 'runtime-only') alerts.push({ key: 'runtime', text: t('skills.statusHint.runtimeOnly') })
  if (skill.status === 'unregistered') {
    alerts.push({ key: 'unregistered', text: t('skills.statusHint.unregistered') })
  }
  if (skill.status === 'diverged') alerts.push({ key: 'diverged', text: t('skills.statusHint.diverged') })
  if (skill.pluginDeps.length > 0) {
    alerts.push({ key: 'deps', text: t('skills.pluginDeps', { plugins: skill.pluginDeps.join('、') }) })
  }
  if (alerts.length === 0) return null
  return (
    <div style={cardSpan}>
      {alerts.map((alert) => (
        <p key={alert.key} style={{ ...cardSpanLine, marginTop: 4 }}>
          {alert.text}
        </p>
      ))}
    </div>
  )
}

/**
 * 一条技能。
 * @param props - 字典、技能视图与两个回调。
 * @returns 技能卡。
 */
export function SkillCard(props: SkillCardProps) {
  const { t, skill } = props
  const fileLabel = skill.file === '' ? t('skills.fileRuntime') : skill.file

  return (
    <li style={card}>
      <div style={cardLayout}>
        <div style={cardMeta}>
          <div style={cardTags}>
            <Tag tone={STATUS_TONE[skill.status] ?? 'neutral'}>{t(`skills.status.${skill.status}` as never)}</Tag>
            {skill.disabled ? (
              <>
                <Tag tone="outline">{t('skills.disabledBadge')}</Tag>
                <InfoHint label={t('skills.disabledHint')} />
              </>
            ) : null}
          </div>
          {/* 路径是"这条技能到底在哪"的唯一答案：完整值进 title，列内断行显示。 */}
          <span style={cardNote} title={skill.file === '' ? undefined : skill.file}>
            {fileLabel}
          </span>
          {skill.origin === '' ? null : <span style={cardNote}>{skill.origin}</span>}
        </div>
        <div style={cardBody}>
          <strong style={cardTitle}>{skill.name}</strong>
          <p style={cardLine}>{skill.description}</p>
        </div>
        <div style={cardActions}>
          <Button size="sm" variant="outline" disabled={!props.editable} onClick={props.onEdit}>
            {t('skills.edit')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!props.editable || skill.file === ''}
            onClick={props.onToggleDisabled}
          >
            {skill.disabled ? t('skills.enable') : t('skills.disable')}
          </Button>
        </div>
        <SkillAlerts t={t} skill={skill} />
      </div>
    </li>
  )
}

