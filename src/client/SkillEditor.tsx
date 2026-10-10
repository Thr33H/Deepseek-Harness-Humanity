/**
 * 技能编辑表单（M7）：新建与修改共用一份；**编辑时正文就在这里**（所以卡片上不再有「看正文」）。
 *
 * 只让用户填三个字段：**技能名 / 一句话说明 / 正文** —— 正好对应官方 `SKILL.md` 的两个必需
 * frontmatter 项加正文。官方增强字段（`zh_name`/`emoji`/`category`/`user-invocable`…）**不由我们生成**：
 * 用户手写过的那些，`replaceSkillDocument` 会原样保住（改一个字段毁一份文件是不可接受的）。
 * @module deepseek-harness-humanity/client/skill-editor
 */
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { CSSProperties } from 'react'

import type { SkillDraftView } from './evolution-views.js'
import { InfoHint } from './InfoHint.js'
import { NS } from './locales.js'
import { headingWithHint, hint, panel, panelTitle } from './styles.js'

type Translate = PropsLocale<typeof NS>['t']

const label: CSSProperties = { display: 'block', margin: '10px 0 4px', fontSize: 13, color: 'var(--dsw-alias-label-secondary)' }

/**
 * 单行字段的槽位：`Input` 原语的外层是 `inline-flex`（按内容收缩），放进 `grid` 里
 * 才会被拉伸成整行宽 —— 官方原语不让改外层样式，这是不写 CSS 也能占满一行的办法。
 */
const fieldSlot: CSSProperties = { display: 'grid' }

/** 多行正文（官方没有多行原语）：令牌与官方 `Input` 对齐，免得同一个表单里两种底色。 */
const body: CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  padding: '7px 10px',
  border: '0.5px solid var(--dsw-alias-border-l4)',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  fontSize: 14,
  lineHeight: 1.5,
  minHeight: 180,
  resize: 'vertical',
}
/** 底栏：与 DSH 设置页的表单一致 —— 动作在**右**，主操作（保存）是 primary 且排在最后。 */
const buttons: CSSProperties = { display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }

export interface SkillEditorProps {
  t: Translate
  draft: SkillDraftView
  /** true = 新建（技能名可填）；false = 修改已有（技能名锁定，改名等于新建另一条）。 */
  isNew: boolean
  /** 已有技能的文件路径（新建时为空）—— 让人知道这一改动的是哪个文件。 */
  file?: string
  /** 该技能当前是否已停用（编辑时如实显示，免得"停用了没"要靠猜）。 */
  disabled?: boolean
  busy: boolean
  onChange(patch: Partial<SkillDraftView>): void
  onSave(): void
  onCancel(): void
}

/**
 * 技能表单。
 * @param props - 字典、草稿、模式、文件事实与三个回调。
 * @returns 表单面板。
 */
export function SkillEditor(props: SkillEditorProps) {
  const { t, draft } = props
  const locked = props.busy
  return (
    <section style={panel}>
      <h2 style={{ ...panelTitle, ...headingWithHint }}>
        {props.isNew ? t('skills.editor.newTitle') : t('skills.editor.editTitle')}
        <InfoHint label={t('skills.editor.hint')} />
      </h2>
      {props.file === undefined ? null : (
        <p style={hint}>
          {t('skills.editor.file')}：{props.file}
          {props.disabled === true ? `（${t('skills.disabledBadge')}）` : ''}
        </p>
      )}
      <label style={label} htmlFor="humanity-skill-name">
        {t('skills.editor.name')}
      </label>
      <div style={fieldSlot}>
        <Input
          id="humanity-skill-name"
          value={draft.name}
          disabled={locked || !props.isNew}
          placeholder="my-skill"
          onChange={(event) => props.onChange({ name: event.target.value })}
        />
      </div>
      <label style={label} htmlFor="humanity-skill-description">
        {t('skills.editor.description')}
      </label>
      <div style={fieldSlot}>
        <Input
          id="humanity-skill-description"
          value={draft.description}
          disabled={locked}
          onChange={(event) => props.onChange({ description: event.target.value })}
        />
      </div>
      <label style={label} htmlFor="humanity-skill-content">
        {t('skills.editor.content')}
      </label>
      <textarea
        id="humanity-skill-content"
        style={body}
        value={draft.content}
        disabled={locked}
        onChange={(event) => props.onChange({ content: event.target.value })}
      />
      <div style={buttons}>
        <Button size="sm" variant="ghost" disabled={locked} onClick={props.onCancel}>
          {t('skills.editor.cancel')}
        </Button>
        <Button size="sm" variant="primary" disabled={locked} onClick={props.onSave}>
          {t('skills.editor.save')}
        </Button>
      </div>
    </section>
  )
}
