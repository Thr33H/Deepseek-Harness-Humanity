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
import { ROOM_DIR } from './constants.js'
import { dayLogFileName } from './diary.js'

/** 调度服务里我们用到的那部分（结构化声明，不固化 DSH 的类型面）。 */
interface ScheduleTaskLike {
  id?: string
  title?: string
  kind?: string
  createdAt?: string
  active?: string
  /** 循环任务的下一次。 */
  nextScheduledAt?: string
  /** 单次的到点时刻。 */
  scheduledAt?: string
  target?: { kind?: string; sessionId?: string }
  code?: string
  /** 存储里的样子（`catalog` 返回摊平的，`view`/`create` 里见过嵌套的）。 */
  record?: {
    id?: string
    title?: string
    kind?: string
    scheduledAt?: string
    target?: { kind?: string; sessionId?: string }
  }
}

/**
 * 从一条调度任务里读出我们关心的字段。
 *
 * ⚠️ **两种形状都要认**：存储里是 `{ record: { id, title, kind, scheduledAt }, target }`，
 * 而 `catalog()` 返回的是摊平的 `{ id, title, kind, scheduledAt, target }`
 * （类型面就是这么声明的：`ScheduleCatalogEntry = ScheduleRecord & {...}`）。
 * 只按一种读，另一半永远是空 —— 真机 2026-11-26 的后果是"认领不到已有卡片"，
 * 于是每跑一次就新建一张，任务列表越攒越多。
 * @param task - 调度服务/存储给的那条任务。
 * @returns 认得的字段（读不到的给空串）。
 */
export function taskFields(task: unknown): {
  id: string
  title: string
  kind: string
  scheduledAt: string
  sessionId: string
} {
  const outer = (typeof task === 'object' && task !== null ? task : {}) as Record<string, unknown>
  const inner = (typeof outer.record === 'object' && outer.record !== null ? outer.record : {}) as Record<string, unknown>
  const pick = (key: string): string => {
    const flat = outer[key]
    if (typeof flat === 'string' && flat !== '') return flat
    const nested = inner[key]
    return typeof nested === 'string' ? nested : ''
  }
  const target = (typeof outer.target === 'object' && outer.target !== null
    ? outer.target
    : typeof inner.target === 'object' && inner.target !== null
      ? inner.target
      : {}) as Record<string, unknown>
  return {
    id: pick('id'),
    title: pick('title'),
    kind: pick('kind'),
    scheduledAt: pick('scheduledAt'),
    sessionId: typeof target.sessionId === 'string' ? target.sessionId : '',
  }
}

/** `ctx.get('schedule')` 读到的服务。 */
export interface ScheduleServiceLike {
  create(request: unknown, actorSessionId?: string, signal?: AbortSignal): Promise<ScheduleTaskLike>
  view(request: { id: string }): Promise<ScheduleTaskLike>
  edit(request: unknown, actorSessionId?: string, signal?: AbortSignal): Promise<ScheduleTaskLike>
  /** 全部任务（"认领"已有房间时用）。 */
  catalog(): Promise<ScheduleTaskLike[]>
  /**
   * 立刻投一次（界面上的"立即执行"）。
   *
   * 关键性质（查源码确认）：**不消耗、也不移动**原来排的时间。
   * 所以卡片可以建成"2099 年才到点"=永远不自己响，什么时候投完全由插件决定。
   */
  run(request: { id: string }, signal?: AbortSignal): Promise<unknown>
}


/**
 * 一个工作区（`workspaceRegistry` 建出来/查出来的那一个）。
 *
 * 只声明我们用到的两样：身份（记住"挂过没挂过"）与挂载动作。
 * 挂载是**唯一的归属入口** —— 不挂，会话就落进侧栏的"未分组"。
 */
export interface WorkspaceLike {
  readonly id: string
  readonly title: string
  attachSession(sessionId: string): Promise<void>
}

/**
 * 工作区注册表（`ctx.get('workspaceRegistry')`）。
 *
 * `create` 遇到同一个目录只会返回已有那条（不会建重复），`resolveByPath` 只查不建 ——
 * 所以"先查再建"是安全的，重复调用也不会多出工作区。
 */
