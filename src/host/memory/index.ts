/**
 * 记忆模块的**唯一入口**：把数据层、写入、检索、注入、工具接在一起。
 *
 * 宿主 `index.ts` 只调 `installMemory(...)` 一行；记忆内部的接线全在这里。
 *
 * ### 存储是怎么接进来的
 *
 * `memories` 表由 `src/host/store.ts` 在打开 humanity 领域时一并声明（一个领域一个打开者）。
 * 记忆模块**不再自己 inject 一次 `storageDomain`**：同一领域打开两次只会互相抢生命周期。
 * 这里只从宿主拿"已打开的存储句柄"，句柄没来之前就是降级态（返回 `undefined`，不抛）。
 *
 * ### 三处消费者，一个入口
 *
 * - **系统提示词**只放不变的那几句（`MEMORY_GUIDANCE`）；
 * - **每轮变的那几条**在 `agent/pre-step` 里追加到消息末尾（不碰前缀缓存）；
 * - **工具**（记住 / 回想）兜底：模型可以主动查，查不到就是没有。
 * @module humanity/memory
 */
import type { Context } from '@deepseek-ai/cordis'
import type { defineTool as defineToolType } from '@deepseek-ai/dsh-tools'

import type { Log } from '../log.js'
import { createLlmAccess, type LlmAccess } from '../llm.js'
import { loadOptional } from '../optional.js'
import type { HumanityStore } from '../store.js'
import { installMemoryInjection } from './inject.js'
import { installMemorySection } from './section.js'
import { createMemoryStore, type MemoryStore } from './store.js'
import { defineMemoryTools } from './tools.js'
import { remember } from './write.js'
import type { MemoryAbout } from './constants.js'
import { MEMORY_GUIDANCE } from './render.js'
import type { MemoryCharacter, MemoryFeeling, MemoryMood, MemoryRecord } from './types.js'

export { MEMORY_GUIDANCE }
export { MEMORY_RECALL_TOOL, MEMORY_REMEMBER_TOOL } from './constants.js'

/** 宿主交给记忆模块的外部事实（依赖由宿主注入，记忆内部不去猜）。 */
export interface MemoryDeps {
  /**
   * 哪个会话要**完全跳过**记忆这一步（她自己的时间）。
   *
   * 为什么：注入按会话全局跑，她独处时被推"想起他累了"这类内容，会放下手上的事去照顾一个
   * 不在场的人（2026-11-24 12:38 真机）。她真想起来的时侯有 `humanity_recall` 可以主动查。
   */
  skipSession?(): string
  /** 已就绪的套件存储句柄；未就绪时返回 `undefined`。 */
  store(): HumanityStore | undefined
  /** 记忆总开关（配置现读）。 */
  enabled(): boolean
  /** 每轮最多带几条（配置现读；0 = 只靠工具）。 */
  maxInject(): number
  /**
   * 写下这一刻她的情绪指纹（宿主从情绪模块现读；缺席时记忆照常写，只是不带温度）。
   *
   * 记忆不该因为情绪模块没接上就写不进去 —— 这条线是**可选增益**，不是前置条件。
   */
  feeling?(): MemoryFeeling | undefined
  /** 此刻的心情（心境一致：同向的旧事更容易被想起；缺席时排序与没有这个能力时相同）。 */
  mood?(): MemoryMood | undefined
  /** 这一轮想起了哪几条（宿主转给情绪模块做回声；失败了也只影响心情）。 */
  onRecalled?(records: readonly MemoryRecord[]): void
  /** 对方叫什么（被窥探之后她记的那一笔要用名字）。 */
  userName?(): string
  /**
   * 她的性格（被窥探之后的反应强度由它定）。
   *
   * 读不到时传 `undefined`，反应退回基准值 —— 那不等于"她很稳定"。
   */
  character?(): MemoryCharacter | undefined
  /** 生效时区（"昨天/今天"按它算日历日；读不到就按 24 小时）。 */
  timeZone?(): string | undefined
  /** 情绪种类 → 人话（工作台要显示"当时：害怕"）。 */
  feltLabel?(kind: string): string
  /** 休眠中（人格还没封存）：工作台要如实说"还没开始"，而不是"没有记忆"。 */
  dormant?(): boolean
}

/** 记忆模块句柄：宿主与工作台都从这里进入记忆。 */
export interface MemoryModule {
  /** 记忆读写入口；存储未就绪时为 `undefined`（降级而不是抛错）。 */
  store(): MemoryStore | undefined
  /** 按配置驱动子件的注册与卸载（幂等；开关即时生效）。 */
  setEnabled(enabled: boolean): void
  /**
   * 记一件事（后台用：睡前收账）。走与工具同一条写入路径。
   * @param input - 记什么、关于谁。
   */
  remember(input: { what: string; about: MemoryAbout }): Promise<void>
  /** 把存储现状重新投影给工作台。 */
  refresh(): Promise<void>
  /** 存储刚就绪：重新投影。 */
  notifyStoreReady(): void
  /** 卸载本模块的全部副作用。 */
  dispose(): void
}

