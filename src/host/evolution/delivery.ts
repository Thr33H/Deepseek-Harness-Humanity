/**
 * 投递守门：**卡片只是通道，什么时候投由插件决定**。
 *
 * ### 为什么要这一层（2026-11-26 真机教训）
 *
 * DSH 的调度卡片会自己到点响。它响的那一刻，如果目标会话正在跑一轮，
 * 消息就被排进"下一轮"——而下一轮没发生，她永远看不到（收账就这么丢了一次）。
 * 所以：卡片建成"2099 年才到点"（永远不会自己响），投递一律由插件用 `run` 触发，
 * 而且触发之前先确认目标会话**空闲**。
 *
 * ### 空闲怎么判
 *
 * 记每个会话"最后一次有动静"的时刻（她说话、调工具、你说话都算）。
 * 安静够 `IDLE_SECONDS` 才算闲。判断在内存里，重启后重新累积 —— 重启后本来也要等一会儿。
 * @module humanity/evolution/delivery
 */
import type { RoomDeps } from './room.js'
import {
  agentBusy,
  createDormantTask,
  deleteTask,
  deliverToAgent,
  inspectRoom,
  taskFields,
  waitAgentIdle,
} from './room.js'

/** 安静多久才算"她闲下来了"（秒）。 */
export const IDLE_SECONDS = 90

/** 每个会话最后一次有动静的时刻（毫秒时间戳）。 */
const lastActivity = new Map<string, number>()

/**
 * 记一次活动。
 * @param sessionId - 会话 id。
 * @param at - 时刻（默认现在）。
 */
export function noteActivity(sessionId: string, at = Date.now()): void {
  if (sessionId === '') return
  lastActivity.set(sessionId, at)
}

/**
 * 这个会话闲够了吗。
 * @param sessionId - 会话 id。
 * @param now - 当前时刻（毫秒）。
 * @returns 从没动过、或安静够久时为 `true`。
 */
export function isIdle(sessionId: string, now = Date.now()): boolean {
  const last = lastActivity.get(sessionId)
  if (last === undefined) return true
  return now - last >= IDLE_SECONDS * 1000
}

/** 只用于测试：清掉记着的活动。 */
export function resetActivity(): void {
  lastActivity.clear()
}

/** 一条通道的种类。 */
export type ChannelKind = 'wake' | 'collect' | 'tell'

/**
 * 通道的标题。
 *
 * **这里是"自主行动"的唯一一张表**：她自己的时间、该写日记了、主动找你说一句，
 * 全部是同一形状 —— 一张停着的卡片 + 插件在判定成立时 `run` 它。
 * 以后再加一种行动，就在这里加一行，别再发明第二种投递方式
 * （真机教训：唯一的例外"她自己的时间"曾经是一条会自己到点的任务，等于让闹钟替她决定）。
 */
export const CHANNEL_TITLES: Readonly<Record<ChannelKind, string>> = {
  wake: '她自己的时间',
  collect: '她该写日记了',
  tell: '她主动找你说一句',
}

/**
 * 找一条已有通道（按标题认领），找不到就建一条"2099 年才到点"的。
 *
 * 认领的纪律：
 * - 只认**停着的**（`rrule`）—— 会自己到点的旧任务到点就自己投，等于绕过插件，当场删掉；
 * - 一种通道只留一张：同标题却指向别的会话的，是上一个会话留下的废卡，删掉（否则任务列表越积越多）。
 *
 * 为什么能按标题认领：卡片 id 存在状态里，但状态可能丢（覆盖、换版本）。
 * 认领就是那张"兜底网"。
 * @param deps - 房间外部事实。
 * @param kind - 哪一种通道。
 * @param sessionId - 投到哪个会话。
 * @param prompt - 建新卡时先用这段占位内容。
 * @param timeZone - 时区（2099 那个锚点用）。
 * @returns 卡片 id；失败时给出原因。
 */
