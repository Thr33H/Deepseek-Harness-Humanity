/**
 * 人格工作台的状态机：持有草稿与远程通道，负责读取、编辑、保存前校验与写回。
 *
 * 三块拆开是为了各自可读：状态快照与文档形状在 `persona-document.ts`（纯函数），
 * 设置 RPC 的通道类型在 `persona-channel.ts`，这里只管状态机本身。
 * 规则真源在宿主（`../host/persona/*`）：客户端保存前校验用的是**同一份**规则模块。
 * @module deepseek-harness-humanity/client/persona-controller
 */
import { describeError } from '../host/log.js'
import { effectivePersona, normalizePersona } from '../host/persona/normalize.js'
import { validatePersona } from '../host/persona/validate.js'
import type { PersonaDocument, PersonaIssue } from '../host/persona/types.js'
import { isDirty, addFormReady, canDeleteItem, canRenameItem, itemName, renameIssue, type PersonaAddForm, type PersonaItemKind, type PersonaIssueView } from './persona-document.js'
import { PERSONA_NAMESPACE, type PersonaChannel, type PersonaNamespaceView } from './persona-channel.js'
import { readIndependentJudgment, writeIndependentJudgment } from './persona-config.js'
import { PersonaStateBase } from './persona-state.js'
import {
  addIdentityField,
  applyAddForm,
  removeIdentityField,
  removeItem,
  renameItem,
  sealPersona,
  setIdentityKey,
  setIdentityValue,
  setSectionText,
  stampInitialization,
} from './persona-edits.js'

export { PERSONA_NAMESPACE } from './persona-channel.js'
/**
 * 人格工作台控制器：对外是状态机（订阅/读取/编辑/保存），对内把纯逻辑委托给
 * `persona-edits.ts`（草稿修改）与 `persona-state.ts`（状态容器）。
 */
export class PersonaWorkbenchController extends PersonaStateBase {
  private channel: PersonaChannel | undefined

  /**
   * 接上设置 RPC，并把当前文档读进来。**形状不对就不接**（调用点在 `ctx.inject` 回调里，
   * 抛出去会变成客户端 cordis 运行时的异常）：只校验与降级，不抛。
   * @param channel - 期望是实现 `describe`/`replace` 的通道；其它值一律按"没有通道"处理。
   */
  attach(channel: PersonaChannel): void {
    this.channel =
      channel !== undefined &&
      channel !== null &&
      typeof channel.describe === 'function' &&
      typeof channel.replace === 'function' &&
      // `update` 是独立判断开关的写通道（DSH 0.1.5-rc.2 起有）。缺了它就把整条通道判为不可用：
      // 形态不对的通道只该导致"工作台只读"，不该等到用户点开关时才在点击回调里抛错。
      typeof channel.update === 'function'
        ? channel
        : undefined
    void this.load()
  }

  /** 断开（服务被摘除）：回到"通道未就绪"，但保留草稿内容，避免用户正在编辑的东西凭空消失。 */
  detach(): void {
    this.channel = undefined
    this.update({ status: 'unavailable', writable: false, saving: false })
  }

  /**
   * 从宿主重新读取（也是"丢弃本地草稿"的唯一入口——本步不做撤销栈，见裁决 5）。
   *
   * **永不抛**：调用点是 `useEffect` 里的 `void controller.load()`，抛出去就是未处理的
   * rejection；返回形状不对也只是降级成"读不到"。
   */
  async load(): Promise<void> {
    const channel = this.channel
    if (channel === undefined) {
      this.update({ status: 'unavailable', writable: false })
      return
    }

    this.update({ status: 'loading', error: undefined })

    let result
    try {
      result = await channel.describe()
    } catch (error) {
      this.update({
        status: 'failed',
        writable: false,
        error: error instanceof Error ? error.message : String(error),
      })
      return
    }

    if (result === undefined || result === null || result.ok !== true) {
      const message = result?.error?.message ?? '宿主没有返回可用的设置描述'
      this.update({ status: 'failed', error: message, writable: false })
      return
    }

    const namespaces = Array.isArray(result.value?.namespaces) ? result.value.namespaces : []
    const view = namespaces.find((entry) => entry?.ns === PERSONA_NAMESPACE)
    if (view === undefined) {
      // 命名空间不在 = 宿主那一半没挂上（或设置服务缺席）。此时没有任何可写目标，
      // 界面据 `unavailable` 显示只读说明；不编造一份可编辑的默认值。
      this.update({ status: 'unavailable', writable: false, issues: [] })
      return
    }

    // 独立判断开关在**顶层配置**命名空间里（与人格文档是两份数据），顺手从同一次 describe 里读。
    this.adopt(view, result.value.writable, { independentJudgment: readIndependentJudgment(namespaces) })
  }

