/**
 * 记忆工作台的**状态机**：读投影、保持快照、对外提供订阅。
 *
 * 除了 `load()`（重新读一次命名空间），对外只有两个动作：`reveal()`（看秘密）与
 * `remove()`（删掉一条）。两者都只是把命令写进命名空间，**执行权在宿主**；
 * 对外形状与人格工作台一致（`subscribe` / `getSnapshot` / `load` / `attach` / `detach`），
 * 所以 `client/index.ts` 的接线一行都不用改。
 * @module deepseek-harness-humanity/client/memory-controller
 */
import { MEMORY_NAMESPACE, type MemoryChannel } from './memory-channel.js'
import {
  asMemoryDocument,
  emptyMemoryDocument,
  type MemoryWorkbenchState,
} from './memory-document.js'

/** 记忆工作台控制器。 */
export class MemoryWorkbenchController {
  private channel: MemoryChannel | undefined
  /** 命行空间当前修订号：写回必须带上，否则并发时会被拒。 */
  private revision: number | undefined
  private listeners = new Set<() => void>()
  private state: MemoryWorkbenchState = { status: 'idle', doc: emptyMemoryDocument() }

  /** 订阅状态变化；返回退订动作。 */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 当前快照（也用作服务端快照：两边读的是同一个对象）。 */
  readonly getSnapshot = (): MemoryWorkbenchState => this.state

  /** 接上设置 RPC 并读一次。形状不对就整条通道判为不可用。 */
  attach(channel: MemoryChannel): void {
    this.channel =
      channel !== undefined && channel !== null && typeof channel.describe === 'function' ? channel : undefined
    void this.load()
  }

  /**
   * 越过门槛查看一条秘密。
   *
   * 客户端只把命令写进命名空间，**真正执行的权力在宿主**（`section-runtime` 的 `consume`）——
   * 这样"谁写了什么"和"谁有权执行"是分开的。
   * @param id - 要看的那条。
   * @returns 是否成功把命令写出去。
   */
  async reveal(id: string): Promise<boolean> {
    return this.command('reveal', id)
  }

  /**
   * 删掉一条记忆。
   *
   * 不可撤销，所以界面上要先问一次再确认一次；这里只负责把命令送出去。
   * @param id - 要删的那条。
   * @returns 是否成功把命令写出去。
   */
  async remove(id: string): Promise<boolean> {
    return this.command('delete', id)
  }

  /**
   * 把一条命令写进命名空间（执行权在宿主，见 `section-runtime` 的 `consume`）。
   *
   * ### 为什么要"先重读、撞了再重读"
   *
   * 命名空间是**乐观并发**：写回时要带"我读到的是第几版"。可这份文档在对话进行中一直在变
   * （每轮回忆都会更新投影），而页面是 30 秒前读的 —— 用户点"我要看"时版本号已经旧了，
   * 宿主的拒绝理由就是「修订号对不上」（2026-11-23 真机现场）。
   *
   * 所以：写之前先重读一次拿最新版本；万一这中间又变了（对话与点击同时发生），再重读重试一次。
   * 重试仍然失败才报错 —— 一次点击失败不该把整页打成"读不到"。
   */
  private async command(op: string, id: string): Promise<boolean> {
    const channel = this.channel
    if (channel === undefined || typeof channel.replace !== 'function') return false
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        // 第一次也重读：页面里的版本号可能已经是几十秒前的了。
        await this.load({ quiet: true })
        if (this.state.status !== 'ready') {
          this.update({ status: 'failed', error: this.state.error ?? '读取失败' })
          return false
        }
        const outcome = await channel.replace(
          MEMORY_NAMESPACE,
          { ...this.state.doc, request: { op, id }, notice: '' },
          this.revision,
        )
        if (outcome.ok) {
          this.revision = outcome.value.revision
          return true
        }
        const message = outcome.error?.message ?? '写入失败'
        // 只有"版本对不上"值得重试：别的错误重试也没用，直接如实报出来。
        // 认三种写法：宿主的「修订号对不上」、设置层的 `settings/conflict`、以及英文 `revision`。
        if (!/修订|revision|conflict/i.test(message)) {
          this.update({ status: 'failed', error: message })
          return false
        }
      }
      this.update({ status: 'failed', error: '记忆正在被对话更新，这次没写进去，请再点一次' })
      return false
    } catch (error) {
      this.update({ status: 'failed', error: error instanceof Error ? error.message : String(error) })
      return false
    }
  }

  /** 断开：回到"通道未就绪"。已读到的内容不清空（用户正在看的东西不该凭空消失）。 */
  detach(): void {
    this.channel = undefined
    this.update({ status: 'unavailable', error: undefined })
  }

  /**
   * 从宿主重新读一次。**永不抛**：调用点在 `useEffect` 的异步链上。
   * @param options - `quiet`：静默刷新（不把状态翻成 `loading`，页面标题就不会闪）。
   */
  async load(options: { quiet?: boolean } = {}): Promise<void> {
    const quiet = options.quiet === true
    const channel = this.channel
    if (channel === undefined) {
      this.update({ status: 'unavailable', error: undefined })
      return
    }
    if (!quiet) this.update({ status: 'loading', error: undefined })
    try {
      const outcome = await channel.describe()
      if (!outcome.ok) {
        this.update({ status: 'failed', error: outcome.error?.message ?? '读取失败' })
        return
      }
      const view = outcome.value.namespaces.find((item) => item.ns === MEMORY_NAMESPACE)
      if (view === undefined) {
        // 命名空间还没注册（宿主没起来 / 插件版本不匹配）：如实说"读不到"，不要说"没有记忆"。
        this.update({ status: 'unavailable', doc: emptyMemoryDocument(), error: undefined })
        return
      }
      this.revision = view.revision
      this.update({ status: 'ready', doc: asMemoryDocument(view.value), error: undefined })
    } catch (error) {
      this.update({ status: 'failed', error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** 合并一次状态并通知订阅者。 */
  private update(patch: Partial<MemoryWorkbenchState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
}
