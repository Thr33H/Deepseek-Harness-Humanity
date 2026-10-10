/**
 * 自进化工作台的**状态机**：读投影、发命令、改调度与预算配置。
 *
 * 与记忆控制器同一形状（`subscribe` / `getSnapshot` / `load`）：命令是**两段式** ——
 * 客户端只把命令写进命令槽（`request`），宿主消费完重新投影，客户端在
 * `settings/document-updated` 事件里重读。界面不做乐观更新：以宿主投影回的 `notice` 为准。
 * @module deepseek-harness-humanity/client/evolution-controller
 */
import { EVOLUTION_NAMESPACE, type EvolutionChannel } from './evolution-channel.js'
import type { PersonaNamespaceView } from './persona-channel.js'
import { asEvolutionConfig } from './evolution-config-doc.js'
import { asEvolutionDocument } from './evolution-document.js'
import { EvolutionStateBase } from './evolution-state.js'
import type { SkillDraftView } from './evolution-views.js'

/** 回扫范围（与宿主 `RescanRange` 的命令行形状一致）。 */
export interface RescanSelection {
  kind: 'days' | 'workspace' | 'session' | 'all'
  value: string
}

/** 自进化工作台控制器。 */
export class EvolutionWorkbenchController extends EvolutionStateBase {
  private channel: EvolutionChannel | undefined

  /** 接上设置 RPC 并读一次。形状不对就整条通道判为不可用。 */
  attach(channel: EvolutionChannel): void {
    const usable = channel !== undefined && channel !== null
      && typeof channel.describe === 'function' && typeof channel.update === 'function'
    this.channel = usable ? channel : undefined
    void this.load()
  }

  /** 断开：回到"通道未就绪"，保留已读到的数据（用户正在看的内容不该凭空消失）。 */
  detach(): void {
    this.channel = undefined
    this.update({ status: 'unavailable', writable: false, busy: '' })
  }

  /** 从宿主重新读取。**永不抛**：调用点在 `useEffect` 的异步链上。 */
  async load(options: { quiet?: boolean } = {}): Promise<void> {
    const quiet = options.quiet === true
    const channel = this.channel
    if (channel === undefined) {
      this.update({ status: 'unavailable', writable: false })
      return
    }
    // 静默刷新：写完之后的回读不把状态翻成 loading（否则整页会闪一次"加载中"）。
    if (!quiet) this.update({ status: 'loading', error: undefined })

    let result
    try {
      result = await channel.describe()
    } catch (error) {
      this.update({ status: 'failed', error: describeError(error) })
      return
    }
    if (!result.ok) {
      this.update({ status: 'failed', error: result.error.message })
      return
    }

    // 形状兜底：describe 少一个字段不该让页面永远停在"加载中…"。
    const namespaces = Array.isArray(result.value?.namespaces) ? result.value.namespaces : []
    if (!Array.isArray(result.value?.namespaces)) {
      this.update({ status: 'failed', error: '宿主返回的设置描述不完整（缺少命名空间列表）' })
      return
    }
    const view = namespaces.find((item) => item.ns === EVOLUTION_NAMESPACE)
    // 顶层配置：修订号（乐观并发）+ `modules.evolution` 当前值（设置表单的数据源）。
    const config = namespaces.find((item) => item.ns === 'humanity')
    if (config !== undefined) {
      const modules = (config.value as { modules?: { evolution?: unknown } } | undefined)?.modules
      this.update({ configRevision: config.revision, config: asEvolutionConfig(modules?.evolution) })
    }
    if (view === undefined) {
      this.update({ status: 'failed', writable: result.value.writable, error: '自进化命名空间尚未就绪' })
      return
    }
    this.adopt(view, result.value.writable)
  }

  /** 立即整理（增量）。 */
  async runNow(): Promise<void> {
    await this.dispatch('op:run', { op: 'run', id: '', mode: 'incremental', rescanKind: '', rescanValue: '' })
  }

  /** 做梦（梦境模式，长窗口）。 */
  async dream(): Promise<void> {
    await this.dispatch('op:dream', { op: 'run', id: '', mode: 'dream', rescanKind: '', rescanValue: '' })
  }