  /**
   * 切换独立判断底层指令（顶层 `humanity` 配置的 `independentJudgment`，读写细节见 `persona-config.ts`）。
   * @param next - 目标状态。
   */
  async setIndependentJudgment(next: boolean): Promise<void> {
    const channel = this.channel
    if (channel === undefined || !this.state.writable || this.state.independentJudgmentSaving) return

    this.update({ independentJudgmentSaving: true, error: undefined })
    let result
    try {
      result = await writeIndependentJudgment(channel, next, this.state.independentJudgmentRevision)
    } catch (error) {
      // 传输层直接抛（断线 / 宿主重启）：**必须**清掉忙碌标记，否则开关永久禁用、一个字都不说。
      this.update({ independentJudgmentSaving: false, error: describeError(error) })
      return
    }
    if (!result.ok) {
      // 宿主拒绝（并发冲突 / 只读 provider）：保持原值并把它的说法原样显示，不假装切成功了。
      this.update({ independentJudgmentSaving: false, error: result.message })
      return
    }
    this.update({
      independentJudgment: result.view.independentJudgment,
      independentJudgmentRevision: result.view.revision,
      independentJudgmentSaving: false,
    })
  }

  /** 保存草稿：**先本机校验，再发请求**；成功后用宿主返回的值重建基线。 */
  async save(): Promise<void> {
    const channel = this.channel
    if (channel === undefined || !this.state.writable || this.state.saving) return

    const stamped = stampInitialization(normalizePersona(this.state.draft), this.state.stored)
    const candidate = effectivePersona(stamped)
    const validation = validatePersona(candidate, this.state.stored, 'user')
    const warnings = validation.issues.filter((issue) => issue.severity === 'warning')

    if (!validation.ok) {
      // 保存前校验：本机就能判定的问题不必打一次网络往返，也避免用户以为"已经存进去了"。
      this.update({ issues: validation.issues })
      return
    }

    this.update({ saving: true, issues: warnings, error: undefined })
    let result
    try {
      result = await channel.replace(PERSONA_NAMESPACE, candidate as unknown as Record<string, never>, this.state.revision)
    } catch (error) {
      // 同上：抛出去会让 saving 永远为真（保存按钮卡在"保存中…"），而且 rejection 从
      // `void controller.save()` 逃逸成未处理拒绝（2026-09-26 客户端审计的阻塞项）。
      this.update({ saving: false, error: describeError(error), issues: warnings })
      return
    }
    if (!result.ok) {
      // 宿主仍然可能拒绝（并发冲突、provider 只读、规则版本比客户端新）。原样显示它的说法。
      this.update({ saving: false, error: result.error.message, issues: warnings })
      return
    }

    this.adopt(result.value, true, { warnings, savedAt: new Date().toISOString() })
  }

  // 下面这些方法只是把用户改了哪一项转成对草稿的修改（纯函数在 ）：
  // 控制器负责改哪一份草稿、改完通知谁，函数负责怎么改。

  /**
   * 封存固定层（P-013：对 Agent 封存，用户仍可改）。
   *
   * 为什么要有这个显式动作（2026-09-26 真机暴露的缺口）：封存原本只有"首次保存"这一条路径，
   * 于是"已初始化但未封存"的卡（预填、旧数据、别的写入方留下的）在界面上**永远封不上**，
   * 独立判断开关一直是灰的。这里补用户的入口：先把封存标记落进草稿，再走同一条保存路径
   * （本机校验 + 修订号 + 宿主拒绝原样显示，一步都不绕过）。
   */
  async seal(): Promise<void> {
    if (this.channel === undefined || !this.state.writable || this.state.saving) return
    this.update({ draft: sealPersona(this.state.draft, new Date().toISOString()) })
    await this.save()
  }

  setIdentityValue(index: number, value: string): void { this.edit((draft) => setIdentityValue(draft, index, value)) }
  setIdentityKey(index: number, key: string): void { this.edit((draft) => setIdentityKey(draft, index, key)) }
  addIdentityField(): void { this.edit(addIdentityField) }
  removeIdentityField(index: number): void { this.edit((draft) => removeIdentityField(draft, index)) }
  setSectionText(title: string, text: string): void { this.edit((draft) => setSectionText(draft, title, text)) }

  // ⚠️ 0.1.14：`setUserDefined` / `addUserDefined` / `removeUserDefined` 三个入口随「用户定义」区块
  // 一起下线（用户："用户自定义可以删了，它跟添加小节重复了"）。数据仍在文档里，只是不再可编辑。

  /* ── 项级交互（0.1.13）：删除要二次确认 / 添加在底部 ─────────────────────────────
   *
   * ⚠️ **没有"编辑态"**（0.1.13 返工后的口径，用户原话）：每项的**内容**一直是可编辑输入框
   * （`PersonaFields` 直接绑 `setIdentityValue` / `setSectionText`），
   * 只有**名称**是纯文字、不可编辑。所以这里只剩两件事：删除确认、底部添加表单。
   *
   * 为什么它们是**控制器状态**而不是组件的 `useState`：
   * ① 两者互斥（确认删除时收起添加表单），放在一处才说得清优先级；
   * ② 静态渲染就能断言"确认带出现了 / 添加表单展开了"，测试不必依赖 DOM 事件；
   * ③ 保存 / 重新加载之后要一起清掉（见 `adopt`），否则会留下指向已消失项的幽灵状态。
   */

