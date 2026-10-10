/**
 * 人格数据模型的**常量**（宿主与浏览器共用的唯一真源）。
 *
 * 与 `types.ts` 的分工：这里只放"值"（字段名、标准小标题、问题代码…），
 * 由值派生出来的类型（如 `PersonaIssueCode`）也跟着放这里，免得两处各写一份。
 * 本文件**不 import 任何东西**：规则模块必须能进浏览器 bundle，不能牵连 schemastery 或宿主服务。
 * @module humanity/persona/constants
 */

/**
 * 固定层的核心字段（P-012 默认三段式 + 2026-09-23 增补「主语言」）。
 *
 * 这几个是"潜意识底色"的最小集合：只有用户能改，Agent 封存后不能改（P-013/P-023）。
 * 用中文键名而不是 `name`/`gender`：这是**用户看得见、编辑得了**的自然语言身份卡，
 * 键名本身就是界面文案；用英文键名再翻译一层，只会让工作台和文档对不上。
 *
 * **顺序有意义**：它就是身份卡在工作台与提示词里的展示顺序（姓名 → 性别 → 人格偏好 → 主语言）；
 * `model.ts` 的默认字段与 `renderPersonaPrompt` 的输出都按它排。
 *
 * 「主语言」（用户 2026-09-23 定）：决定回复用什么语言 —— 除专业术语外全部用主语言。
 * 放在固定层而不是可变层，是因为"这个 AI 对谁说话、用什么语言说话"属于底色，
 * 与姓名/性别同级：对 Agent 封存，只有用户能改。
 */
export const CORE_IDENTITY_KEYS = ['姓名', '性别', '人格偏好', '主语言'] as const

/**
 * 可变层的 **4 个原生小标题**（用户 2026-10-09 定：人格卡原生项**只剩这 4 个**）。
 *
 * 用户原话（逐字）："只有 8 个原生项，角色卡 4 个，人格卡 4 个，其余都是属于自定一项，
 * **没有标准这一说**，除了原生的 8 个外，**其余都一样待遇**，包括 dsh 新装一个 Humanity，
 * 也是显示 8 个原生项。"
 *
 * ⇒ 语义从"标准集合（其余需要归位）"改成"**原生集合**"：
 * - 这 4 个是**锁定项**（见 {@link LOCKED_SECTION_TITLES}），不可整项删除、不可改名；
 * - **其余一切都是自定义项，待遇完全相同**：可删、可改名、可自由添加 ——
 *   包括 0.1.13 及以前算"标准"的「习惯与偏好 / 经验教训 / 情绪 / 未结修正」：
 *   它们在现存卡里**内容与标题一个都不动**，只是从此**降级为普通自定义项**
 *   （空的会被当空壳清掉、删掉之后**不会再被自动补回**）。
 * - 新装只生成"身份卡 4 字段 + 人格卡 4 小节"= **8 个原生项**，不再预置那 4 个空节。
 *
 * 顺序即工作台与提示词里的展示顺序（原生 4 个在前，自定义项按文档顺序在后）。
 * 第 9 个兜底层「用户定义」不是小标题而是键值对列表，因此不在这里；它自 0.1.14 起
 * **不再在界面上渲染/编辑**（数据保留，见 `docs/plans/humanity-0.1.14-native-four.md` §5）。
 */
export const STANDARD_SECTION_TITLES = [
  '对用户称呼',
  '说话风格',
  '交付格式',
  '行为边界',
] as const

/**
 * **锁定小节**：可变层里不许整项删除的前 4 个小标题（用户 2026-10-09）。
 *
 * 加上固定层的 {@link CORE_IDENTITY_KEYS} 4 项，正好是用户要的「默认 8 项不可删」
 * （0.1.14 起 {@link STANDARD_SECTION_TITLES} 就是这 4 项，两者相等）。
 * 为什么是这 4 个：它们描述"这个 AI 怎么跟用户说话"（称呼 / 语气 / 交付形态 / 底线），
 * 是人格卡里**每次都该存在**的部分 —— 删掉其中一个，注入出去的底色就缺一角，
 * 而用户在工作台上看不出"少了什么"。
 *
 * 派生自 {@link STANDARD_SECTION_TITLES} 的前 4 项，不另抄一份字面量：原生集合重排时
 * 这里跟着走，两处不会分叉（与 `model.ts` 用原生标题生成 schema 默认值同一纪律）。
 *
 * **锁定的是"整项删除"与"改名"，不是编辑**：条目照常可增删改（清空后小节仍在）。
 */
