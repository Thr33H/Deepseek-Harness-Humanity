/**
 * 把记忆接进这一轮对话：**系统提示词只放不变的那几句，变化的走消息末尾追加**。
 *
 * ### 为什么分两处（2026-11-20 用户定）
 *
 * 系统提示词在最前面 —— 它一变，后面所有前缀缓存全部作废。而"这一轮想起哪几条"是
 * **每轮都不一样**的，放进系统提示词等于每轮清一次缓存。情绪模块早就按这个原则做了
 * （`agent/pre-step` 追加一条带 `<system-reminder>` 的用户消息），记忆照办：
 *
 * - **不变的部分**（"你有记忆、什么时候该记、想不起来就查"）→ 系统提示词，一次写死不折腾；
 * - **每轮变的部分**（想起来的那 0–3 条）→ 追加到消息末尾；
 * - **完全不变的兜底**：模型主动回忆时调 `humanity_recall`。
 *
 * ### 一条血泪教训
 *
 * 2026-09-25 真机事故：模型把自动注入的一两条**当成了记忆库全部**，然后即兴补细节、
 * 用"我记得"的口吻陈述。所以引导语里必须写明"注入的只是几条，不是全部"。
 * @module humanity/memory/inject
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'

import { createMainAgentJudge } from '../agent-scope.js'
import type { LlmAccess } from '../llm.js'
import { loadOptional } from '../optional.js'
import { warnSafely, type Log } from '../log.js'
import { FIRST_INJECT, MAX_INJECT, MEMORY_SOURCE_KIND, RECALL_REINFORCE } from './constants.js'
import { FIRST_RECALL_TITLE, MEMORY_GUIDANCE, MEMORY_GUIDANCE_TITLE, renderRecalled } from './render.js'
import { splitByDisclosure } from './disclosure.js'
import { recall, strongest } from './search.js'
import type { MemoryStore } from './store.js'
import type { MemoryFeeling, MemoryHit, MemoryMood, MemoryRecord } from './types.js'
import { consolidate } from './consolidate.js'
import { CONSOLIDATE_COOLDOWN_MS } from './constants.js'
import { integrate, remember, type RawEvent } from './write.js'

/** 注入消息的来源名（排查时按它能在会话里认出这条是记忆）。 */
export const MEMORY_SECTION_NAME = 'humanity:memory'

/**
 * 缓冲区攒到多少条就整合一次。
 *
 * 太小 → 模型调用太频繁（每句都花钱）；太大 → 一段对话结束才记，容易丢细节。
 * 6 条大致是"三轮来回"，一段像样的话刚好讲完。
 */
const INTEGRATE_EVERY = 6

/** 距上次整合超过这么久、且缓冲区非空，也整合一次（防止零散对话永远攒不够）。 */
const INTEGRATE_IDLE_MS = 20 * 60_000

/**
 * 「她想起来了，但不想说」那句。
 *
 * 只给这一句、不给内容 —— 这是"秘密"能被看见的唯一形态：她会有反应（回避、欲言又止），
 * 但对方拿不到那件事。如果连这句都不给，她就等于没想起来，那不是藏着，是失忆。
 */
export const WITHHELD_NOTE = '【你刚才想起了一件事，但你不想说】'

/** 一条已经响过的定时提醒。 */
export interface FiredReminder {
  /** 提醒的原话（`reminder_prompt_json` 解出来的）。 */
  prompt: string
  /** 这次触发对应的时刻（`occurrence_at`）—— 用来去重，同一次只记一次。 */
  at: string
}

/**
 * 从一条消息的正文里解析出定时提醒。
 *
 * **必须同时认两种形状**（2026-11-21 真机踩过）：`dsh-schedule` 会按"这条提醒是不是那一轮
 * 唯一要发的"决定用单条还是批量格式，只认一种就会漏（我第一版只写单条，结果真机发的是批量，
 * 一条都没记上）：
 * ```
 * [SCHEDULE REMINDER]              ← 单条
 * occurrence_at: 2026-11-21T07:00:00.000Z
 * reminder_prompt_json: "提醒火火吃药"
 *
 * [SCHEDULE REMINDER BATCH]        ← 批量（哪怕只有一条也走这个）
 * reminders_json: [{"schedule_id":"…","occurrence_at":"…","reminder_prompt":"…"}]
 * ```
 * 解析失败就返回空数组 —— 认不出来就当没有，绝不猜。
 * @param text - 消息正文。
 * @returns 这次触发包含的提醒（可能多条）。
 */
