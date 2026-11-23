/**
 * 工作台文案（人格部分；情绪与记忆分别在 `emotion-locales.ts` / 记忆页自带，末尾合并）。
 *
 * 为什么用 DSH 的 locale 字典而不是写死中文：套件要求「公开、通用」，面板文案随 DSH 的语言
 * 设置切换是原生行为；DSH 的语言注入是**编译期**检查的 —— 文末 `declare module` 把本命名空间
 * 并入 `LocaleNamespaceMap`，`PropsLocale<'humanity'>` 才有带类型的 `t`，缺键或多键编译期报错。
 */

import { emotionEn, emotionZh } from './emotion-locales.js'
import { workbenchEn, workbenchZh } from './workbench-locales.js'

/**
 * 记忆工作台的文案（2026-11-21 随页面重写从 `memory-locales.ts` 并回本文件）。
 *
 * 为什么并回来：那一版有近百个键（作用域、待确认、高级开关、向量检索…），随旧记忆模型一起
 * 整片删除；现在这一页只做一件事——把记忆**显示出来**，文案自然只剩十几条。
 * 为一个一百行的字典再单开一个文件不划算。
 */
const memoryZh = {
  'memory.tab.persona': '人格',
  'memory.tab.memory': '记忆',
  'memory.title': '记忆',
  'memory.reload': '重新加载',
  'memory.loading': '正在读取…',
  'memory.unavailable': '读不到记忆：工作台通道还没就绪（或这个版本还没接上）。记忆本身仍在正常写入与检索。',
  'memory.failed': '读取失败',
  'memory.total': '共 {count} 条',
  'memory.empty': '还没有记下什么。等她经历过值得留下的事，这里会出现。',
  'memory.dormant': '她还没有被设定完（人格未封存）。记忆从封存那一刻才开始 —— 在那之前，她不会记住任何事。',
  'memory.recalled': '想起过 {count} 次',
  'memory.recalledTotal': '{count} 条被想起过',
  'memory.covers': '由 {count} 件合成',
  'memory.felt': '当时：{label}',
  'memory.why.title': '上一次她想起的',
  'memory.why.cue': '因为你说：「{cue}」',
  'memory.why.withheld': '（有一条她不想说）',
  'memory.why.match.high': '很相关',
  'memory.why.match.mid': '有点相关',
  'memory.why.match.low': '沾了点边',
  'memory.secret': '不想说',
  'memory.reveal.ask': '我要看',
  'memory.reveal.warn': '她知道你看了。确定？',
  'memory.reveal.confirm': '确认要看',
  'memory.delete.ask': '删掉',
  'memory.delete.warn': '删掉就没了，确定？',
  'memory.delete.confirm': '确认删掉',
  'memory.about.self': '关于她自己',
  'memory.about.user': '关于你',
  'memory.about.us': '关于你们',
  'memory.about.world': '关于外面',
  'memory.tier.episode': '记住',
  'memory.tier.period': '归拢',
  'memory.tier.chapter': '一段时期',
} as const

