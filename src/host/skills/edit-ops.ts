/**
 * 技能的**工作台编辑动作**：新建 / 修改 / 停用 / 恢复（`evolution/ops.ts` 里几条命令的实现）。
 *
 * 三条纪律：
 * - **绝不覆盖**：新建走官方 `createIfAbsent`；同名已存在就如实拒绝（让用户改名或去"编辑"）；
 * - **不做删除**：官方 `ctx.fs` 的 13 个方法里没有删除，官方给模型的文件工具也只有
 *   read/write/edit —— DSH 有意不提供这个能力（用户 2026-09-26 裁决：下线用"停用"，
 *   真要删由我在运维通道做）。停用用的是官方 `disable-model-invocation`：模型不再自动调用它，
 *   文件保留、随时恢复；
 * - **结论一句话**：调用方是工作台，成功与失败都要能原样显示给人看。
 * @module humanity/skills/edit-ops
 */
import { isSkillName } from './paths.js'
import { replaceSkillDocument, withDisabledFlag } from './render.js'
import type { SkillStore } from './store.js'

/** 新建/修改的输入（工作台表单的三个字段）。 */
export interface SkillDraft {
  name: string
  description: string
  content: string
}

/**
 * 表单校验（名字文法 + 两个必需字段非空）。
 * @param draft - 表单内容。
 * @returns 一句话原因；合法时 `undefined`。
 */
export function validateDraft(draft: SkillDraft): string | undefined {
  if (!isSkillName(draft.name)) return '技能名只能用「小写字母、数字、连字符」（kebab-case），例如 my-skill。'
  if (draft.description.trim() === '') return '说明不能为空（官方要求每个技能都有一句话说明）。'
  if (draft.content.trim() === '') return '正文不能为空。'
  return undefined
}

/**
 * 新建一条技能（同名已存在 ⇒ 拒绝，不覆盖）。
 * @param store - 落盘入口。
 * @param draft - 表单内容。
 * @returns 面向用户的结论。
 */
export async function createSkill(store: SkillStore, draft: SkillDraft): Promise<string> {
  const invalid = validateDraft(draft)
  if (invalid !== undefined) return invalid
  const outcome = await store.write({
    name: draft.name,
    description: draft.description.trim(),
    content: draft.content,
  })
  if (outcome === 'exists') return `技能「${draft.name}」已经存在（不覆盖已有技能）。要改它请用「编辑」。`
  return `已新建技能「${draft.name}」：写进官方技能目录，DSH 会自动加载它。`
}

/**
 * 修改一条已存在的技能（带版本乐观锁：文件在别处被改过就拒绝，不静默覆盖）。
 * @param store - 落盘入口。
 * @param draft - 表单内容。
 * @returns 面向用户的结论。
 */
export async function updateSkill(store: SkillStore, draft: SkillDraft): Promise<string> {
  const invalid = validateDraft(draft)
  if (invalid !== undefined) return invalid
  const raw = await store.readRaw(draft.name)
  if (raw === undefined) return `找不到技能「${draft.name}」（文件可能已被移走）。`
  const text = replaceSkillDocument(raw, {
    name: draft.name,
    description: draft.description.trim(),
    content: draft.content,
  })
  const outcome = await store.writeRaw(draft.name, text, { mustExist: true })
  if (outcome === 'missing') return `技能「${draft.name}」的文件已经不在了，本次没有写入。`
  return `已更新技能「${draft.name}」。`
}

/**
 * 停用 / 恢复一条技能（官方 `disable-model-invocation`）。
 * @param store - 落盘入口。
 * @param name - 技能名。
 * @param disabled - true 停用，false 恢复。
 * @returns 面向用户的结论。
 */
export async function setSkillDisabled(store: SkillStore, name: string, disabled: boolean): Promise<string> {
  if (!isSkillName(name)) return '技能名不合法，没有改动。'
  const raw = await store.readRaw(name)
  if (raw === undefined) return `找不到技能「${name}」（文件可能已被移走）。`
  const text = withDisabledFlag(raw, disabled)
  if (text === undefined) return `技能「${name}」的文件没有合法 frontmatter，改不了停用标记。`
  const outcome = await store.writeRaw(name, text, { mustExist: true })
  if (outcome === 'missing') return `技能「${name}」的文件已经不在了，本次没有写入。`
  return disabled
    ? `已停用「${name}」：模型不会再自动用它（文件保留，随时可恢复）。`
    : `已恢复「${name}」：模型可以再次自动用它。`
}

/** 技能编辑面（宿主把它挂进命令动作面；ops.ts 只认这个接口，不直接碰 store）。 */
export interface SkillEditor {
  create(draft: SkillDraft): Promise<string>
  update(draft: SkillDraft): Promise<string>
  setDisabled(name: string, disabled: boolean): Promise<string>
}

/**
 * 用一个落盘入口造出编辑面。
 * @param store - 技能落盘入口。
 * @returns 三条编辑动作。
 */
export function createSkillEditor(store: SkillStore): SkillEditor {
  return {
    create: (draft) => createSkill(store, draft),
    update: (draft) => updateSkill(store, draft),
    setDisabled: (name, disabled) => setSkillDisabled(store, name, disabled),
  }
}
