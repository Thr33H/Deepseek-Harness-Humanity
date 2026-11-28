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
  dayLogFileName,
  decodeBase64Text,
  diaryFileName,
  materialFileText,
  materialFileName,
  readDiary,
  type DayMaterial,
  type DiaryEntry,
} from './diary.js'
import { capabilityLines, describeCapabilities, toolNamesOf, visibleToolDefinitions, visibleToolNames } from './capabilities.js'
import { channelAlive, ensureChannel, noteActivity, sendViaCard, sessionIdle } from './delivery.js'
import { settleWakeState, sleepGapSeconds } from './lifecycle.js'
import { installEvolutionSection, type GrowView } from './section.js'
import type { Log } from '../log.js'
import {
  afterWake,
  clockTextOf,
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
import { decideSettle, decideSettling } from './settle-plan.js'
import {
  appendDayLog,
  carryRoomFile,
  deleteTask,
  ensureRoom,
  legacyRoomDirOf,
  listWorks,
  readWork,
  readThreads,
  resumeAgent,
  roomDirOf,
  THREADS_FILE,
  wantedRoomDirOf,
  writeOwnFile,
  type AgentHandleLike,
  type AgentRegistryLike,
  type RoomDeps,
  type ScheduleServiceLike,
  type WorkspaceRegistryLike,
} from './room.js'
import {
  BUSY_CHECK_MS,
  BUSY_QUIET_MINUTES,
  COLLECT_DELAY_SECONDS,
  DAY_BOUNDARY_CHECK_MS,
  NOTES_MAX_LINES,
  RETRY_ARM_AFTER_MS,
  SEEN_LIMIT,
  TALK_LINE_CHARS,
  TALK_MAX_LINES,
  TELL_DELAY_SECONDS,
  WAKE_MARKER,
} from './constants.js'
import { buildTellPrompt, canDeliver, readTell, saveTell, unreadOf } from './tell.js'
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
  /** 配置里"她的房间"那一格（原样；空串 = 老位置）。 */
  room(): string
  /** 改配置（深合并进覆盖层）：面板上的"她的房间""一天最多醒几次"都走它。 */
  writeSettings(patch: Record<string, unknown>): Promise<void>
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
 * 这一条调度消息是不是**我们自己发的那几种通道**（她自己的时间 / 该写日记了 / 主动找你）。
 *
 * 为什么要认它：房间里要把"调度器的管理变更通知"滤掉（见 `withoutScheduleNoise`），
 * 但**不能连我们自己发的话一起滤**。真机 2026-11-26：日记提醒正是被这条过滤删掉的 ——
 * 她那一轮里只剩两条系统提醒，她当然不知道自己该写日记。
 *
 * 认的是每种通道提示词的第一句（那几句是我们自己写的固定开头）。
 * @param message - 一条消息。
 * @returns 是我们的通道消息时为 `true`。
 */
export function isChannelMessage(message: unknown): boolean {
  const content = (message as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return false
  const text = content
    .map((block) => (block as { type?: unknown; text?: unknown }) )
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => String(block.text))
    .join('\n')
  if (text === '') return false
  return [WAKE_MARKER, '[收账]', '[你主动找他]'].some((marker) => text.includes(marker))
}

/**
 * 这一条是不是平台的"定时任务被改动过"通知。
 *
 * 它不该出现在任何人的对话里：那是机制在自言自语。真机 2026-11-27：插件改完卡片内容再投递，
 * 这条通知就被同一条路送进会话，她那一轮读完还额外做了个小动作（以为有事发生）。
 * @param message - 一条消息。
 * @returns 是变更通知时为 `true`。
 */
export function isScheduleChangeNotice(message: unknown): boolean {
  const content = (message as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return false
  return content.some((block) => {
    const candidate = block as { type?: unknown; text?: unknown }
    return candidate?.type === 'text' && typeof candidate.text === 'string' && candidate.text.includes('[SCHEDULE CHANGE]')
  })
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
  const kept = messages.filter((message) => {
    if (!isScheduleMessage(message)) return true
    // 我们自己发的通道消息（以及旧式唤醒）一直留着。
    if (isChannelMessage(message) || isWakeMessage(message)) return true
    // 平台的"任务被改动过"通知：哪儿都不要 —— 它是机制在自言自语，不是给谁看的。
    if (isScheduleChangeNotice(message)) return false
    // 其余调度消息：只在她房间里滤（他自己排的提醒在别的会话里要照常出现）。
    return !inRoom
  })
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
    /**
     * 把「Humanity 沉浸」预设**真的挂到**她的 agent 上。
     *
     * 为什么不靠 `create({ meta: { agentPreset } })`：那只是给会话贴了个名字，
     * 预设里的插件一份都没装 —— 平台要求开会话后、第一轮之前调一次 `agentPresets.select`。
     * 真机 2026-11-27/28：她的工具清单里没有 `read`/`write`，"自己写日记"两天写不成。
     */
    selectPreset: async (agent: unknown): Promise<boolean> => {
      const service = ctx.get('agentPresets') as
        | { select?: (target: unknown, preset: string) => Promise<string> }
        | undefined
      if (service === undefined || typeof service.select !== 'function') return false
      try {
        await service.select(agent, HUMANITY_PRESET_ID)
        return true
      } catch (error) {
        log.warn('挂预设失败（她这一轮会少工具）', error)
        return false
      }
    },
    agents: () => {
      const registry = ctx.get('agents') as AgentRegistryLike | undefined
      return registry !== undefined && typeof registry.create === 'function' ? registry : undefined
    },
    workspaces: () => {
      const registry = ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined
      if (registry === undefined || typeof registry.create !== 'function') return undefined
      return registry
    },
    /**
     * 房间用哪个模型：部署默认选择（`agentDefaultModel.currentSelection()`）。
     *
     * 为什么必须显式给：平台只对"在界面里开出来"的会话落一个选择；插件开的会话没有，
     * 于是第一轮就报 `has no provider/model set`（真机 2026-11-26）。
     */
    modelSelection: () => {
      const service = ctx.get('agentDefaultModel') as
        | { currentSelection?(): { provider?: unknown; model?: unknown; reasoningEffort?: unknown } }
        | undefined
      const selection = service?.currentSelection?.()
      if (selection === undefined) return undefined
      const provider = typeof selection.provider === 'string' ? selection.provider : ''
      const model = typeof selection.model === 'string' ? selection.model : ''
      if (provider === '' || model === '') return undefined
      return {
        provider,
        model,
        ...(typeof selection.reasoningEffort === 'string' ? { reasoningEffort: selection.reasoningEffort } : {}),
      }
    },
    homeDir: deps.homeDir,
    roomSetting: () => deps.room(),
    log,
  }
  /** 一个 Agent 句柄：房间活着就拿着它（句柄释放，会话还在但 agent 没了）。 */
  let roomHandle: AgentHandleLike | undefined
  /** "她自己的时间"那张卡片正在跑（心跳每分钟一次，投递要几秒，防重入）。 */
  let waking = false

  /**
   * 有没有一笔"该搬还没搬"的账（配置里的房间跟现在住的地方不一致）。
   *
   * 为什么要单独判一次：`arm` 开头有一条"她在别处说话就先不动"的护栏，而**改房间是用户的明确动作**，
   * 不能因为她正在聊天就一直不生效 —— 真机 2026-11-26：面板显示已改，人却还住在老地方，
   * 因为那次 `arm` 被护栏挡在门外，直到她说完了才轮上。这条待办要能穿过那道护栏。
   * @returns 需要搬为 `true`。
   */
  const roomChangePending = (): boolean => {
    const documents = deps.documents()
    if (documents === undefined) return false
    const state = readState(documents)
    if (state.roomSessionId === '') return false
    const wanted = wantedRoomDirOf(roomDeps)
    if (!wanted.ok) return false
    const current = state.roomDir !== '' ? state.roomDir : (legacyRoomDirOf(roomDeps) ?? '')
    return current !== '' && current !== wanted.path
  }

  /**
   * 开一间新的房间，把闹钟与收账卡片从旧的那间上摘下来。
   *
   * 两件事走同一条路：**换地方**（配置里"她的房间"改了）与**换天**（一天一间）。
   * 为什么不能"搬"：会话的目录是建会话那一刻定死的（写在会话头里），挪不动。
   * 所以旧的只能原样留着（她写过的东西都还在那儿），新的在新目录里开。
   * @param documents - 文档表。
   * @param state - 当前状态。
   * @param dir - 新目录（已经解好、也已经建好）。
   * @param now - 此刻（ISO）。
   * @returns 新的会话与状态；失败时给人话原因。
   */
  const rotateRoom = async (
    documents: DocumentStore,
    state: EvolutionStateDoc,
    dir: string,
    now: string,
  ): Promise<{ ok: true; sessionId: string; state: EvolutionStateDoc } | { ok: false; reason: string }> => {
    const staleTask = state.taskId
    const staleCollect = state.collectTaskId
    /**
     * 她"手上还没做完的事"跟着过去。
     *
     * 房间目录一换，`readThreads` 读的就是新目录的 `todo.md`：不带过去，她每次醒来看到的
     * "手上还没做完的事"就凭空空了 —— 那是她自己的线索账，不是做完的成品。
     */
    const fromDir = state.roomDir !== '' ? state.roomDir : (legacyRoomDirOf(roomDeps) ?? '')
    await carryRoomFile(roomDeps, THREADS_FILE, fromDir, dir)
    // 当天那份全量记录也带过去：不然换了房，她今天前半天的记录就留在了旧目录里。
    await carryRoomFile(roomDeps, dayLogFileName(dayKeyOf(now, deps.timeZone())), fromDir, dir)
    // 刚写的那本日记（如果她已经写好了）：换房不该让她今天这一篇失踪。
    await carryRoomFile(roomDeps, diaryFileName(dayKeyOf(now, deps.timeZone())), fromDir, dir)
    /**
     * 她正在写的这一天也要跟着过去。
     *
     * 房间目录一换，`readWork`/`harvestDiary` 读的就是新目录：材料与日记留在旧目录的话，
     * 收账会以为"还没写"，她白写一遍、或者这一天直接丢。所以复制过去，原件不动。
     */
    if (state.settling !== '') {
      for (const name of [materialFileName(state.settling), diaryFileName(state.settling)]) {
        await carryRoomFile(roomDeps, name, fromDir, dir)
      }
    }
    roomHandle?.dispose?.()
    roomHandle = undefined
    const fresh = await ensureRoom(roomDeps, '')
    if (!fresh.ok) return { ok: false, reason: fresh.reason }
    roomHandle = fresh.handle
    // 建完就是活的：名字在这一刻写（这是唯一不用等会话"被加载"的时机）。
    if (roomHandle?.agent?.session !== undefined) publishRoomTitle(roomHandle.agent.session)
    // 先落盘再删旧任务：中途失败也不会留下"两不靠"的状态。
    const oldRoom = state.roomSessionId
    const next: EvolutionStateDoc = {
      ...state,
      roomSessionId: fresh.sessionId,
      roomDir: dir,
      roomWorkspace: fresh.workspaceId ?? '',
      roomDay: dayKeyOf(now, deps.timeZone()),
      // 旧的房间任务与收账卡片都指向旧会话，留着会继续往昨天那间里投。
      taskId: '',
      collectTaskId: '',
      collectAt: '',
      /**
       * 旧房间要记进"换过的房间"里：它跟新房间是同一个目录、同一个预设，看起来一模一样，
       * 但它已经不是"你跟她说话的地方"了。不记的话，她主动留的那句话会被送进旧屋子
       * （真机 2026-11-27：半夜她留的那句话就是对着空屋子说的）。
       */
      pastRooms: oldRoom === '' ? state.pastRooms : [...state.pastRooms.filter((id) => id !== oldRoom), oldRoom].slice(-8),
      // 记着的那个"说话会话"如果正好是旧房间，就别再往里送了。
      ...(state.talkSessionId === oldRoom ? { talkSessionId: '', talkSeenAt: '' } : {}),
    }
    await saveState(documents, next)
    await deleteTask(roomDeps, staleTask)
    await deleteTask(roomDeps, staleCollect)
    log.info(`新开了一间（${dir}，会话 ${fresh.sessionId}）；旧的那间原样留着`)
    return { ok: true, sessionId: fresh.sessionId, state: next }
  }

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
    /**
     * 「她的房间」：填的是什么、**现在真的住在哪**、配置解出来的目标在哪。
     *
     * 为什么"现在住哪"读状态而不是读配置：两者可以不一样 —— 改了配置还没搬（等她手头这一轮结束）。
     * 只看配置的话，面板会在她还没搬的时候显示"已经搬了"（真机 2026-11-26 就这么骗了一次）。
     */
    room: () => {
      const documents = deps.documents()
      const state = documents === undefined ? undefined : readState(documents)
      const actual = state === undefined || state.roomDir === ''
        ? (legacyRoomDirOf(roomDeps) ?? '')
        : state.roomDir
      const wanted = wantedRoomDirOf(roomDeps)
      return { text: deps.room(), path: actual, target: wanted.ok ? wanted.path : '' }
    },
    writeSettings: (patch) => deps.writeSettings(patch),
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
    ['schedule', 'sessionController', 'sessions', 'agents', 'workspaceRegistry']
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
      /**
       * 当天的**全量记录**先落盘（不截断、不挑拣）。
       *
       * 摘要本子有上限（40 + 60 行），长的一天开头会被挤掉；用户 2026-11-27 定：
       * 她要能看到"今天发生过的所有事"，自己检索、自己挑。所以两份都写：
       * 全量给她查，摘要给收账那份模型调用用。
       */
      await appendDayLog(roomDeps, key, line, clockTextOf(now, deps.timeZone()))
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
      // 摘要本子每行仍然要短：它是喂给模型的，不是给她检索的。
      const clipped = line.length <= TALK_LINE_CHARS ? line : `${line.slice(0, TALK_LINE_CHARS - 1)}…`
      // 换天了就从空本子起：昨天那批已经交给收账了，不该混进今天。
      const base = sameDay ? book : EMPTY_NOTES
      const kept = [...base[column], clipped].slice(-limit)
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
     *
     * 唯一的例外是**还没落地的搬家**：那是用户按下去的动作，不能因为她正在聊天就一直不生效
     * （真机 2026-11-26：面板显示已改，人还住在老地方）。
     */
    if (pausedForBusy && reason !== '她聊完了' && !roomChangePending()) return
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
       * 房间该不该换地方。
       *
       * 会话的目录建好就定死（写在会话头里，挪不动），所以配置里"她的房间"一改，
       * 只有一条路：开一间新的，旧的留给昨天那间自己待着。
       * 老数据没记过 `roomDir`：按老位置的默认值算（升级前房间一定在老位置）。
       *
       * ⚠️ 这一步必须排在"等她写日记"之前：收账等待可以挂几个小时（真机 2026-11-26：
       * 她 14:19 被提醒写日记、一直没写，于是每一次 `arm` 都在收账那一段 `return`，
       * 用户改的房间永远轮不到）。搬家是用户的明确动作，不该被别人的等待拖住。
       */
      if (state.roomSessionId !== '') {
        const wanted = wantedRoomDirOf(roomDeps)
        const current = state.roomDir !== '' ? state.roomDir : (legacyRoomDirOf(roomDeps) ?? '')
        if (!wanted.ok) {
          // 配置填坏了：说清楚，但不动她现在的房间 —— 搬错地方比不搬更糟。
          if (state.lastError !== wanted.reason) {
            state = { ...state, lastError: `"她的房间"解不出来：${wanted.reason}` }
            await saveState(documents, state)
            log.warn(`"她的房间"解不出来（她仍住在 ${current === '' ? '原处' : current}）：${wanted.reason}`)
          }
        } else if (current !== '' && wanted.path !== current) {
          const moved = await rotateRoom(documents, state, wanted.path, now)
          if (moved.ok) {
            state = moved.state
          } else {
            await saveState(documents, { ...state, lastError: `没搬成：${moved.reason}`, lastAttemptAt: now })
            log.warn(`${reason}：没搬成——${moved.reason}`)
            return
          }
        }
      }
      /**
       * 正在等她自己写日记：这段时间**不排"她自己的时间"**。
       *
       * 收账一天的收尾，她已经收到"写吧"那条消息了；这时再叫醒她去干别的，
       * 等于打断她写日记。写好（或这一天放弃）之后自然恢复。
       */
      if (state.settling !== '') {
        const harvested = await harvestDiary(documents, state.settling)
        const today = dayKeyOf(now, deps.timeZone())
        const step = decideSettling({ settling: state.settling, today, harvested })
        if (step === 'harvested') {
          // 收进来了：往下走，按正常节奏排明天的。
          state = readState(documents)
        } else if (step === 'close') {
          /**
           * 那一天已经过去了，她还是没写：**这一天到此为止**。
           *
           * 不这么做的话，零点之后会变成一个死循环：跨天检查每 5 分钟看一次"昨天的手上材料还没写"，
           * 每看一次就重新收账、把 `collectAt` 清掉，于是提醒每 5 分钟响一次，永远不结束
           * （"无日记也是一天"是用户 2026-11-26 的口径，那就不该把这一天吊在这儿）。
           */
          await closeUnwrittenDay(documents, state.settling, now)
          state = readState(documents)
        } else {
          /**
           * 今天这一天还开着、她还没交：不再排任何唤醒。
           *
           * 投递由心跳负责（`collectTaskId` 那张卡片，空闲才投、一天只提醒一次）。
           * 这里只做两件兜底：卡片丢了就补一张；顺带看看她是不是已经写好了（上面那次）。
           */
          if (state.collectTaskId === '' || !(await channelAlive(roomDeps, state.collectTaskId))) {
            const channel = await ensureChannel(
              roomDeps,
              'collect',
              state.roomSessionId,
              buildCollectPrompt(
                state.settling,
                materialFileName(state.settling),
                diaryFileName(state.settling),
                deps.userName?.() ?? '',
                dayLogFileName(state.settling),
              ),
              deps.timeZone(),
            )
            if (channel.ok) {
              await saveState(documents, { ...readState(documents), collectTaskId: channel.taskId })
            }
          }
          return
        }
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
      // 房间必须先有：这个部署的调度服务不能自己创建会话（真机报错见 `room.ts` 的说明）。
      let sessionId = state.roomSessionId
      if (sessionId === '') {
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
          state = {
            ...state,
            roomSessionId: sessionId,
            roomDay: dayKeyOf(now, deps.timeZone()),
            roomDir: room.dir ?? '',
            roomWorkspace: room.workspaceId ?? '',
          }
          await saveState(documents, state)
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
        const wanted = wantedRoomDirOf(roomDeps)
        const rotated = wanted.ok ? await rotateRoom(documents, state, wanted.path, now) : undefined
        if (rotated?.ok === true) {
          sessionId = rotated.sessionId
          state = rotated.state
          log.info(`换了一间新会话（${today}）`)
        } else {
          log.warn(`换新会话失败（${rotated === undefined ? (wanted.ok ? '' : wanted.reason) : rotated.reason}）——今天先接着用旧的那间`)
        }
      } else if (sessionId !== '' && state.roomDay === '') {
        // 老数据没有这个字段：把当前这间认下，别凭空多开一间。
        state = { ...state, roomDay: today }
        await saveState(documents, state)
      }
      /**
       * 她的时间由**插件自己记**。
       *
       * 从前这一步是"建一条 N 秒后自己到点的任务"—— 等于让闹钟替她决定什么时候醒，
       * 而且在"等她写日记"时停不下来、重排时还会念旧文案。现在：`nextAt` 只是插件记下的
       * 一个承诺，到点由心跳去**跑那张卡片**（卡片自己永远不响）。
       * @see installEvolution 里的分钟心跳
       */
      const gap = gapSeconds(state, now)
      /**
       * 已经承诺过的时刻**不许被重启推翻**。
       *
       * 从前这条承诺活在调度任务里（`hasFuture` 那条分支），现在它在状态里：
       * 只要 `nextAt` 还在未来，就沿用它；否则重新算一段间隔。
       */
      const promised = state.nextAt !== '' && Number.isFinite(Date.parse(state.nextAt)) && Date.parse(state.nextAt) > Date.parse(now)
      const nextAt = promised ? state.nextAt : gap === undefined ? '' : new Date(Date.parse(now) + gap * 1000).toISOString()
      const unseen = unnoticedDiary(documents)
      const wakePrompt = buildWakePrompt(
        nextAt === '' ? now : nextAt,
        timeZone,
        lastSaid.get(sessionId) ?? '',
        await readThreads(roomDeps),
        unseen.map((entry) => entry.date),
        deps.userName?.() ?? '',
        describeCapabilities(state.capabilities, deps.userName?.() ?? ''),
      )
      // 通道先摆好：不会自己响，什么时候跑由插件决定。
      const wake = await ensureChannel(roomDeps, 'wake', sessionId, wakePrompt, deps.timeZone())
      if (!wake.ok) {
        await saveState(documents, {
          ...state,
          roomSessionId: sessionId,
          nextAt,
          lastError: wake.reason,
          lastAttemptAt: now,
        })
        log.warn(`${reason}：她那"自己的时间"的卡片没摆好——${wake.reason}`)
        return
      }
      await saveState(documents, {
        ...state,
        roomSessionId: sessionId,
        taskId: wake.taskId,
        nextAt,
        lastError: '',
        lastAttemptAt: now,
      })
      // 这一轮唤醒词里已经带上"日记被翻过"的提醒，她从现在起就知道了。
      await markNoticed(documents, unseen, now)
      log.info(`${reason}：她下一次醒来 ${nextAt === '' ? '（今天不再醒）' : nextAt}`)
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
      log.info('她醒了一次；次数上限是 0（不许自己醒），不再排下一次')
      return
    }
    /**
     * 只记承诺，不排任务。
     *
     * 从前这里要"改那条任务的到点时间 + 顺便换掉提示词"，现在没有那条任务了：
     * `nextAt` 到点之后由心跳把"她自己的时间"那张卡片跑起来，提示词那一刻现写。
     */
    const nextAt = new Date(Date.parse(at) + gap * 1000).toISOString()
    // 提醒已经进下一次唤醒词：从现在起她知道这件事了（不再天天念）。
    await markNoticed(documents, unnoticedDiary(documents), at)
    // 这一轮的"上次"已经用掉了：她马上会产出新的。
    lastSaid.delete(after.roomSessionId)
    await saveState(documents, {
      ...after,
      nextAt,
      lastError: '',
      lastAttemptAt: at,
    })
    const sleeping = after.sleepingSince === '' ? '' : `（睡到 ${nextAt}）`
    void section.refresh()
    log.info(`她醒了一次（今天第 ${after.dayCount} 次，精力 ${Math.round(after.energy)}）；下一次 ${nextAt}${sleeping}`)
  }

  const on = ctx.on as unknown as (
    name: string,
    listener: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>,
  ) => () => void

  /**
   * 投递之前"叫醒她的房间"这件事，我们自己接。
   *
   * 为什么：平台恢复会话那条路**不带模型**，而插件开的会话里也没有"存过的选择"——
   * 真机 2026-11-26：搬完家第一轮就 `agent "…" has no provider/model set`，她一个字都说不出来。
   * 平台在这个动作上留了缺口（`schedule/resolve-agent` 瀑布，注释原话：*"Call next() to use the
   * Web Session controller"*）。我们只认自己那间房，别的会话一律交回去 —— 不替平台做决定。
   */
  ctx.effect(
    () => on('schedule/resolve-agent', async (payload, next) => {
      const sessionId = typeof payload === 'string' ? payload : ''
      const documents = deps.documents()
      const roomSessionId = documents === undefined ? '' : readState(documents).roomSessionId
      if (sessionId === '' || roomSessionId === '' || sessionId !== roomSessionId) return next()
      const registry = roomDeps.agents()
      if (registry === undefined) return next()
      // 已经活着：平台拿到它就行，不用再恢复一次。
      const live = registry.get(sessionId)
      if (live !== undefined) return live
      try {
        const resumed = await resumeAgent(roomDeps, sessionId)
        roomHandle = resumed
        return resumed.agent
      } catch (error) {
        // 叫不醒就交回平台：它至少能让这一轮跑起来（或者如实报错），比我们卡在这里好。
        log.warn('投递前叫醒她的房间失败，交回平台去恢复（那一轮可能没有模型）', error)
        return next()
      }
    }),
    'humanity: 投递前叫醒她的房间',
  )

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
   * **换掉的旧房间也要排掉**：它跟现在的房间是同一个目录、同一个预设，看起来一模一样，
   * 但那儿现在已经不是"你跟她说话的地方"了。真机 2026-11-27：她半夜留的话被送进了旧房间。
   * @param session - 事件带的会话对象。
   * @param sessionId - 会话 id。
   * @param roomSessionId - 她房间的会话 id。
   * @param pastRooms - 换掉的那些房间会话（越新越靠后）。
   * @returns 是的话为 `true`。
   */
  const isTalkSession = (
    session: unknown,
    sessionId: string,
    roomSessionId: string,
    pastRooms: readonly string[] = [],
  ): boolean => {
    if (sessionId === '' || sessionId === roomSessionId) return false
    if (pastRooms.includes(sessionId)) return false
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
      /**
       * 记一次活动：投递守门靠它判断"目标会话闲了没有"。
       *
       * 为什么每条事件都记：她说话、调工具、你说完话都算"这个会话在动"；
       * 只记某一类会漏掉正在跑的那一轮（那就又回到"撞进去"的老问题）。
       */
      noteActivity(sessionId)
      const documents = deps.documents()
      const knownState = documents === undefined ? undefined : readState(documents)
      const roomSessionId = knownState?.roomSessionId ?? ''
      /** 这一次事件是发生在"她跟他说话"的那个会话里吗。 */
      const isTalk = isTalkSession(session, sessionId, roomSessionId, knownState?.pastRooms ?? [])
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
            // 不用去动卡片：她自己的时间由 `fireDueWake` 看着 `busy` 与 `nextAt` 决定跑不跑。
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
            pushHers(`看到：${text.replace(/\s+/g, ' ').trim()}`)
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
            pushTalk(`他说：${said}`)
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
          else if (isTalk) pushTalk(`她说：${said}`)
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
     * 这一天**已经交给她了**（材料写好、提醒也交代过了）：不要再收一遍。
     *
     * 再看一遍会重新写材料、把 `collectAt` 清空 —— 那等于"提醒又没发过"，
     * 于是同一天被反复提醒（跨天之后甚至每 5 分钟一次）。收账只做一次，等她写或者翻篇。
     */
    if (state.settling === date) return
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
    /**
     * 投给她的时候一律用**完整路径**。
     *
     * 2026-11-28 真机：只给文件名，她先 `working_directory` 探了半天位置，最后说
     * "日记材料那个文件我看不到"，两天都没写。她自己目录里有什么、在哪，不该让她猜。
     */
    const roomDir = roomDirOf(roomDeps)
    const pathOf = (name: string): string => (roomDir === undefined ? name : `${roomDir}/${name}`)
    const wrote = await writeOwnFile(roomDeps, materialName, materialFileText(material, date))
    if (!wrote) {
      await noteSettleError(documents, `${date} 的材料没能写进她的目录（她不会看到这一天）`)
      return
    }
    /**
     * 准备"该写日记了"这条**通道**（卡片）——不排时间，等心跳在她空闲时投。
     *
     * 2026-11-26 改：原来是"排一个 30 秒后到点"，结果正好撞进她正在跑的一轮，
     * 消息被排到"下一轮"而下一轮没发生，她根本没看到。现在投的动作交给心跳。
     */
    const channel = await ensureChannel(
      roomDeps,
      'collect',
      state.roomSessionId,
      buildCollectPrompt(date, pathOf(materialName), pathOf(diaryName), deps.userName?.() ?? '', pathOf(dayLogFileName(date))),
      deps.timeZone(),
    )
    if (!channel.ok) {
      await noteSettleError(documents, `${date} 没能备好"该写日记了"这条通道：${channel.reason}`)
      return
    }
    // `collectAt` 留空 = 还没投出去；心跳投成功之后才写它（写了就代表提醒过了，不再提醒）。
    await saveState(documents, {
      ...state,
      settling: date,
      collectAt: '',
      collectTaskId: channel.taskId,
      lastError: '',
    })
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
   * 那一天结束了，她没写：把这一页翻过去。
   *
   * 为什么必须有个"翻篇"的动作：等她写的那段时间里，跨天检查每 5 分钟会看一次"手上材料还没写"，
   * 每看一次就重新收账、把提醒重置一次 —— 于是提醒每 5 分钟响一次，这一天永远不结束。
   * 用户 2026-11-26 的口径是"写不出来就不勉强，无日记也是一天"，所以到点就翻篇：
   * 清掉等待、收掉那张提醒卡，把原因写进状态（外面看得见"这一天没有日记"）。
   * @param documents - 文档表。
   * @param date - 过去的那一天。
   * @param at - 此刻（ISO）。
   */
  const closeUnwrittenDay = async (documents: DocumentStore, date: string, at: string): Promise<void> => {
    const latest = readState(documents)
    await saveState(documents, {
      ...latest,
      settling: '',
      collectAt: '',
      collectTaskId: '',
      lastSettleError: `${date} 她没写：这一天就这么过去了`,
      lastAttemptAt: at,
    })
    await deleteTask(roomDeps, latest.collectTaskId)
    log.info(`${date} 没有日记（她没写），这一天翻篇了`)
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
   * 到点了就跑"她自己的时间"那张卡片。
   *
   * 这就是"什么时候醒由插件定"的落点：卡片永远不会自己响（建的时候锚在 2099），
   * 到点、她空闲、没有在等日记 —— 三个条件同时成立，插件才把它跑起来。
   * @param documents - 文档表。
   * @param state - 现在的状态（心跳刚读的那份）。
   */
  const fireDueWake = async (documents: DocumentStore, state: EvolutionStateDoc): Promise<void> => {
    if (waking) return
    if (state.roomSessionId === '') return
    /**
     * ⚠️ **不再因为"她欠一篇日记"就不叫她**。
     *
     * 原来这里有一条"settling 就先不排"的护栏，理由是"别打断她写日记"。
     * 但它有个致命副作用：她只要一天没写，这一整天就再也不会有自己的时间（真机 2026-11-26：
     * 她 14:19 被提醒、回了两句话没动手，于是到 16:20 都没再被叫过）。
     * 而"别打断"这件事已经有更准的判据了 —— 见下面的 `isIdle`：她真在做事时不会被叫。
     */
    let taskId = state.taskId
    if (taskId === '') {
      // 卡片可能还没摆（例如排程那段因为别的等待提前返回了）：这里补一张，别让她的时间落空。
      const channel = await ensureChannel(roomDeps, 'wake', state.roomSessionId, '这一次醒来要做的事', deps.timeZone())
      if (!channel.ok) {
        log.warn(`她的"自己的时间"没有卡片可用：${channel.reason}`)
        return
      }
      taskId = channel.taskId
      await saveState(documents, { ...readState(documents), taskId })
    }
    // `nextAt` 空 = 没有承诺（例如今天不再醒），不是"马上醒"。
    if (state.nextAt === '' || !Number.isFinite(Date.parse(state.nextAt))) return
    if (Date.parse(state.nextAt) > Date.now()) return
    if (!sessionIdle(roomDeps, state.roomSessionId)) return
    waking = true
    try {
      const at = new Date().toISOString()
      const prompt = buildWakePrompt(
        at,
        deps.timeZone(),
        lastSaid.get(state.roomSessionId) ?? '',
        await readThreads(roomDeps),
        unnoticedDiary(documents).map((entry) => entry.date),
        deps.userName?.() ?? '',
        describeCapabilities(state.capabilities, deps.userName?.() ?? ''),
      )
      const sent = await sendViaCard(roomDeps, taskId, state.roomSessionId, prompt)
      if (!sent.ok) {
        const latest = readState(documents)
        await saveState(documents, { ...latest, lastError: `她的时间投不出去：${sent.reason ?? '未知原因'}` })
        log.warn(`"她自己的时间"投不出去（${sent.reason ?? '未知原因'}）`)
        return
      }
      /**
       * 投出去之后先记一个"下一次"：她这一轮跑完会由 `onWake` 重排；
       * 万一那一轮没跑起来（模型挂了、被取消），也不至于从此不再醒。
       */
      const gap = gapSeconds(readState(documents), at)
      await saveState(documents, {
        ...readState(documents),
        nextAt: gap === undefined ? '' : new Date(Date.parse(at) + gap * 1000).toISOString(),
      })
      log.info('到点了：跑"她自己的时间"那张卡片（她那边是空闲的）')
    } catch (error) {
      log.warn('跑"她自己的时间"那张卡片时出错', error)
    } finally {
      waking = false
    }
  }

  /**
   * 她聊完了就把房间的闹钟放回去。
   *
   * 为什么用轮询而不是"最后一条消息之后延时"：会话可能被压缩、重放或中途断开，
   * 事件不一定有收尾；每分钟看一眼"安静了多久"最稳，也不会因为漏掉一条事件就永远压着。
   */
  const busyTimer = setInterval(() => {
    if (!moduleEnabled()) return
    /**
     * 投递守门：**卡片只是通道，等她那边闲了才投**。
     *
     * 真机 2026-11-26：投递正好撞进她正在跑的一轮，消息被排到"下一轮"而下一轮没发生 ——
     * 她根本没看到"该写日记了"。这里每分钟看一眼：闲了就投，投过就不再投。
     */
    const gated = deps.documents()
    if (gated === undefined) return
    const gatedState = readState(gated)
    // 她自己的时间到点了没有（卡片不会自己响，只能由这里跑）。
    void fireDueWake(gated, gatedState)
    if (
      gatedState.settling !== ''
      && gatedState.collectAt === ''
      && gatedState.collectTaskId !== ''
      && sessionIdle(roomDeps, gatedState.roomSessionId)
    ) {
      // ⚠️ 这里也要给"当天全量记录"和**完整路径**：真正投递走的是这一条（心跳），
      // 不是 settleOnce 那条。2026-11-28 真机：两天没写日记，就是这条还在发旧提示词 ——
      // 只给了文件名，她说"那个文件我看不到"，然后没读、也没写。
      const dir = roomDirOf(roomDeps)
      const pathOf = (name: string): string => (dir === undefined ? name : `${dir}/${name}`)
      const prompt = buildCollectPrompt(
        gatedState.settling,
        pathOf(materialFileName(gatedState.settling)),
        pathOf(diaryFileName(gatedState.settling)),
        deps.userName?.() ?? '',
        pathOf(dayLogFileName(gatedState.settling)),
      )
      void sendViaCard(roomDeps, gatedState.collectTaskId, gatedState.roomSessionId, prompt)
        .then(async (outcome) => {
          if (!outcome.ok) {
            log.warn(`"该写日记了"投不出去（${outcome.reason ?? '未知原因'}）`)
            const latest = readState(gated)
            await saveState(gated, { ...latest, lastError: `收账提醒投不出去：${outcome.reason ?? '未知原因'}` })
            return
          }
          const latest = readState(gated)
          await saveState(gated, { ...latest, collectAt: new Date().toISOString() })
          log.info('"该写日记了"已经投给她（她那边是空闲的）')
        })
        .catch((error: unknown) => log.warn('收账提醒投递失败', error))
    }
    if (!pausedForBusy) return
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
    const today = dayKeyOf(now, deps.timeZone())
    /**
     * 她欠着的那一天**已经过去了**（她没写）：就在这里翻篇。
     *
     * 为什么放在跨天检查里而不是只放在排程里：排程下一次跑可能是几小时后（她的下一次醒来），
     * 那一天就会被吊到那时候 —— 而"翻篇"是墙钟的事，到点就该办。
     */
    const state = readState(documents)
    if (state.settling !== '' && decideSettling({ settling: state.settling, today, harvested: false }) === 'close') {
      void closeUnwrittenDay(documents, state.settling, now).catch((error: unknown) => {
        log.warn(`翻篇失败（${state.settling}）`, error)
      })
    }
    const book = readNotes(documents)
    // 今天的不在这里收：她还没过完这一天，等睡下再说。
    if (book.day === '' || book.day === today || isEmptyNotes(book)) return
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
    /**
     * 记一句"为什么还没送出去"（只在变化时写）。
     *
     * 为什么非要落盘：这条通道的等待有四种（等他说过话的会话、等他安静、等他的会话跑完、没地方送），
     * 外面完全分不出来 —— 真机 2026-11-27 就是"看着一直不送、也不知道卡在哪"。
     */
    const note = async (reason: string): Promise<void> => {
      if (doc.lastReason === reason) return
      await saveTell(documents, { ...doc, lastReason: reason })
    }
    const now = new Date().toISOString()
    const today = dayKeyOf(now, deps.timeZone())
    const state = readState(documents)
    /**
     * 记着的那个"说话会话"如果其实是她的房间（现在的、或换掉的旧房间），就当没有。
     *
     * 真机 2026-11-27：过了零点换房之后这里还指着旧房间，她半夜她留的那句话
     * 被送进了自己的旧屋子 —— 等于对着空屋子说了句话。这里发现就当没记过，等他下次开口再定。
     */
    if (state.talkSessionId !== '' && (state.talkSessionId === state.roomSessionId || state.pastRooms.includes(state.talkSessionId))) {
      await saveState(documents, { ...state, talkSessionId: '', talkSeenAt: '' })
      return
    }
    const verdict = canDeliver(doc, state.talkSessionId)
    if (!verdict.ok) {
      if (verdict.reason !== '') await note(verdict.reason)
      return
    }
    /**
     * **他的会话真的闲了吗**：投之前必须确认对面那一轮已经结束。
     *
     * 真机 2026-11-26：消息撞进正在跑的一轮，被排到"下一轮"，而下一轮没发生 ——
     * 她的话永远没送出去。
     *
     * ⚠️ 这是**技术必要性**，不是"打扰他"的规矩：原来还有一条"等他安静 10 分钟"，
     * 2026-11-27 用户要求一并去掉（"不用给她限制，她想找我就找我"）。
     */
    if (!sessionIdle(roomDeps, state.talkSessionId)) {
      await note('你那边的会话还在跑一轮，等她闲下来再送')
      return
    }

    // 他要看的东西：给她绝对路径，并让她在投递那一轮用 present 交出去（他那边就能点开）。
    const showPath = verdict.show === ''
      ? ''
      : (() => {
          const dir = roomDirOf(roomDeps)
          return dir === undefined ? '' : `${dir}/${verdict.show}`
        })()
    const prompt = buildTellPrompt(verdict.text, verdict.show, showPath, deps.userName?.() ?? '')
    const channel = await ensureChannel(roomDeps, 'tell', state.talkSessionId, prompt, deps.timeZone())
    if (!channel.ok) {
      await saveTell(documents, { ...doc, lastReason: channel.reason })
      return
    }
    const outcome = await sendViaCard(roomDeps, channel.taskId, state.talkSessionId, prompt)
    if (!outcome.ok) {
      await saveTell(documents, { ...doc, lastReason: outcome.reason ?? '投递失败' })
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
      taskId: channel.taskId,
      taskSession: state.talkSessionId,
    })
    log.info(`她主动找他说了一句${verdict.show === '' ? '' : `（还带上「${verdict.show}」）`}（已投到他的会话）`)
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
      // 关掉时不用去动卡片：`fireDueWake` 第一步就是 `moduleEnabled()`，她不会再被叫醒。
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
