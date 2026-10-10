/**
 * **数据面版的"设置服务"**：把 `installSection` 那条契约原样实现在我们自己的存储上。
 *
 * ### 为什么要有它
 *
 * 0.1.5 上三个工作台命名空间（`humanity-persona` / `humanity-memory` / `humanity-evolution`）
 * 与模块开关 `humanity` 都注册在 DSH 的 settings 服务上；0.1.7 把 settings 重构成"配置表单"
 * （命名空间 = Loader 条目 id、值 = 该条目 Config 的投影），`installSection / get / setSource`
 * 全被删除。我们的四个命名空间在新版本里**没有归属**，于是数据面必须自己做。
 *
 * 本模块的作用是**把改动面收在一处**：各 section 仍然只认四件事 ——
 * `get` / `replace` / `update` / `installSection(ctx, ns, schema, base, hooks)`，
 * 只是当官方 settings 不再提供动态命名空间时，这四件事由这里实现（文档落盘 + 数据面 endpoint）。
 * 于是 section 的业务逻辑、校验钩子、命令槽语义**一行都不用改**。
 *
 * ### 与官方契约的对应关系（逐条对齐，别"顺手简化"）
 *
 * | 官方行为 | 这里 |
 * |---|---|
 * | `installSection` 注册命名空间后，`get(ns)` 能读到"schema 默认 → 组合配置 → 用户覆盖" | `get(ns)` = 已落盘文档，没有则读 `base`（= 组合配置那层） |
 * | `validate(value)` 在写入前调用，抛错即拒绝本次写入 | 同：先 `validate` 再落盘 |
 * | `setSource(read)` 在 attach / detach 时回调 | 同：attach 时给一次读取闭包 |
 * | `onChange()` 在**提交成功后**触发（attach 时也立刻触发一次） | 同 |
 * | 未知命名空间写入被拒 | 同：`DataPlaneRejected` |
 *
 * ### 修订号
 *
 * 客户端拿到的 `revision` 来自文档表（每次写入 +1）；`expectedRevision` 对不上就拒绝，
 * 与官方 settings 的乐观并发语义一致（工作台两段式写入依赖它）。
 * @module humanity/plane-settings
 */
import type { Context } from '@deepseek-ai/cordis'

import type { DataNamespace, DataPlane } from './data-plane.js'
import { DataPlaneRejected } from './data-plane.js'
import type { DocumentStore } from './documents.js'
import { mergeDocument } from './documents.js'
import type { Log } from './log.js'

/**
 * 注册钩子。形状与官方 `installSection` 的第五个参数一致，只保留我们真正用到的三个。
 *
 * 全部可选：官方契约里它们也是可选的，而我们的调用方有的只关心 `validate`。
 */
export interface SectionHooks {
  /** attach 时回调一次，交给我们一个"怎么读当前值"的闭包。 */
  setSource?: (read: () => unknown) => void
  /** 写入前校验；抛错即拒绝。 */
  validate?: (value: unknown) => void
  /** 提交成功后回调（attach 时也立刻触发一次）。 */
  onChange?: (current: unknown) => void
}

/**
 * 各 section 需要的**那一小片**设置服务面。
 *
 * 官方 `SettingsProvider` 结构上满足它（`get` / `replace` / `update` / `installSection`），
 * 因此同一份 section 代码在两条路径上都能跑；本模块提供的是 0.1.7 那条实现。
 */
export interface SectionSettings {
  /** 读当前生效值；没写过时返回 `undefined`（调用方自己回退到默认值）。 */
  get(ns: string): unknown
  /** 整份替换。 */
  replace(ns: string, value: Record<string, unknown>): Promise<void>
  /** 深合并补丁。 */
  update(ns: string, patch: Record<string, unknown>): Promise<void>
  /** 注册命名空间到数据面（= 官方 `installSection`）。 */
  installSection(ctx: Context, ns: string, schema: unknown, base: unknown, hooks?: SectionHooks): void
}

/** 一个命名空间的接线记录。 */
interface Mounted {
  base: unknown
  hooks: SectionHooks
  revision(): number
}

