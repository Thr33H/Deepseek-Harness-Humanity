import type { Context } from '@deepseek-ai/cordis'

import type { HumanityConfig, ModuleId } from './config.js'
import { describeError, type Log } from './log.js'

/** 卸载动作。与 cordis `ctx.effect` 的返回值同形，便于直接透传。 */
export type Disposer = () => void

/**
 * 一个模块在本次进程里的可见状态。
 *
 * - `active`：开关打开且已挂载；
 * - `disabled`：被总开关或自身开关关掉；
 * - `failed`：挂载时抛错，已就地隔离；原因同时进日志和工作台；
 * - `skeleton`：开关打开，但该模块在当前版本里还没有实现（M1 阶段全部如此）。
 *
 * 把 `skeleton` 单独列出来，是为了让工作台能如实显示「开关是开的，但功能还没到」，
 * 而不是把未实现的东西标成 active 骗用户。
 */
export type ModuleStatus = 'active' | 'disabled' | 'failed' | 'skeleton'

/** 一个模块的运行状态快照。只含可展示的叶子字段，不含任何活对象。 */
export interface ModuleRuntimeState {
  readonly id: ModuleId
  readonly title: string
  readonly status: ModuleStatus
  /** 仅在 `status === 'failed'` 时存在。 */
  readonly error?: string
}

/** 一个可独立开关的 Humanity 模块。 */
export interface HumanityModule {
  readonly id: ModuleId
  /** 工作台展示用名称。 */
  readonly title: string
  /**
   * 实现是否已落地。未落地 ⇒ 状态读作 `skeleton`。
   * 已落地但没有 `mount`（需要宿主喂存储与开关事实的模块，例如人格 / 记忆）⇒ 由宿主在
   * 注册表之外挂载，注册表报 `active`（见 `mountOne` 的三种情况）。
   */
  readonly implemented: boolean
  /** 该模块自己的开关是否打开。总开关由注册表统一判断，模块这里不用重复判断。 */
  isEnabled(config: HumanityConfig): boolean
  /** 挂载模块并返回卸载动作；尚未实现的模块省略它。 */
  mount?(ctx: Context): void | Disposer
}

/**
 * 套件里的全部模块。
 *
 * 模块之间不互相 import、不共享对象，只共享「开关」这一个事实，因此任何一个模块
 * 挂载失败或日后整体移除，都不会波及其他模块（P-048 模块故障只影响自己）。
 */
export const MODULES: readonly HumanityModule[] = [
  {
    id: 'persona',
    title: '人格',
    implemented: true,
    isEnabled: (config) => config.modules.persona.enabled,
  },
  {
    id: 'memory',
    title: '记忆',
    implemented: true,
    isEnabled: (config) => config.modules.memory.mode !== 'off',
  },
  {
    id: 'evolution',
    title: '自进化',
    implemented: true,
    isEnabled: (config) => config.modules.evolution.enabled,
  },
  {
    id: 'dream',
    title: '梦境',
    implemented: true,
    // 梦境是自进化的一种运行模式，自进化关掉时它没有载体（P-034）。
    isEnabled: (config) => config.modules.evolution.enabled && config.modules.dream.enabled,
  },
]

/** 模块挂载器。 */
export interface ModuleRegistry {
  /**
   * 按当前配置挂载启用的模块，返回**本批次**的卸载动作。
   *
   * 返回值是闭包而不是实例状态，是为了让「改开关 → 卸载旧批次 → 挂载新批次」成为一个
   * 原子动作：调用方不必记住哪一批该被卸掉（见 index.ts 的 syncModules）。
   */
  install(ctx: Context, config: HumanityConfig): Disposer
  /** 各模块当前状态。顺序恒定，与构造时的模块表一致。 */
  snapshot(): readonly ModuleRuntimeState[]
}

/**
 * 挂载一个模块，并给出它本次的状态。
 *
 * 三种情况必须分开（这是"启动日志谎报"的根因）：
 * 1. 有 `mount`：注册表亲自挂载，`implemented` 决定 active / skeleton；
 * 2. **没有 `mount` 但 `implemented`**：功能已落地，只是需要宿主提供存储与开关事实，
 *    由宿主在注册表之外挂载（人格 / 记忆就是这种）。这时报 `active` 是**与宿主的约定** ——
 *    `implemented` 的含义就是"已实现且宿主会挂载它"；
 * 3. 没有 `mount` 且未实现：老实报 `skeleton`，不假装可用。
 * @param ctx - 本插件的上下文。
 * @param module - 模块定义。
 * @param config - 当前配置（总开关与模块开关）。
 * @param batch - 本次批次的卸载动作收集器。
 * @param log - 日志门面。
 * @returns 该模块的运行时状态。
 */
function mountOne(
  ctx: Context,
  module: HumanityModule,
  config: HumanityConfig,
  batch: Disposer[],
  log: Log,
): ModuleRuntimeState {
  const { id, title } = module
  if (!config.enabled || !module.isEnabled(config)) return { id, title, status: 'disabled' }
  if (module.mount === undefined) {
    return { id, title, status: module.implemented ? 'active' : 'skeleton' }
  }
  try {
    const dispose = module.mount(ctx)
    batch.push(typeof dispose === 'function' ? dispose : () => {})
    return { id, title, status: module.implemented ? 'active' : 'skeleton' }
  } catch (error) {
    log.error(`模块「${title}」挂载失败，已单独禁用；其余模块与 DSH 不受影响`, error)
    return { id, title, status: 'failed', error: describeError(error) }
  }
}

/**
 * 创建模块注册表。
 *
 * 隔离点是 `mountOne` 里唯一的 try/catch：单个模块挂载抛错时只把它自己标成 failed，其他模块照常
 * 挂载，DSH 主体也照常启动（G-002 / P-048「停功能，不停 DSH」）。
 */
export function createModuleRegistry(modules: readonly HumanityModule[], log: Log): ModuleRegistry {
  const states = new Map<ModuleId, ModuleRuntimeState>()

  const install = (ctx: Context, config: HumanityConfig): Disposer => {
    const batch: Disposer[] = []
    for (const module of modules) states.set(module.id, mountOne(ctx, module, config, batch, log))
    return () => {
      for (let index = batch.length - 1; index >= 0; index -= 1) {
        try {
          batch[index]?.()
        } catch (error) {
          // 卸载失败同样就地隔离：不能让一个模块的清理异常阻断整条卸载链。
          log.warn('模块卸载时抛错，已忽略并继续卸载其余模块', error)
        }
      }
    }
  }

  return {
    install,
    snapshot: () =>
      modules.map(
        (module) =>
          states.get(module.id) ?? { id: module.id, title: module.title, status: 'disabled' as const },
      ),
  }
}

/** 把模块状态压成一行摘要，供启动日志使用。 */
export function describeModules(states: readonly ModuleRuntimeState[]): string {
  return states.map((state) => `${state.title}=${state.status}`).join(' ')
}