export function parseScheduleReminders(text: string): FiredReminder[] {
  if (!text.includes('[SCHEDULE REMINDER')) return []

  // 批量格式优先：它带着完整的结构，逐条读比正则可靠。
  const batch = /reminders_json:\s*(\[[\s\S]*?\])/.exec(text)?.[1]
  if (batch !== undefined) {
    try {
      const list: unknown = JSON.parse(batch)
      if (Array.isArray(list)) {
        const fired: FiredReminder[] = []
        for (const item of list) {
          const raw = item as { reminder_prompt?: unknown; occurrence_at?: unknown }
          if (typeof raw.reminder_prompt !== 'string' || raw.reminder_prompt.trim() === '') continue
          fired.push({
            prompt: raw.reminder_prompt.trim(),
            at: typeof raw.occurrence_at === 'string' ? raw.occurrence_at : '',
          })
        }
        if (fired.length > 0) return fired
      }
    } catch {
      // 落到单条格式再试一次（形状不对不是"没有提醒"，只是没按批量写）。
    }
  }

  const at = /occurrence_at:\s*(\S+)/.exec(text)?.[1] ?? ''
  const raw = /reminder_prompt_json:\s*(.+)/.exec(text)?.[1]?.trim() ?? ''
  if (raw === '') return []
  try {
    const prompt: unknown = JSON.parse(raw)
    return typeof prompt === 'string' && prompt.trim() !== '' ? [{ prompt: prompt.trim(), at }] : []
  } catch {
    return []
  }
}

/** 已经补记过的提醒（按 `occurrence_at` 去重；内存里就够，重启后最多重记一次）。 */
const recordedReminders = new WeakMap<object, Set<string>>()

/** 一条消息是不是定时提醒发来的。 */
function isReminderMessage(message: unknown): boolean {
  return (message as { source?: { kind?: unknown } } | undefined)?.source?.kind === 'schedule'
}

/**
 * 找出这一轮里**还没记过**的定时提醒。
 *
 * ### 为什么不看"他回没回"
 *
 * 我第一版是"他回话了就不记，交给整合" —— 真机立刻打脸：他回的是"**再**提醒我一次喝水"，
 * 根本不是对"水喝了没"的回应，可我的判断只看见"有用户消息"就放手，结果两边都没记，
 * **她提醒过这件事在系统里彻底消失**（2026-11-21）。
 *
 * 正确口径：「我提醒了」是**已经发生的事实**，他回什么都不改变它。他回了什么由整合另记一条
 * —— 那是"对话内容"这个层面，和"我做过什么"不是一回事，同时存在不是重复。
 * @param agent - 当前会话主体（去重集合按它分）。
 * @param messages - 这一轮要发给模型的消息。
 * @returns 需要补记的提醒；没有就 `undefined`。
 */
function latestFiredReminder(agent: object, messages: readonly unknown[]): FiredReminder | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!isReminderMessage(message)) continue
    const fired = parseScheduleReminders(textOf(message))
    if (fired.length === 0) return undefined
    let seen = recordedReminders.get(agent)
    if (!seen) {
      seen = new Set<string>()
      recordedReminders.set(agent, seen)
    }
    const fresh = fired.find((item) => !seen.has(item.at === '' ? item.prompt : item.at))
    if (fresh === undefined) return undefined
    seen.add(fresh.at === '' ? fresh.prompt : fresh.at)
    return fresh
  }
  return undefined
}

/**
 * 补记一条"我提醒了"。
 *
 * 只在"他还没回"时走这条路 —— 回了他那一句会由整合自然记下来，两边都写就是同一件事两份。
 * @param store - 记忆读写。
 * @param fired - 响过的提醒。
 * @param userName - 对方叫什么（空串时写"他"）。
 * @param now - 现在。
 * @param log - 日志门面。
 */
