/**
 * 她的房间：一个**只属于她**的会话，和一个按约叫醒她的单次任务。
 *
 * ### 为什么是"一次一约"而不是循环任务
 *
 * 循环任务（每 N 分钟一次）会把"什么时候醒"交给闹钟；而觉醒的时机应当由她的状态决定
 * （累不累、手上有没有事）。所以这个任务永远只有**一个未来时点**：每次她醒来、收工，
 * 我们把它的下一次改成新的时刻。整个流程里只有一个任务、一个 id，不会越积越多。
 *
 * ### 房间是怎么长出来的
 *
 * 用 DSH 调度服务的 `new_once` 目标：**第一次投递时才创建会话**，并指定目录与预设；
 * 之后一直复用同一个会话（target 会被改写成 `session`）。所以"她的房间"不需要你手动开。
 *
 * ### 拿不到调度服务怎么办
 *
 * 安静降级：记一条警告，不排程、不喊醒。她只是这段时间"没有自己的日子"，对话与其余模块
 * 一概不受影响（G-002 停功能、不停 DSH）。
 * @module humanity/evolution/room
 */
import { describeError, type Log } from '../log.js'
import { HUMANITY_PRESET_ID } from '../presets.js'
import { ROOM_TASK_TITLE } from './constants.js'

/** 调度服务里我们用到的那部分（结构化声明，不固化 DSH 的类型面）。 */
interface ScheduleTaskLike {
  id?: string
  title?: string
  createdAt?: string
  active?: string
  /** 循环任务的下一次。 */
  nextScheduledAt?: string
  /** 单次任务（fter/t）的下一次 —— 房间用的就是这种。 */
  scheduledAt?: string
  target?: { kind?: string; sessionId?: string }
  code?: string
}

/** `ctx.get('schedule')` 读到的服务。 */
export interface ScheduleServiceLike {
  create(request: unknown, actorSessionId?: string, signal?: AbortSignal): Promise<ScheduleTaskLike>
  view(request: { id: string }): Promise<ScheduleTaskLike>
  edit(request: unknown, actorSessionId?: string, signal?: AbortSignal): Promise<ScheduleTaskLike>
  /** 全部任务（"认领"已有房间时用）。 */
  catalog(): Promise<ScheduleTaskLike[]>
}

/** 会话创建能力（`ctx.get('sessionController')` 的那一部分）。 */
export interface SessionControllerLike {
  create(request: { cwd?: string; agentPreset?: string }): Promise<{ sessionId?: string }>
}

/** 一个已受管的 Agent 句柄（我们只用它的会话与释放能力）。 */
export interface AgentHandleLike {
  agent?: { session?: { id?: string } }
  dispose?: () => void
}

/** Agent 注册表里我们用到的那部分（`ctx.get('agents')`）。 */
export interface AgentRegistryLike {
  create(options: {
    sessionId: string
    meta?: { cwd?: string; agentPreset?: string }
  }): Promise<AgentHandleLike>
  get(sessionId: string): unknown
  resume(options: { resumeSessionId: string }): Promise<AgentHandleLike>
}

/** 房间的外部事实。 */
export interface RoomDeps {
  /** 调度服务（现读：它可能比我们晚挂上，也可能根本不存在）。 */
  schedule(): ScheduleServiceLike | undefined
  /**
   * 会话创建能力（现读）。
   *
   * ⚠️ 真机结论（2026-11-23）：`sessionController` 与 `new_once` 在这个部署里都用不了 ——
   * 前者对插件不可见，后者被 Host 拒绝（`This Host cannot create Sessions`）。
   * 所以房间只能从 **Agent 注册表** 开：它看得见，并且能按我们给的会话 id 建"会话 + Agent"。
   */
  agents(): AgentRegistryLike | undefined
  /** `$DSH_HOME`（现读）。 */
  homeDir(): string | undefined
  /** 日志。 */
  log: Log
}

