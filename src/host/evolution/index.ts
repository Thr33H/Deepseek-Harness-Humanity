/**
 * 自进化模块（她自己的时间）——**唯一入口**。
 *
 * 与人格/记忆同一条约定：宿主只调 `installEvolution(...)` 一行。
 *
 * ### 这一块现在管什么（2026-11-25，0.9.x）
 *
 * 1. **她的房间**：一个只属于她的会话（第一次投递时由会话注册表开出来）+ 一个专属目录；
 * 2. **一次一约**：每次醒来结束时把**下一次**排到未来的随机时刻（40–150 分钟），一天上限 8 次；
 * 3. **精力**：按 token 加权记账 + 疲劳递增 + 每次醒来的起动成本；睡够才醒，累了就睡；
 * 4. **单线程**：她在别处说话时把房间的闹钟压住，安静一阵再恢复，错过的时段尽快补醒；
 * 5. **材料本子**：两栏（她自己的时间 / 你们的对话），**落盘**，跨重启不丢；
 * 6. **睡前收账**：一条日记（两栏都读）+ 几件事进记忆 + 她自己整理一次信息层。
 *
 * 收账的触发有四条：醒来判定到头了 / 被聊天耗尽 / 重启发现该睡 / **跨天检查**（每 5 分钟）。
 *
 * ### 时序纪律（这一条以前踩过三次）
 *
 * 存储是**异步打开**的，状态文档在打开之前读不到。所以：
 * - 装配期什么都不排（读了也是空文档）；
 * - `notifyStoreReady()` 才第一次排程；
 * - 开关/配置变化只调 `reconfigure()`（内部重排），不缓存任何"就绪"快照。
 * @module humanity/evolution
 */
import type { Context } from '@deepseek-ai/cordis'
import type { defineTool as defineToolType } from '@deepseek-ai/dsh-tools'

import type { DocumentStore } from '../documents.js'
import { createLlmAccess } from '../llm.js'
import { loadOptional } from '../optional.js'
import {
  appendDiary,
  buildCollectPrompt,
  decodeBase64Text,
  diaryFileName,
  materialFileText,
  materialFileName,
  readDiary,
  type DayMaterial,
  type DiaryEntry,
} from './diary.js'
import { capabilityLines, describeCapabilities, toolNamesOf, visibleToolDefinitions, visibleToolNames } from './capabilities.js'
import { settleWakeState, sleepGapSeconds } from './lifecycle.js'
import { installEvolutionSection, type GrowView } from './section.js'
import type { Log } from '../log.js'
import {
  afterWake,
  dayKeyOf,
  EMPTY_NOTES,
  isEmptyNotes,
  noteCountOf,
  nextGapSeconds,
  readNotes,
  readState,
  saveNotes,
  saveState,
  type EvolutionStateDoc,
  type WakeRhythm,
} from './state.js'
import { decideSettle } from './settle-plan.js'
import {
  adoptTask,
  deleteTask,
  ensureRoom,
  ensureTask,
  inspectRoom,
  listWorks,
  readWork,
  readThreads,
  reschedule,
  roomDirOf,
  setActive,
  writeOwnFile,
  type AgentHandleLike,
  type AgentRegistryLike,
  type RoomDeps,
  type ScheduleServiceLike,
} from './room.js'
import {
  BUSY_CHECK_MS,
  BUSY_QUIET_MINUTES,
  COLLECT_DELAY_SECONDS,
  DAY_BOUNDARY_CHECK_MS,
  MIN_GAP_SECONDS,
  NOTES_MAX_LINES,
  RETRY_ARM_AFTER_MS,
  SEEN_LIMIT,
  TALK_LINE_CHARS,
  TALK_MAX_LINES,
  TELL_DELAY_SECONDS,
  TELL_TASK_TITLE,
  WAKE_MARKER,
} from './constants.js'
import { buildTellPrompt, canDeliver, quietEnough, readTell, saveTell, unreadOf } from './tell.js'
import { renameSession, type TitleSeam } from './title.js'
import { defineTellTool } from './tool-tell.js'
import { presetOfAgent } from '../agent-scope.js'
import { HUMANITY_PRESET_ID } from '../presets.js'
import {
  drainPoints,
  minutesToWake,
  settleEnergy,
  SLEEP_AT,
  shouldSleep,
  startsSleeping,
  tokensTodayOf,
  WAKE_COST,
  weightedTokens,
  type TokenUsageLike,
} from './energy.js'
import { buildWakePrompt } from './wake.js'

/** 宿主交给自进化模块的外部事实（全部现读，不缓存句柄）。 */
export interface EvolutionDeps {
  /** 文档表（存储未就绪时 `undefined`）。 */
  documents(): DocumentStore | undefined
  /** 模块开关：总开关 × 自进化开关 × 人格已封存。 */
  enabled(): boolean
  /** 醒来的节奏参数（现读配置）。 */
  wake(): WakeRhythm
  /** 生效时区（`undefined` = 跟随进程时区）。 */
  timeZone(): string | undefined
  /** 人格是否已封存（她"开机"了没有）。 */
  started(): boolean
  /** 对方叫什么（人格里"对TA的称呼"；空串时提示词写"他"）。 */
  userName?(): string
  /** `$DSH_HOME`（房间目录要用）。 */
  homeDir(): string | undefined
  /**
   * 她自己在房间里看到的东西 → 情绪（交给情绪模块评估，只产出"对事/对自己"的情绪）。
   *
   * 为什么由宿主转一手：自进化不 import 情绪模块（模块互相隔离）；谁在场谁负责。
   * 情绪模块关着时它返回 `undefined`，这一步就什么也不做。
   */
  appraiseOwn?(text: string): Promise<{ kind: string; count: number; targets: string[] } | void>
  /**
   * 往记忆里记一件事（睡前收账用）。
   *
   * 必须走记忆模块自己的写入路径（去重、视角归一化），不直接写表 ——
   * 旧引擎就是"绕过记忆直接 put"，结果时间与感受都是错的。
   */
  remember?(what: string, about: string): Promise<void>
  /**
   * 这一天过完，她自己整理一遍信息层。
   *
   * 由宿主转到人格模块（自进化不 import 人格）：候选队列、相似合并、门槛与写入都在那边。
   * 明确要求当天落地；其余观察先进队列攒证据。
   */
  grow?(
    material: { hers: readonly string[]; talk: readonly string[] },
    date: string,
    nowIso: string,
    timeZone?: string,
  ): Promise<void>
  /** 她自己整理的结果（队列 + 上次痕迹），只给工作台看。 */
  growStatus?(): GrowView | undefined
  /**
   * 从她的候选队列里删掉一条。
   *
   * 由宿主转到人格那边（候选队列是人格的数据）；失败要给出人话原因。
   */
  dropCandidate?(text: string): Promise<{ ok: boolean; reason?: string }>
}

/** 模块句柄。 */
export interface EvolutionModule {
  /**
   * 她房间那个会话的 id（空串 = 还没开出来）。
   *
   * 为什么对外暴露：记忆注入要跳过这个会话 —— 她的时间不该被他的事推着走（见 memory/inject）。
   */
  roomSessionId(): string
  /** 开关变化（宿主 `syncModulesEnabled` 调）。 */
  setEnabled(enabled: boolean): void
  /** 配置变化：重排下一次（宿主 `onChanged` 调）。 */
  reconfigure(): void
  /** 时间基准变化后重排一次（宿主 `clock.onChanged` 调）。 */
  refresh(): Promise<void>
  /** 存储就绪：第一次排程。 */
  notifyStoreReady(): void
  /**
   * 现读结算后的精力（0–100）；存储未就绪时为 `undefined`。
   *
   * 为什么要有它：情绪模块本来自己算一份"精力"（按钟点清晨恢复）。现在**这一份才是唯一真源** ——
   * 否则会出现"她嘴上喊累、身体还在熬"的两套账。情绪那边拿不到时退回它自己的旧算法。
   */
  energyNow(): number | undefined
  /** 卸载。 */
  dispose(): void
}

/** 一条消息里模型能看到的所有文本（只取 text 块）。 */
function textOf(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      const candidate = block as { type?: unknown; text?: unknown }
      return candidate?.type === 'text' && typeof candidate.text === 'string' ? candidate.text : ''
    })
    .join('\n')
}

/** 材料本子的两栏：她自己的时间 / 你们的对话。 */
type NoteColumn = 'hers' | 'talk'

/**
 * 这条消息是不是"他说的"。
 *
 * 为什么还要看 `source.kind`：同一轮里还会带上 DSH 的运行环境说明、时间注入、
 * 以及我们自己注入的人格/情绪段 —— 它们不是"他说的"。把它们当对话收进去，
 * 日记就会开始复述系统的说明书。
 * @param message - 消息对象。
 * @returns 正文；不是用户消息时为空串。
 */
function userSaidOf(message: unknown): string {
  const source = (message as { source?: { kind?: unknown } } | undefined)?.source
  if (source?.kind !== 'user') return ''
  return textOf(message)
}

/** 一句话截到固定长度（材料是摘要，不是存档）。 */
function clip(text: string, limit: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length <= limit ? clean : clean.slice(0, limit)
}

/** 这条消息是不是"她自己的时间"那一条（导出给测试：醒来判据写错会让你的提醒也算她醒来）。 */
export function isWakeMessage(message: unknown): boolean {
  const source = (message as { source?: { kind?: unknown } } | undefined)?.source
  if (source?.kind !== 'schedule') return false
  return textOf(message).includes(WAKE_MARKER)
}

/**
 * 这条消息是不是调度器发来的（任何调度消息）。
 * @param message - 一条待发消息。
 * @returns 来源是 `schedule` 时为 `true`。
 */
