/**
 * 待确认（pending）条目的确认与拒绝 —— T2/T3 的**数据层**。
 *
 * ### 与任务书（`docs/handoff/TASK-PERSONA-ADDRESS.md` T2/T2 补充/T3）的对应
 *
 * - **共用一份 pending 记录**：不新建命名空间、不新建表 —— 敏感/需确认的记忆本来就是
 *   `status: 'pending'` 的记忆条目（M3 步骤 3b），聊天端与工作台端读的是同一张表，
 *   所以"任一端确认后另一端同步消失"是**数据结构自带的性质**，不需要同步协议。
 * - **两端入口**：`confirmPending(..., source)` 的 `source` 记录是**哪一端**确认的
 *   （`chat` / `workbench`），写进 `confirmedVia` 供审计与工作台展示。
 * - **超时**：刻意**没有**超时逻辑 —— pending 不会因为等久了自动通过，也不会被自动删除
 *   （P-025：模糊/敏感内容进待确认，只有用户能放行）。T2 方案 A 的"超时转移到控制台"
 *   只需要工作台把 {@link listPending} 显示出来（M3 步骤 8），无需任何定时器。
 *
 * ### 两端入口的现状
 *
 * - **工作台端已接入**（M3 步骤 8b）：记忆页的「待确认」队列直接读同一张表，确认/拒绝走
 *   `humanity-memory` 的命令槽（见 `ops.ts` / `section.ts`）。
 * - **聊天端的主动提醒卡片尚未接入**：P-043 要求"下次自然交互时发一张简短卡片"，那是一个
 *   独立功能，不在当前范围内。数据层与工作台端已经能用，所以这里**没有**假装聊天端也存在。
 * @module humanity/memory/confirm
 */
import type { MemoryConfirmSource } from './constants.js'
import type { MemoryStore } from './store.js'
import type { MemoryEntry } from './types.js'

/**
 * 列出全部待确认条目（最近更新在前，顺序由 `MemoryStore.list` 保证）。
 *
 * 工作台与聊天端都读它 —— 两端同源就是"读同一个函数"，不是靠两边各自维护一份队列。
 * @param store - 记忆读写入口。
 * @returns 待确认条目。
 */
export function listPending(store: MemoryStore): MemoryEntry[] {
  return store.list(undefined, 'pending')
}

/**
 * 确认一条待确认记忆：`pending` → `active`，并记录确认入口。
 *
 * 只有 `pending` 能被确认：已经生效的条目返回 `undefined`（"确认两次"不该产生第二次写入，
 * 那正是 T2 双端同源要防的重复落盘）。
 * @param store - 记忆读写入口。
 * @param fingerprint - 条目指纹。
 * @param source - 确认入口（`chat` / `workbench`）。
 * @returns 确认后的条目；不存在或不是待确认时为 `undefined`。
 */
export async function confirmPending(
  store: MemoryStore,
  fingerprint: string,
  source: MemoryConfirmSource,
): Promise<MemoryEntry | undefined> {
  const current = store.get(fingerprint)
  if (current === undefined || current.status !== 'pending') return undefined
  return store.put({ ...current, status: 'active', confirmedVia: source })
}

/**
 * 拒绝一条待确认记忆：**直接删除**。
 *
 * 为什么是删除而不是改一个 `rejected` 状态：拒绝是用户的明确意图（"这条不要记"），
 * 留着它只会在检索与工作台里反复出现。P-026 的"归档不删除"管的是**自动衰减**
 * （用户没表态的东西不能替他扔），与用户主动说"不"是两回事。
 * @param store - 记忆读写入口。
 * @param fingerprint - 条目指纹。
 * @returns 是否真的删掉了一条待确认记录。
 */
export async function rejectPending(store: MemoryStore, fingerprint: string): Promise<boolean> {
  const current = store.get(fingerprint)
  if (current === undefined || current.status !== 'pending') return false
  return store.remove(fingerprint)
}