/** 房间当前的样子。 */
export interface RoomState {
  /** 任务 id；空串 = 还没有任务。 */
  taskId: string
  /** 会话 id；空串 = 第一次投递还没发生。 */
  sessionId: string
  /** 下一次预定时刻（ISO）；空串 = 没排。 */
  nextAt: string
  /** 任务是否处于活动状态。 */
  active: boolean
}

/** 结果：成功时带上房间状态，失败时带一句人话（调用方决定记不记）。 */
export type RoomOutcome = { ok: true; room: RoomState } | { ok: false; reason: string }

/** 房间目录（`$DSH_HOME/humanity/room`）。 */
export function roomDirOf(deps: RoomDeps): string | undefined {
  const home = deps.homeDir()
  if (home === undefined || home.trim() === '') return undefined
  return `${home.replace(/[\\/]+$/, '')}/humanity/room`
}

/** 我们用到的那几个 `node:fs/promises` 函数（宿主编译没有 `@types/node`）。 */
interface FsPromisesModule {
  mkdir(path: string, options: { recursive: boolean }): Promise<string | undefined>
  writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>
  readFile(path: string, encoding: 'utf8'): Promise<string>
  readdir(path: string, options: { withFileTypes: true }): Promise<Array<{ name: string; isFile(): boolean }>>
  stat(path: string): Promise<{ size: number; mtimeMs: number }>
}

/** 她留在自己目录里的一样东西。 */
export interface WorkItem {
  /** 文件名。 */
  name: string
  /** 字节数。 */
  size: number
  /** 最后改动（ISO 8601）。 */
  updatedAt: string
  /** `text` 能直接看；`image` / `other` 只能看大小（浏览器拿不到宿主的文件）。 */
  kind: 'text' | 'image' | 'other'
  /** 文本预览（最多 4000 字；非文本为空串）。 */
  preview: string
}

/** 哪些扩展名算"能直接看"的文本。 */
const TEXT_EXTENSIONS = new Set(['md', 'txt', 'json', 'csv', 'html', 'css', 'js', 'ts', 'yml', 'yaml', 'log'])
/** 哪些算图片（只报存在与大小）。 */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'])

/**
 * 把字节转成 base64。
 *
 * 不直接用 Buffer：宿主编译没有 @types/node（
ode:fs 那几个函数也是按结构取用的）。
 * @param bytes - 原始字节。
 * @returns base64 字符串。
 */
function base64Of(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** 扩展名 → MIME（下载时告诉浏览器）。 */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  md: 'text/markdown;charset=utf-8',
  txt: 'text/plain;charset=utf-8',
  json: 'application/json;charset=utf-8',
  csv: 'text/csv;charset=utf-8',
  html: 'text/html;charset=utf-8',
  log: 'text/plain;charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
}

/**
 * 读她目录里的一个文件（下载用）。
 *
 * 安全边界三条：名字必须是**顶层文件名**（不许带路径分隔符或 `..`）、必须是 `listWorks`
 * 里真的存在的那个、大小不超过上限。任何一条不满足都返回 `undefined` —— 宁可下载不了，
 * 也不能让一句伪造的名字读到别处的文件。
 * @param deps - 外部事实。
 * @param name - 文件名（只有名字，没有路径）。
 * @param limit - 字节上限（默认 2 MB：base64 之后约 2.7 MB）。
 * @returns base64 与 MIME；不合法或读不到时 `undefined`。
 */
export async function readWork(
  deps: RoomDeps,
  name: string,
  limit = 2 * 1024 * 1024,
): Promise<{ base64: string; mime: string; size: number } | undefined> {
  if (name === '' || name.includes('/') || name.includes('\\') || name.includes('..')) return undefined
  const dir = roomDirOf(deps)
  if (dir === undefined) return undefined
  const items = await listWorks(deps, 80)
  const item = items.find((entry) => entry.name === name)
  if (item === undefined || item.size > limit) return undefined
  try {
    const specifier: string = 'node:fs/promises'
    const fs = (await import(specifier)) as FsPromisesModule & {
      readFile(path: string): Promise<Uint8Array>
    }
    const bytes = await fs.readFile(`${dir}/${name}`)
    const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
    return {
      base64: base64Of(bytes),
      mime: MIME_BY_EXTENSION[extension] ?? 'application/octet-stream',
      size: bytes.byteLength,
    }
  } catch {
    return undefined
  }
}