async function writeFiredReminder(
  store: MemoryStore,
  fired: FiredReminder,
  userName: string,
  now: Date,
  log: Log,
): Promise<void> {
  try {
    const who = userName.trim() === '' ? '他' : userName.trim()
    // 提醒的原话里常混着她当时写给自己的交代（"语气随意点，就说一句：水喝了没。"），
    // 记进记忆只需要"提醒什么"，取到第一个句读就够 —— 否则读起来像一条会议记录。
    const clean = fired.prompt.split(/[。：:！!？?\n]/)[0]?.trim() ?? ''
    await remember(
      store,
      {
        what: `我按约定提醒了${who}：${clean === '' ? fired.prompt : clean}`,
        about: 'us',
        certain: 'witnessed',
      },
      { userName },
    )
    // `remember` 不接受自定义 `when`（那是"这件事什么时候发生"，由它自己取当下）——
    // 提醒就是在刚才那一分钟发生的，用当下是对的。
    void now
  } catch (error) {
    warnSafely(log, '定时提醒的留痕没写进去（不影响这一轮）', error)
  }
}

/** 注入需要的外部事实。 */
export interface MemoryInjectionDeps {
  store(): MemoryStore | undefined
  enabled(): boolean
  /** 每轮最多带几条（配置）。 */
  maxInject(): number
  mood?(): MemoryMood | undefined
  /** 这一轮想起了哪几条（宿主转给情绪做回声）。 */
  onRecalled?(records: readonly MemoryRecord[]): void
  /** 对方叫什么（提醒留痕要用名字；空串时退回"他"）。 */
  userName?(): string
  /** 后台模型入口（整合要用）。 */
  llm: LlmAccess
  /**
   * 写下这一刻她的情绪指纹。
   *
   * 整合写下的记忆也要带上它 —— 不带的话，所有"整合来的"记忆强度都按零情绪算，
   * 真机上那些条目就永远停在最淡的那一档（2026-11-22 发现：这条线一直没接）。
   */
  feeling?(): MemoryFeeling | undefined
  /** 后台写了东西（整合/归拢）之后让工作台重新投影。 */
  changed?(): void
  /**
   * 哪个会话要**完全跳过**记忆这一步（她自己的时间）。
   *
   * 为什么：注入是按会话全局跑的，她独处时也会被推"想起他累了"这类内容，
   * 结果她放下手上的事、转身去照顾一个不在场的人（2026-11-24 12:38 真机）。
   * 她的时间不该被他的事推着走；她真想起来的时侯，有 `humanity_recall` 可以主动查。
   */
  skipSession?(): string
  /**
   * 这一轮想起了什么（给工作台的"为什么想起"）。
   *
   * 与 `onRecalled` 的区别：那个是给情绪做回声，这个是给**人看**的说明。
   */
  onRecallShown?(cue: string, hits: readonly MemoryHit[]): void
  /**
   * 生效时区（IANA 名）。
   *
   * 给了就按**日历日**说"今天/昨天" —— 半夜聊天时毫秒差会把昨晚的事算成今天。
   */
  timeZone?(): string | undefined
}

/**
 * 造一条用户消息（注入用）。
 *
 * ### 为什么自己造，不 import `createUserMessage`
 *
 * 插件把 `@deepseek-ai/dsh-llm` 声明成 peer 依赖（由宿主提供），但**运行时从插件目录解析不到它**：
 * 实机验证 `import('@deepseek-ai/dsh-llm')` → `ERR_MODULE_NOT_FOUND`。于是 `loadOptional` 永远返回
 * `undefined`，构造注入消息那一步静默失败 —— 现象是"记忆被算作想起过（`recalled` 加一），
 * 但她这一轮什么都没看到"（2026-11-21 真机）。
 *
 * 而那个函数在运行时只是**纯数据构造**（`dsh-llm/lib/index.js` 第 60 行）：
 * `{ ...input, role: 'user', id: brandString(randomUUID()) }` 再深冻结，而 `brandString` 是恒等函数
 * （`dsh-brand/lib/index.js` 第 20 行）。抄这十行比依赖一个解析不到的包稳。
 * @param input - 正文与来源标记。
 * @returns 一条可追加进 `messages` 的用户消息。
 */
