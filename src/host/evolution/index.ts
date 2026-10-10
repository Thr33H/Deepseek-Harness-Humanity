/**
 * 自进化模块的**唯一入口**（与人格/记忆同一条约定：宿主只调 `installEvolution(...)` 一行）。
 *
 * ### 装配时序（为什么 runner/scheduler 是"存储就绪后懒装"）
 * 存储（storageDomain）是**异步打开**的，而调度器一装就要读写单值状态（nextRunAt、补跑对账）。
 * 与其让调度器处处判空，不如等 `notifyStoreReady()` 一次到位——与记忆模块"存储就绪后
 * 补消费命令 + 重投影"是同一种时序处理。存储没就绪前：工作台投影为空、命令被跳过、
 * 调度不排程；就绪那一刻：恢复已应用技能、对账错过的定时、投影一次。
 *
 * ### 模块独立（P-048）
 * 记忆/人格句柄都是宿主喂进来的**现读函数**：那边关了或未就绪，这边对应分类自动跳过，
 * 绝不替关掉的模块写数据，也不因为别人缺席而自己崩溃。
 * @module humanity/evolution
 */
import type { Context } from '@deepseek-ai/cordis'

import type { HumanityConfig } from '../config.js'
import type { Log } from '../log.js'
import type { HumanityStore } from '../store-schema.js'
import type { MemoryStore } from '../memory/store.js'
import type { MemoryPolicy } from '../memory/types.js'
import type { PersonaSection } from '../persona/section.js'
import { createSkillEditor } from '../skills/edit-ops.js'
import { skillInventory } from '../skills/inventory.js'
import { installActivityTracker } from './activity.js'
import { createLlmAccess } from './llm.js'
import { installProposalNotification } from './notify.js'
import { createProposalActions } from './proposals.js'
import type { Runner } from './run.js'
import type { SchedulerHandle } from './scheduler.js'
import { installEvolutionSection, type EvolutionSection } from './section.js'
import { dayKeyOf } from './schedule-time.js'
import { installSkillRuntime } from './skill-runtime.js'
import { installSkillPersistTool, pendingSkillPersists, sandboxFactsOf } from './tools-skill-persist.js'
import { createEvolutionState, type EvolutionState } from './state.js'
import { buildRunner, buildScheduler } from './runtime.js'
import { pendingFacts, sessionQueryReader, stateReader } from './wiring.js'

/** 宿主交给自进化模块的外部事实（全部现读，不缓存死句柄）。 */
export interface EvolutionDeps {
  store(): HumanityStore | undefined
  config(): HumanityConfig
  memoryStore(): MemoryStore | undefined
  memoryPolicy(): MemoryPolicy | undefined
  personaSection(): PersonaSection | undefined
}

/** 自进化模块句柄。 */
export interface EvolutionModule {
  /** 配置开关驱动（宿主 syncModulesEnabled 调）。 */
  setEnabled(enabled: boolean): void
  /** 设置变更：重排调度并重投影（宿主 onChanged 调）。 */
  reconfigure(): void
  /** 重新投影一次。 */
  refresh(): Promise<void>
  /** 存储刚就绪：懒装 runner/scheduler、恢复已应用技能、补消费命令、重投影。 */
  notifyStoreReady(): void
  dispose(): void
}

/** 模块内部状态（懒装件 + 开关）。 */
interface EvolutionStateful {
  enabled: boolean
  runner?: Runner
  scheduler?: SchedulerHandle
  restored: boolean
  /** 上一次技能恢复的账（写给技能页看：写了几条、为什么没写成）。 */
  skillReport?: string
  /** 懒装件对应的存储表组：存储服务摘除再挂回时表是新对象，懒装件必须跟着重建。 */
  installedTables?: unknown
}

/**
 * 装配自进化模块。
 * @param ctx - 宿主上下文。
 * @param log - 日志门面。
 * @param deps - 宿主注入的外部事实。
 */
