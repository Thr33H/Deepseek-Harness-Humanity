/**
 * Humanity 套件 · 宿主半边。
 *
 * 职责边界（M1）：把套件挂进 DSH 的宿主平面——接开关、开存储、按开关挂载各模块。
 * 具体的业务（记忆、自进化、路由）留给后续里程碑，本文件不实现它们。
 *
 * 三条贯穿全文的约束：
 * 1. **零硬依赖**。`inject` 是空的，所有 DSH seam 都按「可选」取用：缺了只关对应子功能，
 *    插件本身照样挂载（G-002）。
 * 2. **模块互相隔离**。单个模块的异常不扩散，DSH 主体永远可启动、可对话（P-048）。
 * 3. **默认值单一真源**。全部默认值在 `config.ts` 的 schema 里，组合补丁不重复声明（G-004）。
 * @module deepseek-harness-humanity
 */
import type { Context } from '@deepseek-ai/cordis'

import { Config, type HumanityConfig } from './config.js'
import { installDataPlane } from './data-plane.js'
import type { DocumentStore } from './documents.js'
import { evolutionDeps, memoryDeps, personaDeps, type HostState } from './deps.js'
import { installExclusionGuard } from './exclusion-guard.js'
import { installEvolution } from './evolution/index.js'
import { EVOLUTION_NAMESPACE } from './evolution/constants.js'
import { createLog, type Log } from './log.js'
import { createModuleRegistry, describeModules, MODULES, type Disposer, type ModuleRegistry } from './modules.js'
import { migrateLegacyDocuments } from './migrate.js'
import { createPlaneSettings, installPlaneSettings } from './plane-settings.js'
import { createCompatState } from './preset-compat.js'
import { installSettings, SETTINGS_NAMESPACE } from './settings.js'
import { installMemory } from './memory/index.js'
import { installPersona } from './persona/index.js'
import { installHumanityStore } from './store.js'

export { Config, MEMORY_MODES, MODULE_IDS } from './config.js'
export { PERSONA_NAMESPACE } from './persona/section.js'
export { EVOLUTION_NAMESPACE } from './evolution/constants.js'
export type { HumanityConfig, MemoryMode, ModuleId } from './config.js'
export type { HumanityModule, ModuleRuntimeState, ModuleStatus } from './modules.js'

/** Cordis 插件名，loader 诊断用。 */
export const name = 'humanity'

/**
 * 硬依赖服务：**故意为空**。
 *
 * 本插件没有任何「缺了就完全不能工作」的 seam：设置服务、存储领域、日志都是可选的，
 * 缺哪个就关哪个子功能并在日志里说明。声明成硬依赖会让插件在缺少任一服务时进入
 * waiting 状态，一个可选能力反而卡住整个套件——与 G-002 相反。
 *
 * ⚠️ **2026-09-23 真机事故的教训（比上面这段话更硬）**：这条规则不只是"少写几个字"，
 * 它还是**可用性**问题。我们一度在注入模块里写了 `ctx.inject(['agents', 'systemPrompt'], …)`,
 * 结果**每个会话都创建失败**：`cannot get required service "agents" in inactive context`
 * —— 把 `agents` 声明成本插件 fiber 的依赖会让组合失活（会话创建走另一个未激活的上下文）。
 * 结论：**除真正缺了就活不了的服务，一律不要写进 `ctx.inject` 的依赖列表**；
 * 需要"看一眼"某个服务时用 `ctx.get(name)`（只读、不声明依赖、读不到返回 undefined）。
 */
export const inject: string[] = []

/** 设置命名空间名，供测试与后续的工作台读取使用。 */
export { SETTINGS_NAMESPACE }

/**
 * 造一个"批次化挂载"器：总是先卸旧批次再装新批次，于是"改开关 → 换一批模块"是一个原子动作。
 * @param ctx - 本插件的上下文。
 * @param registry - 模块注册表。
 */
