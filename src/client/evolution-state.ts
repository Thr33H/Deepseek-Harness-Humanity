/**
 * 自进化工作台的**状态容器**：持有快照与订阅者，负责"换快照并通知"。
 *
 * 与 `memory-state.ts` 同一分层理由（那边文件头写得很全）：状态容器决定"界面看到什么、
 * 什么时候重渲染"，控制器决定"和宿主怎么说话"。不做跨模块的泛型基类——三家的状态形状
 * 与采纳规则各不相同，强行统一只会得到三边都要绕开的抽象。
 *
 * 订阅面同时服务两处 UI：工作台页面（`useSyncExternalStore`）与侧栏图标的红点
 * （徽标计数变化也走同一个通知链，P-042）。
 * @module deepseek-harness-humanity/client/evolution-state
 */
import { emptyEvolutionState, type EvolutionWorkbenchState } from './evolution-document.js'

/** 自进化工作台的状态容器基类。 */
export abstract class EvolutionStateBase {
  protected state: EvolutionWorkbenchState = emptyEvolutionState()

  private readonly listeners = new Set<() => void>()

  /** 订阅状态变化；返回退订函数（直接交给 `useSyncExternalStore`）。 */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 当前快照。引用稳定：只有 `update()` 会换对象。 */
  readonly getSnapshot = (): EvolutionWorkbenchState => this.state

  /** 换一个新状态对象并通知订阅者。 */
  protected update(patch: Partial<EvolutionWorkbenchState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
}