/** 工具服务的窄面（只用到注册一个方法，不固化整个类型面）。 */
interface ToolsLike {
  register(tool: unknown): () => void
}

/** 工具注册句柄。 */
interface MemoryToolsHandle {
  setEnabled(enabled: boolean): void
  dispose(): void
}

/**
 * 造一个"现读存储句柄"的函数。
 *
 * 存储是**异步打开**的，不能在装配时缓存一个当下必然为空的引用 ——
 * 每次调用现读，句柄没来就返回 `undefined`。
 * @param deps - 宿主注入的外部事实。
 */
function createStoreReader(deps: MemoryDeps): () => MemoryStore | undefined {
  return () => {
    const opened = deps.store()
    return opened === undefined ? undefined : createMemoryStore(opened.memory)
  }
}

/**
 * 注册两个工具（记住 / 回想）。
 *
 * 工具**总是**注册：执行时若存储还没就绪，它返回一句"还没就绪"，而不是让工具从目录里消失 ——
 * 工具目录本来就是每次装配现读的，跟着一起变只会制造"有时有、有时没有"的怪现象。
 * @param ctx - 本插件的上下文。
 * @param log - 日志门面。
 * @param store - 现读存储句柄。
 * @param deps - 情绪指纹与开关。
 * @param changed - 写入后让工作台重新投影。
 * @returns 可开关的注册句柄。
 */
function installTools(
  ctx: Context,
  log: Log,
  store: () => MemoryStore | undefined,
  deps: MemoryDeps,
  changed: () => void,
): MemoryToolsHandle {
  let disposers: Array<() => void> = []
  let active = false

  const clear = (): void => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch (error) {
        log.warn('记忆工具卸载失败（继续卸载其余）', error)
      }
    }
    disposers = []
  }

  const sync = (want: boolean): void => {
    if (want === active) return
    active = want
    clear()
    if (!want) return
    const tools = ctx.get('tools') as ToolsLike | undefined
    if (tools === undefined) return
    void loadOptional<{ defineTool: typeof defineToolType }>('@deepseek-ai/dsh-tools', log).then((module) => {
      if (module === undefined || !active) return
      const defined = defineMemoryTools(module.defineTool, {
        store,
        feeling: deps.feeling,
        changed,
        timeZone: deps.timeZone,
        userName: deps.userName,
        log,
      })
      disposers = defined.map((tool) => tools.register(tool))
    })
  }

  return {
    setEnabled: sync,
    dispose(): void {
      active = false
      clear()
    },
  }
}

/**
 * 装配记忆模块。
 * @param ctx - 宿主上下文，用于把清理钩子挂在本模块的 fiber 上。
 * @param log - 日志门面。
 * @param deps - 宿主注入的外部事实。
 */
export function installMemory(ctx: Context, log: Log, deps: MemoryDeps): MemoryModule {
  const store = createStoreReader(deps)
  const llm: LlmAccess = createLlmAccess(ctx, log)
  let enabled = true

  // 工作台通道先建：写入落盘后要让它重新投影（`changed`），否则界面会停在旧列表上。
  const section = installMemorySection(ctx, log, {
    store,
    userName: deps.userName,
    character: deps.character,
    feltLabel: deps.feltLabel,
    dormant: deps.dormant,
  })
  const changed = (): void => {
    void section.refresh()
  }

  const tools = installTools(ctx, log, store, deps, changed)

  const disposeInjection = installMemoryInjection(ctx, log, {
    store,
    enabled: () => enabled && deps.enabled(),
    maxInject: () => deps.maxInject(),
    mood: deps.mood,
    onRecalled: deps.onRecalled,
    userName: deps.userName,
    llm,
    changed,
    onRecallShown: (cue, hits) => section.noteRecall(cue, hits),
    timeZone: deps.timeZone,
    feeling: deps.feeling,
    skipSession: deps.skipSession,
  })

  const sync = (): void => tools.setEnabled(enabled && deps.enabled())
  sync()

  const cleanup = (): void => {
    tools.dispose()
    disposeInjection()
    log.info('记忆模块已卸载')
  }
  ctx.effect(() => cleanup, 'humanity: 记忆模块卸载')

  log.info('记忆模块已装配：写入 / 遗忘 / 检索 / 注入 / 工具 / 工作台已接')

  return {
    store,
    /**
     * 记一件事（后台用：睡前收账）。
     *
     * 与工具那条路**同一条写入路径**（去重 + 视角归一化），没有"后台记忆"这种特权格式。
     */
    async remember(input) {
      if (!enabled || !deps.enabled()) return
      const handle = store()
      if (handle === undefined) return
      await remember(handle, { what: input.what, about: input.about, certain: 'witnessed' }, { userName: deps.userName?.() })
      changed()
    },
    setEnabled(next) {
      enabled = next
      sync()
    },
    refresh: section.refresh,
    notifyStoreReady: section.notifyStoreReady,
    dispose: cleanup,
  }
}
