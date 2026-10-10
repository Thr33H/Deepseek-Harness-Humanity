/**
 * 记忆模块的**唯一入口**。
 *
 * 宿主 `index.ts` 只调 `installMemory(...)` 一行；记忆内部的接线（存储 CRUD、
 * 自动写入管线、待确认、系统提示词引导、Agent 工具、日后的检索/注入/衰减/工作台）
 * 全在这里，加子件时也只改这一个文件 —— 与人格模块同一条约定。
 *
 * **存储是怎么接进来的**：`memory_entries` 表由 `src/host/store.ts` 的
 * `ctx.inject(['storageDomain'], …)` 在打开 humanity 领域时一并声明（一个领域一个打开者）。
 * 记忆模块**不再自己 inject 一次 `storageDomain`**：同一领域打开两次只会互相抢生命周期。
 * 这里只从宿主拿"已打开的存储句柄"，句柄没来之前就是降级态（返回 `undefined`，不抛）。
 *
 * 已完成：M3 步骤 1 数据模型 · 步骤 2 存储 CRUD · 步骤 3 自动写入管线 + 待确认数据层 ·
 * 步骤 4 本地检索 · 步骤 5 自动注入 · 步骤 6 `humanity_recall` · 步骤 7 衰减归档 ·
 * 步骤 8 工作台**数据层**（设置命名空间 `humanity-memory` + 命令槽）。
 * 尚未接入（步骤 8 剩余 + 9）：工作台界面组件、高级开关进配置 schema。
 * @module humanity/memory
 */
import type { Context } from '@deepseek-ai/cordis'

import type { MemoryAdvancedConfig, MemoryMode } from '../config.js'
import type { CompatState } from '../preset-compat.js'
import type { Log } from '../log.js'
import type { HumanityStore } from '../store.js'
import { canRemember, isDegenerateAdvanced, overridesOf, resolveMemoryPolicy } from './policy.js'
import { installMemoryInjection } from './inject.js'
import { installMemorySection } from './section.js'
import { createMemoryStore, type MemoryStore } from './store.js'
import { installMemoryTools } from './tools.js'
import type { MemoryPolicy } from './types.js'

/** 宿主交给记忆模块的外部事实（依赖由宿主注入，记忆内部不去猜）。 */
export interface MemoryDeps {
  /** 当前生效的预设模式；真源在宿主设置（`modules.memory.mode`）。 */
  mode(): MemoryMode
  /** 高级开关（`modules.memory.advanced`）；`customized` 为假时策略完全跟随模式。 */
  advanced?(): MemoryAdvancedConfig
  /** preset 兼容性探测状态（工作台据此提示极简模式不注入）。 */
  compat?(): CompatState
  /** 已就绪的套件存储句柄；未就绪时返回 `undefined`。 */
  store(): HumanityStore | undefined
}

/** 记忆模块句柄：宿主、Agent 工具与工作台都由它进入记忆。 */
export interface MemoryModule {
  /** 当前生效策略（预设 + 高级开关解析后的结果）。 */
  policy(): MemoryPolicy
  /** 记忆读写入口；存储未就绪时为 `undefined`（G-002：降级而不是抛错）。 */
  store(): MemoryStore | undefined
  /** 按配置驱动工具与注入的注册与卸载（幂等；开关即时生效）。 */
  setEnabled(enabled: boolean): void
  /** 把存储现状重新投影给工作台（宿主写的三个字段）。 */
  refresh(): Promise<void>
  /**
   * 存储刚就绪：补消费积压的命令并重新投影（见 `MemorySection.notifyStoreReady`）。
   *
   * 由宿主在 `storageDomain` 打开完成时调用 —— 存储是异步打开的，比命名空间注册晚。
   */
  notifyStoreReady(): void
  /** 卸载本模块的全部副作用（fiber 卸载时由 cordis 调用同一函数）。 */
  dispose(): void
}

/**
 * 造一个"现读存储句柄"的函数。
 *
 * 存储是**异步打开**的，所以不能也不该在装配时缓存一个当下必然为空的引用 ——
 * 每次调用现读，句柄没来就返回 `undefined`（G-002 降级而不是抛错）。
 * @param deps - 宿主注入的外部事实。
 */
function createStoreReader(deps: MemoryDeps): () => MemoryStore | undefined {
  return () => {
    const opened = deps.store()
    return opened === undefined ? undefined : createMemoryStore(opened.memory)
  }
}

/**
 * 装配记忆模块。
 * @param ctx - 宿主上下文，用于把清理钩子挂在本模块的 fiber 上。
 * @param log - 日志门面。
 * @param deps - 宿主注入的外部事实。
 */
export function installMemory(ctx: Context, log: Log, deps: MemoryDeps): MemoryModule {
  /** 配置层的总开关；工具与注入都现读它（开关即时生效，P-030）。 */
  let enabled = true
  /** "三层全关却选了非 off 模式"这条回退只警告一次。 */
  let warnedDegenerate = false
  /** 当前生效策略：每次现算（模式真源在设置里，开关一改下一次就是新结果，P-030）。 */
  const policy = (): MemoryPolicy => {
    const advanced = deps.advanced?.()
    const mode = deps.mode()
    if (advanced !== undefined && isDegenerateAdvanced(advanced, mode)) {
      // 只警告一次：这个判断在每次拼装提示词时都会被调用，重复刷屏没有意义。
      if (!warnedDegenerate) {
        warnedDegenerate = true
        log.warn('记忆高级开关把三层全关了，但模式不是 off —— 已回退到模式预设（否则记忆会静默失效）')
      }
    }
    return resolveMemoryPolicy(mode, advanced === undefined ? {} : overridesOf(advanced, mode))
  }
  const store = createStoreReader(deps)
  // 工作台通道先建：Agent 工具落盘后要让它重新投影（`changed`），否则工作台会停在旧列表上
  // （真机症状：存储里已有记忆，`entries` 仍是 `[]`）。两者都不依赖对方的构造结果。
  const section = installMemorySection(ctx, log, { store, policy, advanced: deps.advanced, compat: deps.compat })
  const tools = installMemoryTools(ctx, log, { store, policy, changed: () => void section.refresh() })
  // 注入只读：开关、当前消息（事件缓存）与检索都在 inject.ts 里闭环。
  const disposeInjection = installMemoryInjection(ctx, log, { store, policy, enabled: () => enabled })

  /** 开关 + 策略共同决定"工具在不在模型可见集合里"。 */
  const sync = (): void => tools.setEnabled(enabled && canRemember(policy()))

  // 装配时就收敛一次：模式为 off 时不该先注册、等宿主下一次配置变更再撤。
  sync()

  const cleanup = (): void => {
    tools.dispose()
    disposeInjection()
    log.info('记忆模块已卸载')
  }
  ctx.effect(() => cleanup, 'humanity: 记忆模块卸载')

  log.info(`记忆模块已装配：${deps.mode()} 模式（数据模型 + 存储 + 写入管线 + 检索 + 注入就绪）`)

  return {
    policy,
    store,
    /** 重新投影一次供工作台读取（存储异步打开、或外部批量改动后调用）。 */
    refresh: section.refresh,
    /** 存储刚打开：补消费被跳过的命令，并把现状投影给工作台。 */
    notifyStoreReady: section.notifyStoreReady,
    setEnabled(next) {
      enabled = next
      sync()
    },
    dispose: cleanup,
  }
}
