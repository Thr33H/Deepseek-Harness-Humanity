/**
 * 情绪工作台的控制器：**只读**。
 *
 * 为什么没有 commands / 草稿 / 保存：情绪由事件与时间推动，不由人手动拨。
 * 工作台在这里是观察窗——能不能看懂"它现在什么心情、为什么"，比能不能改它更重要。
 * （所以本文件没有 `update` 路径，也没有乐观并发那套东西。）
 *
 * 状态机的形状与另外三个工作台一致（`attach` / `detach` / `load` / `subscribe` / `getSnapshot`），
 * 这样 `attachRemoteController` 不必为它写第二个版本。
 * @module deepseek-harness-humanity/client/emotion-controller
 */
import { asEmotionDocument, EMOTION_NAMESPACE, type EmotionDocument } from './emotion-channel.js'
import type { PlaneChannel } from './plane-channel.js'

/** 工作台看到的状态。 */
export type EmotionStatus = 'unavailable' | 'loading' | 'ready' | 'failed'

/** 一次读取的快照（`useSyncExternalStore` 要求引用稳定，所以整体替换、不就地改）。 */
export interface EmotionSnapshot {
  status: EmotionStatus
  /** 读到了才存在（`ready`）。 */
  document?: EmotionDocument
  /** `failed` 时的原因。 */
  error?: string
}

/**
 * 情绪工作台控制器。
 *
 * 任何失败都收敛成状态字段，**从不抛**：它的调用点是一个 React 渲染路径与一个 cordis 回调，
 * 抛出去分别是白屏与客户端插件异常。
 */
export class EmotionWorkbenchController {
  private channel: PlaneChannel | undefined
  private readonly listeners = new Set<() => void>()
  private snapshot: EmotionSnapshot = { status: 'unavailable' }

  /**
   * 接上通道并读一次。
   * @param channel - 期望实现 `describe`；形状不对一律按"没有通道"处理（只显示未就绪）。
   */
  attach(channel: PlaneChannel): void {
    this.channel =
      channel !== undefined && channel !== null && typeof channel.describe === 'function'
        ? channel
        : undefined
    void this.load()
  }

  /** 断开：回到"未就绪"，但保留上一次读到的内容（服务重连时界面不会闪成空白）。 */
  detach(): void {
    this.channel = undefined
    this.set({ ...this.snapshot, status: 'unavailable' })
  }

  /**
   * 从宿主重读一次。
   * @param options - `quiet`：不切到 loading（后台刷新用，避免界面闪一下）。
   */
  async load(options?: { quiet?: boolean }): Promise<void> {
    const channel = this.channel
    if (channel === undefined) {
      this.set({ status: 'unavailable' })
      return
    }
    if (options?.quiet !== true) this.set({ status: 'loading', document: this.snapshot.document })

    let result
    try {
      result = await channel.describe()
    } catch (error) {
      this.set({ status: 'failed', error: error instanceof Error ? error.message : String(error) })
      return
    }
    if (result === undefined || result === null || result.ok !== true) {
      this.set({ status: 'failed', error: result?.error?.message ?? '宿主没有返回可用的数据' })
      return
    }

    const namespaces = Array.isArray(result.value?.namespaces) ? result.value.namespaces : []
    const view = namespaces.find((entry) => entry?.ns === EMOTION_NAMESPACE)
    if (view === undefined) {
      // 命名空间不在 = 宿主那一半没挂上（或模块被关掉）。显示"未就绪"，不编一份默认状态。
      this.set({ status: 'unavailable' })
      return
    }
    this.set({ status: 'ready', document: asEmotionDocument(view.value) })
  }

  /** 订阅快照变化；返回退订。 */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 读快照（引用稳定）。 */
  readonly getSnapshot = (): EmotionSnapshot => this.snapshot

  /** 替换快照并通知订阅者。 */
  private set(next: EmotionSnapshot): void {
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }
}
