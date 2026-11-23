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
import { installClock, type Clock } from './clock.js'
import { installDataPlane } from './data-plane.js'
import type { DocumentStore } from './documents.js'
import { evolutionDeps, emotionDeps, humanityStarted, memoryDeps, personaDeps, type HostState } from './deps.js'
import { installExclusionGuard } from './exclusion-guard.js'
import { installEmotion } from './emotion/index.js'
import type { EmotionPulse } from './emotion/state.js'
import { accumulate, applyDrift, DRIFT_FLUSH_MS, dueToFlush, nudgesOf } from './persona/drift.js'
import type { CharacterAxisKey } from './persona/constants.js'
import { installEvolution } from './evolution/index.js'
import { EVOLUTION_NAMESPACE } from './evolution/constants.js'
import { createLog, type Log } from './log.js'
import { createModuleRegistry, describeModules, MODULES, type Disposer, type ModuleRegistry } from './modules.js'
import { migrateLegacyDocuments } from './migrate.js'
import { createPlaneSettings, installPlaneSettings } from './plane-settings.js'
import { installPresets, type PresetHandle } from './presets.js'
import { installPromptFilter } from './prompt-filter.js'
import { createCompatState } from './preset-compat.js'
import { installSettings, SETTINGS_NAMESPACE } from './settings.js'
import { installMemory } from './memory/index.js'
import { installPersona } from './persona/index.js'
import { installHumanityStore } from './store.js'

export { Config, MODULE_IDS } from './config.js'
export { PERSONA_NAMESPACE } from './persona/section.js'
export { EVOLUTION_NAMESPACE } from './evolution/constants.js'
export type { HumanityConfig, ModuleId } from './config.js'
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
 *
 * ⚠️ **人格没封存之前，除人格外一律关着**（用户 2026-11-22 定）：那时她还没有"自己"，
 * 情绪/记忆/自进化都不该工作。封存那一刻由 `onDocumentChanged` 再调一次本函数把它们叫醒。
 * @param state - 宿主状态。
 * @param next - 最新配置。
 */
