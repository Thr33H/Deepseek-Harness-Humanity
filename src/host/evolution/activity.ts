/**
 * 空闲检测：监听 `agent/status`（idle⇄running），维护"最后一次活动"与"是否有活跃 agent"。
 *
 * 事实来源（编译 `dsh-agent/lib/types/runtime-types.d.ts:239-252`）：事件 payload 是
 * `{agent, status}`，`status` 是转入态。按**结构**监听、不声明任何依赖——与
 * `memory/inject.ts` 监听 `agent/inbox/claimed` 同一纪律（`agents` 事故的教训）。
 *
 * 语义取舍：
 * - "活动"= 任何一次状态翻转（开始跑或跑完都算）；
 * - 进程重启后从**装配时刻**起算空闲：重启前的活动时间无从得知，把重启当作一次活动
 *   最保守（不会在启动瞬间就把整理跑起来）；
 * - agent 被处置时从运行集合移除：否则一个崩溃的 agent 会让 `hasRunning` 永远为真，
 *   定时触发被无限推迟（P-035 的暂停条款就成了永久停摆）。
 * @module humanity/evolution/activity
 */
import type { Context } from '@deepseek-ai/cordis'

/** 空闲/忙碌事实的读取面。 */
export interface ActivityTracker {
  /** 最后一次 agent 状态翻转的 epoch 毫秒（装配时刻为初值）。 */
  lastActivityAt(): number
  /** 是否有任何 agent 正在运行。 */
  hasRunning(): boolean
}

/** `agent/status` 事件 payload 的结构读取（缺字段一律按"不动"处理）。 */
interface StatusPayload {
  agent?: unknown
  status?: unknown
}

/**
 * 装上活动追踪器。
 * @param ctx - 插件上下文（事件监听随 fiber 自动清理，这里仍返回显式卸载动作供模块复用）。
 * @param now - 时钟注入点（测试用）。
 * @returns 读取面 + 卸载动作。
 */
export function installActivityTracker(ctx: Context, now: () => number = Date.now): ActivityTracker & { dispose(): void } {
  let lastActivity = now()
  const running = new Set<object>()

  const on = ctx.on as unknown as (name: string, listener: (payload: unknown) => void) => () => void
  const disposeStatus = on('agent/status', (payload) => {
    const { agent, status } = (payload ?? {}) as StatusPayload
    lastActivity = now()
    if (agent === null || typeof agent !== 'object') return
    if (status === 'running') running.add(agent)
    else if (status === 'idle') running.delete(agent)
  })
  const disposeDisposed = on('agent/disposed', (payload) => {
    const { agent } = (payload ?? {}) as StatusPayload
    if (agent !== null && typeof agent === 'object') running.delete(agent)
  })

  return {
    lastActivityAt: () => lastActivity,
    hasRunning: () => running.size > 0,
    dispose: () => {
      disposeStatus()
      disposeDisposed()
    },
  }
}