export interface WorkspaceRegistryLike {
  create(path: string, title?: string): Promise<WorkspaceLike>
  resolveByPath(path: string): Promise<WorkspaceLike | undefined>
}

/** 一个已受管的 Agent 句柄（我们只用它的会话与释放能力）。 */
export interface AgentHandleLike {
  agent?: { session?: { id?: string } }
  dispose?: () => void
}

/**
 * 开会话时一并交出去的模型（`AgentOptions` 的那一部分）。
 *
 * 为什么必须要：平台要求"要么开会话时带 provider/model，要么会话里存过选择"。
 * 插件开的会话没人点开过，也不会有选择 —— 不带这一项，第一轮就是
 * `agent "…" has no provider/model set`，她一句话都说不出来（真机 2026-11-26）。
 */
export interface RoomAgentOptions {
  provider: string
  model: string
  reasoningEffort?: string
}

/** Agent 注册表里我们用到的那部分（`ctx.get('agents')`）。 */
export interface AgentRegistryLike {
  create(options: {
    sessionId: string
    meta?: { cwd?: string; agentPreset?: string }
    agentOptions?: RoomAgentOptions
  }): Promise<AgentHandleLike>
  get(sessionId: string): unknown
  resume(options: {
    resumeSessionId: string
    agentOptions?: RoomAgentOptions
  }): Promise<AgentHandleLike>
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
  /** 工作区注册表（`workspaceRegistry`；缺席时房间照开，只是不进侧栏分组）。 */
  workspaces(): WorkspaceRegistryLike | undefined
  /**
   * 开会话时要带的模型（部署默认选择；读不到时 `undefined`）。
   *
   * 平台默认**不会**给插件开的会话配模型：房间没人手动点开，也就没有"存过的选择"。
   */
  modelSelection(): RoomAgentOptions | undefined
  /** `$DSH_HOME`（现读）。 */
  homeDir(): string | undefined
  /**
   * 把预设**真正挂到**那个 agent 上（`agentPresets.select`）。
   *
   * ⚠️ 这是必需品，不是优化。`create({ meta: { agentPreset } })` 只记了"这个会话叫什么预设"，
   * 预设里的插件（文件工具、联网、present、定时任务）**一个都没挂上** —— 平台要求开会话后、
   * 第一轮之前调一次 `select`。真机 2026-11-27/28 两天没写成日记，就是她连 `read`/`write`
   * 都没有：她那一轮的工具清单只有 11 个（微信、窗口目录、留话、记忆…），没有文件工具。
   * @param agent - 那个 agent。
   * @returns 选成了没有（拿不到服务或失败时为 `false`，调用方只记日志）。
   */
  selectPreset?(agent: unknown): Promise<boolean>
  /** 配置里"她的房间"那一格（原样，现读）。 */
  roomSetting(): string
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

/** 老位置（没填"她的房间"时用的那个）：`$DSH_HOME/humanity/room`。 */
export function legacyRoomDirOf(deps: RoomDeps): string | undefined {
  const home = deps.homeDir()
  if (home === undefined || home.trim() === '') return undefined
  return `${trimTrailingSlashes(home)}/${ROOM_DIR}`
}

/** 去掉结尾的分隔符（根路径 `/` 保留）。 */
function trimTrailingSlashes(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  return trimmed === '' ? '/' : trimmed
}

/** 是不是一条绝对路径（POSIX 的 `/`、Windows 的盘符或 UNC）。 */
function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(path)
}

/**
 * 只看形状：这段文字能不能当"她的房间"用（不需要 `$DSH_HOME`，所以界面那侧也能先拦一道）。
 * @param text - 配置原文。
 * @returns 问题；没问题时 `undefined`。
 */
export function roomTextProblem(text: string): string | undefined {
  const trimmed = text.trim()
  if (trimmed === '' || isAbsolutePath(trimmed)) return undefined
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    return '名字里不能带斜杠：想指定位置，请写完整路径（例如 /data/dsh/她的房间）'
  }
  return undefined
}

/**
 * 把配置里那一格解成一个绝对目录。
 *
 * 规则只有一条：**以 `/`（或盘符）开头就是路径，否则整个当成名字**。
 * 名字不允许带分隔符 —— 带了说明他想指定位置，那就该写完整路径，不能靠猜。
 * @param configured - 配置原文。
 * @param home - `$DSH_HOME`（现读）。
 * @returns 解出来的目录；解不出来时给出人话原因。
 */
