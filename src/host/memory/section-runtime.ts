/**
 * 记忆工作台通道的**运行期**：投影刷新、命令消费与串行队列。
 *
 * 为什么从 `section.ts` 拆出来：`section.ts` 回答"怎么接进设置服务"（注入、注册、校验钩子），
 * 这里回答"接上之后怎么运转"（什么时候投影、命令怎么排队）。两者混在一起时，
 * 一个"命令为什么没被执行"的问题要在订阅回调与队列逻辑之间来回找。
 *
 * 队列存在的理由：投影本身也会触发 `onChange`。不串行的话，"客户端发第二条命令"与
 * "宿主投影第一条的结果"会交叉 —— 谁最后写 `request`，另一方的命令就被吃掉。
 * @module humanity/memory/section-runtime
 */
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'

import type { MemoryAdvancedConfig } from '../config.js'
import type { Log } from '../log.js'
import type { CompatState } from '../preset-compat.js'
import { applyMemoryRequest, type MemoryRequest } from './ops.js'
import type { MergeUndoSlot } from './dedupe-ops.js'
import { projectionPatch, shouldClearRequest } from './projection.js'
import type { MemoryDocument } from './section-doc.js'
import type { MemoryStore } from './store.js'
import type { MemoryPolicy } from './types.js'

/** 运行期需要的外部事实（读取与写出都从外面现取，避免把死句柄闭进来）。 */
export interface SectionRuntimeDeps {
  /** 已捕获的设置服务句柄；未接上时返回 `undefined`。 */
  settings(): SettingsProvider | undefined
  /** 读命名空间当前值。 */
  read(): MemoryDocument | undefined
  /** 存储句柄；未就绪时返回 `undefined`。 */
  store(): MemoryStore | undefined
  /** 当前生效策略。 */
  policy(): MemoryPolicy
  /** 配置里的高级开关原值。 */
  advanced?(): MemoryAdvancedConfig
  /** preset 兼容性探测状态。 */
  compat?(): CompatState
  /** 投影写回的命名空间。 */
  namespace: string
  log: Log
}

/** 运行期句柄。 */
export interface SectionRuntime {
  /** 把存储现状投影进命名空间。 */
  refresh(consumed?: MemoryRequest): Promise<void>
  /** 排一次命令消费（客户端写入后由 `onChange` 触发）。 */
  enqueue(): void
  /** 存储刚就绪：补消费积压命令，再补一次投影。 */
  notifyStoreReady(): void
}

/** 运行期的内部状态：外部事实 + 上一次命令的结论（随投影带出去）+ 合并撤销槽。 */
interface RuntimeState {
  deps: SectionRuntimeDeps
  /** 上一次执行命令的结论；工作台原样展示。 */
  notice: string
  /** 合并的撤销槽（内存态：重启即失效，见 `dedupe-ops.ts`）。 */
  undo: MergeUndoSlot
}

/**
 * 投影当前命名空间值：`request` 的清空守则见 `shouldClearRequest`。
 *
 * 存储或设置服务任一未就绪时**什么都不写**（G-002 降级，而不是写一份空投影盖掉真数据）。
 * @param state - 运行期状态。
 * @param consumed - 刚执行完的命令；缺省表示这次投影不是由命令触发的。
 */
async function refreshProjection(state: RuntimeState, consumed?: MemoryRequest): Promise<void> {
  const { deps } = state
  const settings = deps.settings()
  const store = deps.store()
  if (settings === undefined || store === undefined) return
  const compat = deps.compat?.()
  try {
    await settings.update(
      deps.namespace,
      projectionPatch({
        entries: store.list(),
        policy: deps.policy(),
        advanced: deps.advanced?.(),
        // 兼容性：只在**探测过**且确实被吞掉时提示（没探测到就不提示，宁缺勿误报）。
        degraded: compat !== undefined && compat.probed && compat.blocked,
        notice: state.notice,
        clearRequest: shouldClearRequest(deps.read()?.request, consumed),
      }),
    )
  } catch (error) {
    deps.log.warn('记忆投影写入失败（工作台可能看到旧数据）', error)
  }
}

/**
 * 执行客户端留下的一条命令，然后投影一次。
 *
 * 存储未就绪 / 没有命令时直接返回（命令槽留着，由 `notifyStoreReady` 在存储就绪后补消费）。
 * @param state - 运行期状态。
 */
async function consumeOnce(state: RuntimeState): Promise<void> {
  const { deps } = state
  const store = deps.store()
  const request = deps.read()?.request
  if (store === undefined || request === undefined || request.op === '') return
  try {
    state.notice = await applyMemoryRequest(store, deps.policy(), request, state.undo)
  } catch (error) {
    state.notice = '执行这条操作时出错，已保持不变。'
    deps.log.error('记忆工作台操作失败', error)
  }
  deps.log.info(`记忆工作台操作 ${request.op}：${state.notice}`)
  await refreshProjection(state, request)
}

/**
 * 造出运行期。
 * @param deps - 外部事实。
 * @returns 投影 / 排队 / 就绪通知三个入口。
 */
export function createSectionRuntime(deps: SectionRuntimeDeps): SectionRuntime {
  const state: RuntimeState = { deps, notice: '', undo: {} }
  let queue: Promise<void> = Promise.resolve()
  const enqueue = (task: () => Promise<void> = () => consumeOnce(state)): void => {
    queue = queue.then(task, task)
  }

  return {
    refresh: (consumed) => refreshProjection(state, consumed),
    enqueue,
    /**
     * 两件事都排进同一条队列，顺序固定 —— 否则"补投影"可能落在"补消费"的投影之前，
     * 工作台看到的就还是命令执行前的旧列表。
     */
    notifyStoreReady(): void {
      enqueue()
      enqueue(() => refreshProjection(state))
    },
  }
}