function createUserMessage(input: { content: unknown[]; source: unknown }): unknown {
  return Object.freeze(structuredClone({ ...input, role: 'user', id: globalThis.crypto.randomUUID() }))
}

/** 一条消息里取正文（结构读，不假设具体类）。 */
function textOf(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) =>
      block !== null && typeof block === 'object' && (block as { type?: string }).type === 'text'
        ? String((block as { text?: unknown }).text ?? '')
        : '',
    )
    .join('\n')
    .trim()
}

/** 把一条消息读成原始片段；不是对话消息（工具结果等）返回 `undefined`。 */
function rawEventOf(message: unknown, at: string): RawEvent | undefined {
  const role = (message as { role?: unknown } | undefined)?.role
  if (role !== 'user' && role !== 'assistant') return undefined
  const text = textOf(message)
  if (text === '') return undefined
  return { role, text, at }
}

/**
 * 这一轮是不是**这个会话的第一轮**（只有第一轮才说"你有记忆"、才带最牢的五条）。
 *
 * ### 为什么看轮次，而不是看"这个进程见过没有"
 *
 * 真机 2026-11-22：一晚上部署三次，同一个会话里她"醒来"了三次。进程内标记重启就没了。
 *
 * ### 为什么不是看历史里有没有那条注入
 *
 * 试过两轮都不行：`agent/pre-step` 拿到的 `payload.messages` **只有这一条新消息**（真机日志
 * `msgCount: 1`），历史根本不在里面；`agent.session.derived` 在装配这一步还是空的。
 * 而 `payload.turn` 是会话内的轮次号、跨重启连续 —— 它才是"这是不是第一次开口"的可靠依据。
 *
 * ⚠️ 这是**会话级**判断：如果插件是在某个会话说到一半才装上，那个会话不会再打招呼
 * （下一个会话会）。这比"每次重启都重新自我介绍一遍"更接近人。
 * @param turn - `agent/pre-step` 里的轮次号（从 1 开始）。
 * @returns 是本会话第一轮则为 `true`。
 */
export function isGreetingTurn(turn: unknown): boolean {
  return turn === 1
}

/**
 * 这条消息是不是我们注入的记忆说明。
 *
 * 只用于排查：注入消息带 `source.kind`，会话日志里能按它找出来。
 * @param message - 会话里的一条消息。
 * @returns 是记忆注入的消息则为 `true`。
 */
export function isMemoryNotice(message: unknown): boolean {
  const source = (message as { source?: { kind?: unknown } } | undefined)?.source
  return source !== null && typeof source === 'object' && (source as { kind?: unknown }).kind === MEMORY_SOURCE_KIND
}

/**
 * 装上记忆注入。
 * @param ctx - 本插件的上下文。
 * @param log - 日志门面。
 * @param deps - 存储、开关与后台模型入口。
 * @returns 卸载动作。
 */
