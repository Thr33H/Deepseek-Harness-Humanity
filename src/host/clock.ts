/**
 * 时间基准：把**用户浏览器的时区**当作整个 Node 进程的本地时区。
 *
 * ### 它解决的是什么
 *
 * 同一份"现在几点"在这套部署里原本有三处来源，而且互相矛盾（2026-11-19 实测现场）：
 * 容器里 `/etc/timezone` 是 `Etc/UTC`，而 `/etc/localtime` 又被挂成了上海时间 ——
 * `date` 说北京时间，Node 说 UTC。而 DSH 给模型注入的时间按**浏览器时区**（正确），
 * Humanity 的精力与日期却按 **Node 的进程时区**（UTC）算。症状不是报错，而是
 * "她下午两点才睡醒""每日用量早上八点才归零"这类没人会立刻归因到时间上的怪事。
 *
 * ### 为什么能从根上解决
 *
 * Node 允许**运行时**改 `process.env.TZ`，改完 `Date` / `Intl` / `getHours()` 立刻跟着变
 * （Node 24 实测：`UTC` → `Asia/Shanghai`，`getTimezoneOffset()` 0 → -480，
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` 同步变）。所以只要把浏览器时区写进进程，
 * **进程内所有按本地时间算的东西就自动一致** —— 不需要给每个模块各传一份时区，也不必改容器。
 *
 * 于是时区的唯一权威变成**浏览器报的那个**，与 DSH 自己给模型的
 * "Interpret otherwise-unqualified dates and times in this zone" 同源：两边不可能分叉。
 *
 * ### 三条纪律
 *
 * 1. **零配置**：默认自动学。第一次收到带浏览器时区的消息就记住，并落盘，重启后先用它。
 * 2. **不抢运维的显式设置**：进程环境里显式给了 `TZ` 就不自动改 —— 那是部署者的决定。
 * 3. **永不抛**：学习失败、存盘失败都只记日志。时间算错是小事，把对话弄挂是大事。
 *
 * ### 边界（写清楚，不假装覆盖）
 *
 * 它改的是 **Node 进程**的时区。容器操作系统的 `date`、以及容器里另一个 Go 程序（Caddy）
 * 的日志仍然是 UTC —— 那些不参与任何业务判断（我核对过 DSH 服务端：排程用每条任务自带的
 * 时区、注入时间用浏览器时区，没有"到几点做什么"的逻辑）。
 * @module humanity/clock
 */
import type { Context } from '@deepseek-ai/cordis'

import type { DocumentStore } from './documents.js'
import type { Log } from './log.js'

/** 保存学到的时区的那条文档的键（在 `documents` 表里）。 */
export const CLOCK_DOCUMENT = 'humanity-clock'

/** 生效时区的来源。 */
export type ClockSource =
  /** 从浏览器学到（本次运行或以前存下的）。 */
  | 'auto'
  /** 用户在设置里固定了一个时区。 */
  | 'manual'
  /** 进程环境里显式给了 `TZ`，本模块不碰。 */
  | 'env'
  /** 还没学到、也没有固定值，用进程默认值（容器里通常是 UTC）。 */
  | 'default'

/** 工作台要看的时区状态（全是要么真、要么"还不知道"，不编默认值）。 */
export interface ClockReport {
  /** 当前生效的时区（`Intl` 解析出的规范名，例如 `Asia/Shanghai` / `UTC`）。 */
  effective: string
  /** 它是怎么来的。 */
  source: ClockSource
  /** 学到它的时刻（ISO 8601；空串 = 没学过）。 */
  learnedAt: string
}

/** 时间基准句柄。 */
export interface Clock {
  /** 当前状态（工作台与日志用；每次现算，不缓存）。 */
  report(): ClockReport
  /** 存储就绪后调用一次：把上次学到的时区应用上，不必等第一条消息。 */
  restore(): void
  /** 用户改了"自动/手动"或固定时区之后调用：立刻重新算一次生效时区。 */
  reconfigure(): void
  /** 卸载监听。 */
  dispose(): void
}

