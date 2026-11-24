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

/** 自进化工作台控制器。 */
export class EvolutionWorkbenchController {
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
  async open(date: string): Promise<boolean> {
    const channel = this.channel
    if (channel === undefined || date === '') return false
    try {
      // 与记忆同一条命令路：先重读（版本号可能旧了），再写命令槽。
      await this.load({ quiet: true })
      const outcome = await channel.replace(EVOLUTION_NAMESPACE, { ...this.state.doc, request: { op: 'open', date }, notice: '' }, this.revision)
      if (outcome.ok) this.revision = (outcome.value as { revision?: number } | undefined)?.revision ?? this.revision
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
      const value = (result as { ok?: boolean; value?: unknown; error?: unknown } | undefined)?.value
      if ((result as { ok?: boolean } | undefined)?.ok === false || value === undefined) {
        this.setState({ status: 'unavailable', doc: this.state.doc })
        return
      }
      this.revision = (value as { revision?: number }).revision
      this.setState({ status: 'ready', doc: asEvolutionDocument(value) })
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