/**
 * 往她自己的目录里写一个文件（她自己的副本）。
 *
 * 只在**收账**时用：日记的正本在文档表里（工作台按天开合），这里是给她自己看的副本 ——
 * 设计里"她回头重读那一天才发现被翻过"要有可读的东西，而她只能读自己的目录。
 * @param deps - 外部事实。
 * @param name - 顶层文件名（不许带路径）。
 * @param text - 内容。
 * @returns 是否写成（目录拿不到、名字不合法时为 `false`）。
 */
export async function writeOwnFile(deps: RoomDeps, name: string, text: string): Promise<boolean> {
  if (name === '' || name.includes('/') || name.includes('\\') || name.includes('..')) return false
  const dir = roomDirOf(deps)
  if (dir === undefined) return false
  try {
    const specifier: string = 'node:fs/promises'
    const fs = (await import(specifier)) as FsPromisesModule
    await fs.mkdir(dir, { recursive: true })
    await (fs as unknown as { writeFile: (path: string, data: string, encoding: 'utf8') => Promise<void> }).writeFile(
      `${dir}/${name}`,
      text,
      'utf8',
    )
    return true
  } catch {
    return false
  }
}

/**
 * 列她留在自己目录里的东西（只读、只顶层、有条数上限）。
 *
 * 预览只给文本：正文最多 4000 字；图片只报名字与大小（要看图请走 `readWork` 下载）。
 * @param deps - 外部事实。
 * @param limit - 最多几样（按改动时间倒序）。
 * @returns 列表；目录还没建或读不到时是空数组。
 */
export async function listWorks(deps: RoomDeps, limit = 20): Promise<WorkItem[]> {
  const dir = roomDirOf(deps)
  if (dir === undefined) return []
  try {
    const specifier: string = 'node:fs/promises'
    const fs = (await import(specifier)) as FsPromisesModule
    const entries = await fs.readdir(dir, { withFileTypes: true })
    const files = entries.filter((entry) => entry.isFile() && !entry.name.startsWith('.')).slice(0, 80)
    const items: WorkItem[] = []
    for (const file of files) {
      const full = `${dir}/${file.name}`
      let info: { size: number; mtimeMs: number }
      try {
        info = await fs.stat(full)
      } catch {
        continue
      }
      const extension = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase() : ''
      const isImage = IMAGE_EXTENSIONS.has(extension)
      const isText = TEXT_EXTENSIONS.has(extension)
      let preview = ''
      if (isText && info.size <= 64_000) {
        try {
          preview = (await fs.readFile(full, 'utf8')).slice(0, 4000)
        } catch {
          preview = ''
        }
      }
      items.push({
        name: file.name,
        size: info.size,
        updatedAt: new Date(info.mtimeMs).toISOString(),
        kind: isText ? 'text' : isImage ? 'image' : 'other',
        preview,
      })
    }
    return items
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit)
  } catch {
    return []
  }
}

/**
 * 读她手上的"未完成清单"。
 *
 * 为什么用文件而不是新表／新工具：她本来就有读写自己目录的能力（沉浸预设里开着）。
 * 一份 `todo.md` 就是最朴素的线索账 —— 她能读、能改、能勾掉，不需要我们再发明一个工具。
 * 读不到（还没建）就当空的：不替她编内容。
 * @param deps - 外部事实。
 * @returns 清单的每一行（去掉空行与标题行，最多 8 行）。
 */
