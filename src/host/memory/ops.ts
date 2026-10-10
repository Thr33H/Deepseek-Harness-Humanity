/**
 * 工作台对记忆的**操作**：把一条命令落到存储上，并回一句给人看的结论。
 *
 * 为什么单独一个文件：命令的"是什么"（{@link MemoryRequest}）与"怎么接进设置 RPC"（`section.ts`）
 * 是两件事；把操作实现摊在接线文件里，会让"哪几种操作存在"要靠通读订阅回调才能回答。
 *
 * 命令来自浏览器（工作台），因此每条都要能应付"条目已经被别处删掉/改掉"：
 * 结论如实返回（"条目不存在"），不抛异常 —— 抛出去就是客户端一次未处理的 rejection。
 * 所有操作都是**幂等**的：同一条命令重复到达（点击重试、贴两次补丁）不会产生第二次副作用，
 * 因此不需要额外的去重令牌。
 * @module humanity/memory/ops
 */
import { confirmPending, rejectPending } from './confirm.js'
import { runDecayCycle, type DecayReport } from './decay.js'
import { dedupeOnce, undoDedupe, type MergeUndoSlot } from './dedupe-ops.js'
import { buildDedupeKey } from './model.js'
import type { MemoryStore } from './store.js'
import type { MemoryPolicy } from './types.js'

/** 工作台能发起的操作。 */
export type MemoryOp =
  | 'confirm'
  | 'reject'
  | 'archive'
  | 'restore'
  | 'pin'
  | 'unpin'
  | 'remove'
  | 'decay'
  | 'dedupe'
  | 'undo-dedupe'
  | 'rescope'

/** 工作台可用操作的全集（宿主与客户端各存一份字面量；形状由测试断言一致）。 */
export const MEMORY_OPS: readonly MemoryOp[] = [
  'confirm',
  'reject',
  'archive',
  'restore',
  'pin',
  'unpin',
  'remove',
  // 手动维护：工作台的"整理记忆"按钮（自动触发见 search.ts 的顺带核算）。
  'decay',
  // 手动维护：工作台的"清理重复条目"按钮（判据与写入路径同一套，见 similar.ts）。
  'dedupe',
  'undo-dedupe',
  // 改归属：用户在工作台上把一条记忆在「长期」与「区域」之间改（用户 2026-09-26 令）。
  'rescope',
]

/** 一条来自工作台的命令。`op` 为空串表示"没有命令"（命名空间的稳态）。 */
export interface MemoryRequest {
  op: MemoryOp | ''
  fingerprint: string
  /** `rescope` 的目标作用域（`long-term` / `workspace`）；其余命令留空。 */
  scope: string
  /** `rescope` 的目标区域 id（改成区域记忆时必填）；其余命令留空。 */
  ownerId: string
}

/** 没有待执行命令时的取值。 */
export const EMPTY_REQUEST: MemoryRequest = { op: '', fingerprint: '', scope: '', ownerId: '' }

/** 固定/取消固定：`pinned` 是用户标记，标记过的条目不参与衰减（P-026）。 */
async function setPinned(store: MemoryStore, fingerprint: string, pinned: boolean): Promise<string> {
  const current = store.get(fingerprint)
  if (current === undefined) return '这条记忆已经不存在了（可能刚被删除）。'
  await store.put({ ...current, pinned })
  return pinned ? '已固定：这条记忆不参与自动衰减。' : '已取消固定。'
}

/** 确认一条待确认记忆。 */
async function confirmOne(store: MemoryStore, fingerprint: string): Promise<string> {
  const entry = await confirmPending(store, fingerprint, 'workbench')
  return entry === undefined ? '这条记忆不在待确认状态，没有改动。' : '已确认：这条记忆开始生效。'
}

/** 拒绝一条待确认记忆。 */
async function rejectOne(store: MemoryStore, fingerprint: string): Promise<string> {
  const removed = await rejectPending(store, fingerprint)
  return removed ? '已拒绝：这条内容不会被记住。' : '这条记忆不在待确认状态，没有改动。'
}

/** 归档：默认检索不再命中，数据仍保留。 */
async function archiveOne(store: MemoryStore, fingerprint: string): Promise<string> {
  const entry = await store.archive(fingerprint)
  return entry === undefined ? '这条记忆已经不存在了。' : '已归档：默认检索不再命中，数据仍保留。'
}

/** 从归档恢复。 */
async function restoreOne(store: MemoryStore, fingerprint: string): Promise<string> {
  const entry = await store.restore(fingerprint)
  return entry === undefined ? '这条记忆不在已归档状态，没有改动。' : '已恢复：重新参与检索。'
}

/** 永久删除。 */
async function removeOne(store: MemoryStore, fingerprint: string): Promise<string> {
  const removed = await store.remove(fingerprint)
  return removed ? '已永久删除这条记忆。' : '这条记忆已经不存在了。'
}

/**
 * 把一份衰减核算报告说成**一句话**（工作台按钮与自进化运行记录共用同一句）。
 *
 * 五档全列出来：只报"动了多少"会让人看不出"扫了 98 条却一条没动"到底是
 * **都没到期**还是**都被保护**（0.1.10 之前分不清）。
 * @param report - 一次核算的报告。
 */
export function decaySummary(report: DecayReport): string {
  return (
    `扫描 ${report.scanned} 条，受保护 ${report.protectedCount} 条，未到期 ${report.skippedFresh} 条，` +
    `降权 ${report.decayed} 条，归档 ${report.archived} 条。`
  )
}