export function resolveRoomDir(
  configured: string,
  home: string | undefined,
): { ok: true; path: string } | { ok: false; reason: string } {
  const text = configured.trim()
  if (text === '') return { ok: false, reason: '没有填' }
  const problem = roomTextProblem(text)
  if (problem !== undefined) return { ok: false, reason: problem }
  if (isAbsolutePath(text)) return { ok: true, path: trimTrailingSlashes(text) }
  const base = home === undefined ? '' : trimTrailingSlashes(home.trim())
  if (base === '') return { ok: false, reason: '读不到 $DSH_HOME，填名字时没法定位；请直接写完整路径' }
  return { ok: true, path: `${base}/humanity/rooms/${text}` }
}

/**
 * 她的房间**应该**在哪个目录（配置的现读解释）。
 *
 * 与 `roomDirOf` 的区别只有一个：解不出来时给的是原因，而不是 `undefined` ——
 * 排程那一步要把它写进状态，外面才看得见"为什么没搬成"。
 * @param deps - 外部事实。
 * @returns 绝对目录；解不出来时给人话原因。
 */
export function wantedRoomDirOf(deps: RoomDeps): { ok: true; path: string } | { ok: false; reason: string } {
  const configured = deps.roomSetting().trim()
  if (configured !== '') return resolveRoomDir(configured, deps.homeDir())
  const legacy = legacyRoomDirOf(deps)
  if (legacy === undefined) return { ok: false, reason: '读不到 $DSH_HOME' }
  return { ok: true, path: legacy }
}

/**
 * 她的房间目录。
 *
 * 填了"她的房间"就用它解出来的那个；没填就还是老位置 —— 保证升级后不搬家。
 * @param deps - 外部事实。
 * @returns 绝对目录；没有 `$DSH_HOME` 又没填路径时为 `undefined`。
 */