/** 外部事实：文档表（现读）与日志。 */
export interface ClockDeps {
  /** 文档表句柄；存储未就绪时返回 `undefined`。 */
  documents(): DocumentStore | undefined
  log: Log
  /**
   * 用户偏好：是否自动跟随浏览器、固定时区是哪个。
   *
   * 现读不缓存：用户在设置里一改，`reconfigure()` 就会拿最新的值重算（P-030 即时生效）。
   */
  preference(): { auto: boolean; zone: string }
  /**
   * 生效时区变了之后的回调（宿主用来重投影一次工作台）。
   *
   * 为什么需要它：工作台的"时间基准"是投影出来的，不重投影就会一直显示旧时区 ——
   * 那正是这次事故的样子（界面上看不出任何异常）。
   */
  onChanged?(): void
}

/** 进程环境（不在 `lib` 里引入 node 类型，与 `index.ts` 的 `dshHome()` 同一条做法）。 */
function environment(): Record<string, string | undefined> | undefined {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
}

/**
 * 进程当前解析出的时区。
 *
 * 用 `Intl` 而不是读 `process.env.TZ`：后者为空时（容器里就是这样）真实时区由系统文件决定，
 * 只有 Intl 会如实告诉你**实际生效的是哪一个**。
 * @returns 规范时区名。
 */
function currentZone(): string {
  return new Intl.DateTimeFormat('en-US').resolvedOptions().timeZone
}

/**
 * 这个字符串能不能当 IANA 时区用。
 *
 * 非法值绝不能写进 `process.env.TZ`：那会让 `Intl` 在**别的模块**里抛错，
 * 一处坏数据拖垮整个进程。所以先探测再应用。
 * @param name - 候选时区名。
 * @returns 可用时为 `true`。
 */
export function isKnownTimeZone(name: string): boolean {
  if (name.trim() === '') return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name })
    return true
  } catch {
    return false
  }
}

/**
 * 从一条对话消息里读浏览器报的时区。
 *
 * 字段就是 DSH 自己用的那个（`source.clientTimeZone`，网页端发消息时附带）——
 * 读同一个字段是刻意的：这样 Humanity 的"本地时间"与 DSH 注入给模型的时间**同源**，
 * 不存在两套时区各自漂移的可能。
 *
 * 结构读取而不是 import DSH 的类型：本模块只关心这一个字段，不该依赖某个版本的
 * 消息类型（与 `emotion/echo.ts` 结构读取记忆同一条纪律）。
 * @param message - 消息对象（形状不认识时返回 `undefined`，不抛）。
 * @returns 时区名；不是网页端用户消息时为 `undefined`。
 */
export function browserTimeZoneOf(message: unknown): string | undefined {
  if (message === null || typeof message !== 'object') return undefined
  const source = (message as { source?: unknown }).source
  if (source === null || typeof source !== 'object') return undefined
  if ((source as { kind?: unknown }).kind !== 'user') return undefined
  const zone = (source as { clientTimeZone?: unknown }).clientTimeZone
  return typeof zone === 'string' && zone !== '' ? zone : undefined
}

/** 存下来的文档值（读的时候逐字段校验，坏值当作没存过）。 */
function readStoredZone(value: unknown): { timeZone: string; learnedAt: string } | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as { timeZone?: unknown; learnedAt?: unknown }
  if (typeof record.timeZone !== 'string' || !isKnownTimeZone(record.timeZone)) return undefined
  return { timeZone: record.timeZone, learnedAt: typeof record.learnedAt === 'string' ? record.learnedAt : '' }
}

/**
 * 装上时间基准。
 *
 * 做的事只有三件：把学到的时区写进进程环境、存一份到文档表、把状态报告给工作台。
 * 它不碰任何模块的状态 —— 改的是**进程**，所有按本地时间算的代码自动跟着走。
 * @param ctx - 本插件的上下文。
 * @param log - 日志门面。
 * @param deps - 文档表句柄与日志。
 * @returns 时间基准句柄（卸载时调用 `dispose`）。
 */