/** 英文（键集合与中文完全一致，`satisfies` 会在编译期盯着）。 */
const memoryEn = {
  'memory.tab.persona': 'Persona',
  'memory.tab.memory': 'Memory',
  'memory.title': 'Memory',
  'memory.reload': 'Reload',
  'memory.loading': 'Reading…',
  'memory.unavailable': 'Memory is unreadable: the workbench channel is not ready (or this build has not wired it). Memory itself is still being written and recalled.',
  'memory.failed': 'Read failed',
  'memory.total': '{count} entries',
  'memory.empty': 'Nothing recorded yet. When something worth keeping happens to her, it will show up here.',
  'memory.dormant': 'She is not set up yet (persona unsealed). Memory starts the moment it is sealed — before that, she records nothing.',
  'memory.recalled': 'recalled {count}×',
  'memory.recalledTotal': '{count} recalled at least once',
  'memory.covers': 'from {count} moments',
  'memory.felt': 'felt {label}',
  'memory.why.title': 'What she recalled last time',
  'memory.why.cue': 'Because you said: “{cue}”',
  'memory.why.withheld': '(one she would not say)',
  'memory.why.match.high': 'strong match',
  'memory.why.match.mid': 'some match',
  'memory.why.match.low': 'faint match',
  'memory.secret': 'would not say',
  'memory.reveal.ask': 'Let me see',
  'memory.reveal.warn': 'She will know you looked. Sure?',
  'memory.reveal.confirm': 'Yes, show it',
  'memory.delete.ask': 'Delete',
  'memory.delete.warn': 'It will be gone for good. Sure?',
  'memory.delete.confirm': 'Yes, delete',
  'memory.about.self': 'about her',
  'memory.about.user': 'about you',
  'memory.about.us': 'about you two',
  'memory.about.world': 'about the world',
  'memory.tier.episode': 'kept',
  'memory.tier.period': 'gathered',
  'memory.tier.chapter': 'a stretch of time',
} satisfies Record<keyof typeof memoryZh, string>

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
  'persona.independentJudgmentPendingSeal': '（底色封存后生效并可切换；当前未注入）',
  'persona.identityCard': '你的底色',
  'persona.mutableCard': '你的信息',
  'persona.identityHint':
    '你的底色只有你能改。填完点「封存」：Agent 从此改不了底色（你仍可在这里改），独立判断模式也才生效。'
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
  'persona.rename.reserved': '这是插件认的标准名（底色字段名 / 标准小节名），自定义项不能占用',
  'persona.rename.duplicate': '已有别的项在用这个名字（不会覆盖它，请换一个）',
  'persona.mutableHint':
    '你的底色只有你能改；这一层是意识与经验，Agent 会在这里整理。'
    + '每个小标题一行一条；保存时整层替换为这份完整快照（不是追加），被取代的旧内容会进历史。'
    + '每项的**名称是固定文字**（不可就地改），**内容随时可以在右边的框里改**；'
    + '项名下的「删除」删掉的是**整项**（文档里与提示词里都不再有它，默认的前 4 个小节删不掉）；'
    + '要加内容走底部的入口。',
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
  'persona.issue.identity.sealed': '底色已对 Agent 封存（你仍然可以在这里修改）',
  'persona.issue.identity.shadows-mutable': '字段名与信息的小标题或自定义键撞名，请改其中一个名字',
  'persona.issue.mutable.section-duplicate': '有重复的小标题',
  'persona.issue.mutable.section-title-empty': '有一节没有小标题（没有名字的小节不会进提示词，请给它取名或并入别的小节）',
  'persona.issue.mutable.section-dropped': '有内容的小标题整节不见了（要保留请显式传入原内容）',
  'persona.issue.mutable.section-cleared': '有内容的小标题被显式清空（删除已有内容需在对话里确认）',
  'persona.issue.mutable.section-locked-missing': '默认锁定的 8 项不能整项删除（要保留节，只清空里面的条目）',
  'persona.issue.mutable.core-key-shadowed': '底色字段名不能作为信息的小标题或「自定义」的键',
  'persona.issue.mutable.user-defined-duplicate': '「自定义」出现重复键（没有内容被写入）',
  'persona.issue.mutable.user-defined-key-empty': '「自定义」有一项只填了内容、没填名字（请补上键名）',
  'persona.issue.mutable.item-too-long': '有条目超过 120 字，建议拆成多条',
  'persona.issue.mutable.item-conflict': '同一小节里有两句话互相矛盾（一句让做、一句不让做），只能留一条',
  'persona.issue.character.axis-missing': '性格缺少了应该有的轴',
  'persona.issue.character.range-invalid': '性格的数值不合法：每一项都要在 0–1 之间，且下限不能高于上限',
  'persona.issue.character.value-out-of-range': '她此刻的数值掉出了她的范围（应当落在上下限之内）',
  'persona.issue.character.reason-missing': '有一个范围没写下理由——不影响使用，但以后就解释不了她为什么是这样',
  'persona.issue.character.sealed': '性格的范围已对 Agent 封存（你仍然可以在这里修改）',
  'persona.characterCard': '性格',
  'persona.characterHint':
    '四根轴，每根有一对范围。范围是她天生的边界——初始化时她读自己的底色推导出来，之后不再变动；' +
    '经历只能在这个范围里推动她。轨道上那根竖线就是她此刻站的位置。理由是她自己的解释，可以改。',
  'persona.characterRange': '范围',
  'persona.characterReason': '理由',
  'persona.characterReasonPlaceholder': '她当初为什么只给自己这么多空间',
  'persona.characterPending': '她还没有性格。首次初始化时，她会读自己刚写下的底色，自己定出这四根的范围。',
  'persona.characterAxisMissing': '缺了这一根（初始化时没给）',
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
  'persona.issue.mutable.item-conflict': 'Two entries in the same section contradict each other (one says to do it, the other says not to); keep only one',
  'persona.issue.character.axis-missing': 'Her character is missing an axis that should be there',
  'persona.issue.character.range-invalid': 'A character value is invalid: every value must be within 0–1, and the lower bound cannot exceed the upper bound',
  'persona.issue.character.value-out-of-range': 'Her current value has fallen outside her range (it must sit between the bounds)',
  'persona.issue.character.reason-missing': 'One range has no reason written down — harmless, but it will be unexplainable later',
  'persona.issue.character.sealed': 'The character ranges are sealed against the agent (you can still edit them here)',
  'persona.characterCard': 'Character',
  'persona.characterHint':
    'Four axes, each with a range. The range is her innate boundary — derived from the fixed layer at initialization and never changed afterwards; ' +
    'experience can only move her within it. The vertical line on the track is where she stands right now. The reason is her own explanation and is editable.',
  'persona.characterRange': 'Range',
  'persona.characterReason': 'Reason',
  'persona.characterReasonPlaceholder': 'Why she only allowed herself this much room',
  'persona.characterPending': 'She has no character yet. On first initialization she reads the fixed layer she just wrote and derives the four ranges herself.',
  'persona.characterAxisMissing': 'Missing (not provided at initialization)',
} satisfies Record<keyof typeof personaZh, string>

/** 人格 + 情绪 + 记忆三套文案合成同一个字典（对 DSH 仍只是一个 `humanity` 字典；`en` 同键检查照旧）。 */
export const zh = { ...workbenchZh, ...personaZh, ...emotionZh, ...memoryZh }
export const en = { ...workbenchEn, ...personaEn, ...emotionEn, ...memoryEn } satisfies Record<keyof typeof zh, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 工作台自己的文案键集合。 */
    humanity: keyof typeof zh
  }
}
