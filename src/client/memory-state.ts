/**
 * 记忆工作台的**状态容器**：持有快照与订阅者，负责"换快照并通知"。
 *
 * 与人格工作台（`persona-state.ts`）同一个理由分层：状态容器决定"界面看到什么、什么时候重渲染"，
 * 控制器决定"和宿主怎么说话"。两者分开后，控制器里只剩远程调用与用户操作。
 *
 * 为什么不做成两边共用的泛型基类：两边的状态形状与"采纳远端值"的规则完全不同（人格是文档 + 草稿 +
 * 校验问题，记忆是列表 + 策略 + 命令回执），强行统一只会得到一个两边都要绕开的抽象。
 * @module deepseek-harness-humanity/client/memory-state
 */
import { emptyMemoryState, type MemoryWorkbenchState } from './memory-document.js'

/** 记忆工作台的状态容器基类。 */
export abstract class MemoryStateBase {
  protected state: MemoryWorkbenchState = emptyMemoryState()

  private readonly listeners = new Set<() => void>()

  /** 订阅状态变化；返回退订函数（直接交给 `useSyncExternalStore`）。 */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 当前快照。引用稳定：只有 `update()` 会换对象。 */
  readonly getSnapshot = (): MemoryWorkbenchState => this.state

  /** 换一个新状态对象并通知订阅者。 */
  protected update(patch: Partial<MemoryWorkbenchState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
}