export function roomDirOf(deps: RoomDeps): string | undefined {
  const wanted = wantedRoomDirOf(deps)
  return wanted.ok ? wanted.path : undefined
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
 * 她手上那条线索账的文件名。
 *
 * 名字不能随手改：她自己也读写它（醒来词里就是这么念的），改一次她就找不到自己写的东西了。
 * 搬房间时（`rotateRoom`）要凭它把这份"没做完的事"带到新目录。
 */
export const THREADS_FILE = 'todo.md'

/**
 * 往当天的全量记录里追加一行。
 *
 * 为什么要这个：日记材料是插件抄的摘要，**有上限**（她房里的 40 行、你们的对话 60 行），
 * 长的一天开头会被挤掉。用户 2026-11-27 定：她要能看到"今天发生过的所有事"，
 * 自己去检索、自己挑，而不是只看我挑的那几十行。
 * @param deps - 外部事实。
 * @param date - 哪一天（她的时区）。
 * @param line - 原文（不截断：截断是摘要那一份的事）。
 * @param clock - 这一条发生时的**她那边**的时刻（`HH:MM`，由调用方按她的时区算好）。
 * @returns 写成了没有。
 */
export async function appendDayLog(
  deps: RoomDeps,
  date: string,
  line: string,
  clock: string,
): Promise<boolean> {
  if (date === '' || line.trim() === '') return false
  const dir = roomDirOf(deps)
  if (dir === undefined) return false
  const name = dayLogFileName(date)
  try {
    const specifier: string = 'node:fs/promises'
    const fs = (await import(specifier)) as FsPromisesModule & {
      appendFile(path: string, data: string, encoding: 'utf8'): Promise<void>
    }
    await fs.mkdir(dir, { recursive: true })
    const header = `${dir}/${name}`
    let exists = false
    try {
      await fs.stat(header)
      exists = true
    } catch {
      exists = false
    }
    if (!exists) {
      await fs.writeFile(
        header,
        `# ${date} 今天发生的事\n\n（这是自动记下来的全部记录，没有挑拣：她的房间、你们说过的话。时间是她那边的本地时间。）\n\n`,
        'utf8',
      )
    }
    const clockText = clock.trim() === '' ? '' : `- ${clock.trim()} `
    await fs.appendFile(header, `${clockText}${line.replace(/\s+/g, ' ').trim()}\n`, 'utf8')
    return true
  } catch (error) {
    deps.log.warn(`当天记录没写进去（${date}）`, error)
    return false
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
    const text = await fs.readFile(`${dir}/${THREADS_FILE}`, 'utf8')
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
  const configured = deps.roomSetting().trim()
  const dir = roomDirOf(deps)
  if (dir === undefined) {
    deps.log.warn(
      configured === ''
        ? '读不到 $DSH_HOME，她的房间没有固定目录（将使用 Host 默认目录）'
        : `"她的房间"填的「${configured}」解不出目录（将使用 Host 默认目录）`,
    )
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
  const fields = taskFields(task)
  if (fields.id === '') return undefined
  return {
    taskId: fields.id,
    sessionId: fields.sessionId,
    nextAt: fields.scheduledAt,
    active: task.active !== 'paused' && task.active !== 'ended',
  }
}

/**
 * 把一个会话挂到它目录所属的工作区上（侧栏分组就是这么来的）。
 *
 * 为什么要"先查再建"：`create` 只认**已经存在**的目录（它要 realpath），而且同一个目录
 * 重复调用只会返回已有那条 —— 所以"没有就建"是安全的，不会越积越多。
 *
 * 挂载为什么不能省：工作区的成员是**单独记的**（侧栏读的是那份记录，不是会话的目录）。
 * 只开会话不挂，她就落在"未分组"里 —— 这正是升级前她一直在的地方。
 * @param deps - 外部事实。
 * @param dir - 房间目录（绝对路径，且已经建好）。
 * @param sessionId - 要挂进去的会话。
 * @returns 工作区 id；注册表缺席或挂载被拒时为 `undefined`（房间照常用）。
 */
export async function attachToWorkspace(
  deps: RoomDeps,
  dir: string,
  sessionId: string,
): Promise<string | undefined> {
  const registry = deps.workspaces()
  if (registry === undefined) {
    deps.log.warn('这个部署没有工作区注册表（workspaceRegistry 不在）：她会落在侧栏的"未分组"里，其余照常')
    return undefined
  }
  try {
    const existing = await registry.resolveByPath(dir).catch(() => undefined)
    const workspace = existing ?? (await registry.create(dir, workspaceTitleOf(dir)))
    await workspace.attachSession(sessionId)
    deps.log.info(`她住进了工作区「${workspace.title}」（${dir}）`)
    return workspace.id
  } catch (error) {
    // 挂不上不是致命的：会话照常能跑，只是不出现在工作区分组里。
    deps.log.warn(`房间没能挂到工作区上（她会落在"未分组"里）：${describeError(error)}`)
    return undefined
  }
}

/**
 * 工作区显示名：目录的最后一段。
 * @param dir - 绝对目录。
 * @returns 名字；根目录回退成目录本身。
 */
function workspaceTitleOf(dir: string): string {
  const trimmed = trimTrailingSlashes(dir)
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return index === -1 ? trimmed : trimmed.slice(index + 1) || trimmed
}

/**
 * 把一个文件从旧房间目录带到新房间目录（搬家时用）。
 *
 * 为什么需要：她"正在写的那一天"有两份文件在房间里 —— 材料（插件写的）和她写的日记。
 * 房间一换目录，这两份就留在旧目录里，收账会以为"还没写"，她白写一遍、或者这一天就丢了。
 * 所以搬房间时把它们**复制**过去；旧目录里的原件不动（她那边的东西一律不删）。
 * @param deps - 外部事实。
 * @param name - 顶层文件名（不许带路径）。
 * @param fromDir - 旧目录。
 * @param toDir - 新目录。
 * @returns 带过去了为 `true`；旧目录里没有这个文件也算成功（没什么要带的）。
 */
export async function carryRoomFile(
  deps: RoomDeps,
  name: string,
  fromDir: string,
  toDir: string,
): Promise<boolean> {
  if (name === '' || name.includes('/') || name.includes('\\') || name.includes('..')) return false
  if (fromDir === '' || toDir === '' || fromDir === toDir) return false
  try {
    const specifier: string = 'node:fs/promises'
    const fs = (await import(specifier)) as FsPromisesModule & {
      readFile(path: string): Promise<Uint8Array>
      writeFile(path: string, data: Uint8Array): Promise<void>
    }
    const bytes = await fs.readFile(`${fromDir}/${name}`)
    await fs.mkdir(toDir, { recursive: true })
    await fs.writeFile(`${toDir}/${name}`, bytes)
    return true
  } catch {
    // 文件不存在（她还没写）或读不到：都不是错误，别打断搬家。
    return false
  }
}

/**
 * 把一个会话叫醒（恢复成活的 agent），**永远带着部署默认模型**。
 *
 * 为什么要收成一处：平台只对"在界面里开出来"的会话落一个模型选择；插件自己的会话没有。
 * 之前有三个地方各自 `resume({resumeSessionId})`，哪个忘了带模型，那一轮就
 * `has no provider/model`（真机 2026-11-26 连挂两次：先是我们开会话的地方，后是投递前的叫醒）。
 * 现在只剩这一个入口，忘不了。
 * @param deps - 外部事实。
 * @param sessionId - 要叫醒的会话。
 * @returns 那个会话的句柄。
 */
export async function resumeAgent(deps: RoomDeps, sessionId: string): Promise<AgentHandleLike> {
  const registry = deps.agents()
  if (registry === undefined) throw new Error('这个部署没有 Agent 注册表（agents 不在）')
  const agentOptions = deps.modelSelection()
  const resumed = await registry.resume({
    resumeSessionId: sessionId,
    ...(agentOptions === undefined ? {} : { agentOptions }),
  })
  await attachPreset(deps, resumed)
  return resumed
}

/**
 * 把预设挂到这个 agent 上（拿不到服务、或它自己失败时只记日志）。
 *
 * 为什么不抛错：挂不上只是"她少几件工具"，房间本身还能用；把整间房判失败更糟。
 * @param deps - 外部事实。
 * @param handle - 刚建/刚恢复的那个 agent 句柄。
 */
async function attachPreset(deps: RoomDeps, handle: AgentHandleLike | undefined): Promise<void> {
  if (deps.selectPreset === undefined || handle?.agent === undefined) return
  try {
    const ok = await deps.selectPreset(handle.agent)
    if (!ok) deps.log.warn('预设没挂上：她这一轮会缺文件工具（读写文件都要它）')
  } catch (error) {
    deps.log.warn('预设没挂上（select 抛错）', error)
  }
}

/**
 * 那个会话现在忙不忙 —— **问 agent 自己**。
 *
 * 为什么不能靠自己的活动账本判：账本在进程里，重启之后是空的，于是"从没动过"被当成"闲着"。
 * 真机 2026-11-26 就是这一条：投递撞进了一个刚被我们自己开出来的空轮，卡片进了"下一轮"，
 * 而她再没有下一轮 —— 她根本没看到"该写日记了"。
 * @param deps - 外部事实。
 * @param sessionId - 目标会话。
 * @returns 忙为 `true`、闲为 `false`、不知道（没有活的 agent）为 `undefined`。
 */
export function agentBusy(deps: RoomDeps, sessionId: string): boolean | undefined {
  const registry = deps.agents()
  if (registry === undefined || sessionId === '') return undefined
  const agent = registry.get(sessionId) as { status?: unknown } | undefined
  if (agent === undefined || agent === null) return undefined
  return agent.status === 'running'
}

/**
 * 等那个会话空下来。
 *
 * 有 `whenIdle()` 就等它（那是 agent 自己的承诺，比轮询准），没有就轮询状态。
 * @param deps - 外部事实。
 * @param sessionId - 目标会话。
 * @param timeoutMs - 最多等多久。
 * @returns 闲下来了为 `true`；超时 `false`。
 */
export async function waitAgentIdle(deps: RoomDeps, sessionId: string, timeoutMs: number): Promise<boolean> {
  if (sessionId === '') return true
  const registry = deps.agents()
  const agent = registry?.get(sessionId) as { status?: unknown; whenIdle?: unknown } | undefined
  // 没有活的 agent：投递会自己把它拉起来，不存在"撞进正在跑的一轮"这件事。
  if (agent === undefined || agent === null) return true
  if (agent.status !== 'running') return true
  if (typeof agent.whenIdle === 'function') {
    const idle = (agent as { whenIdle(): Promise<void> }).whenIdle()
    const timeout = new Promise<'timeout'>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), timeoutMs) as unknown as { unref?: () => void }
      timer.unref?.()
    })
    const outcome = await Promise.race([idle.then(() => 'idle' as const), timeout])
    return outcome === 'idle'
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2_000) as unknown as { unref?: () => void }
      timer.unref?.()
    })
    if (agentBusy(deps, sessionId) !== true) return true
  }
  return false
}