/**
 * 进程内的接线单例。
 *
 * 为什么用单例而不是把它一路当参数穿到每个 section：三个 section 各自在
 * `ctx.inject(['settings'], …)` 回调里决定"用官方还是用我们自己的"，那条回调的签名由 cordis
 * 决定、改不了；而这份实现是**每插件实例一份**的基础设施（不是业务依赖），
 * 穿参要改 3 个 section + 3 个模块入口 + deps，收益只有"少一个模块级变量"。
 * 接线在 `index.ts` 的 `apply()` 里完成，早于任何 section 的 attach。
 */
let installed: SectionSettings | undefined

/**
 * 登记进程内使用的数据面版设置服务（由 `index.ts` 在装配时调用一次）。
 * @param settings - 待登记的实现。
 */
export function installPlaneSettings(settings: SectionSettings): void {
  installed = settings
}

/** 取登记过的实现；数据面缺席时为 `undefined`（各 section 据此保留"降级 + 明确日志"的老行为）。 */
export function fallbackSettings(): SectionSettings | undefined {
  return installed
}

/**
 * 造一份数据面版设置服务。
 * @param plane - 数据面（endpoint 的宿主）。
 * @param documents - 文档表句柄；存储未就绪时返回 `undefined`（读回退到 `base`，写显式报错）。
 * @param log - 日志门面。
 * @returns 可直接交给各 section 的 `SectionSettings`。
 */
export function createPlaneSettings(
  plane: DataPlane,
  documents: () => DocumentStore | undefined,
  log: Log,
): SectionSettings {
  const mounted = new Map<string, Mounted>()

  const readRecord = (ns: string): { value: unknown; revision: number } | undefined => {
    const store = documents()
    if (store === undefined) return undefined
    const record = store.read(ns)
    return record === undefined ? undefined : { value: record.value, revision: record.revision }
  }

  const get = (ns: string): unknown => {
    const live = readRecord(ns)
    if (live !== undefined) return live.value
    return mounted.get(ns)?.base
  }

  /** 写入前的公共路径：校验 → 落盘 → 通知。存储没就绪时**显式报错**（不静默丢写）。 */
  const write = async (ns: string, value: unknown, expectedRevision: number | undefined): Promise<void> => {
    const entry = mounted.get(ns)
    if (entry === undefined) throw new DataPlaneRejected(`数据面没有命名空间 ${JSON.stringify(ns)}（未注册）`)
    const store = documents()
    if (store === undefined) throw new DataPlaneRejected(`存储未就绪，${ns} 本次无法写入（不是数据丢失，请稍后重试）`)

    const current = store.read(ns)?.revision ?? 0
    if (expectedRevision !== undefined && expectedRevision !== current) {
      throw new DataPlaneRejected(`${ns} 的修订号对不上（读到 ${String(expectedRevision)}，当前 ${String(current)}），请重读后再写`)
    }
    entry.hooks.validate?.(value)
    await store.write(ns, value)
    entry.hooks.onChange?.(value)
  }

  return {
    get,
    replace: (ns, value) => write(ns, value, undefined),
    update: async (ns, patch) => {
      const before = get(ns)
      const merged = mergeDocument(before, patch)
      await write(ns, merged, undefined)
    },
    installSection: (ctx, ns, _schema, base, hooks = {}) => {
      if (mounted.has(ns)) throw new Error(`数据面命名空间 ${ns} 已被注册`)

      const namespace: DataNamespace = {
        ns,
        view: () => ({ value: get(ns) ?? base, revision: readRecord(ns)?.revision ?? 0 }),
        replace: (value, expectedRevision) => write(ns, value, expectedRevision),
        update: async (patch, expectedRevision) => {
          const merged = mergeDocument(get(ns) ?? base, patch)
          await write(ns, merged, expectedRevision)
        },
      }
      const off = plane.register(namespace)
      mounted.set(ns, { base, hooks, revision: () => readRecord(ns)?.revision ?? 0 })

      // 与官方同序：先给读取闭包，再立刻通知一次（调用方不必自己再同步一次）。
      hooks.setSource?.(() => get(ns))
      hooks.onChange?.(get(ns))
      log.info(`命名空间 ${ns} 已挂到自有数据面（0.1.7：settings 不再提供动态命名空间）`)

      ctx.effect(() => () => {
        mounted.delete(ns)
        off()
        log.info(`命名空间 ${ns} 已从自有数据面摘除`)
      }, `humanity: 数据面命名空间 ${ns}`)
    },
  }
}
