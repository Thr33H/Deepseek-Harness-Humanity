/**
 * 工作台编辑器的**字段级组件**：身份卡行、可变层小节、兜底层、以及底部的添加入口。
 *
 * ### 一行三段（0.1.13 追加 5：用户看过真机效果后的布局要求）
 *
 * ```text
 * ┌──────────┬──────────────────────────────┬──────────────┐
 * │ 名称      │  [     内容输入框      ]      │  [改名][删除] │
 * └──────────┴──────────────────────────────┴──────────────┘
 *    ①名称栏              ②内容栏（minmax(240px, 1fr)，最宽）      ③按钮栏
 * ```
 *
 * 三条硬要求（都有可机械复核的判据，见 `test/client-bundle.test.mjs` 的 V17/V18）：
 * 1. **名称 | 内容 | 动作** 三格在**同一行**（同一个网格容器里的连续三格），动作在内容**右侧**；
 * 2. 中间内容栏**吃满剩余宽度**（`minmax(240px, 1fr)`：弹性 + 可用下限），三格**垂直居中**；
 * 3. 锁定项没有动作 ⇒ 右侧栏留**空占位**（不把它删掉，也不让它把内容栏挤偏）。
 *
 * ### 仍然成立的老口径（V5/V12/V14/V15）
 *
 * - **名称区没有输入框**（点「改名」才临时换成输入框，且仍在第一栏）；**内容区一直是可编辑输入框**；
 * - 「改名」「删除」**左右并排**（现在它们在第三栏里）；
 * - 内容控件的包装层会把控件**拉满整列**（见 `editor-styles.editorCell` 的真机缺陷说明）。
 *
 * 为什么"三格 + 共享网格"而不是"每项一个自己的网格"：`max-content` 的按钮栏宽度是**按行**算的，
 * 锁定项那一行没有按钮 ⇒ 每行的中间列宽会不一致，输入框右边缘就会参差不齐（用户要的"整齐"）。
 * 放进**一个**网格容器里，按钮栏取所有行的最大值，于是**每一行的三列都对齐**。
 * @module deepseek-harness-humanity/client/PersonaFields
 */
import { Fragment } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactNode } from 'react'

import {
  addFormReady,
  canDeleteItem,
  canRenameItem,
  identityItemId,
  orderedSections,
  renameIssue,
  sectionItemId,
  type PersonaItemKind,
  type PersonaWorkbenchState,
  type RenameIssue,
} from './persona-document.js'
import {
  addBand,
  deleteBand,
  editorCell,
  fieldLabel,
  groupTitle,
  itemActions,
  itemGrid,
  itemList,
  renameIssueText,
  textarea,
} from './editor-styles.js'
import { InfoHint } from './InfoHint.js'
import type { PersonaWorkbenchController } from './persona-controller.js'
import type { Translate } from './PersonaIssues.js'
import { headingWithHint } from './styles.js'

/** 字段组件共用的属性：字典、控制器、可编辑性，以及当前快照（项的形态由它决定）。 */
export interface FieldProps {
  t: Translate
  controller: PersonaWorkbenchController
  disabled: boolean
  state: PersonaWorkbenchState
}

/**
 * 动作按钮的**标记包装**。
 *
 * 为什么不把 `data-*` 直接挂在 `Button` 上：原语的属性类型是 `ButtonHTMLAttributes`，
 * `data-*` 只对原生标签免检；包一层 `span` 既能被测试稳定取到，也不依赖原语的属性透传行为。
 */
function Marked({ marker, itemId, children }: { marker: string; itemId?: string; children: ReactNode }) {
  return (
    <span data-persona-action={marker} data-persona-item={itemId}>
      {children}
    </span>
  )
}

/**
 * 改名被拦下时的文案键（`renameIssue` 的四个码各有一句）。
 *
 * 写成显式分支而不是拼字符串：字典座位是**编译期带类型**的（`PropsLocale<'humanity'>['t']`），
 * 拼出来的键不在字面量集合里，编译期就过不去。
 * @param issue - 问题码。
 * @returns 文案键。
 */
function renameIssueKey(issue: RenameIssue): 'persona.rename.empty' | 'persona.rename.unchanged' | 'persona.rename.reserved' | 'persona.rename.duplicate' {
  if (issue === 'empty') return 'persona.rename.empty'
  if (issue === 'unchanged') return 'persona.rename.unchanged'
  if (issue === 'reserved') return 'persona.rename.reserved'
  return 'persona.rename.duplicate'
}

/**
 * **第二栏**：内容控件那一格。
 *
 * 两个标记是判据的抓手：`data-persona-content=<项 id>`（这一格的位置，用于"名称区 / 内容区"分区断言）
 * 与 `data-persona-editor`（这一格放的是什么控件）。样式 `editorCell` 负责把它和里面的控件都拉满整列。
 */