  /** 手动回扫（P-037 四档）。 */
  async rescan(selection: RescanSelection): Promise<void> {
    await this.dispatch('op:rescan', {
      op: 'rescan',
      id: '',
      mode: '',
      rescanKind: selection.kind,
      rescanValue: selection.kind === 'all' ? '' : selection.value,
    })
  }

  /** 批准一条提案（P-038：固定层/技能/路由都只能由用户在这里放行）。 */
  approve(id: string): Promise<boolean> {
    return this.dispatch('op:approve', { op: 'approve', id, mode: '', rescanKind: '', rescanValue: '' })
  }

  /** 拒绝一条提案（记录保留可查）。 */
  reject(id: string): Promise<boolean> {
    return this.dispatch('op:reject', { op: 'reject', id, mode: '', rescanKind: '', rescanValue: '' })
  }

  /** 删除一条提案记录。 */
  async delete(id: string): Promise<void> {
    await this.dispatch('op:delete', { op: 'delete', id, mode: '', rescanKind: '', rescanValue: '' })
  }

  /** 改调度/扫描/预算（写顶层 `humanity` 配置；宿主 onChanged 会立即重排定时器）。 */
  setEvolutionConfig(patch: Record<string, unknown>): Promise<void> {
    return this.sendConfig({ modules: { evolution: patch } })
  }

  // 技能编辑（M7）：三个动作共用同一组表单字段，宿主各自回一句如实结论。
  createSkill(draft: SkillDraftView): Promise<boolean> { return this.skillOp('skill-create', draft) }

  /** 修改一条已存在的技能（宿主带版本乐观锁写回）。 */
  updateSkill(draft: SkillDraftView): Promise<boolean> { return this.skillOp('skill-update', draft) }

  /** 停用 / 恢复（官方 disable-model-invocation；不是删除）。 */
  setSkillDisabled(name: string, disabled: boolean): Promise<boolean> {
    return this.skillOp(disabled ? 'skill-disable' : 'skill-enable', { name, description: '', content: '' })
  }

  private skillOp(op: string, draft: SkillDraftView): Promise<boolean> {
    // 四个通用字段留空：技能命令只带表单三字段（宿主按 op 分流）。
    return this.dispatch(`op:${op}`, {
      op, id: '', mode: '', rescanKind: '', rescanValue: '',
      skillName: draft.name, skillDescription: draft.description, skillContent: draft.content,
    })
  }

  private dispatch(busy: string, request: Record<string, string>): Promise<boolean> {
    return this.send(busy, EVOLUTION_NAMESPACE, { request }, this.state.revision)
  }

  /** 改顶层配置（命名空间与修订号都不同，单独一条路径）。 */
  private async sendConfig(patch: Record<string, unknown>): Promise<void> {
    await this.send('config', 'humanity', patch, this.state.configRevision)
  }

  /**
   * 统一写入路径：写补丁 → 静默重读。`busy` 只影响按钮禁用。
   * @returns 宿主是否收下（调用方据此决定要不要关掉表单、要不要提示失败）。
   */
  private async send(busy: string, ns: string, patch: Record<string, unknown>, revision: number | undefined): Promise<boolean> {
    const channel = this.channel
    if (channel === undefined) {
      this.update({ error: '暂时写不了（服务没接上）', busy: '' })
      return false
    }
    if (!this.state.writable) {
      this.update({ error: '当前设置只读，无法写入' })
      return false
    }
    this.update({ busy, error: undefined })

    let result
    try {
      result = await channel.update(ns, patch, revision)
    } catch (error) {
      this.update({ busy: '', error: describeError(error) })
      return false
    }
    if (!result.ok) {
      this.update({ busy: '', error: result.error.message })
      return false
    }
    this.update({ busy: '' })
    await this.load({ quiet: true })
    return true
  }

  /** 用宿主返回的一段值重建状态。 */
  private adopt(view: PersonaNamespaceView, writable: boolean): void {
    try {
      const document = asEvolutionDocument(view.value)
      this.update({ status: 'ready', writable, error: undefined, revision: view.revision, ...document })
    } catch (error) {
      this.update({ status: 'failed', writable: false, error: describeError(error) })
    }
  }
}

/** 把任意抛出物整理成一行可读原因。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
