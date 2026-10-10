/**
 * 人格编辑区的**两张卡片**：身份卡（固定层 + 独立判断模式开关）与人格卡（可变层 + 用户定义）。
 *
 * 为什么单独一个文件（用户 2026-09-23 最终布局）：固定层与可变层是两种不同权限的数据 ——
 * 前者对 Agent 封存、只有用户能改；后者由 Agent 整理。分成两张卡片、各有标题，边界一眼可见；
 * 「独立判断模式」开关放在身份卡顶部（它决定 AI 的行为底线，与"底色"同级），下方用横线隔开字段。
 *
 * 状态由 `PersonaEditor` 统一订阅后传进来；这里只负责画。
 * @module deepseek-harness-humanity/client/PersonaCards
 */
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'

import { personaPromptReport } from '../host/persona/render.js'
import { VALUE_SOFT_LIMIT } from '../host/persona/constants.js'
import { IndependentJudgmentRow } from './IndependentJudgmentRow.js'
import { divider, budgetWarning } from './editor-styles.js'
import { InfoHint } from './InfoHint.js'
import { IdentityFields, MutableFields } from './PersonaFields.js'
import { isDirty, type PersonaWorkbenchState } from './persona-document.js'
import type { PersonaWorkbenchController } from './persona-controller.js'
import type { Translate } from './PersonaIssues.js'
import { headingWithHint, panel, panelTitle } from './styles.js'

/** 两张卡片共用的属性：字典、控制器与当前快照。 */
interface CardProps {
  t: Translate
  controller: PersonaWorkbenchController
  state: PersonaWorkbenchState
}

/**
 * 卡片自带的**保存**按钮（用户 2026-09-26：身份卡与人格卡各要一个，别共用一个底栏）。
 *
 * 说清楚它的边界：保存写的是**整份人格文档**（两张卡的改动一起落盘，P-017 整份快照写回）——
 * 按钮放在各自卡片上只是"改完就地保存"的位置便利，不是"只保存这一张卡"。
 * 因此禁用条件跟随**整份草稿**的脏标记：没有未保存改动时两张卡的按钮一起变灰。
 * @param props - 字典、控制器与当前快照。
 * @returns 保存按钮。
 */
function CardSaveButton({ t, controller, state }: CardProps) {
  const busy = state.saving
  return (
    <Button
      size="sm"
      variant="primary"
      disabled={busy || !state.writable || !isDirty(state)}
      onClick={() => void controller.save()}
    >
      {busy ? t('persona.saving') : t('persona.save')}
    </Button>
  )
}

/**
 * 身份卡卡片：标题（带封存标记）+ 说明 + 「独立判断模式」开关 + 横线 + 固定层字段。
 *
 * 为什么开关在这里（用户 2026-09-23 最终布局）：它决定 AI 的行为底线，与"底色"同级；
 * 但它不是身份卡字段，所以用一条横线把它和字段区分开 —— 看得见是同一张卡里的两件事。
 * @param props - 字典座位、控制器与当前快照。
 * @returns 身份卡卡片。
 */
