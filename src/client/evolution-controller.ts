/**
 * 自进化工作台控制器。
 *
 * 对外形状与人格/记忆工作台一致（`subscribe` / `getSnapshot` / `load` / `attach`），
 * 外加一个动作：`open(date)` —— 翻开某一天的日记。**执行权在宿主**，客户端只把命令写进命名空间。
 * @module deepseek-harness-humanity/client/evolution-controller
 */
import {
  asEvolutionDocument,
  emptyEvolutionDocument,
  EVOLUTION_NAMESPACE,
  type EvolutionChannel,
  type EvolutionDocument,
} from './evolution-channel.js'

/** 工作台状态。 */
export interface EvolutionWorkbenchState {
  /** `idle` 还没读；`ready` 读到了；`unavailable` 通道没接上。 */
  status: 'idle' | 'ready' | 'unavailable'
  doc: EvolutionDocument
}

/**
 * 把一次性传输变成浏览器的一次下载。
 *
 * 为什么不用 `Buffer`/`atob` 之外的东西：这里是浏览器 bundle，只有 Web API；
 * 不在浏览器里（单元测试的 Node 环境）时直接返回 `false`，不抛。
 * @param transfer - 宿主下发的文件。
 * @returns 是否真的触发了下载。
 */
function saveTransfer(transfer: { name: string; mime: string; base64: string }): boolean {
  if (typeof document === 'undefined' || typeof atob !== 'function') return false
  try {
    const binary = atob(transfer.base64)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    const blob = new Blob([bytes], { type: transfer.mime === '' ? 'application/octet-stream' : transfer.mime })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = transfer.name
    anchor.click()
    URL.revokeObjectURL(url)
    return true
  } catch {
    return false
  }
}

/** 自进化工作台控制器。 */export class EvolutionWorkbenchController {
  private channel: EvolutionChannel | undefined
  /** 命名空间当前修订号：写回必须带上（并发保护）。 */
  private revision: number | undefined
  private listeners = new Set<() => void>()
  private state: EvolutionWorkbenchState = { status: 'idle', doc: emptyEvolutionDocument() }

  /** 订阅状态变化；返回退订动作。 */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 当前快照（也用作服务端快照：两边读同一个对象）。 */
  readonly getSnapshot = (): EvolutionWorkbenchState => this.state

  /** 接上通道并读一次；形状不对就整条通道判为不可用。 */
  attach(channel: EvolutionChannel): void {
    this.channel =
      channel !== undefined && channel !== null && typeof channel.describe === 'function' ? channel : undefined
    void this.load()
  }

  /** 通道断开（宿主摘除远端）：回到"读不到"，不清掉已经渲染的内容。 */
  detach(): void {
    this.channel = undefined
    this.setState({ status: 'unavailable', doc: this.state.doc })
  }

  /**
   * 翻开某一天的日记。
   *
   * 客户端只写命令；宿主决定能不能给、并把结果写回通知（见宿主的 `section.ts`）。
   * @param date - 哪一天（YYYY-MM-DD）。
   * @returns 命令是否写出去。
   */
  /**
   * 改「一天最多醒几次」。
   *
   * 写的是套件配置（`humanity` 命名空间的 `modules.evolution`）；宿主若拒绝，会以通知形式说明原因。
   * @param value - 0–24 的整数。
   * @returns 命令是否写出去。
   */
  async setWakeCap(value: number): Promise<boolean> {
    const channel = this.channel
    if (channel === undefined) return false
    try {
      await this.load({ quiet: true })
      const outcome = await channel.replace(
        EVOLUTION_NAMESPACE,
        { ...this.state.doc, request: { op: 'cap', date: String(value) }, notice: '' },
        this.revision,
      )
      if (outcome.ok) this.revision = (outcome.value as { value?: { revision?: number } } | undefined)?.value?.revision ?? this.revision
      await this.load({ quiet: true })
      return outcome.ok === true
    } catch {
      return false
    }
  }

  /**
   * 下载她目录里的一个文件。
   *
   * 宿主把字节放进**一次性**的 `transfer` 里下发（数据面只有三个方法，新开一条下载路由要动协议）；
   * 客户端把它变成 Blob 交给浏览器。拿不到就返回 false，不假装成功。
   * @param name - 文件名。
   * @returns 是否真的交出了一个文件。
   */
  async download(name: string): Promise<boolean> {
    const channel = this.channel
    if (channel === undefined || name === '') return false
    try {
      await this.load({ quiet: true })
      const outcome = await channel.replace(
        EVOLUTION_NAMESPACE,
        { ...this.state.doc, request: { op: 'read', date: name }, notice: '' },
        this.revision,
      )
      if (outcome.ok !== true) return false
      this.revision = (outcome.value as { value?: { revision?: number } } | undefined)?.value?.revision ?? this.revision
      await this.load({ quiet: true })
      const transfer = this.state.doc.transfer
      if (transfer.name !== name || transfer.base64 === '') return false
      return saveTransfer(transfer)
    } catch {
      return false
    }
  }

  async open(date: string): Promise<boolean> {
    const channel = this.channel
    if (channel === undefined || date === '') return false
    try {
      // 与记忆同一条命令路：先重读（版本号可能旧了），再写命令槽。
      await this.load({ quiet: true })
      const outcome = await channel.replace(EVOLUTION_NAMESPACE, { ...this.state.doc, request: { op: 'open', date }, notice: '' }, this.revision)
      if (outcome.ok) this.revision = (outcome.value as { value?: { revision?: number } } | undefined)?.value?.revision ?? this.revision
      if (outcome.ok !== true) return false
      await this.load({ quiet: true })
      return true
    } catch {
      return false
    }
  }

  /**
   * 读一次投影。
   * @param options - `quiet` 不把状态翻成 `idle`（刷新时不闪）。
   */
  async load(options: { quiet?: boolean } = {}): Promise<void> {
    const channel = this.channel
    if (channel === undefined) {
      this.setState({ status: 'unavailable', doc: this.state.doc })
      return
    }
    try {
      const result = await channel.describe()
      /**
       * `describe()` 返回的是**所有命名空间的列表**，不是我们这一个。
       *
       * 真机 2026-11-24：这里被当成"单个命名空间的值"来解，于是永远读到空 ——
       * 页面一直显示"暂时读不到"，而宿主那边什么都有。
       */
      const envelope = (result as { ok?: boolean; value?: { namespaces?: readonly { ns?: string; value?: unknown; revision?: number }[] } } | undefined)
      const namespaces = envelope?.value?.namespaces ?? []
      const view = namespaces.find((candidate) => candidate.ns === EVOLUTION_NAMESPACE)
      if (envelope?.ok === false || view === undefined) {
        this.setState({ status: 'unavailable', doc: this.state.doc })
        return
      }
      this.revision = view.revision
      this.setState({ status: 'ready', doc: asEvolutionDocument(view.value) })
    } catch {
      if (options.quiet === true) return
      this.setState({ status: 'unavailable', doc: this.state.doc })
    }
  }

  /** 推一个新状态给订阅者。 */
  private setState(next: EvolutionWorkbenchState): void {
    this.state = next
    for (const listener of this.listeners) listener()
  }
}
