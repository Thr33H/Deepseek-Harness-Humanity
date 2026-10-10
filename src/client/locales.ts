/**
 * 工作台文案（人格部分；记忆与自进化分别在 `memory-locales.ts` / `evolution-locales.ts`，末尾合并）。
 *
 * 为什么用 DSH 的 locale 字典而不是写死中文：套件要求「公开、通用」，面板文案随 DSH 的语言
 * 设置切换是原生行为；DSH 的语言注入是**编译期**检查的 —— 文末 `declare module` 把本命名空间
 * 并入 `LocaleNamespaceMap`，`PropsLocale<'humanity'>` 才有带类型的 `t`，缺键或多键编译期报错。
 */

import { evolutionEn, evolutionZh } from './evolution-locales.js'
import { workbenchEn, workbenchZh } from './workbench-locales.js'
import { memoryEn, memoryZh } from './memory-locales.js'

/** 本面板的字典命名空间。 */
export const NS = 'humanity'

/**
 * 中文（正本）。`persona.issue.*` 的键**必须**与 `PERSONA_ISSUE_CODES` 一一对应（`test/client-bundle.test.mjs` 断言）：
 * 校验给稳定代码，工作台按代码取本地化文案；缺一个键，那条问题就只能退回显示宿主的中文原句。
 */
const personaZh = {

  // ── 人格页（M2 步 6：最小工作台编辑） ──────────────────────────────────────
  'persona.title': '人格',
  'persona.independentJudgment': '🧠 独立判断模式',
  'persona.independentJudgmentHint': '以事实与证据为准，不迎合、不编造',
  'persona.independentJudgmentOn': '已开启',
  'persona.independentJudgmentOff': '已关闭',
  'persona.independentJudgmentSaving': '正在保存…',
  'persona.independentJudgmentPendingSeal': '（固定层封存后生效并可切换；当前未注入）',
  'persona.identityCard': '身份卡',
  'persona.mutableCard': '人格卡',
  'persona.identityHint':
    '固定层是底色，只有你能改。填完点「封存」：Agent 从此改不了固定层（你仍可在这里改），独立判断模式也才生效。'
    + '每项的**名称是固定文字**（不可就地改），**内容随时可以在右边的输入框里改**；'
    + '项名下的「删除」删掉的是**整项**，姓名 / 性别 / 人格偏好 / 主语言 这 4 项删不掉。'
    + '要加一项走底部的入口。',
  'persona.sealAction': '封存',
  'persona.sealed': '已封存',
  'persona.unsealed': '未封存',
  'persona.fieldKey': '字段名',
  'persona.fieldValue': '内容',
  'persona.addField': '添加字段',
  'persona.remove': '删除',
  // 0.1.13 项级交互（用户 2026-10-09）：名称区是纯文字、删除的是**整项**且在项名下方；
  // 内容区一直是可编辑输入框（当轮口径澄清："只说每项的名称不要输入框了"）。
  'persona.cancel': '取消',
  'persona.emptyValue': '（还没有内容，直接在这里写）',
  'persona.deleteConfirm': '删除「{name}」整项？文档里和提示词里都将不再有它，且不可撤销。',
  'persona.deleteConfirmYes': '确认删除',
  'persona.addSection': '添加小节',
  'persona.sectionName': '小节名',
  'persona.sectionContent': '内容（一行一条）',
  // 0.1.13 追加：只给**用户自定义**的项改名（平时名称仍是纯文字，点了才出现输入框）。
  'persona.rename': '改名',
  'persona.renameConfirm': '确定',
  'persona.rename.empty': '名字不能为空',
  'persona.rename.unchanged': '和现在的名字一样，没有可提交的改动',
  'persona.rename.reserved': '这是插件认的标准名（固定层字段名 / 标准小节名），自定义项不能占用',
  'persona.rename.duplicate': '已有别的项在用这个名字（不会覆盖它，请换一个）',
  'persona.mutableHint':
    '固定层是底色，只有你能改；这一层是意识与经验，Agent 会在这里整理。'
    + '每个小标题一行一条；保存时整层替换为这份完整快照（不是追加），被取代的旧内容会进历史。'
    + '每项的**名称是固定文字**（不可就地改），**内容随时可以在右边的框里改**；'
    + '项名下的「删除」删掉的是**整项**（文档里与提示词里都不再有它，默认的前 4 个小节删不掉）；'
    + '要加内容走底部的入口。',
  // 注入账目（用户 2026-09-26 发现提示词被截断后加的）：卡上写的东西到底进去多少，必须看得见。
  'persona.budget.tag': '进提示词 {injected}/{total} 条',
  'persona.budget.hint':
    '人格卡按字符预算注入（当前上限 {budget} 字符，其中还包含永不截断的操作约定段）。'
    + '一次装不下时，每个小标题先保底一条，再按轮次分配；没进去的条目会在提示词里如实标注。'
    + '把重复的条目合并、把长条目写短，就能让它们全部进去。',
  'persona.budget.dropped':
    '⚠️ 有 {dropped} 条进不了提示词（超出注入预算）：{sections}。上面那张卡上的条目没有全部生效，'
    + '合并重复条目或写短一些即可。',
  'persona.budget.clipped':
    '⚠️ 有条目超过单条上限（{limit} 字符），进提示词时被截断：条目本身还在，但尾巴不会生效。'
    + '把它拆成两条或写短一些即可。',
  // ⚠️ 0.1.14：`persona.userDefined` / `userDefinedHint` / `addEntry`（兜底层「用户定义」及其添加入口）
  // 随该区块下线一起删除 —— 界面上没有入口了，留着的文案只会成为一条永远没人读的死字符串。
  'persona.save': '保存',
  'persona.saving': '保存中…',
  'persona.reload': '重新加载',
  'persona.dirty': '未保存',
  'persona.saved': '已保存',
  'persona.loading': '读取中…',
  'persona.readonly': '当前部署的设置是只读的，无法在这里修改。',
  'persona.unavailable': '暂时读不到人格（设置服务没接上，或人格模块被关掉了）。',
  'persona.failed': '读取失败：{message}',
  'persona.rejected': '宿主拒绝了这次写入：{message}',
  'persona.blocked': '保存前校验未通过（{count} 项），没有任何内容被写入：',
  'persona.warnings': '提示（不影响保存，{count} 项）：',

  // 校验代码 → 本地化文案。键集合 = PERSONA_ISSUE_CODES（有测试盯着）。
  'persona.issue.identity.key-empty': '有字段没有名字',
  'persona.issue.identity.key-duplicate': '有重复的字段名',
  'persona.issue.identity.core-missing': '缺少核心字段（姓名 / 性别 / 人格偏好）',
  'persona.issue.identity.value-too-long': '字段内容超过 120 字，会明显增加注入成本',
  'persona.issue.identity.sealed': '固定层已对 Agent 封存（你仍然可以在这里修改）',
  'persona.issue.identity.shadows-mutable': '字段名与可变层的小标题或用户定义键撞名，请改其中一个名字',
  'persona.issue.mutable.section-duplicate': '有重复的小标题',
  'persona.issue.mutable.section-title-empty': '有一节没有小标题（没有名字的小节不会进提示词，请给它取名或并入别的小节）',
  'persona.issue.mutable.section-dropped': '有内容的小标题整节不见了（要保留请显式传入原内容）',
  'persona.issue.mutable.section-cleared': '有内容的小标题被显式清空（删除用户内容需在对话里确认）',
  'persona.issue.mutable.section-locked-missing': '默认锁定的 8 项不能整项删除（要保留节，只清空里面的条目）',
  'persona.issue.mutable.core-key-shadowed': '固定层字段名不能作为可变层的小标题或「用户定义」的键',
  'persona.issue.mutable.user-defined-duplicate': '「用户定义」出现重复键（没有内容被写入）',
  'persona.issue.mutable.user-defined-key-empty': '「用户定义」有一项只填了内容、没填名字（请补上键名）',
  'persona.issue.mutable.item-too-long': '有条目超过 120 字，建议拆成多条',
} as const