export const LOCKED_SECTION_TITLES: readonly string[] = STANDARD_SECTION_TITLES.slice(0, 4)

/** 这个小标题是否锁定（不可整项删除）。 */
export const isLockedSectionTitle = (title: string): boolean => LOCKED_SECTION_TITLES.includes(title)

/**
 * 稳定的问题代码。新增代码只能追加，不能改已有含义（工作台会按它分支）。
 *
 * 曾经有一个 `mutable.address-changed`（把"改对用户称呼"判为高风险拒绝）—— 2026-09-23 真机反馈后
 * **删掉**：一个人可以有多个称呼，改称呼是低风险（用户裁定），而当时的拒绝文案把用户指向一个尚不存在的
 * 工作台确认入口，形成死结。删掉一个**永远不会再产生**的代码不影响"含义稳定"这条约定。
 *
 * 同一条约定在 0.1.14 再走一次：`mutable.section-non-standard`（小标题不在标准集合内）随用户
 * 2026-10-09 的产品决定一起**删掉** —— "除了原生 8 项，其余都一样待遇"，**没有"标准/非标准"这一说**，
 * 于是这条代码**永远不会再产生**（`grep` 可证无产出点）。它也不再出现在 `PERSONA_ISSUE_CODES` 里，
 * 因此客户端的两条对应文案（`persona.issue.mutable.section-non-standard`）一并删除
 * （`test/client-bundle.test.mjs` 断言"代码 ↔ 文案"一一对应，两边同删才自洽）。
 * 历史记录里若存有这个码的旧字符串，只是不再被 UI 渲染，不影响任何判定。
 */
export const PERSONA_ISSUE_CODES = [
  'identity.key-empty',
  'identity.key-duplicate',
  'identity.core-missing',
  'identity.value-too-long',
  'identity.sealed',
  'identity.shadows-mutable',
  'mutable.section-duplicate',
  'mutable.section-title-empty',
  'mutable.section-dropped',
  'mutable.section-cleared',
  'mutable.section-locked-missing',
  'mutable.core-key-shadowed',
  'mutable.user-defined-duplicate',
  'mutable.user-defined-key-empty',
  'mutable.item-too-long',
] as const

/** 问题代码。 */
export type PersonaIssueCode = (typeof PERSONA_ISSUE_CODES)[number]

/**
 * 单个值的长文软上限（P-015）。
 *
 * 只警告、不硬拒绝：长文本不是错误，只是更贵、更容易自相矛盾。硬拒绝会把
 * "用户就想写一段话"变成功能缺陷。
 */
export const VALUE_SOFT_LIMIT = 120

/**
 * `persona_history` 的**默认保留天数**（用户 2026-10-09：「删除的进历史，要有个保留天数，
 * 而不是永久保留」）。
 *
 * 这里是这个数字的**唯一真源**：`config.ts` 的 schema 默认值引用它，不另抄一份（G-004）。
 * 30 天是产品决策（用户的口径），不是工程凑数：够覆盖"我上周是不是删过一条"这类回溯，
 * 又不至于让审计表无限膨胀。
 *
 * **语义边界**（见 `history-retention.ts`）：`<= 0` = **关闭清理**（历史永久保留）——
 * 这是唯一的"永久保留"入口，必须显式设置；负数是非法输入，按 0 处理（**不**解释成
 * "立刻清空"：误配一个负号就把用户的历史全删掉，是最坏的方向）。
 */
export const HISTORY_RETENTION_DAYS = 30

/**
 * **唯一**允许在"用户已在对话里确认"之后放行的 rejected 级问题。
 *
 * 白名单写死在这里，而不是让调用方随便传代码：`confirmed` 是"用户点头了"的凭证，
 * 一旦它能放行 `identity.sealed`（固定层封存）或核心字段缺失这类问题，封存就等于没有。
 *
 * - `mutable.section-dropped`：整节标题从快照里消失（其它写入方可能这么干）；
 * - `mutable.section-cleared`：**显式**把一节仍有内容的条目清空 —— 工具路径下这是"删内容"的正门，
 *   所以要在这里问一次（真机反馈缺陷 ⑤ 之后，"漏传"已改为"不动这一节"，不再触发确认）。
 * @see validatePersona
 */
export const CONFIRMABLE_ISSUES = ['mutable.section-dropped', 'mutable.section-cleared'] as const

/** 可确认放行的问题代码。 */
export type ConfirmableIssueCode = (typeof CONFIRMABLE_ISSUES)[number]
