/**
 * 套件存储的生命周期接线：把领域接进 DSH 的 `storageDomain` seam。
 *
 * **为什么用 `ctx.inject(['storageDomain'], …)` 而不是 `ctx.get('storageDomain')`**：
 * `ctx.get` 是「此刻取一次」，只覆盖"插件加载时服务已经在"。服务若在插件之后才挂载，
 * `ctx.get` 版本会一次探测定终身 —— 永远不会打开领域，也永远不会重试；服务摘除时它也无从感知。
 * `ctx.inject` 把 attach / detach 整个生命周期交给 cordis：服务出现时执行回调、消失时执行我们
 * 返回的清理函数。与 `settings.ts` 是同一根因、同一改法。
 *
 * 打开是异步的，因此这里额外处理两种时序：
 * - **回调期间被卸载**：回调返回的清理函数会先置 `disposed`，异步打开完成后立即关闭，
 *   不让一个已经没人持有的领域一直占着名字；
 * - **打开失败**：降级为「本次无持久化」并留下日志，不抛出 —— 存储是派生能力，
 *   打不开不应该连带停掉对话和其余模块（G-002）。
 * @module humanity/store
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-storage-domain'

import type { Log } from './log.js'
import { openDomain } from './store-open.js'
import type { DomainFacility, HumanityStore } from './store-schema.js'

export { DOMAIN_NAME, DOMAIN_VERSION, HISTORY_TABLE, PERSONA_DATA_SCHEMA_VERSION } from './store-schema.js'
export type { HumanityStore } from './store-schema.js'

/**
 * 把套件存储接进 DSH 的存储领域 seam（生命周期与降级语义见文件头）。
 * @param ctx - 本插件的上下文。
 * @param log - 日志门面。
 * @param onReady - 领域打开成功后的回调（用于启动摘要）。同步执行，不会拿到未打开的句柄。
 */
export function installHumanityStore(
  ctx: Context,
  log: Log,
  onReady?: (store: HumanityStore) => void,
): void {
  ctx.inject(['storageDomain'], (sctx) => {
    // `ctx.inject` 回调里的服务是存在的，只是 `sctx` 的类型面由 cordis 提供，这里收回真实类型。
    const facility = sctx.storageDomain as DomainFacility
    log.info('存储领域服务已接入，正在打开套件存储')

    let store: HumanityStore | undefined
    let disposed = false

    void (async () => {
      const opened = await openDomain(facility, log)
      if (opened === undefined) return
      if (disposed) {
        // 卸载先于打开完成：直接关掉，别留下没人释放的领域。
        await opened.close()
        return
      }
      store = opened
      onReady?.(opened)
    })()

    // 服务摘除：释放领域（数据本身留在盘上），并让"等待中"的打开自我关闭。
    return () => {
      disposed = true
      log.info('存储领域服务已摘除，持久化已释放')
      void store?.close()
    }
  })
}