  /**
   * 请求删除某一项：先进入**二次确认**态，不直接删。
   *
   * 锁定项（默认 8 项）在这里就没有这个动作 —— `canDeleteItem` 说不行就静默返回，
   * 连确认态都不进（V3 的正面：界面上没有删除入口）。
   */
  requestDelete(itemId: string): void {
    if (!this.state.writable || this.state.saving) return
    if (!canDeleteItem(this.state.draft, itemId)) return
    this.update({ pendingDelete: itemId, addForm: undefined, renaming: undefined })
  }

  /** 放弃删除（用户点了"取消"）。 */
  cancelDelete(): void {
    this.update({ pendingDelete: undefined })
  }

  /**
   * 确认删除：**整项**从草稿里摘掉（不可逆 —— 本步没有撤销栈，`重新加载` 只能丢弃草稿）。
   *
   * 只改草稿，不直接写宿主：删除与其它编辑走同一条落盘路径（卡片上的「保存」），
   * 于是"进历史"由宿主既有的 `persistPersona` 负责（被取代/删除的旧内容进 `persona_history`，
   * 保留期见 `modules.persona.historyRetentionDays`）。
   */
  confirmDelete(): void {
    const itemId = this.state.pendingDelete
    if (itemId === undefined) return
    if (!canDeleteItem(this.state.draft, itemId)) {
      this.update({ pendingDelete: undefined })
      return
    }
    this.edit((draft) => removeItem(draft, itemId))
    this.update({ pendingDelete: undefined })
  }

  /** 打开底部的「添加」入口（点了才出现输入区 + 保存按钮）。 */
  openAdd(kind: PersonaItemKind): void {
    if (!this.state.writable || this.state.saving) return
    this.update({ addForm: { kind, name: '', value: '' }, pendingDelete: undefined, renaming: undefined })
  }

  /** 收起添加表单（取消：表单内容丢弃，草稿一个字不动）。 */
  cancelAdd(): void {
    this.update({ addForm: undefined })
  }

  /** 改添加表单里的一个字段。 */
  setAddField(field: 'name' | 'value', value: string): void {
    const form = this.state.addForm
    if (form === undefined) return
    const next: PersonaAddForm = { ...form, [field]: value }
    this.update({ addForm: next })
  }

  /**
   * 提交添加表单：落进草稿，随即走**同一条保存路径**写回宿主。
   *
   * 为什么顺带保存（用户：底部"增设保存按钮"）：这一项是用户当场填出来的，停在草稿里
   * 等于"点了保存却没生效"。名字或内容为空时是**空操作**（按钮此时也是禁用的，
   * 两处说的是同一件事）；保存被宿主拒绝时草稿保留、原因照常显示，与其它编辑一致。
   */
  async commitAdd(): Promise<void> {
    const form = this.state.addForm
    if (form === undefined || !this.state.writable || this.state.saving) return
    if (!addFormReady(form)) return
    this.edit((draft) => applyAddForm(draft, form))
    this.update({ addForm: undefined })
    await this.save()
  }

  /* ── 改名（0.1.13 追加）：只给用户自定义的项，平时名称仍是纯文字 ───────────────── */

  /**
   * 打开某一项的**改名**入口：名称那一格换成输入框 + 确定/取消。
   *
   * 锁定 8 项与标准小节在这里就没有这个动作（`canRenameItem` 说不行就静默返回，
   * 连输入框都不出现）—— 它们的名字是插件认的标识，改名会变语义（见 `canRenameItem` 的说明）。
   */
  beginRename(itemId: string): void {
    if (!this.state.writable || this.state.saving) return
    if (!canRenameItem(this.state.draft, itemId)) return
    const name = itemName(this.state.draft, itemId) ?? ''
    this.update({ renaming: { itemId, name }, pendingDelete: undefined, addForm: undefined })
  }

  /** 改名字草稿（还没落进文档）。 */
  setRenameName(value: string): void {
    const form = this.state.renaming
    if (form === undefined) return
    this.update({ renaming: { itemId: form.itemId, name: value } })
  }

  /** 取消改名：表单收起，草稿一个字不动（V10/V13 的"取消零改动"）。 */
  cancelRename(): void {
    this.update({ renaming: undefined })
  }

  /**
   * 确认改名：**先复查再落草稿**。
   *
   * 复查用的是与宿主校验逐条对齐的 {@link renameIssue}（空名 / 重名 / 撞标准名一律拒绝），
   * 所以这里不会提交一份宿主必然拒绝的文档；拒绝时**不关表单**，用户看得见自己填的名字，
   * 界面同时把原因写在旁边（不给"点了没反应"）。
   *
   * 落盘仍走卡片上的「保存」（与删除、内容编辑同一条路），所以改名也照常进 `persona_history`。
   */
  confirmRename(): void {
    const form = this.state.renaming
    if (form === undefined) return
    if (renameIssue(this.state.draft, form.itemId, form.name) !== undefined) return
    this.edit((draft) => renameItem(draft, form.itemId, form.name))
    this.update({ renaming: undefined })
  }

  /** 用宿主返回的一段值重建基线（stored = draft = 生效文档），并记录修订号。 */
}
