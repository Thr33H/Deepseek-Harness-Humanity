/**
 * 自进化模块（她自己的时间）——**唯一入口**。
 *
 * 与人格/记忆同一条约定：宿主只调 `installEvolution(...)` 一行。
 *
 * ### 这一版做了什么（第 0 期）
 *
 * 1. 她的房间：一个只属于她的会话（第一次投递时由调度服务自动创建）；
 * 2. 一次一约：每次醒来结束时，把**下一次**排到未来某个随机时刻；
 * 3. 醒来的那一轮，她自己决定做什么（提示词只说清"没有人在等你"）。
 *
 * 还没做：精力（按 token 算累不累）、线索账、睡前收账（日记/记忆/性格）。见设计方案的分期。
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

import type { DocumentStore } from '../documents.js'
import { createLlmAccess } from '../llm.js'
import { appendDiary, buildDiaryPrompt, parseDiary, readDiary, type DayMaterial, type DiaryEntry } from './diary.js'
import { settleWakeState, sleepGapSeconds } from './lifecycle.js'
import { installEvolutionSection } from './section.js'
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
  ensureRoom,
  ensureTask,
  inspectRoom,
  listWorks,
  readWork,
  readThreads,
  reschedule,
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
  MIN_GAP_SECONDS,
  NOTES_MAX_LINES,
  RETRY_ARM_AFTER_MS,
  SEEN_LIMIT,
  TALK_LINE_CHARS,
  TALK_MAX_LINES,
  WAKE_MARKER,
} from './constants.js'
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
    busy: () => pausedForBusy,
    readWork: (name) => readWork(roomDeps, name),
  })

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
      const state = settleAt(raw, now)
      const timeZone = deps.timeZone()
      if (state.energy !== raw.energy || state.sleepingSince !== raw.sleepingSince || state.energyAt !== raw.energyAt) {
        await saveState(documents, state)
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
      const hasFuture =
        state.taskId !== ''
        && state.nextAt !== ''
        && Number.isFinite(Date.parse(state.nextAt))
        && Date.parse(state.nextAt) > Date.parse(now)
      if (hasFuture) {
        // 用"重排到剩下的时间"来恢复，而不是只改 active：真机上只改 active 时任务仍是 paused，
        // 她因此会一直不醒（2026-11-24 抓到）。重排会同时把 timing 与 active 一起写。
        const remain = Math.max(60, Math.round((Date.parse(state.nextAt) - Date.parse(now)) / 1000))
        const resumed = await reschedule(roomDeps, state.taskId, remain)
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
      const gap = missed ? MIN_GAP_SECONDS : gapSeconds(state, now)
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
        }
      }
      // 提示词里写的是**她醒来那一刻**的时间，不是"现在排程的这一刻"；
      // 尾部接上她上次说到哪儿 —— 每一次醒来都不是空白的一天。
      const nextIso = new Date(Date.parse(now) + gap * 1000).toISOString()
      const threads = await readThreads(roomDeps)
      const unseen = unnoticedDiary(documents)
      const prompt = buildWakePrompt(nextIso, timeZone, lastSaid.get(sessionId) ?? '', threads, unseen.map((entry) => entry.date))
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
  const settleWake = async (at: string): Promise<void> => {
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
        if (isTalkSession(session, sessionId, roomSessionId)) {
          const said = userSaidOf(typed.data?.message)
          if (said !== '') pushTalk(`他说：${clip(said, TALK_LINE_CHARS)}`)
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
          else if (isTalkSession(session, sessionId, roomSessionId)) pushTalk(`她说：${clip(said, TALK_LINE_CHARS)}`)
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
    const route = llm.route()
    if (route === undefined) {
      await noteSettleError(documents, '没有可用的模型，这一天没有写成日记')
      return
    }
    const { system, text } = buildDiaryPrompt({
      hers: material.hers.slice(-NOTES_MAX_LINES),
      talk: material.talk.slice(-TALK_MAX_LINES),
    }, date)
    const result = await llm.streamText({ route, system, text, maxTokens: 1200, timeoutMs: 60_000 })
    const parsed = parseDiary(result.text)
    if (parsed === undefined) {
      // 失败不重试、不补写：宁可这一天没有日记，也不留一篇编的。原因写进状态里（日志看不见）。
      log.warn(`收账的输出无法使用（${date} 这一天没有日记）：${result.text.slice(0, 200)}`)
      await noteSettleError(documents, '收账的输出没法用（模型没按格式回），这一天没有日记')
      return
    }
    await appendDiary(documents, { date, text: parsed.diary, createdAt: at, openedAt: '', noticedAt: '' })
    // 她自己的一份副本：设计里"回头重读那一天"要有可读的东西，而她只能读自己的目录。
    await writeOwnFile(roomDeps, `diary-${date}.md`, `# ${date}\n\n${parsed.diary}\n`)
    /**
     * 她自己整理一遍信息层：明确要求当天落地，其余观察进候选队列。
     *
     * 放在清空材料**之前**：这一步也要读这一天的材料。失败只记一笔 ——
     * 信息层没更新不该把已经写成的日记也带走。
     */
    if (deps.grow !== undefined) {
      try {
        await deps.grow({ hers: material.hers, talk: material.talk }, date, at, deps.timeZone())
      } catch (error) {
        log.warn(`${date} 的自我整理失败（这一天没有更新信息层）`, error)
      }
    }
    /**
     * 本子只在"它仍然是那一天"时清空。
     *
     * 跨午夜收昨天的时候，昨天的收账是异步跑的，而今天的第一行材料可能已经进来了 ——
     * 无条件清空会把它连昨天的一起抹掉（收昨天、丢今天）。
     */
    if (readNotes(documents).day === date) {
      try {
        await saveNotes(documents, { day: '', hers: [], talk: [], lastAt: '' })
      } catch (error) {
        log.warn(`收账后没能清空材料本子（${date}）`, error)
      }
    }
    await noteSettleError(documents, '')
    for (const memory of parsed.memories) {
      try {
        await deps.remember?.(memory.what, memory.about)
      } catch (error) {
        // 某一条没记上只影响那一条。
        log.warn('收账时有一条没能写进记忆', error)
      }
    }
    void section.refresh()
    log.info(`收账完成（${date}）：日记 ${parsed.diary.length} 字，记下 ${parsed.memories.length} 件事`)
  }

  /** 她聊完了就把房间的闹钟放回去。
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
    void arm('她聊完了').catch((error: unknown) => log.warn('聊天结束后没能恢复排程', error))
  }, BUSY_CHECK_MS)
  // 轮询是后台行为：Node 不该因为它而退出（也避免测试进程被挂住）。
  ;(busyTimer as unknown as { unref?: () => void }).unref?.()

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
    // 房间还没排上就借这一轮再试：会话服务可能比我们挂得晚（失败原因已写在状态文档里）。
    if (documents !== undefined) {
      const state = readState(documents)
      if (state.taskId === '') {
        const last = Date.parse(state.lastAttemptAt)
        if (!Number.isFinite(last) || Date.now() - last >= RETRY_ARM_AFTER_MS) {
          void arm('重试排程').catch((error: unknown) => log.warn('重试排程失败', error))
        }
      }
    }
    if (!cleaned.some(isWakeMessage)) return decided
    // 落账放在异步尾巴上：她这一轮不必等一次调度写入。
    void settleWake(new Date().toISOString()).catch((error: unknown) => {
      log.warn('醒来之后没能排下一次（这一次不影响对话）', error)
    })
    return decided
  })

  ctx.effect(
    () => () => {
      disposeStep()
      disposeUsage()
      clearInterval(busyTimer)
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
        void arm('开关打开').catch((error: unknown) => log.warn('开关打开后没能排程', error))
        return
      }
      const documents = deps.documents()
      if (documents !== undefined) {
        const state = readState(documents)
        void setActive(roomDeps, state.taskId, false)
      }
    },
    reconfigure() {
      void arm('配置变更').catch((error: unknown) => log.warn('配置变更后没能重排', error))
    },
    refresh: () => arm('时间基准变化'),
    notifyStoreReady() {
      section.notifyStoreReady()
      void arm('存储就绪').catch((error: unknown) => log.warn('存储就绪后没能排程', error))
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
