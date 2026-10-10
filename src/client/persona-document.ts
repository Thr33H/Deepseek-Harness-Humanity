/**
 * 工作台看到的**文档形状**与纯函数操作：解析宿主返回的值、排序、判断"脏没脏"。
 *
 * 为什么从 `persona-controller.ts` 拆出来：控制器的职责是**状态机与远程调用**，
 * 而这里是"后端返回的东西长什么样、怎么把它摆平"的纯逻辑；两者混在一起时，
 * 任何一次渲染兜底都要翻过整个状态机才能看懂。
 * 规则真源仍在宿主侧（`../host/persona/*`），这里只做**形状兜底**，不重复语义规则。
 * @module deepseek-harness-humanity/client/persona-document
 */
import { CORE_IDENTITY_KEYS, STANDARD_SECTION_TITLES, isLockedSectionTitle } from '../host/persona/constants.js'
import { effectivePersona, normalizePersona } from '../host/persona/normalize.js'
import { isUntouchedIdentityCard } from '../host/persona/predicates.js'
import type { PersonaDocument, PersonaIssue } from '../host/persona/types.js'

/** 状态机的阶段：idle/loading 是还没读到，ready 可编辑，unavailable 是通道缺席，failed 是读失败。 */
export type PersonaStatus = 'idle' | 'loading' | 'ready' | 'unavailable' | 'failed'

/** 校验问题在界面层的视图类型（与规则层的 `PersonaIssue` 同形，只是换个更贴近 UI 的别名）。 */
export type PersonaIssueView = PersonaIssue

/**
 * 界面上"某一项"的两类（0.1.13 的项级交互都以它为单位）。
 *
 * - `identity`：身份卡的一个字段（固定层）；
 * - `section`：人格卡的一个小标题（可变层）。
 *
 * ⚠️ 0.1.14：原来的第三类 `userDefined`（兜底层「用户定义」的一条键值对）**退出界面** ——
 * 用户 2026-10-09 原话"**用户自定义可以删了，它跟添加小节重复了**"。
 * **数据不删**：`mutableLayer.userDefined` 照旧读写（见 `asDocument` / `emptyDocument`），
 * 只是不再渲染、不再编辑。
 */
export type PersonaItemKind = 'identity' | 'section'

/**
 * 项引用：身份卡字段用**下标**（键名可编辑，用名字做引用会在改名时错位），小节用标题。
 */
export interface PersonaItemRef {
  kind: PersonaItemKind
  key: string
}

/**
 * 「改名」的界面状态（0.1.13 追加，用户 2026-10-09 选定"加一个改名按钮"）。
 *
 * 平时名称仍是一串纯文字；点「改名」才把**名称那一格**换成输入框 + 确定/取消。
 * 与人格文档分开：这是**界面状态**，取消即丢弃；确认后也只改草稿（落盘仍走卡片上的「保存」）。
 *
 * 为什么放在控制器状态里（与 `pendingDelete` / `addForm` 同一纪律）：
 * 三者互斥、静态渲染就能断言"名称处出现了输入框"，且保存/重载后一起清掉，不留幽灵态。
 */
export interface PersonaRenameForm {
  /** 正在改名的项 id。 */
  readonly itemId: string
  /** 名字草稿（确认前的输入）。 */
  readonly name: string
}

/**
 * 底部「添加」表单的草稿（用户 2026-10-09：添加走底部入口，点了才出现输入区 + 保存按钮）。
 *
 * 与人格文档分开：这是**界面状态**，不进草稿文档、不参与保存，取消即丢弃。
 */
export interface PersonaAddForm {
  readonly kind: PersonaItemKind
  /** 项名：身份卡字段名 / 小节名。 */
  readonly name: string
  /** 内容：字段值 / 小节首条内容。 */
  readonly value: string
}

/** 项 id：身份卡字段。 */
export const identityItemId = (index: number): string => `identity:${index}`
/** 项 id：人格卡小节（标题里可能有冒号，解析时按**首个**冒号切）。 */
export const sectionItemId = (title: string): string => `section:${title}`

/**
 * 把项 id 解析回引用；形状不对返回 `undefined`（渲染期调用，绝不抛）。
 * @param itemId - 组件里用的项 id。
 * @returns 项引用，或者 undefined。
 */