function createModuleSync(ctx: Context, registry: ModuleRegistry): { sync(next: HumanityConfig): void; dispose(): void } {
  let disposeModules: Disposer | undefined
  return {
    sync: (next) => {
      disposeModules?.()
      disposeModules = registry.install(ctx, next)
    },
    dispose: () => disposeModules?.(),
  }
}

/**
 * 把人格/记忆开关同步给已建好的模块句柄。
 *
 * 句柄在接线完成前是 undefined —— 那期间的开关变更由装配末尾补的那一次调用覆盖。
 * @param state - 宿主状态。
 * @param next - 最新配置。
 */
function syncModulesEnabled(state: HostState, next: HumanityConfig): void {
  state.persona?.setEnabled(next.enabled && next.modules.persona.enabled)
  // 模式 off = 记忆功能关闭：工具与注入都要下线（P-030 即时生效）。
  state.memory?.setEnabled(next.enabled && next.modules.memory.mode !== 'off')
  // 自进化：总开关 + 模块开关；调度器随开关重排（关掉 = 清除定时器，不后台运行，P-048）。
  state.evolution?.setEnabled(next.enabled && next.modules.evolution.enabled)
}

/**
 * 接上存储，并在就绪时通知记忆模块。
 *
 * ⚠️ 为什么必须通知：存储是**异步打开**的，比命名空间注册晚。没有这一步，存储就绪前被跳过的
 * 命令永远不会重试、工作台的 `entries` 会一直停在空列表上（真机症状：存储里已有记忆，
 * 工作台仍是 `[]`）。此刻 `state.memory` 必然已经赋值 —— 打开至少要跨过一个 await。
 * @param ctx - 本插件的上下文。
 * @param log - 日志门面。
 * @param state - 宿主状态（本函数负责填 `store`）。
 */
function openStore(ctx: Context, log: Log, state: HostState, onDocuments: (documents: DocumentStore) => void): void {
  installHumanityStore(ctx, log, (opened) => {
    state.store = opened
    log.info('存储已就绪（历史表 + 记忆表 + 自进化四表 + 文档表可用）')
    // 文档表一就绪就补迁移：人格文档本体只在旧的 settings 文件里，晚一步都是数据风险。
    onDocuments(opened.documents)
    state.memory?.notifyStoreReady()
    // 自进化的 runner/scheduler 是存储就绪后才懒装的（时序说明见 evolution/index.ts）。
    state.evolution?.notifyStoreReady()
    // 历史保留期（0.1.13）：启动就清一次超期记录 —— 否则"长期没人改人格"会让旧记录永远留着
    // （写入时那次清理只在真的有写入时才跑）。**永不抛**：实现里已兜住，这里只管不产生未处理 rejection。
    void state.persona?.pruneHistory()
  })
}

/**
 * 读 `$DSH_HOME`。
 *
 * 为什么不像别处那样直接写 `process.env`：本仓库的宿主编译**没有 `@types/node`**
 * （只有 DSH 自己的类型面），直接用 `process` 会让 `tsc` 报错。取值失败一律返回 `undefined`，
 * 让迁移那条路径显式跳过并记日志，而不是猜一个路径去读。
 * @returns 环境变量值；不存在时 `undefined`。
 */
function dshHome(): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
  return env?.DSH_HOME
}

/**
 * 挂载套件。
 *
 * 从头到尾没有 `await`：所有 seam 都通过 `ctx.inject` 注册，生命周期交给 cordis。
 * 这样 "apply 期间 fiber 被卸载" 这类时序问题根本不会出现——也就没必要在 await 前后
 * 小心翼翼地安排 effect 注册顺序。
 * @param ctx - DSH 宿主上下文。
 * @param config - 组合配置入口值；用户覆盖由设置服务叠加在它之上。
 */
