/**
 * 「技能」页（M7）：自进化总结出来的技能**在哪、是什么、什么时候起作用**，并能手动增改。
 *
 * 交互（用户 2026-09-26 定的）：卡片上只有**「编辑」「停用/恢复」**两个按钮 ——
 * 编辑展开后正文就在表单里，所以不再有单独的「看正文」（两个按钮做同一件事是多余的）。
 * **编辑就地展开**：点哪条，哪条原地变成表单 —— 早先的写法把表单渲染在页面顶部，
 * 用户在列表中段点按钮时表单出现在视口外，看起来像"点了没反应"（真机反馈）。
 * 能力边界也写在这页上：**没有删除**（官方文件服务与官方工具都没有删除能力），
 * 下线用官方 `disable-model-invocation`（停用），文件保留、随时恢复。
 * @module deepseek-harness-humanity/client/skills-page
 */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { useSyncExternalStore, useState } from 'react'

import type { EvolutionWorkbenchController } from './evolution-controller.js'
import { emptyEvolutionState, type EvolutionWorkbenchState } from './evolution-document.js'
import type { SkillDraftView } from './evolution-views.js'
import { InfoHint } from './InfoHint.js'
import { NS } from './locales.js'
import { cardList } from './card-styles.js'
import { SkillCard } from './SkillCard.js'
import { SkillEditor } from './SkillEditor.js'
import { headingWithHint, hint, panel, panelTitle, tabRow } from './styles.js'

type Translate = PropsLocale<typeof NS>['t']

/** 表单状态：正在新建，或正在改某一条。 */
interface EditState {
  draft: SkillDraftView
  isNew: boolean
}

/** 控制器缺席时的替身（崩溃防线：宿主只接上部分视图时，技能页显示空态而不是抛）。 */
const NOOP_SUBSCRIBE = (): (() => void) => () => {}
const DETACHED_STATE = emptyEvolutionState()
const DETACHED = { subscribe: NOOP_SUBSCRIBE, getSnapshot: () => DETACHED_STATE }

export interface SkillsPageProps {
  t: Translate
  /** 自进化控制器（技能清单与编辑命令都搭在它的通道上；缺席时只读空态）。 */
  controller?: EvolutionWorkbenchController
}

/**
 * 技能页。
 * @param props - 字典座位与控制器。
 * @returns 技能页；空清单时显示空态而不是空白。
 */
export function SkillsPage({ t, controller }: SkillsPageProps) {
  const [editing, setEditing] = useState<EditState | null>(null)
  const source = controller ?? DETACHED
  const state: EvolutionWorkbenchState = useSyncExternalStore(
    source.subscribe,
    source.getSnapshot,
    source.getSnapshot,
  )
  const busy = state.busy !== ''
  const editable = controller !== undefined && state.writable && !busy
  // 这一页的三段说明（技能怎么起作用 / 文件放在哪 / 为什么没有删除）合并进标题旁的「?」。
  const intro = [t('skills.mechanism'), t('skills.location'), t('skills.deleteHint')].join(' ')

  // 只有宿主真的收下了才关表单（2026-09-26 客户端审计：原来不管成败都关，用户按了保存毫无反馈）。
  const save = (): void => {
    if (controller === undefined || editing === null) return
    const job = editing.isNew ? controller.createSkill(editing.draft) : controller.updateSkill(editing.draft)
    void job.then((ok) => {
      if (ok) setEditing(null)
    })
  }
  // 失败与"上次操作结论"都如实显示：写入被拒的原因在 error 里，宿主给的回执在 notice 里。
  const feedback = state.error === undefined || state.error === '' ? state.notice : state.error

  return (
    <div>
      <section style={panel}>
        <h2 style={{ ...panelTitle, ...headingWithHint }}>
          {t('skills.title')}
          <InfoHint label={intro} />
        </h2>
        {state.skillsWritable ? null : <p style={hint}>{t('skills.notWritable')}</p>}
        {state.skillsReport === '' ? null : (
          <p style={hint}>
            {t('skills.report')}：{state.skillsReport}
          </p>
        )}
        <div style={{ ...tabRow, marginTop: 10 }}>
          <Button
            size="sm"
            variant="primary"
            disabled={!editable}
            onClick={() => setEditing({ draft: { name: '', description: '', content: '' }, isNew: true })}
          >
            {t('skills.new')}
          </Button>
        </div>
      </section>

      {editing?.isNew === true ? (
        <SkillEditor
          t={t}
          draft={editing.draft}
          isNew
          busy={busy}
          onChange={(patch) => setEditing({ ...editing, draft: { ...editing.draft, ...patch } })}
          onSave={save}
          onCancel={() => setEditing(null)}
        />
      ) : null}

      {feedback === '' ? null : <p style={hint} role="alert">{feedback}</p>}

      {state.skills.length === 0 ? (
        <section style={panel}>
          <p style={hint}>{t('skills.empty')}</p>
        </section>
      ) : (
        <ul style={cardList}>
          {state.skills.map((skill) =>
            editing !== null && !editing.isNew && editing.draft.name === skill.name ? (
              // 就地编辑：同一个位置换成表单（列表里仍占一个 li，排版不跳）。
              <li key={skill.name}>
                <SkillEditor
                  t={t}
                  draft={editing.draft}
                  isNew={false}
                  file={skill.file}
                  disabled={skill.disabled}
                  busy={busy}
                  onChange={(patch) => setEditing({ ...editing, draft: { ...editing.draft, ...patch } })}
                  onSave={save}
                  onCancel={() => setEditing(null)}
                />
              </li>
            ) : (
              <SkillCard
                key={skill.name}
                t={t}
                skill={skill}
                editable={editable}
                onEdit={() =>
                  setEditing({
                    draft: { name: skill.name, description: skill.description, content: skill.content },
                    isNew: false,
                  })
                }
                onToggleDisabled={() => void controller?.setSkillDisabled(skill.name, !skill.disabled)}
              />
            ),
          )}
        </ul>
      )}
    </div>
  )
}