function ContentCell({ name, itemId, children }: { name: string; itemId: string; children: ReactNode }) {
  return (
    <span data-persona-content={itemId} data-persona-editor={name} style={editorCell}>
      {children}
    </span>
  )
}

/**
 * **第一栏**：名称格（纯文字；改名态下换成输入框，但仍在第一栏里 —— 位置不动，行不会跳）。
 *
 * `data-persona-item` 挂在这一格上（列表里每项的第一个标记），`data-locked` 只在传了 `locked` 时出现。
 */
function NameCell({
  t,
  controller,
  disabled,
  state,
  itemId,
  name,
  locked,
  renameable,
}: {
  t: Translate
  controller: PersonaWorkbenchController
  disabled: boolean
  state: PersonaWorkbenchState
  itemId: string
  name: string
  locked?: boolean
  renameable: boolean
}) {
  const form = state.renaming
  const renaming = renameable && form !== undefined && form.itemId === itemId

  if (renaming && form !== undefined) {
    return (
      <span
        data-persona-cell="name"
        data-persona-item={itemId}
        data-persona-editor="rename"
        data-persona-rename={itemId}
        style={editorCell}
      >
        <Input
          value={form.name}
          placeholder={t('persona.fieldKey')}
          aria-label={t('persona.rename')}
          disabled={disabled}
          onChange={(event) => controller.setRenameName(event.target.value)}
        />
      </span>
    )
  }

  return (
    <span
      data-persona-cell="name"
      data-persona-item={itemId}
      {...(locked === undefined ? {} : { 'data-locked': locked ? 'true' : 'false' })}
      style={fieldLabel}
    >
      {name}
    </span>
  )
}

/**
 * **第三栏**：动作格（「改名」「删除」并排；改名态下换成「确定」「取消」）。
 *
 * 锁定项两个动作都没有 ⇒ 这一格仍然渲染，但是**空的**（要求 3 的"空占位"）：
 * 有它，判据才能断言"每一项都有右侧栏、且它在内容栏右边"；也让网格结构在所有行上一致。
 */
function ActionsCell({
  t,
  controller,
  disabled,
  state,
  itemId,
  renameable,
  deletable,
}: {
  t: Translate
  controller: PersonaWorkbenchController
  disabled: boolean
  state: PersonaWorkbenchState
  itemId: string
  renameable: boolean
  deletable: boolean
}) {
  const form = state.renaming
  const renaming = renameable && form !== undefined && form.itemId === itemId
  const issue = renaming ? renameIssue(state.draft, itemId, form.name) : undefined

  if (renaming && form !== undefined) {
    return (
      <div data-persona-cell="actions" data-persona-actions={itemId} style={itemActions}>
        <Marked marker="rename-confirm" itemId={itemId}>
          {/* 有问题（空名 / 重名 / 撞标准名 / 没改动）⇒ 确定键禁用：与 `confirmRename` 的空操作同一件事。 */}
          <Button
            size="sm"
            variant="primary"
            disabled={disabled || issue !== undefined}
            onClick={() => controller.confirmRename()}
          >
            {t('persona.renameConfirm')}
          </Button>
        </Marked>
        <Marked marker="rename-cancel" itemId={itemId}>
          <Button size="sm" variant="ghost" disabled={disabled} onClick={() => controller.cancelRename()}>
            {t('persona.cancel')}
          </Button>
        </Marked>
      </div>
    )
  }

  return (
    <div data-persona-cell="actions" data-persona-actions={itemId} style={itemActions}>
      {renameable ? (
        <Marked marker="rename" itemId={itemId}>
          <Button variant="ghost" size="sm" disabled={disabled} onClick={() => controller.beginRename(itemId)}>
            {t('persona.rename')}
          </Button>
        </Marked>
      ) : null}
      {deletable ? (
        <Marked marker="delete" itemId={itemId}>
          <Button variant="ghost" size="sm" disabled={disabled} onClick={() => controller.requestDelete(itemId)}>
            {t('persona.remove')}
          </Button>
        </Marked>
      ) : null}
    </div>
  )
}

/**
 * 删除的**二次确认带**（不可逆操作，防误点）：横跨三栏的一整行，跟在该项下面。
 *
 * 文案里带上项名 —— 用户在点确认那一刻还看得见自己删的是哪一项。
 */