export function installEvolution(ctx: Context, log: Log, deps: EvolutionDeps): EvolutionModule {
  const internal: EvolutionStateful = { enabled: true, restored: false }
  const readState = stateReader(deps.store)
  const sessionQuery = sessionQueryReader(ctx)
  const llm = createLlmAccess(ctx, log)
  const { store: skillStore, bridge: skills } = installSkillRuntime(ctx, log)
  // 0.1.12：技能落盘工具。为什么必须由 **agent 调用**才修得动落盘：插件的批准/启动路径
  // 没有会话身份，官方文件后端只能回落部署默认模式（本部署 workspace-write，根是 /workspace）
  // ⇒ 技能目录一律被拒；本工具在会话里被调用 ⇒ 用那次会话的模式与 cwd 解析 per-call 策略
  // （详见 `tools-skill-persist.ts` 头部引的 DSH 源码原文）。
  const skillPersistTool = installSkillPersistTool(ctx, log, {
    store: () => (skillStore.available() ? skillStore : undefined),
    pending: () => pendingSkillPersists(readState()),
    sandbox: () => sandboxFactsOf(ctx),
  })
  const activity = installActivityTracker(ctx)
  const pending = pendingFacts(readState, deps.memoryStore)
  const moduleEnabled = (): boolean => {
    const config = deps.config()
    return internal.enabled && config.enabled && config.modules.evolution.enabled
  }

  const section: EvolutionSection = installEvolutionSection(ctx, log, {
    state: readState,
    ops: () => {
      const state = readState()
      if (state === undefined || internal.runner === undefined) return undefined
      return {
        runner: internal.runner,
        proposals: createProposalActions({ state, persona: deps.personaSection, skills, log }),
        skills: createSkillEditor(skillStore),
        refresh: () => void section.refresh(),
        warn: (message, error) => log.warn(message, error),
      }
    },
    status: () => ({
      enabled: moduleEnabled(),
      // ⚠️ 0.1.9：这一位**由真实句柄现算**，不再由投影层写死 `true`。
      // 旧写法是 `section-runtime` 里 `{ ...deps.status(), storeReady: true }` —— 一句**断言**，
      // 不是**测量**：2026-10-05 排查时就出现过"工作台显示存储就绪，而所有状态写入都在抛错"的局面，
      // 差点被当成"存储是好的"的证据。现在值从 `readState()`（存储域句柄）来，改不动就改不动。
      storeReady: readState() !== undefined,
      scanReady: sessionQuery() !== undefined,
      modelReady: llm.route() !== undefined,
      skillsReady: skills.available(),
    }),
    memoryPendingCount: () => deps.memoryStore()?.list(undefined, 'pending').length ?? 0,
    nextRunAt: () => internal.scheduler?.nextRunAt() ?? 0,
    dailyCallCap: () => deps.config().modules.evolution.budget.dailyCallCap,
    // 「今天」按调度时区算，与运行记账共用 `dayKeyOf`（审计 E5：UTC 日期与调度日差 8 小时）。
    dayKey: () =>
      dayKeyOf(Date.now(), deps.config().modules.evolution.schedule, (message) => log.warn(message)),
    // 技能页（M7）：清单、能不能落盘、上一次恢复的账。
    // 注册表清单要**现读**（技能可以在运行期注册/卸载）：查到才算 `runtime-only`（审计 E4）。
    skillViews: async () => skillInventory(readState()?.listProposals() ?? [], skillStore, await skills.names()),
    skillsWritable: () => skillStore.available(),
    skillsReport: () => internal.skillReport ?? "",
  })

  const disposeNotify = installProposalNotification(ctx, log, {
    state: readState,
    pending,
    enabled: moduleEnabled,
  })

  // 模型适配器（凭据解析后）注册得比启动首投影**晚**：不跟着适配器清单变化重投影的话，
  // 工作台的「模型解析」就绪灯会停在启动时的旧值 false（TEST 真机 2026-09-25 实拍）。
  // 事件在运行时发射（编译 `dsh-llm/lib/index.js:1753`）但类型面未声明 ⇒ 按结构监听，
  // 与 `agent/status` 同一纪律（不声明依赖、事件缺席只是不刷新）。
  const on = ctx.on as unknown as (name: string, listener: (payload: unknown) => void) => () => void
  const disposeAdapterListener = on('llm/adapters-updated', () => {
    void section.refresh().catch((error: unknown) => log.warn('适配器变化后的重投影失败', error))
  })

  /** 存储就绪后的一次性懒装：runner + scheduler + 已应用技能恢复；存储重开时重建懒装件。 */
  const ensureInstalled = (): void => {
    const opened = deps.store()
    if (opened === undefined) return
    if (internal.runner !== undefined && internal.installedTables === opened.evolution) return
    if (internal.runner !== undefined) {
      // 存储服务摘除又挂回：旧表句柄已经死了，调度器与 runner 必须换到新表上。
      internal.scheduler?.dispose()
      internal.runner = undefined
      internal.scheduler = undefined
    }
    internal.installedTables = opened.evolution
    const state = createEvolutionState(opened.evolution)
    const parts = { deps, moduleEnabled, sessionQuery, llm, skills, activity, log, refresh: () => void section.refresh() }
    internal.runner = buildRunner(parts, state)
    internal.scheduler = buildScheduler(ctx, parts, state, internal.runner)
    if (!internal.restored) {
      internal.restored = true
      void skills
        .restoreApplied(state.listProposals())
        .then((report) => {
          internal.skillReport =
            `落盘写入 ${report.written} 条、可用 ${report.restored} 条、失败 ${report.failed} 条` +
            (report.note === "" ? "" : `（${report.note}）`)
          log.info(`技能恢复：${internal.skillReport}`)
          void section.refresh()
        })
        .catch((error: unknown) => log.warn('已应用技能恢复失败（提案数据仍在，可在批准后重试）', error))
    }
  }

  const cleanup = (): void => {
    internal.scheduler?.dispose()
    activity.dispose()
    skillPersistTool.dispose()
    disposeAdapterListener()
    disposeNotify()
    log.info('自进化模块已卸载')
  }
  ctx.effect(() => cleanup, 'humanity: 自进化模块卸载')

  log.info('自进化模块已装配（扫描/解析/提案/调度就绪；等待存储打开后排程）')

  return {
    setEnabled(next) {
      internal.enabled = next
      internal.scheduler?.reconfigure()
    },
    reconfigure() {
      internal.scheduler?.reconfigure()
      void section.refresh().catch((error: unknown) => log.warn('配置变更后的重投影失败', error))
    },
    refresh: section.refresh,
    notifyStoreReady() {
      ensureInstalled()
      section.notifyStoreReady()
    },
    dispose: cleanup,
  }
}