export function apply(ctx: Context, config: HumanityConfig): void {
  const log = createLog(ctx)
  const registry = createModuleRegistry(MODULES, log)
  const state: HostState = {}
  const modules = createModuleSync(ctx, registry)

  // 先注册卸载钩子，让模块清理一定挂在 fiber 上；后续任何一步失败都不会漏掉它。
  ctx.effect(() => modules.dispose, 'humanity: 模块卸载')

  // 开关即时生效（P-030）：模块批次、人格/记忆工具与注入都由这一条链同步。
  const onChanged = (next: HumanityConfig): void => {
    modules.sync(next)
    syncModulesEnabled(state, next)
    // 配置变更（模式/高级开关）不走命令消费路径，若不重投影，工作台的策略视图
    // （模式下拉、生效作用域、自动注入/衰减摘要）会停在上一次投影的旧值上，直到某次
    // 偶然消费才刷新 —— 真机症状：拨开关/切模式界面闪一下不变，点「重新加载」才动
    // （2026-09-25 视频取证）。投影读的是活依赖，重投影即收敛。
    const memory = state.memory
    if (memory !== undefined) {
      void memory.refresh().catch((error: unknown) => log.warn('配置变更后的重投影失败（不影响本次写入）', error))
    }
    // 自进化：调度配置（模式/时刻/时区/预算）变更后立即重排下一次触发并重投影。
    state.evolution?.reconfigure()
    // 历史保留期（0.1.13）：把保留天数调小时立刻生效，不必等到下一次人格写入。
    void state.persona?.pruneHistory()
  }
  // 自有数据面：0.1.7 删除了 settings.installSection 之后，工作台读写宿主数据只剩这一条通道
  // （`POST /api/humanity/<method>`）。先挂通道、后挂模块：模块注册命名空间时通道已就绪。
  const plane = installDataPlane(ctx, log)
  /** 文档表句柄**现读**：存储异步打开，装配这一刻通常还没有（P-030 同一纪律）。 */
  const documents = (): DocumentStore | undefined => state.store?.documents
  /** 数据面版设置服务：把 `installSection` 那条契约实现在我们自己的文档表上。 */
  const planeSettings = plane === undefined ? undefined : createPlaneSettings(plane, documents, log)
  if (planeSettings !== undefined) installPlaneSettings(planeSettings)

  const settings = installSettings(ctx, config, onChanged, log, plane, documents)
  // 设置服务已挂载时，installSection 在 attach 阶段就同步过一次，这里不能再来一遍，
  // 否则同一模块会被挂载两次（第二次注册/订阅会直接报错）。
  if (!settings.attached && !settings.planeAttached) modules.sync(config)

  openStore(ctx, log, state, (documents) => {
    // 旧设置 → 文档表的一次性迁移（幂等、只读源文件、失败显式报错）。
    void migrateLegacyDocuments(documents, log, dshHome())
  })

  // 净室排除：极简会话拒绝 Humanity 工具（complete 吞 prompt 不吞工具目录，工具层由 guard 兜底）。
  installExclusionGuard(ctx, log)

  // 人格模块：**一个入口**装配它的全部子件（设置命名空间 / Agent 工具 / 系统提示词注入）。
  // ⛔ 注入模块内部**只**声明 `systemPrompt` 依赖 —— 声明 `agents` 会让每个会话都创建失败
  // （2026-09-23 真机事故）。preset 兼容性：注入在**首次主 Agent 装配**时用自己的作用域探测
  // 本段是否被 complete 吞掉；探测完成要让工作台重新投影一次，否则警告条要等下一次操作才出现。
  const compat = createCompatState()
  state.persona = installPersona(ctx, log, personaDeps(settings, state), compat, () => void state.memory?.refresh())
  // 记忆模块：同样一个入口。模式与存储句柄都**现读不缓存**（P-030）。
  state.memory = installMemory(ctx, log, memoryDeps(settings, state, compat))
  // 自进化模块（M5）：整理管线 + 提案系统 + 调度 + 对话内提醒。跨模块句柄现读（P-048）。
  state.evolution = installEvolution(ctx, log, evolutionDeps(settings, state))
  syncModulesEnabled(state, settings.read())

  // 一行摘要：出问题时用户和日志都能立刻看到「谁被关掉了、为什么」。
  log.info(
    `已挂载[设置${settings.attached ? '可改' : '只读'}][数据面${plane === undefined ? '缺席' : '在线'}] ${describeModules(registry.snapshot())}`,
  )
}
