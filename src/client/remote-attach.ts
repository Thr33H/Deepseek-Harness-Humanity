/**
 * 客户端与宿主之间的**通道接线**（从 `index.ts` 拆出：那边只管"注册什么"，这里管"怎么接上"）。
 *
 * 两件事：
 * - {@link subscribeToProjection}：订阅 `settings/document-updated`，宿主投影写完后重读；
 * - {@link attachRemoteController}：把任意一个工作台控制器接到设置 RPC（含真机踩坑的
 *   `remote.settings` 注入纪律）。
 * @module deepseek-harness-humanity/client/remote-attach
 */
import type { Context } from '@deepseek-ai/cordis'

import { createPlaneChannel, type RpcCaller } from './plane-channel.js'

/**
 * 订阅宿主转发的事件，**宿主写完之后重读一次**。
 *
 * 为什么必须订阅，而不是"客户端写完立刻 load"：
 * - 人格是直写命名空间，客户端写完后立刻读是对的；
 * - 记忆/自进化是**两段式**——客户端只把命令放进命令槽（`request`），宿主消费完才更新
 *   投影字段并清空命令槽。客户端 `update()` 返回时宿主多半还没消费完，此时立刻 `load()`
 *   读到的是中间态（真机症状：点按钮有反应、列表不变）。
 * 宿主每次投影都会 emit `settings/document-updated`，这正是"第二段写完了"的确定信号
 * （第一方 `dsh-client-ui-settings` 用的是同一个事件）。拿不到这个 API 时退化为"不自动刷新"，
 * 工作台仍可手动重载 —— 绝不因为没有它就抛。
 * @param remote - 客户端 `ctx.remote`。
 * @param namespaces - 只在这些命名空间变化时重读（避免无关设置写入引发刷新风暴）。
 * @param reload - 重读动作。
 * @returns 取消订阅；不可用时是空操作。
 */
export function subscribeToProjection(
  remote: unknown,
  namespaces: readonly string[],
  reload: () => void,
): () => void {
  const events = remote as { $on?: (event: string, listener: (ns: string) => void) => () => void } | undefined
  if (events === undefined || typeof events.$on !== 'function') return () => {}
  try {
    return events.$on('settings/document-updated', (ns: string) => {
      if (namespaces.includes(ns)) reload()
    })
  } catch (error) {
    // 订阅失败只是"不自动刷新"，手动重载仍然可用；抛出去会让整块 UI 消失。
    console.error('[humanity] 设置变更订阅失败，工作台将不会自动刷新', error)
    return () => {}
  }
}

/**
 * 把一个工作台控制器接上设置 RPC。
 *
 * ⚠️ **必须注入命名空间服务 `remote.settings` 本身，不能只注入父服务 `remote`。** 真机踩过一次：
 * - `ctx.remote` 由 `dsh-api-gateway` 的客户端半边**同步**提供，而各命名空间（`remote.settings`）
 *   是 `dsh-api-remotes` 的 `apply()` 里 `await ctx.remote.$mount(contribution)` **异步逐个挂**的；
 * - 只注入 `remote` 时，回调在父服务一出现就跑，此刻 `sctx.remote.settings` 还是 `undefined`
 *   ⇒ 工作台永远显示「命名空间未就绪」（服务端其实一切正常）；
 * - `ctx.remote.settings` 这种"点号访问"由 cordis 的 traceable 代理按
 *   `ctx.reflect.props['remote.settings']` 解析，**调用方必须自己声明这个依赖**
 *   （`dsh-api-gateway` 源码原话：*"every caller declare `remote.settings` in its own `inject`"*）。
 *
 * 注入之后：命名空间没挂上时回调**不跑**（不抢跑），挂上即触发；卸载时走返回的清理函数。
 * 同时订阅宿主的 `settings/document-updated`：两段式写入（宿主消费完命令才投影），
 * 没有这个事件就只能靠客户端"写完立刻读"的中间态（真机症状：点按钮有反应、列表不变）。
 * @param ctx - 客户端根上下文。
 * @param controller - 人格 / 记忆 / 自进化工作台控制器（形状一致）。
 * @param namespace - 该控制器关心的设置命名空间。
 * @param label - 日志里用的中文名。
 */
export function attachRemoteController<C>(
  ctx: Context,
  controller: { attach(channel: C): void; detach(): void; load(options?: { quiet?: boolean }): Promise<void> },
  namespace: string,
  label: string,
): void {
  // 0.1.7 起走**自有数据面**：`connection.rpc.call('/api', 'humanity/<method>', { args })`。
  // 为什么不再注入 `remote.settings`：那个命名空间在 0.1.7 已变成"配置表单"语义面
  // （命名空间 = Loader 条目 id），我们四个命名空间不在其中（详见 `plane-channel.ts` 文件头）。
  ctx.inject(['connection'], (sctx) => {
    // 读取这一句本身也可能抛（服务在解析与读取之间被摘除）。包住：
    // 这里抛出去是客户端 cordis 回调里的异常，代价远大于"这轮没接上"。
    try {
      const connection = (sctx as unknown as { connection: { rpc: RpcCaller } }).connection
      controller.attach(createPlaneChannel(connection.rpc) as C)
    } catch (error) {
      console.error(`[humanity] ${label}通道接入失败，将显示为未就绪`, error)
      controller.detach()
      return
    }
    // 通道就绪后立刻读一次：旧实现靠官方转发的 `settings/document-updated` 事件驱动重读，
    // 而第三方没有事件推送 seam（清单写死在 `dsh-api-remotes`），所以改为
    // ①每次写入的返回值就是最新投影（`plane-channel.ts` 的 settle），②这里补一次首读。
    void controller.load({ quiet: true })
    return () => {
      controller.detach()
    }
  })
}