export async function ensureChannel(
  deps: RoomDeps,
  kind: ChannelKind,
  sessionId: string,
  prompt: string,
  timeZone?: string,
): Promise<{ ok: true; taskId: string } | { ok: false; reason: string }> {
  const service = deps.schedule()
  if (service === undefined) return { ok: false, reason: '调度服务不在' }
  const title = CHANNEL_TITLES[kind]
  /** 认领到的那张（同标题、同会话、停着的）。 */
  let found = ''
  /** 该删的：会自己到点的旧任务、指向别的会话的废卡、同标题的重复卡。 */
  const stale: string[] = []
  try {
    const tasks = await service.catalog()
    for (const task of tasks) {
      const fields = taskFields(task)
      if (fields.title !== title || fields.id === '') continue
      /**
       * 只认"停着的"卡片（`rrule` = 2099 才到点的那种）。
       *
       * 会自己到点的旧任务（`after` / `at`）**不是通道**：留着它，它到点就自己投，
       * 等于绕过插件做决定 —— 升级时第一次跑到这里就要把它清掉（真机 0.9.51 之前的房间闹钟就是它）。
       */
      if (fields.kind !== 'rrule') {
        stale.push(fields.id)
        continue
      }
      // 一种通道只留一张：同会话的第一张认领，其余（重复的、指向旧会话的）都算废卡。
      if (fields.sessionId === sessionId && found === '') {
        found = fields.id
        continue
      }
      stale.push(fields.id)
    }
  } catch {
    // 认领失败就当没有：下面会新建一条。
  }
  for (const id of stale) await deleteTask(deps, id)
  if (found !== '') return { ok: true, taskId: found }
  return createDormantTask(deps, title, prompt, sessionId, timeZone)
}

/**
 * 这个会话闲着吗（心跳的闸门用）。
 *
 * 先问 agent 自己（权威），问不到才退回"最近有没有动静"那份账本。
 * @param deps - 房间外部事实。
 * @param sessionId - 目标会话。
 * @param now - 当前时刻（毫秒）。
 * @returns 闲着为 `true`。
 */
export function sessionIdle(deps: RoomDeps, sessionId: string, now = Date.now()): boolean {
  const busy = agentBusy(deps, sessionId)
  if (busy !== undefined) return !busy
  return isIdle(sessionId, now)
}

/**
 * 投一次：**把卡片上的字换成这一次要说的，然后直接交给她那个 agent**。
 *
 * 为什么不再调 `schedule.run`：它把消息排进"下一轮"，然后指望有人去开这一轮 ——
 * 真机 2026-11-26 反复验证：投递记录有了，她一个字都没收到（她那一轮里只有我们注入的两条提醒）。
 * 卡片仍然保留：它是「自动化任务」列表里的那一行记录，也是面板的入口；改它的 prompt 是为了
 * 事后点"立即执行"时还说得清这次说了什么。
 * @param deps - 房间外部事实。
 * @param taskId - 通道卡片 id。
 * @param sessionId - 投到哪个会话。
 * @param prompt - 这一次要说的内容。
 * @param options - `timeoutMs` 等她空闲的上限（默认 180 秒）。
 * @returns 投出去了没有；没投出去给出原因。
 */
export async function sendViaCard(
  deps: RoomDeps,
  taskId: string,
  sessionId: string,
  prompt: string,
  options: { timeoutMs?: number } = {},
): Promise<{ ok: boolean; reason?: string }> {
  const service = deps.schedule()
  if (taskId === '') return { ok: false, reason: '没有卡片' }
  if (service !== undefined) {
    try {
      await service.edit({ id: taskId, action: 'update', patch: { prompt } })
    } catch {
      // 改卡片只是留个记录：改不了不该挡住这一次投递。
    }
  }
  return deliverToAgent(deps, sessionId, prompt, options.timeoutMs ?? 180_000)
}

/**
 * 读一张卡片最近一次投递的时刻（毫秒）。
 * @param service - 调度服务。
 * @param taskId - 卡片 id。
 * @returns 时刻；从没投过时 `undefined`。
 */
async function lastDeliveryOf(
  service: { view(request: { id: string }): Promise<unknown> },
  taskId: string,
): Promise<number | undefined> {
  try {
    const task = (await service.view({ id: taskId })) as
      | { lastDelivery?: { deliveredAt?: unknown } }
      | undefined
    const at = task?.lastDelivery?.deliveredAt
    if (typeof at !== 'string') return undefined
    const ms = Date.parse(at)
    return Number.isFinite(ms) ? ms : undefined
  } catch {
    return undefined
  }
}

/**
 * 等一会儿。
 * @param ms - 毫秒。
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms) as unknown as { unref?: () => void }
    timer.unref?.()
  })
}

/**
 * 卡片还在不在（被删了就得重建）。
 * @param deps - 房间外部事实。
 * @param taskId - 通道卡片 id。
 * @returns 还在为 `true`。
 */
export async function channelAlive(deps: RoomDeps, taskId: string): Promise<boolean> {
  if (taskId === '') return false
  return (await inspectRoom(deps, taskId)) !== undefined
}