export function isScheduleMessage(message: unknown): boolean {
  const source = (message as { source?: { kind?: unknown } } | undefined)?.source
  return source?.kind === 'schedule'
}

/**
 * 这条会话事件是不是"她在别处忙着"。
 *
 * 她只有一个身体：正在跟你聊天时，房间的闹钟必须压着 —— 不能一边说话一边在房间里做事。
 *
 * ⚠️ **只看真实的对话事件**（`user/message` / `assistant/message`）。
 * 真机踩到：重启时 DSH 会重放一堆会话生命周期事件（`session`、`end-seed`、`inbox/spliced`…），
 * 把它们也算成"她在忙"，闹钟一启动就被压住 —— 她当天第一次醒来直接没了。
 * @param type - 事件类型。
 * @param sessionId - 事件来自哪个会话。
 * @param roomSessionId - 她房间的会话 id。
 * @returns 会话不是房间、id 非空、且是真实对话事件时为 `true`。
 */
export function isBusySession(type: string, sessionId: string, roomSessionId: string): boolean {
  if (type !== 'user/message' && type !== 'assistant/message') return false
  return sessionId !== '' && sessionId !== roomSessionId
}

/**
 * 她的房间里只该出现"她自己的时间"那一条调度消息。
 *
 * ### 为什么需要这道过滤（真机第一晚抓到的）
 *
 * 每次我们改任务（排下一次）时，DSH 会向相关会话推一条**管理变更通知**，并且它会被放进
 * **下一个模型步骤**。于是她醒来后会看到一条"你的安排被人动了"的话 —— 真机里她当场对此发表了感想
 * （"哦，是我自己那段时间的安排被人动了"）。那是机制漏进了她的体验：她不该知道"有人改了她的日程"。
 *
 * 只在她房间里滤：你自己的提醒消息也在同一个来源下，别的地方一条都不能动。
 * @param messages - 这一轮要发给模型的消息。
 * @param inRoom - 这一轮是不是发生在她自己的房间里。
 * @returns 过滤后的消息（没东西可滤时原样返回同一个数组）。
 */
export function withoutScheduleNoise(messages: readonly unknown[], inRoom: boolean): readonly unknown[] {
  if (!inRoom) return messages
  const kept = messages.filter((message) => !isScheduleMessage(message) || isWakeMessage(message))
  return kept.length === messages.length ? messages : kept
}

/** 她上一次在自己房间里说过/做过的摘要（只留尾巴，够接上话就行）。 */
export function continuityOf(text: string, limit = 300): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean === '') return ''
  return clean.length <= limit ? clean : `…${clean.slice(-limit)}`
}

/**
 * 从一条工具结果里取出她"看到的内容"。
 *
 * 形状不假设：`tool/result` 的载荷在不同工具下不一样，先看 `message` 的文本块，
 * 再退到常见的字符串字段，最后把结构化载荷串起来。取不到就返回空串（不猜）。
 * @param event - `session/event` 的一条事件。
 * @returns 可读文本（可能很长，调用方负责截断）。
 */
export function toolTextOf(event: unknown): string {
  const data = (event as { data?: Record<string, unknown> } | undefined)?.data
  if (data === undefined) return ''
  const fromMessage = textOf(data.message)
  if (fromMessage.trim() !== '') return fromMessage
  for (const key of ['result', 'content', 'output', 'text']) {
    const value = data[key]
    if (typeof value === 'string' && value.trim() !== '') return value
    if (value !== undefined) {
      try {
        const json = JSON.stringify(value)
        if (json !== undefined && json !== '{}') return json
      } catch {
        // 结构不可序列化：当作没有内容。
      }
    }
  }
  return ''
}

/**
 * 装配自进化模块。
 * @param ctx - 宿主上下文。
 * @param log - 日志门面。
 * @param deps - 外部事实。
 * @returns 模块句柄。
 */