function DeleteConfirm({
  t,
  controller,
  disabled,
  itemId,
  name,
}: {
  t: Translate
  controller: PersonaWorkbenchController
  disabled: boolean
  itemId: string
  name: string
}) {
  return (
    <div
      style={{ ...deleteBand, gridColumn: '1 / -1' }}
      data-persona-action="delete-confirm-band"
      data-persona-item={itemId}
    >
      <span>{t('persona.deleteConfirm', { name })}</span>
      <Marked marker="delete-confirm" itemId={itemId}>
        <Button size="sm" variant="primary" disabled={disabled} onClick={() => controller.confirmDelete()}>
          {t('persona.deleteConfirmYes')}
        </Button>
      </Marked>
      <Marked marker="delete-cancel" itemId={itemId}>
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => controller.cancelDelete()}>
          {t('persona.cancel')}
        </Button>
      </Marked>
    </div>
  )
}

/** 改名态下的原因提示带（同样横跨三栏，跟在该项下面）：让灰着的确定键永远有解释。 */
function RenameIssueBand({ t, itemId, issue }: { t: Translate; itemId: string; issue: RenameIssue }) {
  return (
    <span
      style={{ ...renameIssueText, gridColumn: '1 / -1' }}
      data-persona-rename-issue={issue}
      data-persona-item={itemId}
    >
      {t(renameIssueKey(issue))}
    </span>
  )
}

/** 改名态下"确实有问题"才渲染原因带（没问题时不留空行）。 */
function RenameIssueBandIfAny({
  t,
  state,
  itemId,
}: {
  t: Translate
  state: PersonaWorkbenchState
  itemId: string
}) {
  const form = state.renaming
  if (form === undefined || form.itemId !== itemId) return null
  const issue = renameIssue(state.draft, itemId, form.name)
  if (issue === undefined) return null
  return <RenameIssueBand t={t} itemId={itemId} issue={issue} />
}

/** 身份卡里的一行（三栏）：名称格 + 内容格（输入框）+ 动作格。 */
function IdentityFieldCells({
  t,
  controller,
  disabled,
  state,
  index,
}: FieldProps & { index: number }) {
  const field = state.draft.identityCard.fields[index]
  if (field === undefined) return null
  const itemId = identityItemId(index)
  const pending = state.pendingDelete === itemId
  const deletable = canDeleteItem(state.draft, itemId)
  const renameable = canRenameItem(state.draft, itemId)

  return (
    <Fragment>
      <NameCell
        t={t}
        controller={controller}
        disabled={disabled}
        state={state}
        itemId={itemId}
        name={field.key}
        renameable={renameable}
      />
      <ContentCell name="value" itemId={itemId}>
        <Input
          value={field.value}
          placeholder={t('persona.fieldValue')}
          aria-label={field.key === '' ? t('persona.fieldValue') : field.key}
          disabled={disabled}
          onChange={(event) => controller.setIdentityValue(index, event.target.value)}
        />
      </ContentCell>
      <ActionsCell
        t={t}
        controller={controller}
        disabled={disabled}
        state={state}
        itemId={itemId}
        renameable={renameable}
        deletable={deletable}
      />
      {pending ? (
        <DeleteConfirm
          t={t}
          controller={controller}
          disabled={disabled}
          itemId={itemId}
          name={field.key === '' ? t('persona.fieldValue') : field.key}
        />
      ) : null}
      <RenameIssueBandIfAny t={t} state={state} itemId={itemId} />
    </Fragment>
  )
}

/**
 * 固定层身份卡编辑区：4 个锁定字段 + 自定义字段，底部是「添加字段」入口。
 * @param props - 字典、控制器、可编辑性与当前快照。
 * @returns 身份卡编辑区。
 */
export function IdentityFields({ t, controller, disabled, state }: FieldProps) {
  const shared = { t, controller, disabled, state }
  return (
    <div style={itemList} data-persona-list="identity">
      {state.draft.identityCard.fields.map((field, index) => (
        <IdentityFieldCells key={`field-${index}`} {...shared} index={index} />
      ))}
      <AddEntry
        {...shared}
        kind="identity"
        openLabel={t('persona.addField')}
        nameLabel={t('persona.fieldKey')}
        valueLabel={t('persona.fieldValue')}
      />
    </div>
  )
}

/** 可变层的一个小节（三栏）：名称格 + 多行内容格 + 动作格。 */
function MutableSectionCells({
  t,
  controller,
  disabled,
  state,
  section,
}: FieldProps & { section: { title: string; items: string[] } }) {
  const itemId = sectionItemId(section.title)
  const pending = state.pendingDelete === itemId
  const deletable = canDeleteItem(state.draft, itemId)
  const renameable = canRenameItem(state.draft, itemId)
  const text = section.items.join('\n')

  return (
    <Fragment>
      <NameCell
        t={t}
        controller={controller}
        disabled={disabled}
        state={state}
        itemId={itemId}
        name={section.title}
        locked={!deletable}
        renameable={renameable}
      />
      <ContentCell name="section" itemId={itemId}>
        <textarea
          style={textarea}
          value={text}
          placeholder={t('persona.emptyValue')}
          disabled={disabled}
          aria-label={section.title}
          onChange={(event) => controller.setSectionText(section.title, event.target.value)}
        />
      </ContentCell>
      <ActionsCell
        t={t}
        controller={controller}
        disabled={disabled}
        state={state}
        itemId={itemId}
        renameable={renameable}
        deletable={deletable}
      />
      {pending ? (
        <DeleteConfirm t={t} controller={controller} disabled={disabled} itemId={itemId} name={section.title} />
      ) : null}
      <RenameIssueBandIfAny t={t} state={state} itemId={itemId} />
    </Fragment>
  )
}