/** 一个活的 agent 里我们用到的那部分（`ctx.agents.get()` 拿到的那个）。 */
interface LiveAgentLike {
  id?: string
  status?: unknown
  followup?(message: unknown): void
  whenIdle?(): Promise<void>
}

/**
 * 直接把她要收到的那条消息交给那个会话的 agent。
 *
 * 为什么不再让调度服务去投：它投递时把消息排进"下一轮"，然后指望有人去开这一轮 ——
 * 真机 2026-11-26 反复验证下来，那个"下一轮"经常永远不来（投递记录有了，她一个字都没收到）。
 * 平台的 `followup` 是"排进下一轮 + 立刻把 driver 叫起来"，这是唯一不会丢的路。
 *
 * 消息来源仍标成 `schedule`：会话里长得和平台的「自动化任务」块一样（用户口径）。
 * @param deps - 外部事实。
 * @param sessionId - 目标会话。
 * @param text - 她这一次要看到的那段话。
 * @param timeoutMs - 等她手头那一轮结束最多多久。
 * @returns 发出去了没有；没发出去给原因。
 */
export async function deliverToAgent(
  deps: RoomDeps,
  sessionId: string,
  text: string,
  timeoutMs = 180_000,
): Promise<{ ok: boolean; reason?: string }> {
  const registry = deps.agents()
  if (registry === undefined) return { ok: false, reason: '这个部署没有 Agent 注册表（agents 不在）' }
  if (sessionId === '') return { ok: false, reason: '没有目标会话' }
  let agent = registry.get(sessionId) as LiveAgentLike | undefined
  if (agent === undefined) {
    try {
      const handle = await resumeAgent(deps, sessionId)
      agent = (handle as { agent?: LiveAgentLike }).agent
    } catch (error) {
      return { ok: false, reason: `叫不醒会话：${describeError(error)}` }
    }
  }
  if (agent === undefined || typeof agent.followup !== 'function') {
    return { ok: false, reason: '这个 agent 不能收消息（followup 不在）' }
  }
  // 她手头这一轮还没跑完：等它（否则消息会排在"下一轮"，而下一轮未必来）。
  if (agent.status === 'running') {
    const quiet = await waitAgentIdle(deps, sessionId, timeoutMs)
    if (!quiet) return { ok: false, reason: '会话一直没安静下来（等不到可以投的时刻）' }
  }
  try {
    agent.followup(createScheduleMessage(text))
  } catch (error) {
    return { ok: false, reason: `投递失败：${describeError(error)}` }
  }
  /**
   * 核对：投完她应该**在跑一轮**。不跑就是没收到（这正是"投递记录有了、她却没看到"的形状）。
   */
  const deadline = Date.now() + 10_000
  for (;;) {
    if (agent.status === 'running') return { ok: true }
    if (Date.now() >= deadline) return { ok: false, reason: '消息投出去了，但她没有开始这一轮' }
    await sleep(500)
  }
}