export function parseItemId(itemId: string): PersonaItemRef | undefined {
  if (typeof itemId !== 'string') return undefined
  const at = itemId.indexOf(':')
  if (at <= 0) return undefined
  const kind = itemId.slice(0, at)
  const key = itemId.slice(at + 1)
  if (kind === 'section') return key === '' ? undefined : { kind: 'section', key }
  if (kind === 'identity' && /^\d+$/.test(key)) return { kind, key }
  return undefined
}

/**
 * 固定层的 4 个核心字段是**锁定的**（默认 8 项 = 这 4 项 + 人格卡 4 个原生小节）。
 *
 * 正常数据里它们是 `custom: false`；这里按键名再查一次，是为了挡住"键名是核心字段、却被标成自定义"
 * 的畸形数据 —— 那种数据上删一次，`normalizePersona` 的 `ensureCoreFields` 会把它补回来，
 * 界面看起来就是"点了删除没反应"。
 * @param key - 字段名。
 * @returns 该字段名是否属于锁定的核心字段。
 */
export const isLockedIdentityKey = (key: string): boolean => (CORE_IDENTITY_KEYS as readonly string[]).includes(key)

/**
 * 这一项**能不能整项删除**（V5 的正面的另一半：锁定的 8 项在客户端就没有这个动作）。
 *
 * 只读判断、绝不抛：它在渲染期被调用，也在控制器里当护栏用。
 * @param doc - 当前草稿。
 * @param itemId - 项 id。
 * @returns 可删时为 true。
 */
export function canDeleteItem(doc: PersonaDocument, itemId: string): boolean {
  const ref = parseItemId(itemId)
  if (ref === undefined) return false
  if (ref.kind === 'identity') {
    const field = doc?.identityCard?.fields?.[Number(ref.key)]
    return field !== undefined && field.custom === true && !isLockedIdentityKey(field.key)
  }
  return !isLockedSectionTitle(ref.key) && (doc?.mutableLayer?.sections ?? []).some((row) => row.title === ref.key)
}

/** 底部添加表单是否填齐了（空输入 ⇒ 保存按钮禁用、提交是空操作，界面据此给出明确行为）。 */
export function addFormReady(form: PersonaAddForm | undefined): boolean {
  if (form === undefined) return false
  return form.name.trim() !== '' && form.value.trim() !== ''
}

/**
 * 这一项**能不能改名**（0.1.13 追加）。
 *
 * 只给**用户自己加的**项：自定义身份卡字段、自定义小节、「用户定义」的条目。
 * **锁定的 8 项（身份卡 4 + 人格卡 4 个原生小节）都不给** —— 原生小节的名字不是"名字"而是
 * "插件认的标识"：
 * - `STANDARD_SECTION_TITLES` 是 P-020/P-022 的固定集合，`orderedSections`、`isStandardMutableLayer`
 *   与原生集合都按它判定；把自定义小节改成「对用户称呼」这类**原生名**，等于让它变成锁定项
 *   （会跟着锁定规则走），这是语义变更，不是改名；
 *   ⚠️ 0.1.14 起「习惯与偏好 / 经验教训 / 情绪 / 未结修正」**不在原生集合里**了 —— 它们和用户
 *   自己加的小节一样是自定义项，因此**可以改名、也可以整项删除**（用户 2026-10-09 的产品决定）；
 * - 4 个核心身份字段的键就是 `CORE_IDENTITY_KEYS`，`ensureCoreFields` 按它补齐、注入按它排序。
 * 所以原生名一律按**保留名**处理（见 {@link renameIssue} 的 `reserved`），只允许改自定义名。
 * @param doc - 当前草稿。
 * @param itemId - 项 id。
 * @returns 可改名时为 true。
 */
export function canRenameItem(doc: PersonaDocument, itemId: string): boolean {
  const ref = parseItemId(itemId)
  if (ref === undefined) return false
  if (ref.kind === 'identity') {
    const field = doc?.identityCard?.fields?.[Number(ref.key)]
    return field !== undefined && field.custom === true && !isLockedIdentityKey(field.key)
  }
  // 小节：**自定义**的才可改（原生小节的名字是插件认的标识，见 `renameIssue` 的 `reserved`）。
  if (isLockedSectionTitle(ref.key)) return false
  return (doc?.mutableLayer?.sections ?? []).some((row) => row.title === ref.key)
}