/**
 * 跑一次衰减核算并给出结论（**唯一的核算入口**：工作台「整理记忆」与自进化每轮顺带都走它）。
 *
 * 为什么要有这个包装：核算本身在 `decay.ts`（纯维护），而"怎么把这个动作说给人听"是
 * 工作台/运行记录的口径问题。两处各写一遍措辞，迟早出现"工作台说降权 3 条、时间线说 0 条"。
 * ⚠️ `policy.decay` 为假时**不调用**（调用方负责判）：本函数只做"跑 + 说"，不做开关判定，
 * 免得"关了却还是进了核算入口"这种说法上的歧义。
 * @param store - 记忆读写入口。
 * @param policy - 当前生效策略。
 * @param now - 当前时刻（ISO）；显式传入时核算**确定**（自进化每轮传自己的 `now`，测试据此断言）。
 * @returns 报告与一句话结论。
 */
export async function runDecayMaintenance(
  store: MemoryStore,
  policy: MemoryPolicy,
  now?: string,
): Promise<{ report: DecayReport; summary: string }> {
  const report = await runDecayCycle(store, policy, now)
  return { report, summary: decaySummary(report) }
}

/** 手动跑一次衰减归档（"整理记忆"按钮）。 */
async function decayOnce(store: MemoryStore, policy: MemoryPolicy): Promise<string> {
  const { report, summary } = await runDecayMaintenance(store, policy)
  if (report.scanned === 0) return '记忆维护已跑过：本次没有需要衰减的条目。'
  return `记忆维护完成：检查 ${report.scanned} 条，降权 ${report.decayed} 条，归档 ${report.archived} 条，受保护跳过 ${report.protectedCount} 条。`
}

/**
 * 改一条记忆的**归属**（用户 2026-09-26：作用域判断不能只由模型说了算）。
 *
 * 三件事必须一起做对，缺一个就会留下脏数据：
 * - **指纹随作用域变**（\`dedupeKey = scope:正文\`）⇒ 先删旧键、再写新键；
 * - **身份与使用统计沿用原值**（\`put\` 对新键无从沿用，不显式带上就会被清零）；
 * - **目标归属已有同内容条目时如实拒绝** —— 不合并（语义复杂）、不覆盖（丢信息）。
 * @param store - 记忆读写入口。
 * @param fingerprint - 目标条目的当前指纹。
 * @param scope - 目标作用域（只接受 long-term / workspace）。
 * @param ownerId - 目标区域 id（改成区域时必填）。
 * @returns 面向用户的结论。
 */
async function rescopeOne(
  store: MemoryStore,
  fingerprint: string,
  scope: string,
  ownerId: string,
): Promise<string> {
  const current = store.get(fingerprint)
  if (current === undefined) return '这条记忆已经不存在了（可能刚被删除）。'
  if (scope !== 'long-term' && scope !== 'workspace') {
    return '只能改成「长期记忆」或「区域记忆」。（会话记忆没有归属，改不进去。）'
  }
  const target = scope === 'workspace' ? ownerId : ''
  if (scope === 'workspace' && target === '') return '改成「区域记忆」需要指定它属于哪个区域。'
  if (current.scope === scope && current.ownerId === target) return '这条记忆的归属已经是它，没有改动。'

  const nextKey = buildDedupeKey(scope, current.content)
  if (nextKey !== fingerprint && store.get(nextKey) !== undefined) {
    return '目标归属下已经有一条内容相同的记忆，本次没有改动（避免产生重复条目）。'
  }
  if (nextKey !== fingerprint) await store.remove(fingerprint)
  await store.put({ ...current, scope, ownerId: target, dedupeKey: nextKey })
  return scope === 'long-term'
    ? '已改为「长期记忆」：任何区域都能被想起来。'
    : `已改为「区域记忆」：只在 ${ownerId} 里被想起来。`
}

/**
 * 执行一条命令。
 * @param store - 记忆读写入口。
 * @param policy - 当前生效策略（"整理"要不要跑由它决定）。
 * @param request - 工作台发来的命令。
 * @param undo - 合并的撤销槽（宿主持有；缺省时合并仍可用，只是撤不回来）。
 * @returns 面向用户的结论（成功与失败都返回一句话，由工作台原样展示）。
 */
export async function applyMemoryRequest(
  store: MemoryStore,
  policy: MemoryPolicy,
  request: MemoryRequest,
  undo: MergeUndoSlot = {},
): Promise<string> {
  const { op, fingerprint, scope, ownerId } = request
  switch (op) {
    case 'confirm':
      return confirmOne(store, fingerprint)
    case 'reject':
      return rejectOne(store, fingerprint)
    case 'archive':
      return archiveOne(store, fingerprint)
    case 'restore':
      return restoreOne(store, fingerprint)
    case 'pin':
      return setPinned(store, fingerprint, true)
    case 'unpin':
      return setPinned(store, fingerprint, false)
    case 'remove':
      return removeOne(store, fingerprint)
    case 'decay':
      return decayOnce(store, policy)
    case 'dedupe':
      return dedupeOnce(store, undo)
    case 'undo-dedupe':
      return undoDedupe(store, undo)
    case 'rescope':
      return rescopeOne(store, fingerprint, scope, ownerId)
    default:
      // 未知命令不该走到这里（`section.ts` 的 validate 已经在写入时拦过），如实说明而不是假装成功。
      return '无法识别的操作，没有改动。'
  }
}