/**
 * 造一条"来源是调度"的用户消息（会话里会显示成「自动化任务」块）。
 *
 * 形状照抄宿主（见 `@deepseek-ai/dsh-llm` 的 `createUserMessage`）：展开输入、现铸一个 id、
 * 深冻结 —— 宿主把它当不可变对象。
 * @param text - 消息正文。
 * @returns 可以交给 `followup` 的消息。
 */
function createScheduleMessage(text: string): unknown {
  const message = {
    id: globalThis.crypto.randomUUID(),
    role: 'user' as const,
    content: [{ type: 'text' as const, text }],
    source: { kind: 'schedule' as const },
  }
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return
    Object.freeze(value)
    for (const key of Object.keys(value)) freeze((value as Record<string, unknown>)[key])
  }
  freeze(message)
  return message
}

/** 等一会儿（不挂住进程）。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms) as unknown as { unref?: () => void }
    timer.unref?.()
  })
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
 * @returns 会话 id、它落在哪个目录、挂在哪个工作区（后两个可能为空）；失败时给人话原因。
 */
export async function ensureRoom(
  deps: RoomDeps,
  knownSessionId: string,
): Promise<
  | { ok: true; sessionId: string; handle?: AgentHandleLike; dir?: string; workspaceId?: string }
  | { ok: false; reason: string }