/** 改名被拦下的原因（界面据此给出明确文案；`undefined` = 可以改）。 */
export type RenameIssue = 'empty' | 'unchanged' | 'reserved' | 'duplicate'

/** 某一项当前的名称（项不存在时返回 `undefined`）。 */
export function itemName(doc: PersonaDocument, itemId: string): string | undefined {
  const ref = parseItemId(itemId)
  if (ref === undefined) return undefined
  if (ref.kind === 'identity') return doc?.identityCard?.fields?.[Number(ref.key)]?.key
  return (doc?.mutableLayer?.sections ?? []).find((row) => row.title === ref.key)?.title
}

/**
 * 改名到 `nextName` 会遇到的问题（V13：空名 / 重名 / 非法名都要**明确**，且**不许静默覆盖**已有项）。
 *
 * 判据与宿主校验**逐条对齐**，免得"界面上点得下去、保存时被宿主拒"：
 * - `empty`：清空后的名字为空 —— 宿主对无名项一律拒绝（`identity.key-empty` /
 *   `mutable.user-defined-key-empty` / 无名小节不进提示词）；
 * - `unchanged`：和现在一样 —— 不是错误，只是没有可提交的改动（确认键禁用）；
 * - `reserved`：撞上**插件认的原生名**（4 个原生小节标题 / 4 个固定层核心字段名）——
 *   宿主那边分别是"语义变更"与 `mutable.core-key-shadowed`；
 * - `duplicate`：**另一个项已经在用**这个名字 —— 宿主会以 `identity.key-duplicate` /
 *   `mutable.section-duplicate` / `mutable.user-defined-duplicate` 拒绝；
 *   跨层撞名（字段 / 小节 /「用户定义」键之间）也归这里（见下面的说明，比宿主严一档）。
 *
 * **名字空间是整张人格卡**：字段名、小节标题、用户定义的键共用一个唯一性约束。这样"改名"这条
 * 规则一句话说得完，用户也不会造出"两个都叫咖啡的项"或"撞名之后加不回字段"的状态。
 *
 * **不静默覆盖**：这里只**读**文档、只回一个原因码；真正落草稿的 `renameItem` 会先复查
 * `canRenameItem`，改名永远是"原地换名字"，绝不把另一个项写掉或顶掉。
 * @param doc - 当前草稿。
 * @param itemId - 项 id。
 * @param nextName - 想改成的新名字（原样传入，函数内部自己去空白比较）。
 * @returns 问题码；可以改时返回 `undefined`。
 */
export function renameIssue(doc: PersonaDocument, itemId: string, nextName: string): RenameIssue | undefined {
  if (!canRenameItem(doc, itemId)) return 'reserved'
  const ref = parseItemId(itemId)
  if (ref === undefined) return 'reserved'

  const name = typeof nextName === 'string' ? nextName.trim() : ''
  if (name === '') return 'empty'

  const current = itemName(doc, itemId)
  if (current === undefined) return 'reserved'
  if (name === current) return 'unchanged'

  const standard = STANDARD_SECTION_TITLES as readonly string[]
  const core = CORE_IDENTITY_KEYS as readonly string[]
  if (standard.includes(name) || core.includes(name)) return 'reserved'

  // 名字必须在**整张人格卡**里唯一：身份卡字段名 / 小节标题共用一个名字空间
  // （「用户定义」的键自 0.1.14 起不再出现在界面上，但**仍在文档里**，所以照旧计入唯一性 ——
  //  否则用户可以把小节改成「用户定义」里已有的键名，造出宿主那边看着矛盾的数据）。
  //
  // 与宿主的关系逐向说明（避免"界面放行、宿主拒绝"的那种不一致）：
  // - **身份卡字段 → 可变层**：宿主本来就会拒（`identity.shadows-mutable`）⇒ 这里是对齐；
  // - **小节 → 身份卡字段名**：宿主目前**不拦这一向**（`checkShadowsMutable` 只查固定层
  //   那一侧）。这里**故意比宿主严**，理由与那条规则自己的注释一致：撞名要在**源头**拦 ——
  //   否则用户之后删掉字段再加一个同名的，会被 `identity.shadows-mutable` 拒，
  //   而那句"请改其中一个名字"指向的正是他当初改出来的这个状态。
  // 只**读**、只回一个原因码，不动别人的数据（见 `renameItem`）。
  const allNames = [
    ...(doc?.identityCard?.fields ?? []).map((field) => field.key),
    ...(doc?.mutableLayer?.sections ?? []).map((row) => row.title),
    ...(doc?.mutableLayer?.userDefined ?? []).map((entry) => entry.key),
  ]
  if (allNames.some((key) => key === name && key !== current)) return 'duplicate'
  return undefined
}