export async function readThreads(deps: RoomDeps, limit = 8): Promise<string[]> {
  const dir = roomDirOf(deps)
  if (dir === undefined) return []
  try {
    const specifier: string = 'node:fs/promises'
    const fs = (await import(specifier)) as FsPromisesModule
    const text = await fs.readFile(`${dir}/todo.md`, 'utf8')
    return text
      .split('\n')
      .map((line) => line.replace(/^\s*[-*]\s*/, '').trim())
      .filter((line) => line !== '' && !line.startsWith('#'))
      // 她自己写的分栏标题（"已经做完的："）不是待办 —— 真机 2026-11-25 它被当成一条空事念了出来。
      .filter((line) => !/[:：]\s*$/.test(line))
      .slice(0, limit)
  } catch {
    return []
  }
}

/** 确保房间目录存在；失败只记日志（目录没建成也不阻止排程）。 */
async function ensureRoomDir(deps: RoomDeps): Promise<string | undefined> {
  const dir = roomDirOf(deps)
  if (dir === undefined) {
    deps.log.warn('读不到 $DSH_HOME，她的房间没有固定目录（将使用 Host 默认目录）')
    return undefined
  }
  try {
    const specifier: string = 'node:fs/promises'
    const fs = (await import(specifier)) as FsPromisesModule
    await fs.mkdir(dir, { recursive: true })
    return dir
  } catch (error) {
    deps.log.warn('她的房间目录建不出来（排程照常，文件可能写不进）', error)
    return undefined
  }
}

/**
 * 把一次视图结果读成房间状态。
 * @param task - `view` / `create` / `edit` 返回的任务；找不到时带 `code`。
 * @returns 房间状态；`undefined` = 任务不存在。
 */
function roomOf(task: ScheduleTaskLike | undefined): RoomState | undefined {
  if (task === undefined) return undefined
  if (typeof task.code === 'string') return undefined
  const id = typeof task.id === 'string' ? task.id : ''
  if (id === '') return undefined
  return {
    taskId: id,
    sessionId: typeof task.target?.sessionId === 'string' ? task.target.sessionId : '',
    nextAt:
      typeof task.nextScheduledAt === 'string' && task.nextScheduledAt !== ''
        ? task.nextScheduledAt
        : typeof task.scheduledAt === 'string'
          ? task.scheduledAt
          : '',
    active: task.active !== 'paused' && task.active !== 'ended',
  }
}

/**
 * 开出她的房间（一个只属于她的会话）。
 *
 * ### 为什么从 Agent 注册表开
 *
 * 真机两条路都断了（2026-11-23）：
 * - 调度服务的 `new_once` → `This Host cannot create Sessions; choose an existing Session target.`
 * - `ctx.sessionController.create` → 那个服务对插件**不可见**（诊断：`sessionController=no`）
 *
 * 而 `ctx.agents` 看得见，它能按我们给的会话 id 建"会话 + Agent"。房间因此是一个
 * **由本插件持有的 Agent**：句柄活着，会话就活着；句柄释放，会话还在（内容已持久化）。
 *
 * @param deps - 外部事实。
 * @param knownSessionId - 上次开出来的会话 id（空串 = 还没开过）。
 * @returns 会话 id 与需要一直持有的句柄；失败时给人话原因。
 */