> {
  const registry = deps.agents()
  if (registry === undefined) return { ok: false, reason: '这个部署没有 Agent 注册表（agents 不在）' }
  /**
   * 房间的模型：用部署默认选择。
   *
   * 每次都现读（对方可能在设置里换过默认模型）；读不到就不带 —— 那一轮会像从前一样报
   * "没有模型"，但至少不会假装成功。
   */
  const agentOptions = deps.modelSelection()
  // 已经活着：直接复用（重启后 Agent 会没，但会话还在，走下面的 resume）。
  if (knownSessionId !== '' && registry.get(knownSessionId) !== undefined) {
    return { ok: true, sessionId: knownSessionId }
  }
  if (knownSessionId !== '') {
    try {
      const resumed = await resumeAgent(deps, knownSessionId)
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
      ...(agentOptions === undefined ? {} : { agentOptions }),
    })
    // 只记了预设名不算挂上：预设里的插件（文件工具等）要靠这一次 select 才会装进来。
    await attachPreset(deps, handle)
    deps.log.info(`她的房间已开出（会话 ${sessionId}）`)
    /**
     * 挂工作区只在她**真的有自己的目录**时做：
     *
     * 没填"她的房间"时用的是老位置，那是插件内部的事，不该悄悄往侧栏里多一个工作区；
     * 填了就是明确要求"她住在这里"，那就登记并挂上。
     */
    const configured = deps.roomSetting().trim() !== ''
    const workspaceId = configured && cwd !== undefined ? await attachToWorkspace(deps, cwd, sessionId) : undefined
    return {
      ok: true,
      sessionId,
      handle,
      ...(cwd === undefined ? {} : { dir: cwd }),
      ...(workspaceId === undefined ? {} : { workspaceId }),
    }
  } catch (error) {
    deps.log.warn('她的房间没开出来（这次不排程）', error)
    return { ok: false, reason: `新建会话被拒绝：${describeError(error)}` }
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
 * 一张"永远不自己响"的卡片用的时间。
 *
 * 为什么是 2099：DSH 建任务必须给一个时间；给一个远到不会到来的时刻，
 * 这张卡片就只是一条**通道**，什么时候投完全由插件用 `run` 决定。
 */
export const DORMANT_RRULE = 'DTSTART;TZID=Asia/Shanghai:20991231T120000\nRRULE:FREQ=DAILY;COUNT=1'

/**
 * 建一张"停着的卡片"（不会自己触发）。
 * @param deps - 外部事实。
 * @param title - 面板上显示的名字。
 * @param prompt - 首次投递要用的正文（之后每次投之前都会改）。
 * @param sessionId - 投到哪个会话。
 * @param timeZone - 她的时区（决定 2099 那个锚点的时区）。
 * @returns 建好的卡片；失败给 `undefined` 与原因。
 */
export async function createDormantTask(
  deps: RoomDeps,
  title: string,
  prompt: string,
  sessionId: string,
  timeZone?: string,
): Promise<{ ok: true; taskId: string } | { ok: false; reason: string }> {
  const service = deps.schedule()
  if (service === undefined) return { ok: false, reason: '调度服务不在' }
  if (sessionId === '') return { ok: false, reason: '还没有可投的会话' }
  const zone = timeZone === undefined || timeZone.trim() === '' ? 'Asia/Shanghai' : timeZone.trim()
  try {
    const created = await service.create({
      title,
      prompt,
      timing: { kind: 'rrule', rrule: DORMANT_RRULE.replace('Asia/Shanghai', zone) },
      target: { kind: 'session', sessionId },
    })
    const room = roomOf(created)
    if (room === undefined || room.taskId === '') return { ok: false, reason: '建出来的卡片没有 id' }
    return { ok: true, taskId: room.taskId }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}
