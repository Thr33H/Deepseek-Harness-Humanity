/**
 * 情绪模块的装配：**一个入口**把状态、存储、工作台窗口与（后续的）注入接在一起。
 *
 * ### 它回答的问题
 *
 * 「它此刻怎么样」——不是"它是谁"（人格），也不是"它记得什么"（记忆）。
 *
 * ### 三条纪律（都由别处的教训换来的）
 *
 * 1. **全局只有一份状态**（用户 2026-11-17 定）。会话 A 与 B 读到的是同一份：
 *    换会话不重置、不分裂。这也是把状态键固定成 `current` 的原因（见 `store.ts`）。
 * 2. **结算惰性、不落盘**。内存里保存的是**原始**状态（`settledAt` 可能是几小时前），
 *    `snapshot()` 时按现在一次算完。好处是"进程关了、功能模式待一周"都不影响结果，
 *    而且省掉每一轮写盘 —— 因为衰减是时间函数，重算与逐步攒出来的结果完全相同。
 * 3. **状态未就绪时静默降级**。存储没打开、模块被关掉，都只是"没有情绪"，
 *    绝不能让对话或工作台跟着崩（G-002）。
 *
 * ### 功能模式为什么不介入
 *
 * 用户 2026-11-17 定：功能模式下情绪**不读、不写、不算**。它在那里只是一个"有人格、
 * 没脸色"的助手。所以本模块自己不判断当前是什么模式 —— 判断在调用方（注入），
 * 模块只管"被问到时给出状态"。
 * @module humanity/emotion
 */
import type { Context } from '@deepseek-ai/cordis'

import { createLlmAccess } from '../llm.js'
import type { Log } from '../log.js'
import { warnSafely } from '../log.js'
import type { HumanityStore } from '../store-schema.js'
import { buildEcho, type RecallEchoSource } from './echo.js'
import { installEmotionInjection } from './inject.js'
import { settle, apply, type EmotionPulse } from './state.js'
import { createEmotionStore, type EmotionStore } from './store.js'
import { installEmotionSection, type EmotionSection } from './section.js'
import { stanceReader } from './stance.js'
import { viewOf } from './view.js'
import type { EmotionState } from './types.js'

/** 情绪模块的外部事实。 */
export interface EmotionDeps {
  /** 存储句柄；未就绪时返回 `undefined`。 */
  store(): HumanityStore | undefined
  /** 模块开关（总开关 × 模块开关）。 */
  enabled(): boolean
  /**
   * 生效时区（IANA 名）。
   *
   * 为什么必须显式要它、而不是读进程本地时间：2026-11-19 实机抓到的现场是 —— 同一进程里
   * 改 `process.env.TZ` 之后 `Intl` 跟着变了、`Date` 的本地时间却仍是 UTC，
   * 于是"精力按哪个清晨恢复"和"界面显示哪个时区"对不上。所有影响判断的时间换算都走这里。
   */
  timeZone?(): string | undefined
  /**
   * 一轮情绪真的落地之后的通知（宿主拿它推动性格轴，见 `persona/drift.ts`）。
   *
   * 为什么挂在这里而不是让性格模块自己读情绪表：一次脉冲"结算 → 叠加 → 落盘 → 投影"只有这一条路，
   * 挂在这里拿到的就是**这一次**确切发生了什么（哪些情绪、各多少、温度变了多少），不必事后猜。
   * 回调必须是"不抛、不等"的：情绪是对话的主路径，性格是顺带的事，不能反过来拖住它。
   */
  onApplied?(input: EmotionPulse, now: string): void
}

/** 情绪模块句柄。 */
export interface EmotionModule {
  /**
   * 当前状态（**已结算到此刻**，但不落盘、不改变内存里的原始值）。
   * @param now - 结算到的时刻；省略取当前时钟（测试注入点）。
   * @returns 状态；模块被关掉且从未装载过时为 `undefined`。
   */
  snapshot(now?: string): EmotionState | undefined
  /**
   * 施加一次评估结果（情绪增减 + 关系温度 + 对对方的观察），并落盘 + 刷新工作台投影。
   *
   * 唯一的变化入口：所有事件（对话、任务成败、道歉……）都必须走这里，
   * 这样"结算 → 叠加 → 落盘 → 投影"只有一条路径，不会出现两处各写一半。
   * @param input - 这一次的变化（空脉冲会被判成"没变化"，不写盘）。
   * @param now - 事件时刻。
   */
  pulse(input: EmotionPulse, now?: string): Promise<void>
  /** 存储刚就绪：装载状态并投影一次。 */
  notifyStoreReady(): void
  /**
   * **记忆回声**：这一轮想起了几条旧事，把它们当时的温度带回来一点。
   *
   * 为什么是"一点"：想起一件事不等于重新经历一次。系数压得很低（强度的 8%，上限 6 分），
   * 所以它只会在原本就有的情绪上添一笔，不会凭一条旧记忆把心情整个改写。
   * @param entries - 这一轮召回的记忆（只用 `affect` 与 `content` 两个字段，结构读取）。
   */
  echoRecalled(entries: readonly RecallEchoSource[]): void
  /** 开关变化（false 时保留数据、停止计算与投影）。 */
  setEnabled(enabled: boolean): void
  /** 工作台窗口。 */
  readonly section: EmotionSection
}

/** 时钟注入点（测试用；生产不传）。 */
export type Clock = () => Date

/**
 * 装配情绪模块。
 * @param ctx - 本插件的上下文。
 * @param log - 日志门面。
 * @param deps - 存储句柄与开关。
 * @param clock - 时钟（测试注入）。
 * @returns 模块句柄。
 */