/**
 * 可变层的小节列表 + 底部「添加小节」入口。
 *
 * 顺序由 `orderedSections` 决定：**文档里真实存在的小节**按标准顺序在前、自定义在后
 * （被删掉的小节不再补回，见 `persona-document.orderedSections`）。
 * @param props - 字典、控制器、可编辑性与当前快照。
 * @returns 可变层编辑区。
 */
export function MutableFields({ t, controller, disabled, state }: FieldProps) {
  const shared = { t, controller, disabled, state }
  return (
    <div style={itemList} data-persona-list="section">
      {orderedSections(state.draft).map((section) => (
        <MutableSectionCells key={section.title} {...shared} section={section} />
      ))}
      <AddEntry
        {...shared}
        kind="section"
        openLabel={t('persona.addSection')}
        nameLabel={t('persona.sectionName')}
        valueLabel={t('persona.sectionContent')}
        multiline
      />
    </div>
  )
}

/**
 * 底部的**统一添加入口**：默认只有一个按钮，点开才出现输入区 + 保存/取消。
 *
 * 展开后的输入区**按同一套三栏栅格对齐**（名称进第一栏、内容进第二栏、保存/取消进第三栏），
 * 外面只多一条虚线把它和上面的项分开 —— 这样"添加"看起来就是列表里正在编辑的一行，
 * 而不是另一套版式（用户要的"整齐"）。
 *
 * 这里是**唯一**会出现"名称输入框"的地方（新项还没有名字，得先取一个）：
 * 已存在项的名称一律纯文字，改名要点「改名」。
 * @param props - 字典、控制器、形态与文案。
 * @returns 入口按钮或展开后的表单。
 */
function AddEntry({
  t,
  controller,
  disabled,
  state,
  kind,
  openLabel,
  nameLabel,
  valueLabel,
  multiline = false,
}: {
  t: Translate
  controller: PersonaWorkbenchController
  disabled: boolean
  state: PersonaWorkbenchState
  kind: PersonaItemKind
  openLabel: string
  nameLabel: string
  valueLabel: string
  multiline?: boolean
}) {
  const form = state.addForm
  if (form === undefined || form.kind !== kind) {
    return (
      <div style={{ gridColumn: '1 / -1' }} data-persona-add-open={kind}>
        <Marked marker="add-open">
          <Button variant="outline" size="sm" disabled={disabled} onClick={() => controller.openAdd(kind)}>
            {openLabel}
          </Button>
        </Marked>
      </div>
    )
  }

  const ready = addFormReady(form)
  return (
    <div style={addBand} data-persona-add={kind}>
      <div style={itemGrid}>
        <span data-persona-editor="add-name" style={editorCell}>
          <Input
            value={form.name}
            placeholder={nameLabel}
            aria-label={nameLabel}
            disabled={disabled}
            onChange={(event) => controller.setAddField('name', event.target.value)}
          />
        </span>
        {multiline ? (
          <textarea
            data-persona-editor="add-value"
            style={textarea}
            value={form.value}
            placeholder={valueLabel}
            aria-label={valueLabel}
            disabled={disabled}
            onChange={(event) => controller.setAddField('value', event.target.value)}
          />
        ) : (
          <span data-persona-editor="add-value" style={editorCell}>
            <Input
              value={form.value}
              placeholder={valueLabel}
              aria-label={valueLabel}
              disabled={disabled}
              onChange={(event) => controller.setAddField('value', event.target.value)}
            />
          </span>
        )}
        <div style={itemActions}>
          <Marked marker="add-save">
            {/* 名字或内容为空 ⇒ 按钮禁用：与 `commitAdd` 的空操作是同一件事，不给"点了没反应"的按钮。 */}
            <Button
              size="sm"
              variant="primary"
              disabled={disabled || !ready}
              onClick={() => void controller.commitAdd()}
            >
              {t('persona.save')}
            </Button>
          </Marked>
          <Marked marker="add-cancel">
            <Button size="sm" variant="ghost" disabled={disabled} onClick={() => controller.cancelAdd()}>
              {t('persona.cancel')}
            </Button>
          </Marked>
        </div>
      </div>
    </div>
  )
}