/** 改名表单是否可提交（无问题码且确实改了名）。 */
export function renameReady(doc: PersonaDocument, form: PersonaRenameForm | undefined): boolean {
  if (form === undefined) return false
  return renameIssue(doc, form.itemId, form.name) === undefined
}

/** 工作台快照。每次变更换一个新对象——`useSyncExternalStore` 靠引用比较发现变化。 */
export interface PersonaWorkbenchState {
  readonly status: PersonaStatus
  /** `failed` 时的原始原因（远端消息），用于诊断。 */
  readonly error?: string
  /** 宿主是否接受写入；false 时界面只读（设置服务缺席或 provider 只读）。 */
  readonly writable: boolean
  /** 读取时的用户层修订号；写回时必须带上它，避免静默覆盖并发修改。 */
  readonly revision?: number
  /** 宿主里当前生效的文档（写回时的"旧值"，也是校验的 prev）。 */
  readonly stored: PersonaDocument
  /** 正在编辑的副本。 */
  readonly draft: PersonaDocument
  readonly saving: boolean
  /** 最近一次保存的 ISO 时间；空串表示本次会话还没保存过。 */
  readonly savedAt: string
  /** 保存前校验的问题清单（P-011：由插件渲染，中性可操作）。 */
  readonly issues: readonly PersonaIssue[]
  /**
   * 等待二次确认删除的项 id（不可逆操作，必须先确认）。
   *
   * ⚠️ **没有** `editing` 这类"编辑态"字段（0.1.13 返工后的口径）：用户要的是
   * 「每项的**内容**一直是可以改的输入框，只是**名称**不要输入框」——
   * 内容区默认就是可编辑控件，不存在"点一下才出现"这一步；名称区则永远是纯文字。
   */
  readonly pendingDelete?: string
  /** 底部添加表单；`undefined` = 入口收起，只显示那个按钮。 */
  readonly addForm?: PersonaAddForm
  /**
   * 改名表单；`undefined` = 名称以纯文字显示（默认态，**没有**输入框）。
   *
   * 只有**自定义**的项会用它（见 {@link canRenameItem}）；锁定的 8 项（身份卡 4 + 原生小节 4）没有这个入口。
   */
  readonly renaming?: PersonaRenameForm
  /**
   * 独立判断底层指令开关（顶层 `humanity` 配置的 `independentJudgment`，与人格文档**不是**同一份数据）。
   *
   * 默认 true：读不到（命名空间缺席 / 字段没写过）时按 schema 默认值显示"开"，
   * 而不是显示成"关"——后者会让用户以为功能没生效。
   */
  readonly independentJudgment: boolean
  /** 读取顶层配置时的修订号（写回必须带上，避免覆盖别人的并发修改）。 */
  readonly independentJudgmentRevision?: number
  /** 开关正在写回（界面据此禁用控件，避免连点造成两次在不同修订号上的写入）。 */
  readonly independentJudgmentSaving: boolean
}

/**
 * 未初始化时的空文档。
 *
 * 与 `model.ts` 里 schema 默认值同形；这里不 import 它（会带进 schemastery），
 * 且只在"命名空间读不到"时用于渲染，**从不用于写回**（读不到就是不可编辑）。
 */
export function emptyDocument(): PersonaDocument {
  return {
    schemaVersion: 1,
    identityCard: {
      fields: CORE_IDENTITY_KEYS.map((key) => ({ key, value: '', custom: false })),
      initializedAt: '',
      sealedAt: '',
    },
    mutableLayer: {
      sections: STANDARD_SECTION_TITLES.map((title) => ({ title, items: [] })),
      userDefined: [],
    },
  }
}