/** 英文。键集合必须与中文完全一致，否则 `satisfies` 会在编译期报错。 */
const personaEn = {

  'persona.title': 'Persona',
  'persona.independentJudgment': '🧠 Independent judgment',
  'persona.independentJudgmentHint': 'Facts and evidence first — no flattery, no making things up',
  'persona.independentJudgmentOn': 'On',
  'persona.independentJudgmentOff': 'Off',
  'persona.independentJudgmentSaving': 'Saving…',
  'persona.independentJudgmentPendingSeal': '(takes effect and becomes toggleable once the fixed layer is sealed; not injected yet)',
  'persona.identityCard': 'Identity card',
  'persona.mutableCard': 'Persona card',
  'persona.identityHint':
    'The fixed layer is the undertone and only you can change it. Press Seal when done: the agent can no longer change the fixed layer (you still can), and the independent-judgment mode starts applying. '
    + 'Each item has a fixed, non-editable name; its content is always editable in the box on the right. '
    + 'The "Remove" under an item name deletes the whole item, and the four defaults (name / gender / persona preference / main language) cannot be removed. '
    + 'Use the entry at the bottom to add one.',
  'persona.sealAction': 'Seal',
  'persona.sealed': 'Sealed',
  'persona.unsealed': 'Not sealed',
  'persona.fieldKey': 'Field',
  'persona.fieldValue': 'Value',
  'persona.addField': 'Add field',
  'persona.remove': 'Remove',
  // 0.1.13 item-level interactions: the name is plain text, removal is whole-item and sits below the
  // name; the content area is always an editable box (the owner clarified: only the *name* is not an input).
  'persona.cancel': 'Cancel',
  'persona.emptyValue': '(nothing yet — write here)',
  'persona.deleteConfirm': 'Delete "{name}" entirely? It will be gone from the document and the prompt, and this cannot be undone.',
  'persona.deleteConfirmYes': 'Delete',
  'persona.addSection': 'Add section',
  'persona.sectionName': 'Section',
  'persona.sectionContent': 'Content (one per line)',
  // 0.1.13 addendum: renaming is offered only for user-added items (the name stays plain text until clicked).
  'persona.rename': 'Rename',
  'persona.renameConfirm': 'Confirm',
  'persona.rename.empty': 'The name cannot be empty',
  'persona.rename.unchanged': 'Same as the current name — nothing to submit',
  'persona.rename.reserved': 'This is a name the plugin owns (fixed-layer field / standard section); custom items cannot take it',
  'persona.rename.duplicate': 'Another item already uses this name (it will not be overwritten — pick another)',
  'persona.mutableHint':
    'The fixed layer is the undertone and only you can change it; this layer is awareness and experience, where the agent tidies up. '
    + 'One entry per line in each section; saving replaces the whole layer with this complete snapshot (never appends) and superseded content goes to history. '
    + 'Each item has a fixed, non-editable name; its content is always editable in the box on the right. '
    + 'The "Remove" under an item name deletes the whole item '
    + '(gone from the document and the prompt; the first four default sections cannot be removed), and new content goes in through the entry at the bottom.',
  'persona.budget.tag': '{injected}/{total} entries injected',
  'persona.budget.hint':
    'The persona card is injected under a character budget ({budget} characters, which also covers the untruncated operating note). '
    + 'When it does not fit, every section keeps at least one entry and the rest are handed out round by round; whatever is left out is stated in the prompt. '
    + 'Merging duplicates and shortening long entries brings everything back in.',
  'persona.budget.dropped':
    '⚠️ {dropped} entries will not reach the prompt (over the injection budget): {sections}. '
    + 'The card above is not fully in effect — merging duplicates or shortening entries fixes it.',
  'persona.budget.clipped':
    '⚠️ Some entries exceed the per-entry limit ({limit} characters) and are cut when injected: '
    + 'the entry stays on the card, but its tail never takes effect. Splitting it or shortening it fixes this.',
  // ⚠️ 0.1.14: `persona.userDefined` / `userDefinedHint` / `addEntry` removed with the User-defined block.
  'persona.save': 'Save',
  'persona.saving': 'Saving…',
  'persona.reload': 'Reload',
  'persona.dirty': 'Unsaved',
  'persona.saved': 'Saved',
  'persona.loading': 'Loading…',
  'persona.readonly': 'This deployment serves settings read-only; editing is disabled.',
  'persona.unavailable':
    'The host-side persona namespace is not available (settings service or persona module not mounted), so reading and writing are disabled.',
  'persona.failed': 'Could not read: {message}',
  'persona.rejected': 'The host refused this write: {message}',
  'persona.blocked': 'Pre-save validation failed ({count} issue(s)); nothing was written:',
  'persona.warnings': 'Warnings (they do not block saving, {count}):',

  'persona.issue.identity.key-empty': 'A field has no name',
  'persona.issue.identity.key-duplicate': 'Duplicate field names',
  'persona.issue.identity.core-missing': 'A core field is missing (name / gender / persona preference)',
  'persona.issue.identity.value-too-long': 'A value exceeds 120 characters, which raises injection cost',
  'persona.issue.identity.sealed': 'The fixed layer is sealed against the agent (you can still edit it here)',
  'persona.issue.identity.shadows-mutable': 'A fixed-layer field name collides with a mutable section title or user-defined key; rename one of them',
  'persona.issue.mutable.section-duplicate': 'Duplicate section titles',
  'persona.issue.mutable.section-title-empty':
    'A section has no title (untitled sections never reach the prompt; give it a name or merge it into another section)',
  'persona.issue.mutable.section-dropped': 'A section that had content was dropped entirely (pass its content explicitly to keep it)',
  'persona.issue.mutable.section-cleared': 'A section that had content was explicitly cleared (deleting user content needs in-chat confirmation)',
  'persona.issue.mutable.section-locked-missing': 'One of the 8 default locked items cannot be deleted as a whole (keep the section and clear its entries)',
  'persona.issue.mutable.core-key-shadowed': 'A fixed-layer field name cannot be a mutable section title or a user-defined key',
  'persona.issue.mutable.user-defined-duplicate': 'A user-defined key is duplicated (nothing was written)',
  'persona.issue.mutable.user-defined-key-empty': 'A user-defined entry has content but no name (add its key)',
  'persona.issue.mutable.item-too-long': 'An entry exceeds 120 characters; consider splitting it',
} satisfies Record<keyof typeof personaZh, string>

/** 人格 + 记忆 + 自进化三套文案合成同一个字典（对 DSH 仍只是一个 `humanity` 字典；`en` 同键检查照旧）。 */
export const zh = { ...workbenchZh, ...personaZh, ...memoryZh, ...evolutionZh }
export const en = { ...workbenchEn, ...personaEn, ...memoryEn, ...evolutionEn } satisfies Record<keyof typeof zh, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 工作台自己的文案键集合。 */
    humanity: keyof typeof zh
  }
}