export function installMemoryInjection(ctx: Context, log: Log, deps: MemoryInjectionDeps): () => void {
  const isMainAgent = createMainAgentJudge(ctx, log)
  /** 已经收到过"你有记忆"那段说明的会话（每个会话只给一次）。 */
  const greeted = new WeakSet<object>()
  /** 还没被整合的原始片段（只在内存里：重启即失，本来就该如此）。 */
  let buffer: RawEvent[] = []
  /** 上一次看到的"最后两条消息"，用来避免同一段内容被反复推进缓冲。 */
  let signature = ''
  /** 上一次整合的时刻（毫秒）。 */
  let integratedAt = 0
  /** 归拢正在进行（同一时刻只跑一次：它要调模型，重叠跑只会白花钱）。 */
  let consolidating = false
  /**
   * 上一次**尝试**归拢的时刻（毫秒）。
   *
   * 为什么不能只看库里有没有新概括：模型可能看完说"这些凑不成一类"，那一条都不会写；
   * 只看数据的话，下一轮又会被判定为"该归拢"，于是每轮都花一次钱。
   * 这份时间在内存里（重启会丢），但库里那份冷却仍在（`consolidationDue`），
   * 所以最坏情况是重启后多试一次。
   */
  let consolidateTriedAt = 0

  /** 注入一条带 `<system-reminder>` 的消息（与情绪、第一方时间插件同一形状）。 */
  const makeMessage = (text: string): unknown => {
    const body = `<system-reminder>\n${text}\n</system-reminder>`
    return createUserMessage({
      content: [{ type: 'text', text: body }],
      source: { kind: MEMORY_SOURCE_KIND, form: 'snapshot', sections: [{ name: MEMORY_SECTION_NAME, text: body }] },
    })
  }

  // ① 会话内的第一次：先说清"你有记忆"，再带上她最牢的那几条。
  // ② 之后每轮：按这句话检索 → 追加一条消息 → 记"想起过"。
  const on = ctx.on as unknown as (
    name: string,
    listener: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>,
  ) => () => void

  const off = on('agent/pre-step', async (payload, next) => {
    const decision = (await next()) as { kind?: string; messages?: unknown[] }
    if (decision === null || typeof decision !== 'object' || decision.kind !== 'enter') return decision

    try {
      const { agent, turn } = (payload ?? {}) as { agent?: unknown; turn?: unknown }
      if (agent === null || typeof agent !== 'object' || !isMainAgent(agent)) return decision
      if (!deps.enabled()) return decision
      // 她自己的时间：不注入、也不从那儿收割（她的经历由睡前收账自己写）。
      const skip = deps.skipSession?.() ?? ''
      const sessionId = (agent as { session?: { id?: string } } | undefined)?.session?.id ?? ''
      if (skip !== '' && sessionId === skip) return decision

      const now = new Date()
      const store = deps.store()
      const messages = Array.isArray(decision.messages) ? [...decision.messages] : []

      // 收原始片段：只认最后两条对话消息，且同一段不重复收。
      const tail = messages.slice(-2).map((message) => rawEventOf(message, now.toISOString())).filter((event) => event !== undefined)
      const nextSignature = tail.map((event) => `${event.role}:${event.text}`).join('\n')
      if (nextSignature !== '' && nextSignature !== signature) {
        signature = nextSignature
        buffer = [...buffer, ...tail].slice(-INTEGRATE_EVERY * 3)
      }

      if (store !== undefined) {
        const limit = Math.min(MAX_INJECT, deps.maxInject())
        // 这个会话是不是还没听过"你有记忆"那段：只看**本会话第一轮**（见 `isGreetingTurn`）。
        // 进程内标记用来挡住同一轮里第 2、3 步重复打招呼。
        const first = !greeted.has(agent) && isGreetingTurn(turn)
        const parts: string[] = []
        /** 这一轮真正被她"想起来"的那几条 —— **只有消息真的进了这一轮才算数**。 */
        const recalled: MemoryRecord[] = []

        // 这个会话第一次开口：先说明"你有记忆"，再想起她最牢的那几条。
        // 为什么无条件给：人醒来不会先想"对方今天要聊什么"才决定想起谁 —— 她本来就该记得你。
        // 只靠"拿这句话去配对"的检索回答不了"你还记得我吗"（这句话和任何记忆都不重合）。
        if (first) {
          greeted.add(agent)
          parts.push(MEMORY_GUIDANCE)
          if (limit > 0) {
            // 第一次开口多给几条：她还不知道自己是谁、对方是谁（见 `FIRST_INJECT`）。
            const earliest = strongest(store.all(), Math.max(limit, FIRST_INJECT), now)
            const text = renderRecalled(earliest, now, FIRST_RECALL_TITLE, deps.timeZone?.())
            if (text !== '') {
              parts.push(text)
              recalled.push(...earliest.map((hit) => hit.record))
            }
          }
        }

        // 每轮：以对方这一句话为线索去想起来。
        //
        // 第一句那个"最牢的几条"已经出现过的，这里不再重复 —— 同一段话里同一条记忆写两遍，
        // 既浪费上下文，也让她显得像是在复读（2026-11-22 真机观察到）。
        const alreadyShown = new Set(recalled.map((record) => record.id))
        const latest = [...tail].reverse().find((event) => event.role === 'user')?.text ?? ''
        if (latest !== '' && limit > 0) {
          const hits = recall(store.all(), latest, { mood: deps.mood?.(), now })
            .filter((hit) => !alreadyShown.has(hit.record.id))
            .slice(0, limit)
          const { speakable, withheld } = splitByDisclosure(hits)
          const text = renderRecalled(speakable, now, undefined, deps.timeZone?.())
          if (text !== '') parts.push(text)
          // 秘密：**说她想起了一件但不想说**，不给内容。
          // 如果连"有这么一件事"都不提，她就等于没想起来 —— 那不是藏着，是失忆。
          if (withheld.length > 0) parts.push(WITHHELD_NOTE)
          // 两堆都算"想起来过"：想起来的动作发生了，说不说是另一件事。
          recalled.push(...hits.map((hit) => hit.record))
          if (hits.length > 0) {
            try {
              deps.onRecallShown?.(latest, hits)
            } catch (error) {
              warnSafely(log, '记忆工作台的"为什么想起"上报失败（只影响界面）', error)
            }
          }
        }

        // 定时提醒刚响过：**无论他回不回，这件事都发生过**。
        //
        // 他回话了，整合会把"我提醒了他、他说知道了"记下来（那是主路径，这里不碰）；
        // 但他**不回**才是常态 —— 那就什么都不会留下，恰好是"她做了事却没痕迹"。
        // 所以这里只在"提醒之后还没有任何他的消息"时补一条。
        const fired = latestFiredReminder(agent, messages)
        if (fired !== undefined) {
          void writeFiredReminder(store, fired, deps.userName?.() ?? '', now, log)
        }

        if (parts.length > 0) {
          // 先确认消息真的追加进去了，再记"想起来过"。
          // 反过来的顺序踩过：消息构造失败时（2026-11-21 的 `ERR_MODULE_NOT_FOUND`）
          // 使用次数照样加一，于是库里全是 `recalled: 1` 而模型一次都没看到。
          messages.push(makeMessage(parts.join('\n\n')))
          for (const record of recalled) void store.touch(record.id, now.toISOString(), RECALL_REINFORCE)
          if (recalled.length > 0) {
            try {
              deps.onRecalled?.(recalled)
            } catch (error) {
              warnSafely(log, '记忆召回的情绪回声失败（只影响心情，不影响这一轮）', error)
            }
          }
        }
      }

      // 攒够了就异步整合一次；绝不阻塞这一轮。
      const due = buffer.length >= INTEGRATE_EVERY || (buffer.length > 0 && now.getTime() - integratedAt >= INTEGRATE_IDLE_MS)
      if (due && store !== undefined) {
        const batch = buffer
        buffer = []
        integratedAt = now.getTime()
        void integrate(store, batch, {
          llm: deps.llm,
          log,
          feeling: deps.feeling,
          userName: deps.userName,
        }).catch((error: unknown) => {
          warnSafely(log, '记忆整合失败：这一段没有被记下来（不影响对话）', error)
        })
      }

      // 归拢：把攒够的同类经历合成一句概括（一天最多一次，绝不阻塞这一轮）。
      //
      // 放在这里而不是另起一个定时器：她只在有对话的时候才需要「想起来」，
      // 而这段时间正好是"她闲着"的地方 —— 不必为此再养一套调度器（P-048 的同一考虑）。
      //
      // 两道闸：内存里那道挡住"模型说凑不成、下一轮又来一次"；库里那道（在 `consolidate`
      // 里）挡住进程重启后手痒。两道都过了才真去调模型。
      const attemptDue = now.getTime() - consolidateTriedAt >= CONSOLIDATE_COOLDOWN_MS
      if (store !== undefined && !consolidating && attemptDue) {
        consolidating = true
        consolidateTriedAt = now.getTime()
        void consolidate(store, { llm: deps.llm, log })
          .then((written) => {
            if (written.length > 0) deps.changed?.()
          })
          .catch((error: unknown) => {
            warnSafely(log, '记忆归拢失败（不影响这一轮，明天再试）', error)
          })
          .finally(() => {
            consolidating = false
          })
      }

      return { ...decision, messages }
    } catch (error) {
      log.warn('记忆注入失败：这一轮不注入（不影响对话）', error)
      return decision
    }
  })

  return off
}