export async function ensureRoom(
  deps: RoomDeps,
  knownSessionId: string,
): Promise<{ ok: true; sessionId: string; handle?: AgentHandleLike } | { ok: false; reason: string }> {
  const registry = deps.agents()
  if (registry === undefined) return { ok: false, reason: '这个部署没有 Agent 注册表（agents 不在）' }
  // 已经活着：直接复用（重启后 Agent 会没，但会话还在，走下面的 resume）。
  if (knownSessionId !== '' && registry.get(knownSessionId) !== undefined) {
    return { ok: true, sessionId: knownSessionId }
  }
  if (knownSessionId !== '') {
    try {
      const resumed = await registry.resume({ resumeSessionId: knownSessionId })
      deps.log.info(`她的房间已恢复（会话 ${knownSessionId}）`)
      return { ok: true, sessionId: knownSessionId, handle: resumed }
    } catch (error) {
      // 恢复不了就重开一间：房间是"她的地方"，丢了不该让她从此不再有日子。
      deps.log.warn(`她的房间恢复失败，将重开一间（旧会话 ${knownSessionId}）`, error)
    }
  }
  const cwd = await ensureRoomDir(deps)
  const sessionId = `session-${globalThis.crypto.randomUUID()}`
  try {
    const handle = await registry.create({
      sessionId,
      ...(cwd === undefined ? {} : { meta: { cwd, agentPreset: HUMANITY_PRESET_ID } }),
    })
    deps.log.info(`她的房间已开出（会话 ${sessionId}）`)
    return { ok: true, sessionId, handle }
  } catch (error) {
    deps.log.warn('她的房间没开出来（这次不排程）', error)
    return { ok: false, reason: `新建会话被拒绝：${describeError(error)}` }
  }
}

/**
 * 认领一个**已经存在**的房间任务。
 *
 * 为什么需要：状态文档可能丢（真机 2026-11-24 就被工作台投影覆盖过一次）。丢了就重建的话，
 * 旧房间会留在那儿没人管、闹钟越积越多。所以先找：同标题的任务里挑**最早的那个**（那是她的
 * 老房间，里面有她的东西），其余同标题的暂停掉。
 * @param deps - 外部事实。
 * @returns 认领到的房间；没有就 `undefined`。
 */
export async function adoptTask(deps: RoomDeps): Promise<RoomState | undefined> {
  const service = deps.schedule()
  if (service === undefined) return undefined
  let tasks: ScheduleTaskLike[]
  try {
    tasks = await service.catalog()
  } catch {
    return undefined
  }
  const mine = tasks
    .filter((task) => task.title === ROOM_TASK_TITLE && typeof task.code !== 'string')
    .sort((left, right) => String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? '')))
  const kept = mine[0]
  if (kept === undefined) return undefined
  // 多出来的（同标题）暂停：不删，免得误删你手建的同类任务；它们不会再喊她。
  for (const extra of mine.slice(1)) {
    await setActive(deps, String(extra.id ?? ''), false)
  }
  deps.log.info(`认领了已有的房间任务 ${String(kept.id ?? '')}`)
  return roomOf(kept)
}

/**
 * 确保房间里有一个任务，并把它排到下一次。
 *
 * 顺序：已有任务 → 直接沿用；没有 → 在**已存在的房间会话**上建一个任务。
 * @param deps - 外部事实。
 * @param taskId - 已知的任务 id（空串 = 认为还没有）。
 * @param sessionId - 房间的会话 id（必须已存在：这个部署不允许任务自己建会话）。
 * @param gapSeconds - 下一次隔多少秒。
 * @param prompt - 醒来时她要看到的那段话。
 * @returns 结果。
 */
export async function ensureTask(
  deps: RoomDeps,
  taskId: string,
  sessionId: string,
  gapSeconds: number,
  prompt: string,
  title: string = ROOM_TASK_TITLE,
): Promise<RoomOutcome> {
  const service = deps.schedule()
  if (service === undefined) return { ok: false, reason: '调度服务不在（DSH 没装或没启用它会话调度）' }
  if (sessionId === '') return { ok: false, reason: '还没有她的房间（会话 id 为空）' }
  const existing = taskId === '' ? undefined : roomOf(await service.view({ id: taskId }).catch(() => undefined))
  if (existing !== undefined) return { ok: true, room: existing }
  try {
    const created = await service.create({
      title,
      prompt,
      timing: { kind: 'after', after_seconds: gapSeconds },
      target: { kind: 'session', sessionId },
    })
    const room = roomOf(created)
    if (room === undefined) return { ok: false, reason: '调度服务没有返回新建的任务' }
    return { ok: true, room }
  } catch (error) {
    deps.log.warn('她的房间没建成（这次不排程）', error)
    return { ok: false, reason: `新建定时任务被拒绝：${describeError(error)}` }
  }
}

