/**
 * 记忆工作台的设置命名空间接线（`humanity-memory`）。
 *
 * 与自进化、人格同一份裁决：**复用 settings RPC，不新建 gateway**。
 * 宿主写整份投影；客户端只有两件事能写进这份文档 —— 命令槽（`request`，目前是看秘密与删除）
 * 与它自己的阅读状态。命令的语义与权限全在宿主那边（见 `section-runtime.ts` 的 `consume`）。
 *
 * ⚠️ `validate` 钩子**注册时也会跑一次**（2026-09-23 真机事故教训）：这里什么都不校验。
 * 投影内容来自存储、形状由 schema 兜底；为它写一条会在注册瞬间抛的规则，等于让整个命名空间挂不上。
 * @module humanity/memory/section
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'

import type { Log } from '../log.js'
import { fallbackSettings } from '../plane-settings.js'
import { supportsDynamicSections } from '../settings.js'
import { MEMORY_NAMESPACE, MemoryDocSchema, emptyMemoryDocument, type MemoryDocument } from './section-doc.js'
import { createMemorySectionRuntime, type MemorySectionDeps, type MemorySectionRuntime } from './section-runtime.js'
import type { MemoryHit } from './types.js'

/** 工作台入口（由 `installMemory` 装配并驱动）。 */
export interface MemorySection {
  refresh(): Promise<void>
  notifyStoreReady(): void
  /** 记下这一轮"因为哪句话、想起了哪几条"（工作台的"为什么想起"）。 */
  noteRecall(cue: string, hits: readonly MemoryHit[]): void
  /** 是否已接上设置服务；false 表示工作台此刻读不到记忆。 */
  readonly attached: boolean
}

/** 接线状态。 */
interface MemorySectionState {
  settings?: SettingsProvider
  attached: boolean
}

/** 读命名空间当前值（读取包 try/catch：装配路径没有兜底）。 */
function readDoc(settings: SettingsProvider | undefined): MemoryDocument | undefined {
  if (settings === undefined) return undefined
  try {
    const live = settings.get(MEMORY_NAMESPACE)
    return live === undefined || live === null ? undefined : (live as MemoryDocument)
  } catch {
    return undefined
  }
}

/**
 * 把记忆投影写进命名空间。
 * @param state - 接线状态（现读句柄）。
 * @param log - 日志门面。
 * @param doc - 整份投影。
 */
function writeDoc(state: MemorySectionState, log: Log, doc: MemoryDocument): void {
  const settings = state.settings
  if (settings === undefined) return
  try {
    // 用 replace 而不是 update：投影是**整份重算**的结果，深合并会把已经不在库里的条目留下来。
    const pending = settings.replace(MEMORY_NAMESPACE, doc) as unknown
    // `replace` 在部分实现里是**异步排队**的：服务被销毁之后它才跑到，于是 reject。
    // 那对工作台毫无意义（界面本来就没了），但放任不管会变成 unhandled rejection。
    if (pending !== null && pending !== undefined && typeof (pending as Promise<unknown>).then === 'function') {
      void (pending as Promise<unknown>).catch((error: unknown) => {
        log.warn('记忆工作台投影写入失败（界面可能停在旧值）', error)
      })
    }
  } catch (error) {
    log.warn('记忆工作台投影写入失败（界面可能停在旧值）', error)
  }
}

/**
 * 把命名空间接进设置服务；服务摘除时回到"工作台不可用"。
 * @param ctx - 本插件的上下文。
 * @param log - 日志门面。
 * @param state - 接线状态。
 * @param runtime - 运行期。
 */
function attachMemorySection(
  ctx: Context,
  log: Log,
  state: MemorySectionState,
  runtime: MemorySectionRuntime,
): void {
  ctx.inject(['settings'], (sctx) => {
    const settings: SettingsProvider = sctx.settings
    const hooks = {
      setSource: () => {},
      // 客户端只写命令槽；写入的语义由宿主在执行时把关（见 section-runtime 的 consume）。
      validate: () => {},
      // 命令进来就消费它，然后重新投影（投影会把命令槽清空）。
      onChange: () => {
        void runtime.consume()
      },
    }

    // G-002 升级兼容：0.1.7+ 的 settings 没有动态命名空间 API —— 改挂自有数据面。
    if (!supportsDynamicSections(settings)) {
      const plane = fallbackSettings()
      if (plane === undefined) {
        log.error(
          '当前的 DSH settings 服务不提供 installSection（0.1.7+ 已重构），且自有数据面缺席：' +
            '记忆工作台本次降级为不可用；记忆的写入、检索与注入不受影响。',
        )
        return
      }
      plane.installSection(ctx, MEMORY_NAMESPACE, MemoryDocSchema, emptyMemoryDocument(), hooks)
      state.settings = plane as unknown as SettingsProvider
      state.attached = true
      log.info('0.1.7：记忆工作台改由自有数据面承载')
      void runtime.refresh()

      return () => {
        state.settings = undefined
        state.attached = false
        log.info('数据面摘除：记忆工作台回到不可用')
      }
    }
    state.settings = settings

    settings.installSection(ctx, MEMORY_NAMESPACE, MemoryDocSchema, emptyMemoryDocument(), hooks)

    log.info('记忆命名空间已接入设置服务')
    state.attached = true
    void runtime.refresh()

    return () => {
      state.settings = undefined
      state.attached = false
      log.info('设置服务已摘除：记忆工作台回到不可用')
    }
  })
}

/** 运行期装配所需的外部事实（形状见 `section-runtime.ts`）。 */
export type { MemorySectionDeps } from './section-runtime.js'

/**
 * 把记忆接进设置服务（工作台的只读通道）。
 * @param ctx - 本插件的上下文。
 * @param log - 日志门面。
 * @param deps - 运行期需要的外部事实（存储读取与当前时刻）。
 */
export function installMemorySection(
  ctx: Context,
  log: Log,
  deps: Omit<MemorySectionDeps, 'write' | 'log'>,
): MemorySection {
  const state: MemorySectionState = { attached: false }
  const runtime = createMemorySectionRuntime({
    ...deps,
    log,
    write: (doc) => writeDoc(state, log, doc),
    pendingRequest: () => readDoc(state.settings)?.request,
  })
  attachMemorySection(ctx, log, state, runtime)

  return {
    refresh: runtime.refresh,
    notifyStoreReady: runtime.notifyStoreReady,
    noteRecall: runtime.noteRecall,
    get attached() {
      return state.attached
    },
  }
}

export { MEMORY_NAMESPACE }
export { readDoc as readMemoryDocument }