/** 深拷贝纯 JSON 文档。用 JSON 往返而不是 `structuredClone`：文档里不可能有非 JSON 值，且不依赖全局。 */
export function clone(document: PersonaDocument): PersonaDocument {
  return JSON.parse(JSON.stringify(document)) as PersonaDocument
}

/** 把宿主返回的一段值收窄成文档。 */
export function asDocument(value: unknown): PersonaDocument {
  if (value === null || typeof value !== 'object') throw new Error('宿主返回的人格文档不是对象')
  const candidate = value as Partial<PersonaDocument>
  if (candidate.identityCard === undefined || candidate.mutableLayer === undefined) {
    throw new Error('宿主返回的人格文档缺少 identityCard / mutableLayer')
  }
  // **补齐数组字段**：宿主返回的形状我们没权力假设完整。少了数组就会在**渲染期**
  // `undefined.map(...)` 抛错 —— 那会把整个 React 根带下去（真机事故：点会话 → UI 全塌）。
  // 缺什么补成空数组：界面最多显示为空，不会崩。
  //
  // `effectivePersona`（= 规范化 + 删空壳）：历史遗留的"删除后的空壳自定义节"不该出现在界面里
  // （真机 Bug B / R2：它是删不掉的僵尸）。滤掉之后，工作台下一次保存也会把它从存储里清掉
  // ——因为保存发的是整份文档。
  return effectivePersona({
    ...(candidate as PersonaDocument),
    identityCard: {
      initializedAt: candidate.identityCard.initializedAt ?? '',
      sealedAt: candidate.identityCard.sealedAt ?? '',
      fields: Array.isArray(candidate.identityCard.fields) ? candidate.identityCard.fields : [],
    },
    mutableLayer: {
      sections: Array.isArray(candidate.mutableLayer.sections) ? candidate.mutableLayer.sections : [],
      userDefined: Array.isArray(candidate.mutableLayer.userDefined) ? candidate.mutableLayer.userDefined : [],
    },
  })
}

/**
 * 有序分组：**在文档里的小节**里，原生小标题按原生顺序在前、其余（一律自定义）按原顺序在后。
 *
 * ⚠️ 0.1.13 起这里**不再补齐缺失的原生小标题**（旧实现给每个原生标题兜一个空壳）。
 * 原因：用户要求"删除 = 整项删掉（文档里没有、提示词里也没有）"，而补齐会让被删掉的小节
 * 在界面当场复活成一个空壳 —— 用户看到的是"删了还在"，打字还打不进去（`setSectionText` 按标题找不到）。
 * 小节现在只有一个来源：文档里真实有的那些；没有就是没有。
 *
 * 渲染期调用，逐层兜底（抛一次就是整帧崩）。
 * @param doc - 当前文档。
 * @returns 有序的小节列表。
 */
export function orderedSections(doc: PersonaDocument): Array<{ title: string; items: string[] }> {
  const standard = new Set<string>(STANDARD_SECTION_TITLES)
  const sections = Array.isArray(doc?.mutableLayer?.sections) ? doc.mutableLayer.sections : []
  const known = STANDARD_SECTION_TITLES.flatMap((title) => {
    const found = sections.find((section) => section?.title === title)
    return found === undefined ? [] : [{ title, items: Array.isArray(found.items) ? [...found.items] : [] }]
  })
  const rest = sections
    .filter((section) => section !== undefined && section !== null && !standard.has(section.title))
    .map((section) => ({ title: section.title, items: Array.isArray(section.items) ? [...section.items] : [] }))
  return [...known, ...rest]
}

/** 判断草稿是否与已保存内容不同（界面据此启用保存按钮）。 */
export function isDirty(state: PersonaWorkbenchState): boolean {
  try {
    return JSON.stringify(normalizePersona(state.draft)) !== JSON.stringify(normalizePersona(state.stored))
  } catch {
    // 渲染期调用：算不出来就当作"没有改动"，绝不让一次比较失败变成白屏。
    return false
  }
}

/**
 * 人格工作台控制器。
 *
 * 生命周期：`attach(remote)` 在客户端 remote 服务出现时调用，`detach()` 在它消失时调用
 * （`ctx.inject(['remote'], …)` 的两个方向）。服务不在时界面显示"通道未就绪"而不是假装可编辑。
 */