/**
 * 读一次任务的当前样子（用于 `create` 没回报下一次时间时补读）。
 * @param deps - 外部事实。
 * @param taskId - 任务 id。
 * @returns 房间状态；任务不存在或调度服务缺席时为 `undefined`。
 */
export async function inspectRoom(deps: RoomDeps, taskId: string): Promise<RoomState | undefined> {
  const service = deps.schedule()
  if (service === undefined || taskId === '') return undefined
  return roomOf(await service.view({ id: taskId }).catch(() => undefined))
}

/**
 * 把下一次醒来排到 `gapSeconds` 之后。
 * @param deps - 外部事实。
 * @param taskId - 任务 id。
 * @param gapSeconds - 间隔秒数。
 * @returns 结果（成功时带刷新后的房间状态）。
 */
export async function reschedule(
  deps: RoomDeps,
  taskId: string,
  gapSeconds: number,
  prompt?: string,
): Promise<RoomOutcome> {
  const service = deps.schedule()
  if (service === undefined) return { ok: false, reason: '调度服务不在' }
  if (taskId === '') return { ok: false, reason: '还没有房间任务' }
  try {
    const edited = await service.edit({
      id: taskId,
      action: 'update',
      patch: {
        timing: { kind: 'after', after_seconds: gapSeconds },
        active: true,
        // 下一次醒来看到的那段话随"上次做到哪"一起改：连续性靠它，不靠她的记性。
        ...(prompt === undefined ? {} : { prompt }),
      },
    })
    const room = roomOf(edited)
    if (room === undefined) return { ok: false, reason: '任务已经不存在（下次醒来时会重建）' }
    return { ok: true, room }
  } catch (error) {
    deps.log.warn('下一次醒来的时间没排上（这次不排程）', error)
    return { ok: false, reason: '修改定时任务被拒绝（详见日志）' }
  }
}

/**
 * 让任务进入/退出活动状态。
 *
 * 关掉模块时**暂停**任务而不是删掉：重开时不用重建房间，会话与 id 都还在。
 * @param deps - 外部事实。
 * @param taskId - 任务 id。
 * @param active - 是否活动。
 */
/**
 * 删掉一个调度任务。
 *
 * 为什么需要：她的房间**每天是一个新会话**，旧会话的那个任务不能留着 ——
 * 留着它就会往昨天的会话里投递，等于她被拉回昨天。
 * 之前只会"暂停"，任务列表里于是越积越多（源码里 `edit` 支持 `action: 'delete'`）。
 * @param deps - 外部事实。
 * @param taskId - 任务 id。
 */
export async function deleteTask(deps: RoomDeps, taskId: string): Promise<void> {
  const service = deps.schedule()
  if (service === undefined || taskId === '') return
  try {
    await service.edit({ id: taskId, action: 'delete' })
  } catch (error) {
    deps.log.warn('旧任务没能删掉（不影响她今天）', error)
  }
}

/**
 * 把一个任务改成投到别的会话。
 * @param deps - 外部事实。
 * @param taskId - 任务 id。
 * @param sessionId - 新的投递会话。
 * @returns 改成功了吗。
 */
export async function retarget(deps: RoomDeps, taskId: string, sessionId: string): Promise<boolean> {
  const service = deps.schedule()
  if (service === undefined || taskId === '' || sessionId === '') return false
  try {
    await service.edit({ id: taskId, action: 'update', patch: { target: { kind: 'session', sessionId } } })
    return true
  } catch (error) {
    deps.log.warn('房间任务没能改到新会话', error)
    return false
  }
}

export async function setActive(deps: RoomDeps, taskId: string, active: boolean): Promise<void> {
  const service = deps.schedule()
  if (service === undefined || taskId === '') return
  try {
    await service.edit({ id: taskId, action: 'update', patch: { active } })
  } catch (error) {
    deps.log.warn(active ? '房间任务没能恢复' : '房间任务没能暂停', error)
  }
}
