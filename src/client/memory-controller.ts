/**
 * 记忆工作台的**状态机**：读投影、按关键词过滤、派发命令。
 *
 * 分层：投影采纳在 `memory-sync.ts`（含"本地改动不被旧读回冲掉"那条纪律），过滤在
 * `memory-view.ts`；这里只管"用户点了什么 → 发哪条命令"。对外形状与人格工作台一致
 * （`subscribe` / `getSnapshot` / `load`），界面用 `useSyncExternalStore` 订阅。
 * @module deepseek-harness-humanity/client/memory-controller
 */
import { MEMORY_NAMESPACE, type MemoryChannel, type MemoryOp, type MemoryRequest } from './memory-channel.js'
import type { MemoryAdvancedView, MemoryWorkbenchState } from './memory-document.js'
import { MemoryStateBase } from './memory-state.js'
import { ConfigWrites } from './memory-config.js'
import { readMemoryProjection, type PendingChanges } from './memory-sync.js'
import { filterEntries } from './memory-view.js'

export class MemoryWorkbenchController extends MemoryStateBase {
  private channel: MemoryChannel | undefined

  /** 本地改动（含义与"为什么必须有它"见 `memory-sync.ts` 文件头）。 */
  private pending: PendingChanges = {}

  /** 配置写入的本地流程（乐观 + 串行 + 失败回退；纪律见 `memory-sync.ts`）。 */
  private readonly config = new ConfigWrites({
    snapshot: () => this.state,
    update: (patch) => this.update(patch),
    pending: () => this.pending,
    // 串行由 `ConfigWrites` 自己保证（见那里的 queue），这里只是把写入落到 RPC 上。
    write: (busy, patch) => this.send(busy, patch),
    reload: () => this.load({ quiet: true }),
  })

  /**
   * 接上设置 RPC 并读一次。形状不对就整条通道判为不可用（缺 `update` 时不该等点按钮才炸）。
   * @param channel - 期望实现 `describe`/`update` 的通道。
   */
  attach(channel: MemoryChannel): void {
    this.channel =
      channel !== undefined &&
      channel !== null &&
      typeof channel.describe === 'function' &&
      typeof channel.update === 'function'
        ? channel
        : undefined
    void this.load()
  }

  /** 断开：回到"通道未就绪"，但保留已读到的列表（用户正在看的内容不该凭空消失）。 */
  detach(): void {
    this.channel = undefined
    this.update({ status: 'unavailable', writable: false, busy: '', configBusy: '' })
  }

  /**
   * 从宿主重新读取（重新加载）。**永不抛**：调用点在 useEffect 的异步链上。
   * @param options - `quiet`：静默刷新（写完之后的回读走这条）—— 不把状态翻成 `loading`，
   *   页面标题就不会闪出"正在读取…"（用户 2026-09-26 反馈的"闪屏"）；失败也只记错误。
   */
  async load(options: { quiet?: boolean } = {}): Promise<void> {
    const quiet = options.quiet === true
    const channel = this.channel
    if (channel === undefined) {
      this.update({ status: 'unavailable', writable: false })
      return
    }
    if (!quiet) this.update({ status: 'loading', error: undefined })
    const read = await readMemoryProjection(channel, this.pending)
    if (!read.ok) {
      this.update(quiet ? { error: read.error } : { status: 'failed', error: read.error })
      return
    }
    this.pending = read.pending
    this.update(read.patch)
  }

  /** 按关键词过滤后的列表（活跃 / 待确认 / 已归档三组，界面各取所需）。 */
  visible(status: string): MemoryWorkbenchState['entries'] {
    return filterEntries(this.state.entries, status, this.state.query)
  }

  /** 本地搜索框（纯客户端过滤，不问宿主）。 */
  setQuery(query: string): void {
    this.update({ query })
  }

  /** 切模式；实现见 `memory-sync.ts` 的 `ConfigWrites`（乐观 + 串行 + 失败回退）。 */
  setMode(mode: string): Promise<void> { return this.config.setMode(mode) }