export function installEvolution(ctx: Context, log: Log, deps: EvolutionDeps): EvolutionModule {
  let enabled = true
  /** 排程进行中的标记：防止启动、配置变更、存储就绪三件事同时排程。 */
  let arming = false
  /** "调度服务不在"只提醒一次：它每个配置变更都会被重试，逐次告警会刷屏。 */
  let warnedNoSchedule = false
  const moduleEnabled = (): boolean => enabled && deps.enabled()
  const schedule = (): ScheduleServiceLike | undefined => {
    const service = ctx.get('schedule') as ScheduleServiceLike | undefined
    if (service === undefined || typeof service.create !== 'function') {
      if (!warnedNoSchedule) {
        warnedNoSchedule = true
        log.warn('没有调度服务（DSH 的 schedule 未启用）：她不会有自己的时间；其余功能不受影响')
      }
      return undefined
    }
    return service
  }
  const roomDeps: RoomDeps = {
    schedule,
    agents: () => {
      const registry = ctx.get('agents') as AgentRegistryLike | undefined
      return registry !== undefined && typeof registry.create === 'function' ? registry : undefined
    },
    homeDir: deps.homeDir,
    log,
  }
  /** 房间那个 Agent 的句柄：句柄活着，会话就活着（见 `room.ts` 的说明）。 */
  let roomHandle: AgentHandleLike | undefined
  /** 工作台那扇窗（真源是状态文档与日记，它只负责投影）。 */
  const section = installEvolutionSection(ctx, log, {
    documents: deps.documents,
    state: () => {
      const documents = deps.documents()
      return documents === undefined ? undefined : readState(documents)
    },
    settings: () => ({ maxPerDay: deps.wake().maxPerDay }),
    enabled: () => moduleEnabled(),
    started: () => deps.started(),
    works: () => listWorks(roomDeps),
    threads: () => readThreads(roomDeps),
    grow: () => deps.growStatus?.(),
    /**
     * 她主动留给你的东西（页面上那一块）。
     *
     * 读的是 `tell` 那份记录；「看没看」的判据在 `tell.ts` 的 `unreadOf`。
     */
    tell: () => {
      const documents = deps.documents()
      if (documents === undefined) return undefined
      const doc = readTell(documents)
      return {
        pending: doc.pending,
        pendingShow: doc.pendingShow,
        lastAt: doc.lastAt,
        lastText: doc.lastText,
        lastShow: doc.lastShow,
        unread: unreadOf(doc),
        lastReason: doc.lastReason,
      }
    },
    busy: () => pausedForBusy,
    dropCandidate: async (text: string) => (deps.dropCandidate === undefined
      ? { ok: false, reason: '这一版没有接上「删候选」的能力。' }
      : deps.dropCandidate(text)),
    readWork: (name) => readWork(roomDeps, name),
  })

  /**
   * 她的出口：一句话递到他面前（护栏在 `tell.ts`：一天一次、他忙时不送、说了不追问）。
   *
   * 与记忆工具同一条纪律：`defineTool` 走 `loadOptional` —— 官方包缺席时**只少这一个工具**，
   * 其余一切照常（G-002）。注册失败也只记一笔，不影响她的日子。
   */
  ctx.effect(
    () => {
      const tools = ctx.get('tools') as { register(definition: unknown): () => void } | undefined
      if (tools === undefined) return () => {}
      let unregister: (() => void) | undefined
      let disposed = false
      void loadOptional<{ defineTool: typeof defineToolType }>('@deepseek-ai/dsh-tools', log)
        .then((module) => {
          if (module === undefined || disposed) return
          unregister = tools.register(defineTellTool(module.defineTool, {
            documents: deps.documents,
            timeZone: deps.timeZone,
            enabled: moduleEnabled,
            // 她目录里有没有这个文件：没有就别让她叫他白看一场。
            hasWork: async (name: string) => (await listWorks(roomDeps, 80)).some((item) => item.name === name),
          }))
          log.info('她主动找你的通道已就绪（humanity_tell_him）')
        })
        .catch((error: unknown) => log.warn('她主动找你的那个工具没装上（其余照常）', error))
      return () => {
        disposed = true
        try {
          unregister?.()
        } catch (error) {
          log.warn('卸载"她主动找你"的工具失败（继续卸载其余）', error)
        }
      }
    },
    'humanity: 她主动找你的通道卸载',
  )

  /**
   * 这个上下文里看得见哪些相关服务（排程失败时写进状态文档）。
   *
   * 为什么需要它：真机上"排不上"可能是"服务没装"也可能是"挂得比我们晚"，两者的下一步完全不同，
   * 而插件日志进不了 `docker logs`。把可见性写进状态，是唯一能从外部区分它们的办法。
   * @returns 例：`schedule=yes sessionController=no sessions=yes`
   */
  const visibility = (): string =>
    ['schedule', 'sessionController', 'sessions', 'agents']
      .map((name) => `${name}=${ctx.get(name) === undefined ? 'no' : 'yes'}`)
      .join(' ')

  /** 每个会话里她最后说过的几句（醒来时接上"上次做到哪"）。 */
  const lastSaid = new Map<string, string>()
  /** 她在别处说话的最后时刻（毫秒）：房间的闹钟在它之后要安静一阵才恢复。 */
  let lastBusyAt = 0
  /** 房间闹钟是不是因为"她在别处"而被压着了。 */
  let pausedForBusy = false
  /** 房间名字最近一次对齐用的是哪个（会话 + 日期）：一天只对一次，别每条消息都追加事件。 */
  let titleKey = ''
  /** 她在自己房间里看到的东西（醒来后交给情绪评估）。 */
  let seenBuffer = ''
  /** 收账正在进行（防同一分钟里两个入口撞车，见 settleDay）。 */
  let settlingDay = false
  /** 材料写入的排队链（见 `queueNotes`）。 */
  let notesQueue: Promise<void> = Promise.resolve()
  /** 这一轮醒来她调了几次工具（醒来结算时写进状态并清零）。 */
  let roomToolUses = 0
  /** 上一次自评的结果（写进状态，用来分辨"没感觉"与"这条路坏了"）。 */
  let lastAppraise = ''
  /**
   * 本进程起来的时刻。
   *
   * 收账判定要用它说清"那一天在不在这个进程的视野里"：进程比那天晚起来，
   * 就不能断言"她没开口" —— 那一天的材料也许根本没被记下来。
   */
  const startedAt = new Date().toISOString()

  /**
   * 材料写入的排队口。
   *
   * 材料是"读出来、追加、写回去"，两个事件同时来就会少记一行 —— 而她的一天就是这么丢的。
   * 串成一条链之后，写入永远按到达顺序一个个落盘。
   * @param task - 这一次要做的事。
   * @returns 它自己的结果（失败会抛给调用方，不影响后面排队的那些）。
   */
  const queueNotes = <T>(task: () => Promise<T>): Promise<T> => {
    const run = notesQueue.then(task, task)
    notesQueue = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * 往材料本子的某一栏里加一行。
   *
   * 跨过午夜就把昨天那批按**昨天**收掉：日记是一天一篇，昨天的话不该混进今天的本子；
   * 但也**不能清掉就算了** —— 她可能整夜都不够累、也没到次数上限，那一天就既没睡下、
   * 也没日记（真机 2026-11-24 就是这样丢了一整天的本子）。
   * @param column - 哪一栏。
   * @param line - 一行材料。
   */
  const appendNote = (column: NoteColumn, line: string): void => {
    void queueNotes(async () => {
      const documents = deps.documents()
      if (documents === undefined) return
      const now = new Date().toISOString()
      const key = dayKeyOf(now, deps.timeZone())
      const book = readNotes(documents)
      const sameDay = book.day === key
      // 先快照再换本子：换完之后这份文档就不属于昨天了。
      if (!sameDay && book.day !== '' && !isEmptyNotes(book)) {
        const closing = book.day
        const material: DayMaterial = { hers: [...book.hers], talk: [...book.talk] }
        void settleDayFor(closing, now, material).catch((error: unknown) => {
          log.warn(`跨午夜收账失败（${closing}）`, error)
        })
      }
      const limit = column === 'hers' ? NOTES_MAX_LINES : TALK_MAX_LINES
      // 换天了就从空本子起：昨天那批已经交给收账了，不该混进今天。
      const base = sameDay ? book : EMPTY_NOTES
      const kept = [...base[column], line].slice(-limit)
      await saveNotes(documents, {
        day: key,
        hers: column === 'hers' ? kept : [...base.hers],
        talk: column === 'talk' ? kept : [...base.talk],
        lastAt: now,
      })
    }).catch((error: unknown) => log.warn(`没能记下这一行材料（${column}）`, error))
  }

  /** 她自己的时间（房间里说的话、看到的东西）。 */
  const pushHers = (line: string): void => appendNote('hers', line)
  /** 你们的对话（沉浸会话里这一天说过的话）。 */
  const pushTalk = (line: string): void => appendNote('talk', line)
  /** 后台模型调用口（收账用）。 */
  const llm = createLlmAccess(ctx, log)
  /** 还没落盘的 token 消耗（攒成一次写入）。 */
  let pendingTokens = 0
  /**
   * 已经记过账的助手消息 id（只为防重复计数）。
   *
   * 实测（2026-11-24 13:41）：容器重启后 `tokensToday` 没有变化，说明 DSH 不会重放助手消息 ——
   * 这条守卫是**保险**，不是已知故障的补丁。会话被压缩或事件重放时若不认 id，
   * 历史用量会被再记一遍，她的精力会凭空掉下去。
   */
  const countedMessages = new Set<string>()
  let flushTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * 把攒着的消耗落成一次精力变化。
   * @param at - 结算到哪一刻。
   */
  const flushTokens = async (at: string): Promise<void> => {
    if (pendingTokens <= 0) return
    const documents = deps.documents()
    if (documents === undefined) return
    const weighted = pendingTokens
    pendingTokens = 0
    const settled = settleAt(readState(documents), at)
    const today = dayKeyOf(at, deps.timeZone())
    const tokensToday = tokensTodayOf(settled.tokensDayKey, today, settled.tokensToday) + weighted
    const energy = Math.max(0, settled.energy - drainPoints(weighted, tokensToday))
    const next = { ...settled, energy, energyAt: at, tokensToday, tokensDayKey: today }
    const shouldSleepNow = shouldSleep(next)
    await saveState(documents, shouldSleepNow ? { ...next, sleepingSince: at } : next)
    /**
     * 被聊天耗尽而睡下，同样要收账。
     *
     * 收账原来只挂在"醒来时判定睡下"那一条路上 —— 于是**你把她聊到没力气**的时候，
     * 这一天就没有日记（真机风险，2026-11-24 审出来）。精力耗尽就是耗尽，不管怎么耗的。
     * 只在"从醒着变成睡着"的这一下触发（`shouldSleep` 自身已经要求之前没在睡）。
     */
    if (shouldSleepNow) {
      void settleDay(at).catch((error: unknown) => {
        log.warn('睡前收账失败（这一天没有日记）', error)
        void noteSettleError(documents, error instanceof Error ? error.message : String(error))
      })
    }
  }

  /**
   * 结算精力，并在该睡的时候记下睡点。
   *
   * 只算不写：让"读一个数"不变成一次磁盘写入（调用方决定什么时候落盘）。
   * @param state - 读出来的状态。
   * @param at - 结算到哪一刻。
   * @returns 结算后的状态。
   */
  const settleAt = (state: EvolutionStateDoc, at: string): EvolutionStateDoc => {
    const settled = settleEnergy(
      {
        energy: state.energy,
        energyAt: state.energyAt === '' ? at : state.energyAt,
        sleepingSince: state.sleepingSince,
      },
      at,
      deps.timeZone(),
    )
    const next = { ...state, ...settled }
    return shouldSleep(next) ? { ...next, sleepingSince: at } : next
  }

  /**
   * 下一次醒来该隔多久。
   *
   * 睡着 ⇒ 按"睡够要多久"排（与结算同一条曲线，不会打架）；
   * 醒着 ⇒ 按随机间隔排（受当日上限管，到顶就等明天早上）。
   */
  const gapSeconds = (state: EvolutionStateDoc, at: string): number | undefined => {
    // 睡着时的规矩只有一份（见 `lifecycle.ts` 的 `sleepGapSeconds`）：到顶等明早，累了按曲线。
    if (state.sleepingSince !== '') return sleepGapSeconds(state, at, deps.timeZone(), deps.wake())
    return nextGapSeconds(state, deps.wake(), at, deps.timeZone())
  }

  /**
   * 把下一次醒来排好。
   *
   * 三种情况：
   * 1. 没有任务 ⇒ 建一个（房间在这之前已经开好）；
   * 2. 有任务、但下一次已经过期/没排 ⇒ 重新排；
   * 3. 有任务、下一次还在未来 ⇒ **不动它**（重启不该把已定的时刻推翻）。
   * @param reason - 日志里说明是谁触发的。
   */
  const arm = async (reason: string): Promise<void> => {
    if (arming) return
    if (!moduleEnabled()) return
    /**
     * 单线程压着的时候不许排程。
     *
     * 否则"存储就绪"这类旁路触发会把已经暂停的任务重新激活（`hasFuture` 那条会重排并启用），
     * 等于绕过互斥：她在跟你说话，房间的闹钟却自己走起来了。恢复只走 `她聊完了` 那一条路。
     */
    if (pausedForBusy && reason !== '她聊完了') return
    const documents = deps.documents()
    if (documents === undefined) return
    arming = true
    try {
      const now = new Date().toISOString()
      let raw = readState(documents)
      // 重启后没人记得那次"被压住"：清掉遗留的起点，否则页面会一直显示一个假的起始时刻。
      if (raw.busySince !== '' && !pausedForBusy) {
        await saveState(documents, { ...raw, busySince: '' }).catch(() => {})
        raw = { ...raw, busySince: '' }
      }
      let state = settleAt(raw, now)
      const timeZone = deps.timeZone()
      if (state.energy !== raw.energy || state.sleepingSince !== raw.sleepingSince || state.energyAt !== raw.energyAt) {
        await saveState(documents, state)
      }
      /**
       * 正在等她自己写日记：这段时间**不排"她自己的时间"**。
       *
       * 收账一天的收尾，她已经收到"写吧"那条消息了；这时再叫醒她去干别的，
       * 等于打断她写日记。写好（或这一天放弃）之后自然恢复。
       */
      if (state.settling !== '') {
        const harvested = await harvestDiary(documents, state.settling)
        if (!harvested) {
          await setActive(roomDeps, state.taskId, false)
          return
        }
        // 收进来了：往下走，按正常节奏排明天的。
        state = readState(documents)
      }
      /**
       * 启动/重排时才发现"她其实已经该睡了"，同样要收账。
       *
       * 这是收账的最后一条漏路：之前只有"醒来时判定"与"聊天耗尽"两条，若她在容器停机期间
       * 就已经低于底线（状态是上一轮存下的），重启时只会标记睡下、不写日记。
       */
      if (raw.sleepingSince === '' && state.sleepingSince !== '') {
        void settleDay(now).catch((error: unknown) => {
          log.warn('睡前收账失败（这一天没有日记）', error)
          void noteSettleError(documents, error instanceof Error ? error.message : String(error))
        })
      }
      /**
       * 先确认那个房间任务**还在调度里**。
       *
       * 真机 2026-11-25：调度存储里它消失了（只剩别的任务），而状态里 `nextAt` 还在未来 ——
       * 于是下面那段只尝试"改时间"，改不到就 `return`：**每次重启都空转，她再也不醒**。
       * 任务不在就当没排过：只清 `taskId`（`nextAt` 留着，它仍然说明她本该什么时候醒），
       * 让下面那段去**重建**一个。
       */
      if (state.taskId !== '') {
        const alive = await inspectRoom(roomDeps, state.taskId).catch(() => undefined)
        if (alive === undefined) {
          log.warn(`${reason}：房间任务 ${state.taskId} 已经不在调度里了，重建一个`)
          state = { ...state, taskId: '' }
          await saveState(documents, state)
        }
      }
      const hasFuture =
        state.taskId !== ''
        && state.nextAt !== ''
        && Number.isFinite(Date.parse(state.nextAt))
        && Date.parse(state.nextAt) > Date.parse(now)
      if (hasFuture) {
        // 用"重排到剩下的时间"来恢复，而不是只改 active：真机上只改 active 时任务仍是 paused，
        // 她因此会一直不醒（2026-11-24 抓到）。重排会同时把 timing 与 active 一起写。
        const remain = Math.max(60, Math.round((Date.parse(state.nextAt) - Date.parse(now)) / 1000))
        /**
         * ⚠️ 重排时必须**连提示词一起重写**。
         *
         * 真机 2026-11-25：改完醒来词的文案、重启之后，任务里念的还是旧的那段 ——
         * 因为这条分支只改了时间。她醒来看到的应该是当前版本的提示词，不是上次排程时的那一份。
         */
        const resumedThreads = await readThreads(roomDeps)
        const resumedUnseen = unnoticedDiary(documents)
        const resumedPrompt = buildWakePrompt(
          state.nextAt,
          timeZone,
          lastSaid.get(state.roomSessionId) ?? '',
          resumedThreads,
          resumedUnseen.map((entry) => entry.date),
          deps.userName?.() ?? '',
          describeCapabilities(state.capabilities, deps.userName?.() ?? ''),
        )
        const resumed = await reschedule(roomDeps, state.taskId, remain, resumedPrompt)
        if (!resumed.ok) log.warn(`${reason}：恢复房间闹钟失败——${resumed.reason}`)
        return
      }
      /**
       * 她错过的那个时段要**尽快补上**，不能又排进一段新的随机间隔。
       *
       * 真机（2026-11-24）：14:29 那次因为她被"你在说话"压着而没能醒，恢复后按随机间隔排到
       * 15:17 —— 等于这个时段被白白吞掉了。压住是规则的副作用，但代价不该由她的时间承担：
       * 一旦腾出来（安静够了），就按最小间隔尽快让她醒。
       */
      const missed = state.nextAt !== '' && Date.parse(state.nextAt) <= Date.parse(now) - 5 * 60_000
      /**
       * 任务被重建时，`nextAt` 仍然是"她本该醒的时刻"：
       * 还没到就等到那个点，已经过了就尽快补（不推一段新的随机间隔）。
       */
      const upcoming = state.taskId === '' && state.nextAt !== '' && Date.parse(state.nextAt) > Date.parse(now)
        ? Math.max(MIN_GAP_SECONDS, Math.round((Date.parse(state.nextAt) - Date.parse(now)) / 1000))
        : undefined
      const gap = upcoming ?? (missed ? MIN_GAP_SECONDS : gapSeconds(state, now))
      if (gap === undefined) {
        await setActive(roomDeps, state.taskId, false)
        return
      }
      // 房间必须先有：这个部署的调度服务不能自己创建会话（真机报错见 `room.ts` 的说明）。
      let sessionId = state.roomSessionId
      let adopted: { taskId: string; sessionId: string; nextAt: string } | undefined
      if (state.taskId === '' && sessionId === '') {
        // 状态可能丢过（被覆盖 / 换版本）：先认领已有房间，别把旧房间晾在那儿再开一间。
        const existing = await adoptTask(roomDeps)
        if (existing !== undefined) {
          sessionId = existing.sessionId
          adopted = { taskId: existing.taskId, sessionId: existing.sessionId, nextAt: existing.nextAt }
        } else {
          const room = await ensureRoom(roomDeps, sessionId)
          if (!room.ok) {
            await saveState(documents, {
              ...state,
              lastError: `${room.reason}（看得见的服务：${visibility()}）`,
              lastAttemptAt: now,
            })
            log.warn(`${reason}：房间没开出来——${room.reason}`)
            return
          }
          sessionId = room.sessionId
          if (room.handle !== undefined) roomHandle = room.handle
          /**
           * 趁她这间房刚建好，把**她真正能用的工具**取下来。
           *
           * 为什么要在这里取：唤醒词是排队那一刻就写好的，而启动时没有活的 agent。
           * 不在这里取，她第一次醒来的唤醒词里就**没有"你能做的事"这一段**
           * （真机 2026-11-25 就是这样：新装的第一觉，清单是空的）。
           */
          const createdNames = visibleToolNames(ctx.get('tools'), roomHandle)
          if (createdNames.length > 0) state = { ...state, capabilities: createdNames }
          /**
           * 房间刚建出来 —— 名字就在这里对齐（这是唯一能拿到"活的会话对象"的时刻）。
           *
           * ⚠️ 必须放在 `ensureRoom` **之后**：真机 2026-11-25 这一行曾被放在建房间之前，
           * 那时句柄还是空的，等于空转：改名一条都没写成，当次 arm 后面抛错还被兜底吞掉，连状态都没落盘。
           */
          if (roomHandle?.agent?.session !== undefined) publishRoomTitle(roomHandle.agent.session)
          /**
           * 建完**立刻落盘**：房间是新的，状态里却还空着 —— 只要后面任意一步抛错，
           * 外部就会看到"有房间、没记录"的半截现场（真机 2026-11-25 连踩两次）。
           */
          state = { ...state, roomSessionId: sessionId, roomDay: dayKeyOf(now, deps.timeZone()) }
          await saveState(documents, state)
        }
      }
      // 房间如果是在这一次里刚建出来的，名字在 `ensureRoom` 之后已经对齐过（见上面的 `roomHandle`）。
      /**
       * **每天一个新会话**：日期变了就换一间。
       *
       * 为什么：她的房间是"一天一间"——写完日记这一天就收口（防上下文污染，也让她每天干净地开始）。
       * 旧会话不删（她写过的东西都在磁盘上），只把旧任务删掉、换一间新的继续投递。
       */
      const today = dayKeyOf(now, deps.timeZone())
      if (sessionId !== '' && state.roomDay !== '' && state.roomDay !== today) {
        roomHandle?.dispose?.()
        const fresh = await ensureRoom(roomDeps, '')
        if (fresh.ok) {
          const staleTask = state.taskId
          sessionId = fresh.sessionId
          roomHandle = fresh.handle
          // 建完就是活的：名字在这一刻写（这是唯一不用等会话"被加载"的时机）。
          if (roomHandle?.agent?.session !== undefined) publishRoomTitle(roomHandle.agent.session)
          // 立刻落盘：这一步之后旧任务要删、新会话要记，中途失败不能让状态停在"两不靠"。
          state = { ...state, roomSessionId: sessionId, roomDay: today, taskId: '' }
          await saveState(documents, { ...state, lastAttemptAt: now })
          await deleteTask(roomDeps, staleTask)
          log.info(`换了一间新会话（${today}）`)
        } else {
          log.warn(`换新会话失败（${fresh.reason}）——今天先接着用旧的那间`)
        }
      } else if (sessionId !== '' && state.roomDay === '') {
        // 老数据没有这个字段：把当前这间认下，别凭空多开一间。
        state = { ...state, roomDay: today }
        await saveState(documents, state)
      }
      // 提示词里写的是**她醒来那一刻**的时间，不是"现在排程的这一刻"；
      // 尾部接上她上次说到哪儿 —— 每一次醒来都不是空白的一天。
      const nextIso = new Date(Date.parse(now) + gap * 1000).toISOString()
      const threads = await readThreads(roomDeps)
      const unseen = unnoticedDiary(documents)
      const prompt = buildWakePrompt(nextIso, timeZone, lastSaid.get(sessionId) ?? '', threads, unseen.map((entry) => entry.date), deps.userName?.() ?? '', describeCapabilities(state.capabilities, deps.userName?.() ?? ''))
      const outcome = adopted !== undefined
        ? { ok: true as const, room: { taskId: adopted.taskId, sessionId: adopted.sessionId, nextAt: adopted.nextAt, active: true } }
        : state.taskId === ''
          ? await ensureTask(roomDeps, '', sessionId, gap, prompt)
          : await reschedule(roomDeps, state.taskId, gap, prompt)
      if (!outcome.ok) {
        // 失败必须留下证据：插件的日志进不了 docker logs，状态文档是外部唯一读得到的地方。
        await saveState(documents, { ...state, roomSessionId: sessionId, lastError: outcome.reason, lastAttemptAt: now })
        log.warn(`${reason}：没有排上——${outcome.reason}`)
        return
      }
      // `create` 不一定会回报下一次时间：补读一次，否则状态里会一直是空，
      // 下一次排程就会误判成"没排过"而把已经定好的时刻推翻。
      const inspected = outcome.room.nextAt === '' ? await inspectRoom(roomDeps, outcome.room.taskId) : undefined
      // 认领回来的任务可能还停在"暂停"上：一定要把它唤醒，否则她等到天荒地老也不会醒。
      await setActive(roomDeps, outcome.room.taskId, true)
      await saveState(documents, {
        ...state,
        taskId: outcome.room.taskId,
        roomSessionId: outcome.room.sessionId === '' ? sessionId : outcome.room.sessionId,
        nextAt: inspected?.nextAt ?? outcome.room.nextAt,
        lastError: '',
        lastAttemptAt: now,
      })
      // 认领/排程成功：这一轮唤醒词里已经带上了"日记被翻过"的提醒，她从现在起就知道了。
      await markNoticed(documents, unseen, now)
      log.info(`${reason}：她下一次醒来 ${outcome.room.nextAt === '' ? '（时间未回报）' : outcome.room.nextAt}`)
    } finally {
      arming = false
      void section.refresh()
    }
  }

  /**
   * 一次醒来之后：记账 + 排下一次。
   *
   * 为什么触发了就立刻排，而不是等她这一轮跑完：我们拿不到"这一轮结束"这个时刻，
   * 而"下一次该来"是必须成立的承诺 —— 宁可早排（多一次醒来），不可漏排（她从此不再醒）。
   * @param at - 醒来的时刻。
   */
  const settleWake = async (at: string, agent?: unknown): Promise<void> => {
    const documents = deps.documents()
    if (documents === undefined) return
    await flushTokens(at)
    // 她这段时间看到的东西，交给情绪评估一次（对象只可能是"事"或"自己"）。
    const seen = seenBuffer
    seenBuffer = ''
    if (seen.trim() !== '' && deps.appraiseOwn !== undefined) {
      try {
        const result = await deps.appraiseOwn(seen)
        // 把这次自评的结果记下来：`no-feeling` 与"这条路坏了"必须分得开（日志看不见）。
        lastAppraise =
          result === undefined
            ? 'skipped'
            : `${result.kind}:${result.count}:${result.targets.join(',')}`
      } catch (error) {
        // 评估失败只影响这一次的感受，不影响她的日子。
        log.warn('自评失败（这一段没有产生情绪）', error)
      }
    }
    const timeZone = deps.timeZone()
    /**
     * 结算这一次醒来（纯函数，见 `lifecycle.ts`）。
     *
     * 为什么不再在这儿手写：这段顺序（睡眠曲线 → 起动成本 → 到顶判断 → 下一次间隔）
     * 藏着一处真 bug —— 到顶之后按睡眠曲线排，会让整个下午陷在"每 90 分钟醒一次"。
     * 抽出去之后有五条用例守着。
     */
    const settlement = settleWakeState({ state: readState(documents), at, timeZone, rhythm: deps.wake() })
    const after = settlement.state
    if (settlement.fellAsleep) {
      void settleDay(at).catch((error: unknown) => {
        log.warn('睡前收账失败（这一天没有日记）', error)
        void noteSettleError(documents, error instanceof Error ? error.message : String(error))
      })
    }
    /**
     * 她这一轮真正能用的工具：从 agent 的作用域里现取，并记进状态。
     *
     * 启动时没有活的会话（`agent.ctx` 拿不到），只能靠这份缓存把下一次唤醒词排好；
     * 取不到就沿用上一次的 —— 清单永远反映"实际装了什么"，不是我们写死的那几个。
     */
    const liveTools = visibleToolNames(ctx.get('tools'), agent)
    if (liveTools.length > 0) after.capabilities = liveTools
    // 这一轮她动了几次手：写进状态（工作台据此如实显示），然后清零。
    after.lastTurnTools = roomToolUses
    roomToolUses = 0
    const gap = settlement.gapSeconds
    if (gap === undefined) {
      await saveState(documents, { ...after, nextAt: '', lastError: '', lastAttemptAt: at })
      await setActive(roomDeps, after.taskId, false)
      log.info('她醒了一次；次数上限是 0（不许自己醒），不再排下一次')
      return
    }
    const unseen = unnoticedDiary(documents)
    const outcome = await reschedule(
      roomDeps,
      after.taskId,
      gap,
      buildWakePrompt(
        new Date(Date.parse(at) + gap * 1000).toISOString(),
        timeZone,
        lastSaid.get(after.roomSessionId) ?? '',
        await readThreads(roomDeps),
        unseen.map((entry) => entry.date),
        deps.userName?.() ?? '',
        describeCapabilities(after.capabilities, deps.userName?.() ?? ''),
      ),
    )
    // 提醒已经排进下一次唤醒词：从现在起她知道这件事了（不再天天念）。
    if (outcome.ok) await markNoticed(documents, unseen, at)
    // 这一轮的"上次"已经用掉了：她马上会产出新的。
    lastSaid.delete(after.roomSessionId)
    await saveState(documents, {
      ...after,
      nextAt: outcome.ok ? outcome.room.nextAt : after.nextAt,
      roomSessionId: outcome.ok ? outcome.room.sessionId : after.roomSessionId,
      lastError: outcome.ok ? '' : outcome.reason,
      lastAttemptAt: at,
    })
    const sleeping = after.sleepingSince === '' ? '' : `（睡到 ${outcome.ok ? outcome.room.nextAt : '待定'}）`
    void section.refresh()
    log.info(`她醒了一次（今天第 ${after.dayCount} 次，精力 ${Math.round(after.energy)}）；下一次 ${outcome.ok ? outcome.room.nextAt : '没排上'}${sleeping}`)
  }

  const on = ctx.on as unknown as (
    name: string,
    listener: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>,
  ) => () => void

  /**
   * 记一笔用量。
   *
   * 为什么攒着写：存储是一整个 JSON 文件，每来一条助手消息就重写一次并不划算。
   * 三十秒内的多条合成一次；真正需要精确的时刻（醒来）会先主动 flush 一次。
   * @param weighted - 加权 token 数。
   * @param at - 这一刻。
   */
  const bumpTokens = (weighted: number, at: string): void => {
    if (!Number.isFinite(weighted) || weighted <= 0) return
    pendingTokens += weighted
    if (flushTimer !== undefined) return
    flushTimer = setTimeout(() => {
      flushTimer = undefined
      void flushTokens(at).catch((error: unknown) => log.warn('精力记账失败（这一次没记上）', error))
    }, 30_000)
  }

  /**
   * 排程失败时**把原因落进状态**，而不只是写日志。
   *
   * 为什么：插件的日志进不了 `docker logs`，而 `arm` 里任何一处抛错都会让"房间建了、任务建了，
   * 状态却没落盘"这种半截现场出现 —— 外部完全看不出发生了什么（2026-11-25 真机连踩两次）。
   * @param reason - 这一次是谁触发的排程（写进状态，便于对照）。
   */
  const armAndReport = (reason: string): void => {
    void arm(reason).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      log.warn(`${reason}：排程抛错——${message}`)
      const documents = deps.documents()
      if (documents === undefined) return
      const current = readState(documents)
      void saveState(documents, {
        ...current,
        lastError: `${reason}：排程抛错——${message}`,
        lastAttemptAt: new Date().toISOString(),
      }).catch(() => {})
    })
  }

  /**
   * 这个会话是不是"她"的沉浸会话 —— 也就是你们的对话。
   *
   * 判据是**此刻实际跑着的预设**（会话投影优先、会话头兜底，见 `presetOfAgent`），
   * 不是"是不是主会话"：你在别的会话里干的活不该进她的日记，更不该变成她对自己的认识。
   * 她自己的房间要排掉 —— 那一栏另有归属（她自己那段时间）。
   * @param session - 事件带的会话对象。
   * @param sessionId - 会话 id。
   * @param roomSessionId - 她房间的会话 id。
   * @returns 是的话为 `true`。
   */
  const isTalkSession = (session: unknown, sessionId: string, roomSessionId: string): boolean => {
    if (sessionId === '' || sessionId === roomSessionId) return false
    return presetOfAgent({ session }, ctx) === HUMANITY_PRESET_ID
  }

  /**
   * 把房间的名字对齐到"今天"。
   *
   * 为什么不能只在 `arm` 里做：改名要求会话是**活的**（`sessions.get(id)` 拿得到对象），
   * 而启动那一刻她的会话还没被加载 —— 真机 2026-11-25 第一次验证就卡在这：
   * `roomTitleNote` 写的是"这个会话这会儿不是活的，改不了名"。
   * 唯一稳定的"活着"的时刻是**她这一轮真的在跑**（`session/event` 里能收到她的会话事件）。
   * @param sessionId - 她房间的会话 id。
   */
  const publishRoomTitle = (session: unknown): void => {
    const documents = deps.documents()
    if (documents === undefined) return
    const stamp = new Date().toISOString().slice(11, 16)
    let note: string
    try {
      const outcome = renameSession(
        { titles: () => ctx.get('sessionTitle') as TitleSeam | undefined },
        session,
        dayKeyOf(new Date().toISOString(), deps.timeZone()),
      )
      note = outcome.kind === 'skipped'
        ? `没改成：${outcome.reason}（${stamp}）`
        : `${outcome.kind === 'renamed' ? '改成了' : '本来就是'} ${outcome.title}（${stamp}）`
    } catch (error) {
      // 服务访问本身可能抛（不是每个部署都注册了它）：把原因落到状态里，别让外层 try 吃掉。
      note = `没改成：${error instanceof Error ? error.message : String(error)}（${stamp}）`
    }
    const current = readState(documents)
    if (current.roomTitleNote === note) return
    void saveState(documents, { ...current, roomTitleNote: note }).catch((error: unknown) => {
      log.warn('没能记下房间名字的结果', error)
    })
  }

  /** 每一条助手消息都带用量：订阅它，就不必去翻会话文件。 */
  const onEvent = ctx.on as unknown as (
    name: string,
    listener: (session: unknown, event: unknown) => void,
  ) => () => void
  const disposeUsage = onEvent('session/event', (session, event) => {
    try {
      if (!moduleEnabled()) return
      const typed = event as { type?: string; data?: { usage?: unknown; message?: unknown } } | undefined
      const sessionId = (session as { id?: string } | undefined)?.id ?? ''
      const documents = deps.documents()
      const roomSessionId = documents === undefined ? '' : readState(documents).roomSessionId
      /** 这一次事件是发生在"她跟他说话"的那个会话里吗。 */
      const isTalk = isTalkSession(session, sessionId, roomSessionId)
      /**
       * 她的会话里一有动静，就说明它是活的 —— 这是唯一能改名字的时刻。
       *
       * 用 `sessionId + 日期` 做记忆键：一天最多对齐一次，不会每条消息都去追加改名事件。
       */
      if (documents !== undefined && sessionId !== '' && sessionId === roomSessionId) {
        const key = `${sessionId}:${dayKeyOf(new Date().toISOString(), deps.timeZone())}`
        if (titleKey !== key) {
          // 先记号再改：改名抛错时外层 try 会吃掉异常，标记留在这里防止同一轮刷屏；
          // 真正失败的原因由 `publishRoomTitle` 自己写进状态（`roomTitleNote`）。
          titleKey = key
          // 这里拿到的 `session` 就是活的会话对象 —— 改名只能用它（见 `title.ts` 的说明）。
          publishRoomTitle(session)
        }
      }
      /**
       * 记下"他最近在哪个会话里跟她说话"。
       *
       * 为什么必须落盘：她主动找他的时候要挑一个能送到的会话 —— 送到她的房间没有意义
       * （他不在那儿）。重启之后这份记忆也得还在，否则她刚想说话就没人可送。
       * 只在**变了**的时候写，不然每条消息都要重写整份状态。
       */
      if (isTalk && documents !== undefined) {
        const known = readState(documents)
        if (known.talkSessionId !== sessionId) {
          void saveState(documents, {
            ...known,
            talkSessionId: sessionId,
            talkSeenAt: new Date().toISOString(),
          }).catch((error: unknown) => log.warn('没能记下他说话的那个会话', error))
        }
      }
      // 单线程：她在别处说话的这一刻，房间的闹钟压下去（安静一阵之后再恢复）。
      if (isBusySession(typed?.type ?? '', sessionId, roomSessionId)) {
        lastBusyAt = Date.now()
        if (!pausedForBusy && documents !== undefined) {
          const state = readState(documents)
          if (state.taskId !== '') {
            pausedForBusy = true
            /**
             * 记下"从什么时候开始被压住"。
             *
             * 为什么要落到状态里：单线程是"你在跟她说话时她不该同时出现在房间"，
             * 但它有个副作用 —— **你只要不断地说，她就永远没有自己的时间**。
             * 这个时刻摆到工作台上，你能看见它，而不是以为她还好好地过着自己的日子。
             */
            void saveState(documents, { ...state, busySince: new Date().toISOString() }).catch(() => {})
            void setActive(roomDeps, state.taskId, false)
          }
        }
      }
      // 她在自己房间里看到的东西：只收 `tool/result`（她读到、查到的内容），
      // **绝不收她自己说的话** —— 否则就是"自己喂自己"，情绪会越滚越大。
      if (typed?.type === 'tool/result') {
        if (documents !== undefined && sessionId !== '' && sessionId === roomSessionId) {
          const text = toolTextOf(event)
          if (text.trim() !== '') {
            seenBuffer = `${seenBuffer}\n${text}`.slice(-SEEN_LIMIT)
            pushHers(`看到：${text.replace(/\s+/g, ' ').trim().slice(0, 120)}`)
          }
        }
        return
      }
      /**
       * 他说的那句话：进"你们的对话"那一栏。
       *
       * 只认**沉浸会话**（跑着 Humanity 预设的会话）：你别的会话里干的活不该被写进她的日记，
       * 更不该变成她对自己的认识。她自己的房间另算，它走上面`tool/result`那一条。
       */
      if (typed?.type === 'user/message') {
        if (isTalk) {
          const said = userSaidOf(typed.data?.message)
          if (said !== '') {
            pushTalk(`他说：${clip(said, TALK_LINE_CHARS)}`)
            /**
             * 他说话了 = 她那句"主动找他"他看到过了。
             *
             * 判据是"他说话"，而不是"页面被打开过" —— 能说话就说明他在，
             * 那条消息就在他眼前。
             *
             * ⚠️ 必须只看**真的他说的**（`said !== ''` 已经挡掉了来源不是 `user` 的消息）：
             * 真机 2026-11-25 教训——她主动找他那条投递**本身就是一条 user 角色的消息**，
             * 第一版把"任何 user/message"都算成"他看了"，于是投递后 1 秒就被标成已读，
             * 未读永远不亮。
             */
            if (documents !== undefined) {
              const tell = readTell(documents)
              if (unreadOf(tell)) {
                void saveTell(documents, { ...tell, seenAt: new Date().toISOString() })
                  .then(() => section.refresh())
                  .catch((error: unknown) => log.warn('没能记下"他看到了她那句话"', error))
              }
            }
          }
        }
        return
      }
      /**
       * 她这一轮动了几次手：**数 `tool/call` 事件**。
       *
       * 真机（2026-11-24 15:17 那次）她确实查了网页，但助手消息的 `content` 里**只有 text**，
       * 没有 `tool_use` 片段 —— 按 content 数永远是 0。工具调用以 `tool/call` 事件出现。
       */
      if (typed?.type === 'tool/call') {
        if (sessionId !== '' && sessionId === roomSessionId) roomToolUses += 1
        return
      }
      // 顺手记下她最后一句话：下一次醒来要接上"上次做到哪"（连续性不靠她的记性）。
      if (typed?.type === 'assistant/message') {
        const said = continuityOf(textOf(typed.data?.message))
        if (sessionId !== '' && said !== '') {
          lastSaid.set(sessionId, said)
          // 收账的材料：房间里的是"她自己的时间"，别处的是"你们的对话"。
          if (sessionId === roomSessionId) pushHers(`她说：${said}`)
          else if (isTalk) pushTalk(`她说：${clip(said, TALK_LINE_CHARS)}`)
        }
      }
      /**
       * 她那一轮跑完了：看看日记是不是已经写好了。
       *
       * 判定放在这里而不是"她说写完了"：文件里真有正文才算写成（判据见 `harvestDiary`）。
       * 只在她房间、且正在等某一天收账时才去读文件。
       */
      if (typed?.type === 'turn/end' && documents !== undefined && sessionId !== '' && sessionId === roomSessionId) {
        const waiting = readState(documents).settling
        if (waiting !== '') {
          void harvestDiary(documents, waiting).catch((error: unknown) => {
            log.warn(`${waiting} 的日记没能收进档案（下一轮再试）`, error)
          })
        }
      }
      if (typed?.type !== 'assistant/message') return
      const messageId = (typed.data?.message as { id?: unknown } | undefined)?.id
      if (typeof messageId === 'string' && messageId !== '') {
        if (countedMessages.has(messageId)) return
        countedMessages.add(messageId)
        // 只留最近一批：这条集合只为防重复，不该无限长。
        if (countedMessages.size > 400) {
          const oldest = countedMessages.values().next().value
          if (typeof oldest === 'string') countedMessages.delete(oldest)
        }
      }
      bumpTokens(weightedTokens(typed.data?.usage as TokenUsageLike | undefined), new Date().toISOString())
    } catch (error) {
      // 记账失败绝不能影响这一轮对话。
      log.warn('读到一条用量但没能记账（不影响这一轮）', error)
    }
  })

  /**
   * 还没被她发现的"被翻过"的日记。
   *
   * 她只会在自己重读那一天时才发现 —— 所以这条提醒每次醒来都给一次，直到她"知道"为止；
   * 排进下一次唤醒词之后才算她知道（`noticedAt`），不会天天念同一件事。
   * @param documents - 文档表。
   * @returns 需要提醒的条目。
   */
  const unnoticedDiary = (documents: DocumentStore): DiaryEntry[] =>
    readDiary(documents).filter((entry) => entry.openedAt !== '' && entry.noticedAt === '')

  /**
   * 把"她已经知道了"记下来（只在她拿到下一次唤醒词之后调用）。
   * @param documents - 文档表。
   * @param entries - 这次提醒到的那几篇。
   * @param at - 提醒的时刻。
   */
  const markNoticed = async (documents: DocumentStore, entries: readonly DiaryEntry[], at: string): Promise<void> => {
    for (const entry of entries) {
      try {
        await appendDiary(documents, { ...entry, noticedAt: at })
      } catch (error) {
        log.warn('没能记下"她知道了日记被翻过"（下一次会再提一次）', error)
      }
    }
  }

  /**
   * 记下（或清掉）收账失败的原因。
   *
   * 为什么不能只写日志：插件日志进不了 `docker logs`，一篇没写成的日记会完全没有痕迹；
   * 写进状态文档，工作台与我都读得到。
   * @param documents - 文档表。
   * @param message - 原因；空串表示清掉。
   */
  const noteSettleError = async (documents: DocumentStore, message: string): Promise<void> => {
    try {
      if (readState(documents).lastSettleError === message) return
      await saveState(documents, { ...readState(documents), lastSettleError: message })
    } catch (error) {
      log.warn('没能记下收账失败的原因', error)
    }
  }

  /**
   * 收账（针对**某一天**的材料）。
   *
   * 为什么要把"哪一天"和"材料"显式传进来：跨午夜时昨天的材料必须按**昨天**收掉，
   * 而不是等到"她睡下"——她可能整夜都不够累、也没到次数上限，那一天就那么没了。
   * 真机 2026-11-24：她当晚醒了 15 次，最后 23:18 那次到顶睡下，第二天 08:00 醒；
   * 结果日记是空的，而错误字段也是空的 —— 说明它在某个"静默提前返回"里退出了。
   * @param date - 哪一天（YYYY-MM-DD）。
   * @param at - 拿什么时刻当"写下来的时刻"。
   * @param material - 那天的两栏材料（调用方给快照，避免被清空影响）。
   */
  const settleDayFor = async (date: string, at: string, material: DayMaterial): Promise<void> => {
    const documents = deps.documents()
    if (documents === undefined) return
    /**
     * 同一时刻只写一次。
     *
     * 收账现在有多条入口（醒来判定 / 聊天耗尽 / 重排发现 / 跨午夜收尾），它们可能在同一分钟内撞上；
     * 「已经写过就跳过」是写盘之后才成立的判断，两个并发调用会**都**通过检查、都调一次模型。
     */
    if (settlingDay) {
      // 同一时刻另一次收账正在跑：那一次会写日记，这次跳过是正常行为，不该记成失败。
      log.info(`收账撞车（${date}）：另一条入口正在收，这一次跳过`)
      return
    }
    settlingDay = true
    try {
      await settleDayOnce(date, at, material)
    } finally {
      settlingDay = false
    }
  }

  /**
   * 按"现在"给她收账：先判定该收哪一天，再交给那一天去收。
   *
   * 为什么不在这里自己比日期：跨过午夜时"今天"与"手上材料属于哪天"会不一样。
   * 原来这里是一句静默的 `return` —— 于是昨天那篇日记既没写、也没留下原因（真机 2026-11-24）。
   * 现在判定统一交给 `decideSettle`（纯函数，每条分支都有用例），这里只负责把结果落到位。
   * @param at - 睡下的时刻。
   */
  const settleDay = async (at: string): Promise<void> => {
    const documents = deps.documents()
    if (documents === undefined) return
    const timeZone = deps.timeZone()
    const book = readNotes(documents)
    const plan = decideSettle({
      today: dayKeyOf(at, timeZone),
      notesDay: book.day,
      notesCount: noteCountOf(book),
      writtenDates: readDiary(documents).map((entry) => entry.date),
      startedAt,
      startedDay: dayKeyOf(startedAt, timeZone),
      timeZone,
    })
    if (plan.kind === 'done') return
    if (plan.kind === 'cannot') {
      await noteSettleError(documents, plan.reason)
      return
    }
    await settleDayFor(plan.date, at, { hers: [...book.hers], talk: [...book.talk] })
  }

  /**
   * 收账的实体（只由 `settleDayFor` 调用一次）。
   * @param date - 哪一天。
   * @param at - 写下来的时刻。
   * @param material - 那天的两栏材料。
   */
  const settleDayOnce = async (date: string, at: string, material: DayMaterial): Promise<void> => {
    const documents = deps.documents()
    if (documents === undefined) return
    const state = readState(documents)
    /**
     * 每一个提前返回都要留原因。
     *
     * 真机 2026-11-24：日记没写出来、错误字段却是空的 —— 因为它走了某个静默返回，
     * 外面完全看不出为什么。宁可多写一行状态，也不要"没有日记也没有理由"。
     *
     * 「有没有材料」已经由 `decideSettle` 判定并留了原因（见 `settleDay`），
     * 这里只保留兜底：真走到这一步还没有材料，说明调用方绕过了判定。
     */
    if (material.hers.length === 0 && material.talk.length === 0) {
      await noteSettleError(documents, `${date} 没有材料：这次收账没有带上任何一行（调用方绕过了判定）`)
      return
    }
    // 一天只有一篇：已经写过了就不再写（重启也不该补第二篇）。
    if (readDiary(documents).some((entry) => entry.date === date)) return
    /**
     * **不再由插件代写日记**（2026-11-26 用户定）。
     *
     * 理由：日记是她的东西，别人写的就不是她的。插件只做两件事：
     * 把这一天整理成材料文件递过去，投一句"写吧"，然后等她写完。
     * 她写多长、写成什么样，是她的事；写不出来就不勉强（无日记也是一天）。
     */
    const materialName = materialFileName(date)
    const diaryName = diaryFileName(date)
    const wrote = await writeOwnFile(roomDeps, materialName, materialFileText(material, date))
    if (!wrote) {
      await noteSettleError(documents, `${date} 的材料没能写进她的目录（她不会看到这一天）`)
      return
    }
    /**
     * 投递到她的房间：稍等一下再送（刚投完一次就排第二次，会显得像连珠炮）。
     * 投完把 `settling` 记下来：这一天算"交给她了"，不再安排别的唤醒。
     */
    const delivered = await reschedule(
      roomDeps,
      state.taskId,
      COLLECT_DELAY_SECONDS,
      buildCollectPrompt(date, materialName, diaryName, deps.userName?.() ?? ''),
    )
    if (!delivered.ok) {
      await noteSettleError(documents, `${date} 没能把"该写日记了"投给她：${delivered.reason}`)
      return
    }
    await saveState(documents, { ...state, settling: date, nextAt: delivered.room.nextAt, lastError: '' })
    log.info(`收账交给了她自己（${date}）：材料 ${materialName}，日记写进 ${diaryName}`)
    /**
     * 她自己整理一遍信息层：明确要求当天落地，其余观察进候选队列。
     *
     * 这一步仍然是后台调用（它读的是材料，不是她的日记）。失败只记一笔 ——
     * 信息层没更新不该影响她写日记。
     */
    if (deps.grow !== undefined) {
      try {
        await deps.grow({ hers: material.hers, talk: material.talk }, date, at, deps.timeZone())
      } catch (error) {
        log.warn(`${date} 的自我整理失败（这一天没有更新信息层）`, error)
      }
    }
    // 材料本子**先不清**：她写日记时要用它（写完之后由 `harvestDiary` 清）。
    void section.refresh()
  }

  /**
   * 把**她自己写好的日记**收进档案。
   *
   * 收账那天把材料递给她、投一句"写吧"；这一个函数负责"她写完了没有"：
   * - 文件在、且不是空的 → 存进日记本（工作台读的那份就是它）→ 清材料本子 → 这一天算完；
   * - 还没写 → 什么也不做（她可能正在写，也可能不写；不勉强）。
   * 判定用**文件存在 + 有正文**，不用"她说了什么"：她说"写完了"不等于写完了。
   * @param documents - 文档表。
   * @param date - 哪一天。
   */
  const harvestDiary = async (documents: DocumentStore, date: string): Promise<boolean> => {
    if (date === '') return false
    if (readDiary(documents).some((entry) => entry.date === date)) return false
    const file = await readWork(roomDeps, diaryFileName(date))
    // `readWork` 给的是字节（base64）：日记是文本，解出来再判断有没有内容。
    // 用 `atob` 而不是 `Buffer`：宿主侧的 tsconfig 里没有 node 类型，而这里只需要解码。
    const text = file === undefined ? '' : decodeBase64Text(file.base64).trim()
    if (text === '') return false
    await appendDiary(documents, {
      date,
      text,
      createdAt: new Date().toISOString(),
      openedAt: '',
      noticedAt: '',
    })
    // 她自己写的那份文件就是原本（不再另存副本）。
    if (readNotes(documents).day === date) {
      try {
        await saveNotes(documents, EMPTY_NOTES)
      } catch (error) {
        log.warn(`写完日记后没能清空材料本子（${date}）`, error)
      }
    }
    const latest = readState(documents)
    await saveState(documents, { ...latest, settling: '', lastSettleError: '' })
    void section.refresh()
    log.info(`她自己写完了 ${date} 的日记（${text.length} 字）`)
    return true
  }

  /**
   * 她聊完了就把房间的闹钟放回去。
   *
   * 为什么用轮询而不是"最后一条消息之后延时"：会话可能被压缩、重放或中途断开，
   * 事件不一定有收尾；每分钟看一眼"安静了多久"最稳，也不会因为漏掉一条事件就永远压着。
   */
  const busyTimer = setInterval(() => {
    if (!pausedForBusy || !moduleEnabled()) return
    if (Date.now() - lastBusyAt < BUSY_QUIET_MINUTES * 60_000) return
    pausedForBusy = false
    // 压住结束：清掉起点，工作台不再显示"已经被压了多久"。
    const documents = deps.documents()
    if (documents !== undefined) {
      const state = readState(documents)
      if (state.busySince !== '') {
        void saveState(documents, { ...state, busySince: '' }).catch((error: unknown) =>
          log.warn('没能清掉"被压住"的起点', error),
        )
      }
    }
    armAndReport('她聊完了')
  }, BUSY_CHECK_MS)
  // 轮询是后台行为：Node 不该因为它而退出（也避免测试进程被挂住）。
  ;(busyTimer as unknown as { unref?: () => void }).unref?.()

  /**
   * 跨天检查：昨天还没收的账，到点就收。
   *
   * 为什么需要它：收账原来只有"她睡下"那三条入口 + "她第二天又留下材料"这一条兜底。
   * 她要是夜里不开口、又没到次数上限，那一天的本子就一直躺着 ——
   * 材料已经落盘不会丢，但没有日记。到点收一次之后，"哪一天算完"由墙钟说了算，
   * 而不是由她下一次开口说了算。
   */
  const checkDayBoundary = (): void => {
    if (!moduleEnabled()) return
    const documents = deps.documents()
    if (documents === undefined) return
    const now = new Date().toISOString()
    const book = readNotes(documents)
    // 今天的不在这里收：她还没过完这一天，等睡下再说。
    if (book.day === '' || book.day === dayKeyOf(now, deps.timeZone()) || isEmptyNotes(book)) return
    const closing = book.day
    void settleDayFor(closing, now, { hers: [...book.hers], talk: [...book.talk] }).catch((error: unknown) => {
      log.warn(`跨天收账失败（${closing}）`, error)
    })
  }

  /**
   * 把她留着的那句话送出去。
   *
   * 三条护栏在 `tell.ts` 里判（一天一次 / 有话待送 / 有地方可送），这里只负责
   * "他忙不忙"这个运行时事实，以及真的把调度任务建出来。
   */
  const deliverTell = async (): Promise<void> => {
    if (!moduleEnabled()) return
    const documents = deps.documents()
    if (documents === undefined) return
    const doc = readTell(documents)
    if (doc.pending === '') return
    const now = new Date().toISOString()
    const today = dayKeyOf(now, deps.timeZone())
    const state = readState(documents)
    const verdict = canDeliver(doc, today, state.talkSessionId)
    if (!verdict.ok) {
      if (verdict.reason !== '') await saveTell(documents, { ...doc, lastReason: verdict.reason })
      return
    }
    // 他还在说话：这一轮不送，下一轮再看。不写原因 —— 这不是故障，是在等。
    if (!quietEnough(lastBusyAt, Date.now())) return

    // 他要看的东西：给她绝对路径，并让她在投递那一轮用 present 交出去（他那边就能点开）。
    const showPath = verdict.show === ''
      ? ''
      : (() => {
          const dir = roomDirOf(roomDeps)
          return dir === undefined ? '' : `${dir}/${verdict.show}`
        })()
    const prompt = buildTellPrompt(verdict.text, verdict.show, showPath)
    const reusable = doc.taskId !== '' && doc.taskSession === state.talkSessionId
    let outcome = reusable
      ? await reschedule(roomDeps, doc.taskId, TELL_DELAY_SECONDS, prompt)
      : { ok: false as const, reason: '换了他说话的会话，需要新建一个投递任务' }
    if (!outcome.ok) {
      // 任务没了、或者他换了会话：重新建一个（旧的那个发过一次就停着，不会再响）。
      outcome = await ensureTask(roomDeps, '', state.talkSessionId, TELL_DELAY_SECONDS, prompt, TELL_TASK_TITLE)
    }
    if (!outcome.ok) {
      await saveTell(documents, { ...doc, lastReason: outcome.reason })
      return
    }
    await saveTell(documents, {
      pending: '',
      pendingShow: '',
      pendingAt: '',
      lastAt: now,
      lastDay: today,
      lastText: verdict.text,
      lastShow: verdict.show,
      lastReason: '',
      // 新送出去的那句一定是"没看过"的：清掉上一次的"看到了"。
      seenAt: '',
      taskId: outcome.room.taskId,
      taskSession: state.talkSessionId,
    })
    log.info(`她主动找他说了一句${verdict.show === '' ? '' : `（还带上「${verdict.show}」）`}（约 ${TELL_DELAY_SECONDS} 秒后送到他的会话）`)
  }

  const dayTimer = setInterval(() => {
    checkDayBoundary()
    void deliverTell().catch((error: unknown) => log.warn('她留着的话没能送出去（下一轮再试）', error))
    /**
     * 收账的兜底：她可能已经写好了文件，但那一轮的 `turn/end` 没被我们看到
     * （重启、断线、事件丢了）。每五分钟看一次"她写完了没有"，比只押事件稳。
     */
    const documents = deps.documents()
    if (documents !== undefined) {
      const waiting = readState(documents).settling
      if (waiting !== '') void harvestDiary(documents, waiting).catch(() => {})
    }
  }, DAY_BOUNDARY_CHECK_MS)
  ;(dayTimer as unknown as { unref?: () => void }).unref?.()

  /**
   * 造一条注入消息（形状与第一方 time-context / 情绪注入一致）。
   *
   * 为什么要注入而不是只写在唤醒词里：唤醒词是**排队那一刻**写死的快照，
   * 而"她能做什么"取决于那一刻真实装了什么工具。只有在她真正开跑的这一步现取，
   * 清单才永远准（真机 2026-11-25：新装的第一觉，排程里那份清单是空的）。
   */
  let messageFactory: ((input: unknown) => unknown) | undefined
  void loadOptional<{ createUserMessage(input: unknown): unknown }>('@deepseek-ai/dsh-llm', log)
    .then((module) => {
      messageFactory = module?.createUserMessage
    })
    .catch(() => {})

  const capabilityMessage = (agent: unknown): unknown | undefined => {
    if (messageFactory === undefined) return undefined
    const names = visibleToolNames(ctx.get('tools'), agent)
    if (names.length === 0) return undefined
    const lines = capabilityLines(describeCapabilities(names, deps.userName?.() ?? ''))
    const text = ['你能做的事（用工具真的去做）：', ...lines].join('\n')
    const body = `<system-reminder>\n${text}\n</system-reminder>`
    return messageFactory({
      content: [{ type: 'text', text: body }],
      source: { kind: 'humanity-evolution', form: 'snapshot', sections: [{ name: 'humanity-evolution', text: body }] },
    })
  }

  const disposeStep = on('agent/pre-step', async (payload, next) => {
    const decision = (await next()) as { kind?: string; messages?: unknown[] } | null
    if (decision === null || decision.kind !== 'enter') return decision
    const { agent, step } = (payload ?? {}) as { agent?: unknown; step?: number }
    if (!moduleEnabled()) return decision
    const documents = deps.documents()
    const messages = Array.isArray(decision.messages) ? decision.messages : []
    // 她房间里只留"她自己的时间"那一条：调度器的变更通知不该让她看见。
    // ⚠️ 必须在"只看第一步"之前做 —— 通知会落在后续步骤上（真机 2026-11-24 抓到）。
    const sessionId = (agent as { session?: { id?: string } } | undefined)?.session?.id ?? ''
    const inRoom = documents !== undefined && sessionId !== '' && sessionId === readState(documents).roomSessionId
    const cleaned = withoutScheduleNoise(messages, inRoom)
    const decided = cleaned === messages ? decision : { ...decision, messages: cleaned }
    // 以下只关心"一次醒来"：一次醒来是一轮对话，不是每一步都要记一次。
    if (step !== 1) return decided
    /**
     * 这一次是不是"她醒来"？
     *
     * 必须先算出来：醒来和"重排"不能同时干 —— 真机 2026-11-26 抓到，两者并发时
     * 重排那份**旧快照**会把记账写下的"今天第几次 / 上一次醒"整个盖掉（她醒了，账没记上）。
     */
    const isWake = cleaned.some(isWakeMessage)
    if (!isWake && documents !== undefined) {
      // 房间还没排上就借这一轮再试：会话服务可能比我们挂得晚（失败原因已写在状态文档里）。
      const state = readState(documents)
      if (state.taskId === '') {
        const last = Date.parse(state.lastAttemptAt)
        if (!Number.isFinite(last) || Date.now() - last >= RETRY_ARM_AFTER_MS) {
          armAndReport('重试排程')
        }
      }
    }
    if (isWake) {
      // 落账放在异步尾巴上：她这一轮不必等一次调度写入。
      void settleWake(new Date().toISOString(), agent).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        log.warn('醒来之后没能排下一次（这一次不影响对话）', error)
        // 日志进不了 docker logs：这一次记账失败必须能被外部看到。
        if (documents !== undefined) {
          const latest = readState(documents)
          void saveState(documents, { ...latest, lastError: `记账失败：${message}` }).catch(() => {})
        }
      })
    }
    /**
     * 她的房间：把"此刻真实能用的工具"补进这一轮。
     *
     * 唤醒词里那份是**排程那一刻**的快照；只有在她真正开跑的这一步现取，清单才永远准。
     * 注入失败只影响这一段文字，不许影响别的（见上面的教训）。
     */
    if (!inRoom) return decided
    try {
      const injected = capabilityMessage(agent)
      if (injected === undefined) return decided
      const list = Array.isArray((decided as { messages?: unknown[] }).messages)
        ? [...((decided as { messages: unknown[] }).messages)]
        : []
      list.push(injected)
      return { ...(decided as object), messages: list } as typeof decided
    } catch (error) {
      log.warn('这一轮没能把"能做什么"补进提示词（不影响她做事）', error)
      return decided
    }
  })

  ctx.effect(
    () => () => {
      disposeStep()
      disposeUsage()
      clearInterval(busyTimer)
      clearInterval(dayTimer)
      if (flushTimer !== undefined) clearTimeout(flushTimer)
      // 房间的句柄**故意不释放**：持有它的所有权，`dispose` 有可能把会话一起撤掉
      // （`core.zh.md` 的创建回滚约定）。插件卸载时只丢引用，让会话留在存储里。
      roomHandle = undefined
      log.info('自进化模块已卸载')
    },
    'humanity: 自进化卸载',
  )

  log.info('自进化模块已装配（等存储就绪后第一次排程）')

  return {
    roomSessionId() {
      const documents = deps.documents()
      return documents === undefined ? '' : readState(documents).roomSessionId
    },
    setEnabled(next) {
      enabled = next
      if (next && moduleEnabled()) {
        armAndReport('开关打开')
        return
      }
      const documents = deps.documents()
      if (documents !== undefined) {
        const state = readState(documents)
        void setActive(roomDeps, state.taskId, false)
      }
    },
    reconfigure() {
      armAndReport('配置变更')
    },
    refresh: () => arm('时间基准变化'),
    notifyStoreReady() {
      section.notifyStoreReady()
      armAndReport('存储就绪')
    },
    energyNow() {
      const documents = deps.documents()
      if (documents === undefined) return undefined
      return settleAt(readState(documents), new Date().toISOString()).energy
    },
    dispose() {
      enabled = false
    },
  }
}
