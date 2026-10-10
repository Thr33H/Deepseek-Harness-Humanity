/**
 * 工作台草稿的**纯数据操作**：把"用户改了哪一项"翻译成对草稿的修改。
 *
 * 为什么从状态机里拆出来（`persona-controller.ts` 只留下状态与远程调用）：
 * 这些函数是**纯的**（改传入的草稿、返回 void，不碰状态与网络），因此可以被单独读懂、单独测；
 * 混在控制器里时，每个 setter 都要先理解 subscribe/update 的一套生命周期才看得清在做什么。
 *
 * 0.1.13 起"删一项"是**整项删除**（用户明确否掉条目级删除）：身份卡删一个字段、人格卡删一个小节。
 * 锁定的 8 项（固定层 4 项 + {@link LOCKED_SECTION_TITLES} 4 个原生小节）在客户端就没有删除动作，
 * ⚠️ 0.1.14：兜底层「用户定义」退出界面（用户："用户自定义可以删了，它跟添加小节重复了"），
 * 因此这里不再有它的增删改；**数据仍在文档里**（`mutableLayer.userDefined`），只是没人再动它。
 * 宿主校验还会独立拦一次（见 `validate-mutable.ts` 的 `checkLockedSections`）。
 * @module deepseek-harness-humanity/client/persona-edits
 */
import { isLockedSectionTitle } from '../host/persona/constants.js'
import { isUntouchedIdentityCard } from '../host/persona/predicates.js'
import type { PersonaDocument } from '../host/persona/types.js'
import { addFormReady, canDeleteItem, parseItemId, renameIssue, type PersonaAddForm } from './persona-document.js'

/** 改一个身份卡字段的值。 */
export function setIdentityValue(draft: PersonaDocument, index: number, value: string): void {
  const field = draft.identityCard.fields[index]
  if (field !== undefined) field.value = value
}

/** 改一个自定义字段的名字（核心三段式的键不可改，界面也不提供入口）。 */
export function setIdentityKey(draft: PersonaDocument, index: number, key: string): void {
  const field = draft.identityCard.fields[index]
  if (field !== undefined && field.custom) field.key = key
}

/** 追加一个自定义字段（P-012/P-014：用户可以自由增加字段）。 */
export function addIdentityField(draft: PersonaDocument): void {
  draft.identityCard.fields.push({ key: '', value: '', custom: true })
}

/**
 * 删除一个自定义字段。核心三段式删不掉 —— 宿主校验也会拒绝缺核心字段的文档。
 *
 * 新界面走 {@link removeItem}（按项 id 判断可删性）；这个函数保留给既有的调用方与测试。
 */
export function removeIdentityField(draft: PersonaDocument, index: number): void {
  const field = draft.identityCard.fields[index]
  if (field !== undefined && field.custom) draft.identityCard.fields.splice(index, 1)
}

/**
 * **整项删除**一个人格卡小节（0.1.13）。
 *
 * 锁定小节（对用户称呼 / 说话风格 / 交付格式 / 行为边界）在这里就不动：客户端不提供这个动作，
 * 宿主校验也会拒绝缺锁定小节的文档（V3 的两面）。非锁定小节直接从小节数组里摘掉 ——
 * 文档里没有它，注入时自然也没有。
 * @param draft - 当前草稿。
 * @param title - 小节标题。
 */
export function removeSection(draft: PersonaDocument, title: string): void {
  if (isLockedSectionTitle(title)) return
  const at = draft.mutableLayer.sections.findIndex((section) => section.title === title)
  if (at >= 0) draft.mutableLayer.sections.splice(at, 1)
}

/**
 * 按项 id 删除**一整项**（界面上唯一的删除落点）。
 *
 * 可删性由 {@link canDeleteItem} 判定：锁定项、越界下标、解析不出来的 id 一律原样不动 ——
 * 静默拒绝而不是抛错：这条路径在点击回调里，抛出去就是一次未捕获异常。
 * @param draft - 当前草稿。
 * @param itemId - 项 id（`identity:0` / `section:我自己的标题`）。
 */
export function removeItem(draft: PersonaDocument, itemId: string): void {
  if (!canDeleteItem(draft, itemId)) return
  const ref = parseItemId(itemId)
  if (ref === undefined) return
  if (ref.kind === 'identity') {
    draft.identityCard.fields.splice(Number(ref.key), 1)
    return
  }
  removeSection(draft, ref.key)
}