export function IdentityCardEditor({ t, controller, state }: CardProps) {
  const sealed = state.stored.identityCard.sealedAt !== ''
  return (
    <section style={panel}>
      <h2 style={{ ...panelTitle, ...headingWithHint }}>
        {t('persona.identityCard')}{' '}
        <Tag tone={sealed ? 'neutral' : 'outline'}>{sealed ? t('persona.sealed') : t('persona.unsealed')}</Tag>
        {/* 未封存时给一个**显式**入口（2026-09-26 真机缺口）：原来封存只发生在"首次保存"，
            预填 / 旧数据那种"已初始化但未封存"的卡在界面上永远封不上，独立判断开关一直是灰的。 */}
        {sealed ? null : (
          <Button
            size="sm"
            variant="outline"
            disabled={state.saving || !state.writable}
            onClick={() => void controller.seal()}
          >
            {t('persona.sealAction')}
          </Button>
        )}
        {/* 每张卡自带一个保存按钮（用户 2026-09-26）：改完就地保存，不用回头看底栏。 */}
        <CardSaveButton t={t} controller={controller} state={state} />
        <InfoHint label={t('persona.identityHint')} />
      </h2>

      <IndependentJudgmentRow
        t={t}
        // 显示与可拨性跟随**生效态**：封存前独立判断段不注入（锚点不存在），开关显示关且禁用，
        // 不再让「干净装完就是开的」误导用户以为封存前它就在干预对话（用户 2026-09-25）。
        checked={sealed && state.independentJudgment}
        disabled={state.independentJudgmentSaving || !state.writable || !sealed}
        saving={state.independentJudgmentSaving}
        sealed={sealed}
        onChange={(next) => void controller.setIndependentJudgment(next)}
      />
      <hr style={divider} />

      <IdentityFields
        t={t}
        controller={controller}
        disabled={state.saving || !state.writable}
        state={state}
      />
    </section>
  )
}

/**
 * 人格卡卡片：可变层的标准/自定义小标题 + 兜底层「用户定义」。
 *
 * 与身份卡分成两张卡（用户 2026-09-23 最终布局）：固定层对 Agent 封存、只有用户能改，
 * 可变层由 Agent 整理 —— 共用一个标题会让人以为它们是同一种数据。
 *
 * **注入账目就写在这张卡的标题上**（用户 2026-09-26 发现提示词被截断后加的）：
 * 旧实现在工作台上一个字都不说，用户只能去翻系统提示词才知道"写进去的有一半没生效"。
 * 现在按**草稿**实时算（改一个字就重算），装不下时直接给出是哪些小节、还有怎么办。
 * @param props - 字典座位、控制器与当前快照。
 * @returns 人格卡卡片。
 */
export function MutableCardEditor({ t, controller, state }: CardProps) {
  const shared = { t, controller, disabled: state.saving || !state.writable }
  const report = personaPromptReport(state.draft, { independentJudgment: state.independentJudgment })
  const total = (report?.injected ?? 0) + (report?.dropped ?? 0)
  const overflow = (report?.sections ?? []).filter((section) => section.dropped > 0)
  const detail = overflow.map((section) => `${section.title} ${section.dropped} 条`).join('、')
  // 有条目被**单条上限**裁短：它进得去（`injected` 照算），但尾巴不生效 —— 与"整条没进去"是两回事，
  // 所以分开说，且只在没有整条掉队时显示（两条警告同时挂出来只会让人不知道该做哪件事）。
  const clippedOnly = report?.truncated === true && overflow.length === 0

  return (
    <section style={panel}>
      <h2 style={{ ...panelTitle, ...headingWithHint }}>
        {t('persona.mutableCard')}
        <InfoHint
          label={
            report === undefined
              ? t('persona.mutableHint')
              : `${t('persona.mutableHint')} ${t('persona.budget.hint', { budget: String(report.budget) })}`
          }
        />
        {report === undefined ? null : (
          <Tag tone={overflow.length > 0 ? 'outline' : 'quiet'}>
            {t('persona.budget.tag', { injected: String(report.injected), total: String(total) })}
          </Tag>
        )}
        <CardSaveButton t={t} controller={controller} state={state} />
      </h2>
      {overflow.length === 0 ? null : (
        <p style={budgetWarning}>{t('persona.budget.dropped', { dropped: String(report?.dropped ?? 0), sections: detail })}</p>
      )}
      {clippedOnly ? (
        <p style={budgetWarning}>{t('persona.budget.clipped', { limit: String(VALUE_SOFT_LIMIT) })}</p>
      ) : null}
      <MutableFields {...shared} state={state} />
      {/* ⚠️ 0.1.14：「用户定义」区块已下线（用户："用户自定义可以删了，它跟添加小节重复了"）。
          `mutableLayer.userDefined` 的数据**仍在文档里**、仍随保存原样写回，只是不再渲染。 */}
    </section>
  )
}