export function installEmotion(
  ctx: Context,
  log: Log,
  deps: EmotionDeps,
  clock: Clock = () => new Date(),
): EmotionModule {
  /** 内存里的原始状态（`settledAt` 可能早于现在）。未装载时为 `undefined`。 */
  let state: EmotionState | undefined
  /** 已绑定到当前存储句柄的读写入口；换存储（重新打开）要重建。 */
  let store: EmotionStore | undefined
  let enabled = false
  /** 装载/写入的串行队列：两个方向都在改同一份内存状态，交叉会得到半份真相。 */
  let queue: Promise<void> = Promise.resolve()

  const nowIso = (): string => clock().toISOString()

  /** 确保内存状态可用（从存储装载一次；没有就造出厂状态）。 */
  const ensureLoaded = (): EmotionState | undefined => {
    if (state !== undefined) return state
    const opening = deps.store()
    if (opening === undefined) return undefined
    store ??= createEmotionStore(opening.emotion)
    try {
      state = store.load(nowIso())
    } catch (error) {
      // 存储已经关了（插件正在卸载，而某个异步收尾动作才跑到这里）：**这不是错误**，
      // 只是"现在没有可读的状态"。不兜住的话它会变成未处理异常 —— 真机上表现为重启前后
      // 日志里一串 `domain 'humanity' is closed`，测试里直接把用例判红。
      warnSafely(log, '情绪状态装载失败（存储可能已关闭），本次当作没有状态', error)
      return undefined
    }
    return state
  }

  /** 结算到 `now` 并**写回内存**（但不落盘：衰减不需要每次写盘）。 */  const section = installEmotionSection(ctx, log, () => {
    const current = state
    if (current === undefined || !enabled) return undefined
    // 工作台读到的是"现在"的值：不结算就展示，会永远停在上次结算的那一刻。
    return viewOf(settle(current, nowIso(), deps.timeZone?.()))
  })

  /**
   * 施加一次脉冲的**唯一实现**（排队 → 结算 → 叠加 → 落盘 → 投影）。
   *
   * 为什么抽成函数：评估（`pulse`）与记忆回声（`echoRecalled`）都会改状态，
   * 两处各写一遍"排队 + 落盘 + 投影"，迟早有一边会漏掉投影或漏掉落盘。
   */
  const runPulse = (input: EmotionPulse, now?: string): Promise<void> => {
    const at = now ?? nowIso()
    const run = async (): Promise<void> => {
      if (!enabled) return
      const current = ensureLoaded()
      if (current === undefined) return
      const next = apply(current, input, at, deps.timeZone?.())
      // 同一个对象说明没有任何变化（空脉冲）：不写盘、不投影。
      if (next === current) return
      state = next
      try {
        await store?.save(next)
      } catch (error) {
        // 落盘失败不该阻断这一轮：内存里已经是新状态，工作台照常能看，
        // 代价只是重启后回到上一次成功的落盘（配一次日志即可，不要重试风暴）。
        log.warn('情绪状态落盘失败（本次仍在内存里生效）', error)
      }
      // 性格漂移是顺带的事：回调自己吞错，绝不拖住情绪这条主路径。
      try {
        deps.onApplied?.(input, at)
      } catch (error) {
        warnSafely(log, '性格漂移的记账失败（不影响情绪与对话）', error)
      }
      await section.refresh()
    }
    queue = queue.then(run, run)
    return queue
  }

  const api: EmotionModule = {
    snapshot: (now) => {
      if (!enabled) return undefined
      const current = ensureLoaded()
      if (current === undefined) return undefined
      return settle(current, now ?? nowIso(), deps.timeZone?.())
    },
    pulse: (input, now) => runPulse(input, now),
    echoRecalled: (entries) => {
      if (!enabled) return
      const shifts = buildEcho(entries)
      if (shifts.length === 0) return
      void runPulse({ shifts })
    },
    notifyStoreReady: () => {
      const run = async (): Promise<void> => {
        if (deps.store() === undefined) return
        // 换了一个存储句柄（重新打开）时必须重建入口，否则会读一份不再被写入的旧表。
        store = undefined
        state = undefined
        ensureLoaded()
        await section.refresh()
      }
      queue = queue.then(run, run)
    },
    setEnabled: (next) => {
      enabled = next
      if (!next) {
        // 关掉只停计算与投影，**不删数据**：下次打开接着用（P-006 同一纪律）。
        state = undefined
        store = undefined
        return
      }
      const run = async (): Promise<void> => {
        ensureLoaded()
        await section.refresh()
      }
      queue = queue.then(run, run)
    },
    section,
  }

  // 注入：只在沉浸模式下往这一轮追一条提醒；后台评估与它共用同一个模型入口。
  /**
   * 她的**立场**：现读人格命名空间，取会改变"这件事意味着什么"的那几样
   * （性格 / 偏好 / 底线 / 关系 / 称呼）。读人格要走已接上的设置句柄 ——
   * 那个句柄住在 `section.read` 里（见 `section.ts` 的说明）。
   */
  const stance = stanceReader((ns) => section.read(ns))
  const disposeInjection = installEmotionInjection(ctx, log, {
    enabled: () => enabled,
    snapshot: () => api.snapshot(),
    pulse: (input) => api.pulse(input),
    llm: createLlmAccess(ctx, log),
    stance,
  })
  ctx.effect(() => disposeInjection, 'humanity: 情绪注入')

  return api
}