export function installClock(ctx: Context, log: Log, deps: ClockDeps): Clock {
  const env = environment()
  /** 运维显式给的时区：给了就不抢（那是部署者的决定，不是我们能覆盖的）。 */
  const explicit = env?.TZ?.trim() ?? ''
  /** 进程出厂时区：手动模式切回自动、又还没学到东西时，靠它复原。 */
  const originalZone = currentZone()
  /** 学到 / 恢复的时区；空串 = 还没学到。 */
  let learnedZone = ''
  let learnedAt = ''
  /** 生效时区是从哪来的（每次 `resolve` 重算）。 */
  let source: ClockSource = explicit !== '' ? 'env' : 'default'

  /** 把时区写进进程（`Intl` 与 `Date` 会立刻跟着变）。 */
  const apply = (zone: string): void => {
    if (env === undefined) return
    if (currentZone() === zone) return
    env.TZ = zone
    log.info(`时间基准：进程时区已切到 ${zone}`)
    deps.onChanged?.()
  }

  /**
   * 按"用户的偏好 + 环境 + 学到的东西"算出生效时区并应用。
   *
   * 优先级（高到低）：
   * 1. **手动指定**（且时区合法）：用户明确选了，就按它；
   * 2. **运维的 `TZ`**：部署者显式设了，不动；
   * 3. **浏览器学到的**：自动模式的默认来源；
   * 4. 什么都没有：回到进程出厂的时区。
   */
  const resolve = (): ClockSource => {
    const pref = deps.preference()
    if (pref.auto === false && isKnownTimeZone(pref.zone)) {
      source = 'manual'
      apply(pref.zone)
      return 'manual'
    }
    if (explicit !== '') {
      source = 'env'
      return 'env'
    }
    if (learnedZone !== '') {
      source = 'auto'
      apply(learnedZone)
      return 'auto'
    }
    source = 'default'
    apply(originalZone)
    return 'default'
  }

  /** 记住并落盘（同一个值不重复写）。 */
  const remember = (zone: string): void => {
    if (zone === learnedZone) return
    learnedZone = zone
    learnedAt = new Date().toISOString()
    source = 'auto'
    apply(zone)
    const store = deps.documents()
    if (store === undefined) return
    void store
      .write(CLOCK_DOCUMENT, { timeZone: zone, learnedAt })
      .catch((error: unknown) => log.warn(`时间基准：保存时区 ${zone} 失败（本次仍在生效）`, error))
  }

  // 装上就先算一次：手动固定要**立刻**生效（不能等存储打开或下一条消息）。
  const initial = resolve()
  // 预启动提示：让日志里能一眼看到"这次用的是哪个钟、从哪来的"。
  switch (initial) {
    case 'env':
      log.info(`时间基准：沿用进程环境里的 TZ=${explicit}（不再自动学习）`)
      break
    case 'manual':
      log.info(`时间基准：手动模式，固定 ${currentZone()}`)
      break
    case 'auto':
      log.info(`时间基准：沿用上次学到的时区 ${currentZone()}`)
      break
    default:
      log.info(`时间基准：还没学到浏览器时区，暂用进程默认值 ${currentZone()}`)
  }

  const on = ctx.on as unknown as (
    name: string,
    listener: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>,
  ) => () => void

  const off = on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    // 只读、只记：任何异常都不许影响这一轮对话。
    try {
      if (explicit !== '') return decision
      // 手动模式下不学：用户已经明确说了用哪个，跟着对话变就是打他的脸。
      if (deps.preference().auto === false) return decision
      if (decision === null || typeof decision !== 'object') return decision
      const messages = (decision as { messages?: unknown }).messages
      if (!Array.isArray(messages)) return decision
      // 同一次请求里可能有多条带时区的消息（历史 + 本轮）。取**最后一条**：
      // 它代表用户此刻用的设备；与 DSH 自己"本轮以最新上报为准"的取向一致。
      let zone: string | undefined
      for (const message of messages) {
        const found = browserTimeZoneOf(message)
        if (found !== undefined) zone = found
      }
      if (zone === undefined) return decision
      if (!isKnownTimeZone(zone)) {
        log.warn(`时间基准：浏览器上报的时区「${zone}」无法识别，忽略（仍用 ${currentZone()}）`)
        return decision
      }
      remember(zone)
    } catch (error) {
      log.warn('时间基准：读取浏览器时区失败（这一轮不切换，不影响对话）', error)
    }
    return decision
  })

  return {
    report: () => ({ effective: currentZone(), source, learnedAt }),
    restore: () => {
      const stored = readStoredZone(deps.documents()?.read(CLOCK_DOCUMENT)?.value)
      if (stored !== undefined) {
        learnedZone = stored.timeZone
        learnedAt = stored.learnedAt
        log.info(
          explicit === ''
            ? `时间基准：读到上次学到的时区 ${stored.timeZone}`
            : `时间基准：读到 ${stored.timeZone}，但进程环境已指定 TZ=${explicit}（以环境为准）`,
        )
      }
      // 无论有没有存过，都按当前偏好算一次：手动模式要立刻盖过存下来的值。
      resolve()
    },
    reconfigure: () => {
      resolve()
    },
    dispose: off,
  }
}