  /** 改高级开关；实现同上（任何一项都意味着"用户要自己说了算"，会一并打开 customized）。 */
  setAdvanced(patch: Partial<MemoryAdvancedView>): Promise<void> { return this.config.setAdvanced(patch) }

  /** 手动跑一次记忆维护（衰减 + 归档）。 */
  runDecay(): Promise<void> { return this.dispatch('decay', '') }
  /** 清理全库的近似重复条目（判据与写入路径同一套）。 */
  dedupe(): Promise<void> { return this.dispatch('dedupe', '') }
  /** 撤销上一次合并（快照是宿主内存态：重启后宿主会答"没有可撤销的合并"）。 */
  undoDedupe(): Promise<void> { return this.dispatch('undo-dedupe', '') }

  /** 改归属：长期 ⇄ 区域（会话记忆也能借此升级成持久记忆）。 */
  rescope(fp: string, scope: string, ownerId: string): Promise<void> { return this.dispatch('rescope', fp, { scope, ownerId }) }

  /** 确认一条待确认记忆（T2 的"工作台端"，宿主会记下 `confirmedVia: 'workbench'`）。 */
  confirm(fingerprint: string): Promise<void> { return this.dispatch('confirm', fingerprint) }

  /** 拒绝一条待确认记忆（宿主直接删除）。 */
  reject(fingerprint: string): Promise<void> { return this.dispatch('reject', fingerprint) }

  /** 归档：默认检索不再命中，数据保留。 */
  archive(fingerprint: string): Promise<void> { return this.dispatch('archive', fingerprint) }

  /** 从归档恢复。 */
  restore(fingerprint: string): Promise<void> { return this.dispatch('restore', fingerprint) }

  /** 永久删除。 */
  remove(fingerprint: string): Promise<void> { return this.dispatch('remove', fingerprint) }

  /** 固定 / 取消固定（固定过的不参与自动衰减，P-026）。 */
  setPinned(fingerprint: string, pinned: boolean): Promise<void> { return this.dispatch(pinned ? 'pin' : 'unpin', fingerprint) }

  /** 派发一条命令：写进命令槽，等宿主执行并重新投影（界面不做乐观更新）。 */
  private async dispatch(op: MemoryOp, fingerprint: string, extra: Partial<MemoryRequest> = {}): Promise<void> {
    await this.send(`op:${op}`, { request: { op, fingerprint, ...extra } })
  }

  /**
   * 统一的写入路径：写补丁 → **静默**回读（不让整页闪一次 `loading`）。`busy` 只影响按钮禁用。
   * @param busy - 忙碌标记（同时决定写哪个命名空间）。
   * @param patch - 要合并的补丁。
   * @returns 是否写入成功（调用方据此决定要不要回滚本地乐观值）。
   */
  private async send(busy: string, patch: Record<string, unknown>): Promise<boolean> {
    const channel = this.channel
    if (channel === undefined) {
      this.update({ error: '暂时写不了（服务没接上）', busy: '', configBusy: '' })
      return false
    }
    if (!this.state.writable) {
      this.update({ error: '当前设置只读，无法写入' })
      return false
    }

    const isConfigWrite = busy === 'mode' || busy === 'advanced'
    const ns = isConfigWrite ? 'humanity' : MEMORY_NAMESPACE
    const revision = isConfigWrite ? this.state.configRevision : this.state.revision
    // 配置写入只亮自己的那一行：整页一起变灰就是用户看到的"闪一下"（见 configBusy 的说明）。
    this.update(isConfigWrite ? { configBusy: busy, error: undefined } : { busy, error: undefined })

    /** 清掉这次写入占着的标记（两种写入各清各的）。 */
    const clearBusy = isConfigWrite ? { configBusy: '' } : { busy: '' }
    let result
    try {
      result = await channel.update(ns, patch, revision)
    } catch (error) {
      this.update({ ...clearBusy, error: describeError(error) })
      return false
    }
    if (!result.ok) {
      this.update({ ...clearBusy, error: result.error.message })
      return false
    }
    this.update(clearBusy)
    await this.load({ quiet: true })
    return true
  }
}

/** 把任意抛出物整理成一行可读原因。 */
function describeError(error: unknown): string { return error instanceof Error ? error.message : String(error) }