/**
 * 给**自定义项**改名（0.1.13 追加；用户选定"加一个改名按钮"）。
 *
 * 三条边界（与界面上的护栏是同一份判据，见 `persona-document.renameIssue`）：
 * 1. **只改自定义项**：`canRenameItem` 说不行（锁定的 8 项 / 越界下标）就原样不动；
 * 2. **有问题就不落**：空名、重名、撞标准名（`renameIssue` 非 `undefined`）一律不动草稿 ——
 *    宁可"点了没反应 + 界面写明原因"，也不提交一份宿主必然拒绝的文档；
 * 3. **原地换名字，绝不顶掉别人**：只改这一项自己的 `key` / `title` 字段，不碰同层的其他项
 *    （所以不存在"静默覆盖已有项"这条路径）。
 * @param draft - 当前草稿。
 * @param itemId - 项 id。
 * @param nextName - 新名字（函数内部去空白）。
 */
export function renameItem(draft: PersonaDocument, itemId: string, nextName: string): void {
  const ref = parseItemId(itemId)
  if (ref === undefined) return
  if (renameIssue(draft, itemId, nextName) !== undefined) return
  const name = nextName.trim()
  if (ref.kind === 'identity') {
    const field = draft.identityCard.fields[Number(ref.key)]
    if (field !== undefined) field.key = name
    return
  }
  const section = draft.mutableLayer.sections.find((row) => row.title === ref.key)
  if (section !== undefined) section.title = name
}

/**
 * 把底部的「添加」表单落进草稿（0.1.13 的添加入口）。
 *
 * 两种形态共用一套表单：身份卡加字段、人格卡加小节（名字撞上已有小节就往那一节追加一条）。
 * **名字与内容都非空**才落得下去（空输入由界面把保存按钮禁用，
 * 这里再守一道，保证"点了没反应"与"按钮是灰的"说的是同一件事）。
 * @param draft - 当前草稿。
 * @param form - 表单内容。
 */
export function applyAddForm(draft: PersonaDocument, form: PersonaAddForm): void {
  if (!addFormReady(form)) return
  const name = form.name.trim()
  const value = form.value.trim()

  if (form.kind === 'identity') {
    draft.identityCard.fields.push({ key: name, value, custom: true })
    return
  }
  const existing = draft.mutableLayer.sections.find((section) => section.title === name)
  if (existing === undefined) draft.mutableLayer.sections.push({ title: name, items: [value] })
  else existing.items.push(value)
}

/** 改一个小标题的整段文本（一行一条）。 */
export function setSectionText(draft: PersonaDocument, title: string, text: string): void {
  const section = draft.mutableLayer.sections.find((entry) => entry.title === title)
  if (section !== undefined) section.items = text.split('\n')
}

/**
 * 首次在工作台保存时，替用户落下初始化与封存标记（P-002/P-003）。
 *
 * 为什么必须做：P-002 要求"是否首次唤醒"由**独立标记**判断，而工作台是三条初始化路径之一。
 * 用户在卡片里填完内容却不落标记，等于这条路没有留下任何痕迹 —— 聊天侧的
 * `humanity_persona_init` 只能靠"内容非空"间接推断，P-002 的标记就永远停在空串。
 * 落标记之后封存语义才完整：固定层对 Agent 封存，但用户仍可在此修改（P-013）。
 * @param draft - 已规范化的草稿。
 * @param stored - 当前生效文档（判断"是否还没人写过"）。
 * @returns 需要落标记时返回带标记的副本，否则原样返回。
 */
export function stampInitialization(draft: PersonaDocument, stored: PersonaDocument): PersonaDocument {
  if (!isUntouchedIdentityCard(stored.identityCard)) return draft
  const now = new Date().toISOString()
  return { ...draft, identityCard: { ...draft.identityCard, initializedAt: now, sealedAt: now } }
}

/**
 * 手动封存固定层（工作台「封存」按钮）。
 *
 * 为什么需要它（2026-09-26 真机暴露的缺口）：封存原本**只有**一条路径 —— 首次保存时由
 * {@link stampInitialization} 自动落下。于是两种卡会卡死：① 初始化标记已存在、封存标记为空
 * （预填、旧数据、别的写入方留下的）；② 用户就想"先存草稿、稍后再封"。这两种情况下 UI 里
 * 根本没有能封存的入口，独立判断开关永远是灰的。语义与首次保存一致：已初始化就只补封存时间，
 * 未初始化则两个标记一起补。
 * @param draft - 已规范化的草稿。
 * @param now - 当前时刻（ISO）。
 * @returns 带封存标记的副本。
 */
export function sealPersona(draft: PersonaDocument, now: string): PersonaDocument {
  const card = draft.identityCard
  return {
    ...draft,
    identityCard: {
      ...card,
      initializedAt: card.initializedAt === '' ? now : card.initializedAt,
      sealedAt: now,
    },
  }
}