function syncModulesEnabled(state: HostState, next: HumanityConfig): void {
  const started = humanityStarted(state)
  state.persona?.setEnabled(next.enabled && next.modules.persona.enabled)
  // 情绪：关掉即停算停投影（数据保留，下次打开接着用）。
  state.emotion?.setEnabled(next.enabled && next.modules.emotion.enabled && started)
  // 模式 off = 记忆功能关闭：工具与注入都要下线（P-030 即时生效）。
  state.memory?.setEnabled(next.enabled && next.modules.memory.enabled && started)
  // 自进化：总开关 + 模块开关；调度器随开关重排（关掉 = 清除定时器，不后台运行，P-048）。
  state.evolution?.setEnabled(next.enabled && next.modules.evolution.enabled && started)
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
    // 人格：**必须等这一刻**。命名空间注册得比存储早，那期间 `get()` 返回的是默认文档
    // （`sealedAt` 为空），据此注册工具会把已封存的实例当成未封存 —— 真机表现是
    // "封存了却还给她 humanity_persona_init"（2026-11-22）。存储就绪后按真实状态重判。
    state.persona?.notifyStoreReady()
    state.memory?.notifyStoreReady()
    // 情绪：装载状态并投影一次（存储未就绪时工作台只显示"平静"）。
    state.emotion?.notifyStoreReady()
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
 * @param config - 组合配置入口值；对方覆盖由设置服务叠加在它之上。
 */
export function apply(ctx: Context, config: HumanityConfig): void {
  const log = createLog(ctx)
  const registry = createModuleRegistry(MODULES, log)
  const state: HostState = {}
  const modules = createModuleSync(ctx, registry)
  /**
   * 预设句柄。**提前声明**：存储打开的回调要在这里用它重判一次封存状态，
   * 而它真正赋值在 `apply()` 末尾（那时人格模块已经装好、`sealed()` 才有东西可读）。
   */
  let presets: PresetHandle | undefined

  // 先注册卸载钩子，让模块清理一定挂在 fiber 上；后续任何一步失败都不会漏掉它。
  ctx.effect(() => modules.dispose, 'humanity: 模块卸载')

  // 开关即时生效（P-030）：模块批次、人格/记忆工具与注入都由这一条链同步。
  /** 时间基准句柄；在设置服务之后才装（要用设置读取偏好），这里先占位给 `onChanged` 用。 */
  let clock: Clock | undefined
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
    // 时间基准：用户切了"自动/手动"或改了固定时区，立刻重算并应用（不等下一次对话）。
    clock?.reconfigure()
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

  /**
   * 时间基准（2026-11-19）：把浏览器报的时区校准到**整个 Node 进程**。
   *
   * 为什么在这儿装、而且只装一次：精力、每日归零、"今天是几号"各算各的本地时间，
   * 容器若是 UTC 就会各错各的；把进程时区校准掉，它们自动一致（详见 `clock.ts`）。
   * 持久值要等存储打开才读得到 —— 那一步在下面的 `openStore` 回调里。
   */
  const clockHandle = installClock(ctx, log, {
    documents,
    log,
    // 用户偏好：自动跟浏览器（默认）/ 固定一个时区。现读，改设置立刻生效。
    preference: () => {
      const schedule = settings.read().modules.evolution.schedule
      return { auto: schedule.autoTimeZone !== false, zone: schedule.timezone }
    },
    // 生效时区一变就重投影一次：工作台的"时间基准"必须立刻反映真相。
    onChanged: () => {
      void state.evolution?.refresh().catch((error: unknown) => log.warn('时间基准变化后的重投影失败', error))
    },
  })
  clock = clockHandle
  ctx.effect(() => clockHandle.dispose, 'humanity: 时间基准')

  openStore(ctx, log, state, (documents) => {
    // 旧设置 → 文档表的一次性迁移（幂等、只读源文件、失败显式报错）。
    void migrateLegacyDocuments(documents, log, dshHome())
    // 上次学到的时区：存储一就绪就先应用，不必等第一条消息。
    clockHandle.restore()
    // ⚠️ 存储打开是"人格文档真的读得到"的那一刻：在此之前 `section.read()` 拿到的是默认文档
    // （`sealedAt` 为空），预设会按"未封存"注册。`presets` 在这之后才会赋值，用 `?.` 兜住。
    presets?.sync()
    // 模块开关也按**真实配置**重判一次（2026-11-22）。
    //
    // 装配时那一趟 `onChanged` 跑在存储就绪之前：`settings.read()` 那时拿到的是默认配置
    // （所有模块都开），于是用户在设置里关掉的模块会被重新打开 —— 与"独立判断关了却还在注入"
    // 是同一个模式。这里用 `onChanged` 而不是只调 `syncModulesEnabled`，是为了让批次与工具
    // 注册也一起收敛（它内部就是这两件事）。
    onChanged(settings.read())
    // 人格数据升级（关系搬家、退役「交付格式」，2026-11-16）：需要文档真的读得到，所以也放在这一刻。
    void state.persona?.upgrade()
  })

  // 净室排除：极简会话拒绝 Humanity 工具（complete 吞 prompt 不吞工具目录，工具层由 guard 兜底）。
  installExclusionGuard(ctx, log)
  // 工具使用说明（`tool:*` 段）从提示词里整体去掉：它们是英文操作指南，对陪伴是噪音。
  installPromptFilter(ctx, log)

  // 人格模块：**一个入口**装配它的全部子件（设置命名空间 / Agent 工具 / 系统提示词注入）。
  // ⛔ 注入模块内部**只**声明 `systemPrompt` 依赖 —— 声明 `agents` 会让每个会话都创建失败
  // （2026-09-23 真机事故）。preset 兼容性：注入在**首次主 Agent 装配**时用自己的作用域探测
  // 本段是否被 complete 吞掉；探测完成要让工作台重新投影一次，否则警告条要等下一次操作才出现。
  const compat = createCompatState()
  state.persona = installPersona(ctx, log, personaDeps(settings, state), compat, () => void state.memory?.refresh())
  // 补齐竞态：`openStore` 在上面（第 223 行）就先跑起来了，存储若开得**比这一行快**，
  // 它那次 `notifyStoreReady()` 打在一个还是 `undefined` 的 persona 上，等于没打。
  // 所以装配完再看一眼：存储已经就绪就立刻补一次（幂等）。
  if (state.store !== undefined) state.persona.notifyStoreReady()
  // 情绪模块：状态 + 存储 + 工作台窗口。**只看存储**，不依赖人格或记忆（模块互相隔离）。
  // 性格漂移：攒在内存里，满一天且够一个阈值才写一次人格文档（每轮都写会把历史刷成流水账）。
  // 规则见 `persona/drift.ts`；它只由情绪落地的事件推动，不给她任何主动调节的入口。
  let driftAccumulator: Partial<Record<CharacterAxisKey, number>> = {}
  let driftLastAt = ''
  const onEmotionApplied = (pulse: EmotionPulse, at: string): void => {
    driftAccumulator = accumulate(driftAccumulator, nudgesOf({ shifts: pulse.shifts, warmth: pulse.warmth }))
    const previous = driftLastAt === '' ? Number.NaN : Date.parse(driftLastAt)
    // 第一次触达也允许落地（否则要等满一天才有第一笔）；之后至少隔一天。
    const intervalOk = !Number.isFinite(previous) || Date.parse(at) - previous >= DRIFT_FLUSH_MS
    if (!dueToFlush(driftAccumulator, intervalOk)) return
    const pending = driftAccumulator
    driftAccumulator = {}
    driftLastAt = at
    const persona = state.persona
    if (persona === undefined) return
    const outcome = applyDrift(persona.section.read(), pending)
    if (!outcome.changed) return
    // 写入失败只是这一步没留下：不重试、不影响对话（与情绪落盘同一条纪律）。
    void persona.section.write(outcome.document, 'agent').catch((error: unknown) => {
      log.warn('性格漂移写入失败（这一步没留下，不影响对话）', error)
    })
  }

  state.emotion = installEmotion(ctx, log, emotionDeps(settings, state, clockHandle, onEmotionApplied))
  // 记忆模块：同样一个入口。模式与存储句柄都**现读不缓存**（P-030）。
  state.memory = installMemory(ctx, log, memoryDeps(settings, state, clockHandle))
  // 自进化模块（M5）：整理管线 + 提案系统 + 调度 + 对话内提醒。跨模块句柄现读（P-048）。
  state.evolution = installEvolution(ctx, log, evolutionDeps(settings, state, clockHandle))
  syncModulesEnabled(state, settings.read())

  // 预设（2026-11-14）：未封存只有"取内容"的工具，封存后换成沉浸式清单。
  // 必须排在人格/记忆之后 —— 封存状态要能在那一刻读到，工具清单也才完整。
  // 封存状态**现读**人格文档；三个时机会重判：文档写入、命名空间接上、存储打开。
  presets = installPresets(ctx, log, () => state.persona?.section.read().identityCard.sealedAt !== '')
  ctx.effect(() => presets?.dispose, 'humanity: 预设卸载')
  if (state.persona !== undefined) {
    const off = state.persona.section.onDocumentChanged(() => {
      presets?.sync()
      // 封存（或解封）就在这一刻发生：把"是否已启动"重新算一遍，其余模块跟着醒来/睡下。
      // 反过来的顺序同样重要 —— 只靠装配时那一次判断，封存后它们永远醒不过来。
      syncModulesEnabled(state, settings.read())
    })
    ctx.effect(() => off, 'humanity: 预设随封存切换')
    // 启动时"数据可读"比"有写入"更早发生也更关键：那一刻才知道人格到底封没封存。
    const offAttached = state.persona.section.onAttached(() => {
      presets?.sync()
      // 命名空间接上（含存储晚就绪）也要重算一次：那时才读得到真实的封存状态。
      syncModulesEnabled(state, settings.read())
      // 存储可能晚于设置接上；升级是幂等的，两个就绪点各叫一次最省事。
      void state.persona?.upgrade()
    })
    ctx.effect(() => offAttached, 'humanity: 预设随命名空间接上重判')
  }

  // 一行摘要：出问题时对方和日志都能立刻看到「谁被关掉了、为什么」。
  log.info(
    `已挂载[设置${settings.attached ? '可改' : '只读'}][数据面${plane === undefined ? '缺席' : '在线'}] ${describeModules(registry.snapshot())}`,
  )
}
