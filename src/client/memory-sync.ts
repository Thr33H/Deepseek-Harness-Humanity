/**
 * 记忆工作台的**投影采纳**：把宿主那一份 `humanity-memory` 变成状态补丁，
 * 并保证「刚拨的开关不会被上一次投影冲掉」。
 *
 * 为什么单独一个文件：控制器本体贴着文件行数质量门，而这段逻辑（读回协议 + 本地未确认改动
 * + 逐字段核对）是**纯的、可单测的**，与"用户点了什么"没有关系。分出来之后，
 * 控制器只剩状态机与命令派发。
 *
 * ⚠️ **为什么必须挡住"旧的那一次回读"**（2026-09-26 真机，两轮才定位到）：
 * 配置写入之后，宿主要**异步重投影**一次才会把新模式/新开关写进 `humanity-memory`；
 * 而设置 RPC 的 `update` 一返回我们就回读 —— 那一刻读到的还是**上一次投影**。后果分两种：
 * - 没有本地值（旧代码）：拨了开关界面不动，点「重新加载」才动（宿主 `index.ts` 里记着同一条视频取证）；
 * - 有乐观值但不管这次旧读：翻一下又立刻弹回去 —— 看起来就是"点了没反应"。
 * 所以本地改动先记在 {@link PendingChanges} 里，每次采纳投影时**盖在它上面**；
 * 等投影真的给出同一个值，才把这条改动撤掉。
 * @module deepseek-harness-humanity/client/memory-sync
 */
import type { MemoryAdvancedView, MemoryWorkbenchState } from './memory-document.js'
import { asMemoryDocument } from './memory-document.js'
import type { MemoryChannel, PersonaNamespaceView } from './memory-channel.js'

/** 命名空间名（与宿主 `memory/section.ts` 一致，由 bundle 测试比对）。 */
const MEMORY_NAMESPACE = 'humanity-memory'

/** 本地改动：还没被宿主投影确认的那些。 */
export interface PendingChanges {
  advanced?: Partial<MemoryAdvancedView>
  mode?: string
  customized?: boolean
}

/** 采纳结果：状态补丁 + 撤掉已确认项之后的本地改动。 */
export interface AdoptResult {
  patch: Partial<MemoryWorkbenchState>
  pending: PendingChanges
}

/**
 * 宿主投影里的值是否已经与本地改动一致（逐字段比，缺字段当不一致）。
 * @param patch - 本地改动。
 * @param actual - 投影给出的值。
 * @returns 是否全部一致。
 */
function sameValues(patch: Partial<MemoryAdvancedView>, actual: MemoryAdvancedView): boolean {
  const left = patch as Record<string, unknown>
  const right = actual as unknown as Record<string, unknown>
  return Object.keys(left).every((key) => left[key] === right[key])
}

/**
 * 把一段命名空间值变成状态补丁（本地未确认改动盖在投影之上）。
 *
 * **绝不吞形状错误**：文档形状不对时抛出去，由调用方决定怎么显示 —— 那种情况下
 * "装作读到了"比报错更糟（列表会静默变成空）。
 * @param view - `describe()` 给出的命名空间视图。
 * @param writable - 这次读取时设置服务是否可写。
 * @param pending - 当前的本地改动。
 * @returns 状态补丁与更新后的本地改动。
 */
export function adoptMemoryView(
  view: PersonaNamespaceView,
  writable: boolean,
  pending: PendingChanges,
): AdoptResult {
  const document = asMemoryDocument(view.value)
  const advanced = { ...document.advanced, ...(pending.advanced ?? {}) }
  const mode = pending.mode ?? document.policy.mode
  const customized = pending.customized ?? document.policy.customized
  const next: PendingChanges = { ...pending }
  // 投影已经和本地改动一致 ⇒ 这条被宿主确认了，不用再盖着。
  if (pending.advanced !== undefined && sameValues(pending.advanced, document.advanced)) delete next.advanced
  if (pending.mode !== undefined && document.policy.mode === pending.mode) delete next.mode
  if (pending.customized !== undefined && document.policy.customized === pending.customized) delete next.customized
  return {
    pending: next,
    patch: {
      status: 'ready',
      writable,
      error: undefined,
      revision: view.revision,
      entries: document.entries,
      policy: { ...document.policy, mode, customized },
      advanced,
      notice: document.notice,
      degraded: document.degraded,
    },
  }
}

/** 一次读回的结果。 */
export type MemoryRead =
  | { ok: true; patch: Partial<MemoryWorkbenchState>; pending: PendingChanges }
  | { ok: false; error: string }

/**
 * 读一次宿主投影并算出状态补丁（`load()` 的全部协议都在这里）。
 * @param channel - 设置 RPC 通道。
 * @param pending - 当前的本地改动。
 * @returns 补丁，或一句如实的失败原因。
 */
export async function readMemoryProjection(
  channel: MemoryChannel,
  pending: PendingChanges,
): Promise<MemoryRead> {
  let result
  try {
    result = await channel.describe()
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  if (!result.ok) return { ok: false, error: result.error.message }
  // 形状兜底：describe 少一个字段不该让界面永远停在"正在读取…"（那时连「重新加载」都是禁用的）。
  const namespaces = Array.isArray(result.value?.namespaces) ? result.value.namespaces : []
  if (!Array.isArray(result.value?.namespaces)) return { ok: false, error: '宿主返回的设置描述不完整（缺少命名空间列表）' }

  const view = namespaces.find((item) => item.ns === MEMORY_NAMESPACE)
  if (view === undefined) return { ok: false, error: '记忆命名空间尚未就绪' }
  try {
    const adopted = adoptMemoryView(view, result.value.writable, pending)
    // 顶层配置的修订号（改模式/开关时带回去做乐观并发控制）—— 每次读回顺手刷新。
    const config = namespaces.find((item) => item.ns === 'humanity')
    const patch: Partial<MemoryWorkbenchState> = { ...adopted.patch }
    if (config !== undefined) patch.configRevision = config.revision
    return { ok: true, patch, pending: adopted.pending }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
