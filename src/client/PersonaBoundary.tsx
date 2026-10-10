import { Component, type ErrorInfo, type ReactNode } from 'react'

/** 出错时渲染的兜底内容（由调用方传入，保证"出错也不白屏、也不消失"）。 */
export interface PersonaBoundaryProps {
  children: ReactNode
  fallback: ReactNode
}

/** 边界自身的状态：只记"坏没坏"，不记错误对象（错误对象是活数据，不该进 React state）。 */
interface PersonaBoundaryState {
  failed: boolean
}

/**
 * 人格面板的**错误边界**。
 *
 * 为什么必须有它：DSH 的 Web 外壳在整帧上**没有**为我们兜底 —— 我们子树里任何一次渲染抛错，
 * React 18 会卸载**整个根**，用户看到的是"点一下会话，侧栏所有会话都不见了"
 * （2026-09-23 真机事故）。错误边界把后果限制在**我们自己那一块**：
 * 它显示一句中性说明，外壳、会话列表、对话区照常工作。
 *
 * 两条纪律：
 * 1. `componentDidCatch` 里**不许再抛**（React 会因此升级崩溃）；
 * 2. 兜底内容不依赖任何我们自己的状态（失败时那些状态可能正是问题来源）。
 */
export class PersonaBoundary extends Component<PersonaBoundaryProps, PersonaBoundaryState> {
  override state: PersonaBoundaryState = { failed: false }

  /** 子树的渲染错误 → 只翻自己的标志位。 */
  static getDerivedStateFromError(): PersonaBoundaryState {
    return { failed: true }
  }

  /** 记一条诊断，但绝不再抛。 */
  override componentDidCatch(error: Error, info: ErrorInfo): void {
    try {
      console.error('[humanity] 人格面板渲染失败，已就地兜底（外壳不受影响）', error, info?.componentStack)
    } catch {
      // 连日志都失败也要吞掉：这里唯一的职责是"不要抛"。
    }
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}
