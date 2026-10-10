/**
 * 人格文档的**读与写**（真源是 `humanity-persona` 设置命名空间）。
 *
 * 与 `section.ts`（命名空间接线）分开：那边回答"怎么接进设置服务、怎么降级"，
 * 这里回答"读的是哪一份、写的时候怎么校验与落盘"。
 * @module humanity/persona/document
 */
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'

import { persistPersona, type HistorySink } from './persist.js'
import { effectivePersona, normalizePersona } from './normalize.js'
import { validatePersona } from './validate.js'
import type { PersonaDocument, ValidateOptions, WriteSource } from './types.js'

/**
 * 人格文档的命名空间名。它写在用户的设置文件里，因此**改名等于丢用户数据**（G-004）。
 */
export const PERSONA_NAMESPACE = 'humanity-persona'

/** 写入被拒。`issues` 是结构化的判定结果，调用方据此组织对用户说的话（P-011）。 */
export class PersonaWriteRejected extends Error {
  readonly code = 'PERSONA_WRITE_REJECTED'
  readonly issues: ReturnType<typeof validatePersona>['issues']

  constructor(issues: ReturnType<typeof validatePersona>['issues']) {
    const rejected = issues.filter((issue) => issue.severity === 'rejected')
    super(rejected.map((issue) => issue.message).join(' '))
    this.name = 'PersonaWriteRejected'
    this.issues = issues
  }
}

/** 接线状态：服务句柄、就绪标记与默认文档。读、写、注册三条路径共享同一个对象。 */
export interface SectionState {
  /** 设置服务句柄；未接上 / 已摘除时为 `undefined`。 */
  settings?: SettingsProvider
  /** 命名空间是否已接上（决定 `attached` 与"能不能读到真文档"）。 */
  attached: boolean
  /** 默认（未初始化）人格：base 层，也是设置服务缺席时的回退值。 */
  fallback: PersonaDocument
  /** 「写入成功」监听者；工具注册集依赖初始化状态翻转，见 `writePersona` 末尾。 */
  changedListeners?: Set<() => void>
}

/**
 * 读**当前生效**的人格文档：每次都从设置命名空间现取，绝不缓存。
 *
 * **读的只有一处**：`state.settings.get(PERSONA_NAMESPACE)` —— 注入回调里捕获的设置服务句柄。
 * 为什么不走 `ctx.get('settings')`：那依赖**调用时的上下文**能解析出这个服务，而提示词拼装发生在
 * agent loop 的上下文里；服务在别的上下文（未激活 / 被 isolate 的组合）里读不到时它就是 `undefined`。
 * 也不走 `installSection` 给的回调（sink）：那个闭包捕获的是**注册那一刻**的 registration，
 * 与写入实际落到的对象可能不是同一个 —— 这正是"写进新的、读出旧的"的来源（真机表现：
 * 工作台保存成功、设置文档里也确实有，但对话里读到的还是启动时那一份）。
 * 一个句柄、一条读取路径，读和写必然查同一张表。
 *
 * 句柄为空（设置服务尚未挂载 / 已摘除）⇒ 返回**空默认文档**，绝不返回任何"上一次读到的"数据：
 * 过时的人格比不注入更糟（它会和新人格打架）。
 *
 * 为什么包 try/catch：本函数在**提示词拼装路径**上被调用，那一层没有 try/catch
 * （`dsh-system-prompt/lib/index.js:339` 逐字是 `section.text(context)`），读一次抛出去
 * 就毁掉这一轮对话的 pre-step。宁可这轮不注入，也不能把宿主带崩。
 * @param state - 接线状态。
 * @returns 当前生效文档（未规范化）。
 */
export function readCurrent(state: SectionState): PersonaDocument {
  if (state.settings === undefined) return state.fallback
  try {
    const live = state.settings.get(PERSONA_NAMESPACE)
    return live === undefined || live === null ? state.fallback : (live as PersonaDocument)
  } catch {
    return state.fallback
  }
}

/**
 * 写入一份完整快照。
 *
 * 单向数据流（见 normalize.ts 文件头）：**校验**看调用方传了什么（空的自定义节还在 ⇒ 能区分
 * "显式清空"与"漏传"），**落盘**才删掉空壳 —— 顺序反了就会出现"显式删除被误报成漏传"。
 * `options.confirmed` 只可能来自"用户已在对话里点过确认"（见 constants.ts 的 CONFIRMABLE_ISSUES
 * 白名单），所以存储层的二次校验没有被绕过：它只是知道了"这一条用户已经点头"。
 * @param state - 接线状态。
 * @param history - 历史接收方；存储未就绪时返回 undefined 即可。
 * @param next - 待写入的文档（会被规范化）。
 * @param writeSource - 写入来源，决定校验强度。
 * @param options - 用户已确认的问题代码白名单。
 */
export async function writePersona(
  state: SectionState,
  history: () => HistorySink | undefined,
  next: PersonaDocument,
  writeSource: WriteSource,
  options?: ValidateOptions,
): Promise<void> {
  const before = effectivePersona(readCurrent(state))
  const candidate = normalizePersona(next)
  const stored = effectivePersona(next)

  const result = validatePersona(candidate, before, writeSource, options)
  if (!result.ok) throw new PersonaWriteRejected(result.issues)

  // 落盘用的句柄与读取路径**同一个**（见 persist.ts 的说明：两处现取可能分叉）。
  await persistPersona(() => state.settings, history, before, stored, writeSource)

  // 落盘成功后才通知：工具注册集按初始化状态决定 init 是否可见（封存后下线），
  // 而所有写入路径（Agent 工具 / 工作台命令）都经过本函数，这里是唯一可靠的翻转点。
  for (const listener of state.changedListeners ?? []) listener()
}
