/**
 * 运行编排：一次整理运行（增量/梦境/回扫）的入口、互斥与门禁（DEV-PLAN §5.1）。
 *
 * 主循环与收尾在 `run-loop.ts`；这里只管"什么时候允许跑、跑砸了怎么收场"：
 * 1. **单实例互斥**：同一时刻至多一次运行；并发触发被拒绝（调度器与手动命令共享这道闸）。
 * 2. **门禁降级**：sessionQuery / 模型路由缺席时运行记 failed 并写明原因（G-002 说清楚，
 *    不静默）；没有任何待消化内容时**不碰模型**（零成本收工）。
 * 3. **运行内的失败不 reject**：一切结局都收敛成 RunRecord（工作台时间线的唯一数据源）；
 *    reject 只留给"根本没资格跑"（模块关闭 / 互斥被占）。
 *
 * 梦境与增量共用同一条管线（P-034「不造两套引擎」）：差别只在提示词模式与叙事/洞察的收集；
 * "长窗口"来自梦境触发更稀疏（每周/每月），未消化内容自然更多。
 * @module humanity/evolution/run
 */
import type { HumanityConfig } from '../config.js'
import type { Log } from '../log.js'
import { decaySummary, runDecayMaintenance } from '../memory/ops.js'
import type { ClassifyDeps } from './classify.js'
import type { LlmAccess } from './llm.js'
import { createRunRecord } from './model.js'
import { isPersonaBudgetGuarded, personaBudgetNote, type PersonaBudgetState, type PersonaCardSection } from './prompt.js'
import { finalizeRun, runLoop, type RunAccumulator } from './run-loop.js'
import type { RescanRange } from './scan.js'
import { collectScanTargets } from './scan.js'
import type { EvolutionState } from './state.js'
import type { RunRecord, RunTrigger, SessionQueryLike } from './types.js'

/** 运行配置（宿主从设置现读）。 */
export interface RunnerConfig {
  evolution: HumanityConfig['modules']['evolution']
  dream: HumanityConfig['modules']['dream']
}

/** 运行依赖（全部现读函数：开关/句柄变了，下一次运行立刻反映）。 */
export interface RunnerDeps {
  state: EvolutionState
  config(): RunnerConfig
  enabled(): boolean
  sessionQuery(): SessionQueryLike | undefined
  llm: LlmAccess
  classify(): ClassifyDeps
  /** 人格可变层的当前内容（提示词合同用：标题清单 + 现有条目；人格未就绪时给空数组）。 */
  personaCard?(): readonly PersonaCardSection[]
  /**
   * 人格**注入预算**的当前读数（0.1.10 · A1；人格未就绪时 undefined）。
   *
   * 为什么由宿主现读进来而不是在这里算：注入预算的账只有一处算得对
   * （`persona/render.ts` 的 `personaPromptReport`，与提示词拼装共用同一套拟合）——
   * 在这里重算一遍迟早与真实注入不一致，而那正是用户最不能接受的一类"看起来对"。
   */
  personaFit?(): PersonaBudgetState | undefined
  /**
   * 免费的**人格卡整合**：合并近重复条目，返回合并了几条。
   *
   * 为什么挂在运行时开头：它是纯本地计算（不调模型），而且**越早做越好** ——
   * 重复条目会把人格卡顶到注入预算上限，真正的新内容反而进不了提示词（P-056）。
   * 缺席（人格未接上）就是不整合。
   */
  consolidatePersona?(): Promise<number>
  log: Log
  now?(): string
}

/** 一次运行的发起参数。 */
export interface RunOptions {
  mode: 'incremental' | 'dream'
  trigger: RunTrigger
  rescan?: RescanRange
  signal?: AbortSignal
}

/** 运行入口。 */
export interface Runner {
  /** 正在运行的记录；空闲时 `undefined`。 */
  current(): RunRecord | undefined
  /** 发起一次运行；互斥被占或模块关闭时 reject。运行内的失败进记录，不 reject。 */
  start(options: RunOptions): Promise<RunRecord>
}

/** 采集与门禁：建基线、扫目标、验路由；返回可消化的目标列表（空 = 零成本收工）。 */
async function gateAndScan(deps: RunnerDeps, accumulator: RunAccumulator, options: RunOptions): Promise<Awaited<ReturnType<typeof collectScanTargets>>['targets']> {
  const query = deps.sessionQuery()
  if (query === undefined) {
    accumulator.record.status = 'failed'
    accumulator.notes.push('会话查询服务（sessionQuery）不可用：无法扫描')
    return []
  }
  const config = deps.config().evolution
  const stateRecord = deps.state.readState()
  const scan = await collectScanTargets(query, deps.state, {
    baselineAt: stateRecord.baselineAt,
    includeSubSessions: config.scan.includeSubSessions,
    budget: config.budget,
    rescan: options.rescan,
    now: deps.now?.() ?? new Date().toISOString(),
  })
  if (scan.newBaselineAt !== '') {
    await deps.state.mutateState({ baselineAt: scan.newBaselineAt })
    accumulator.notes.push(`已建立扫描基线 ${scan.newBaselineAt}（默认只整理此后的新会话；旧历史请用回扫）`)
  }
  if (scan.targets.length === 0) {
    if (scan.skippedSessions > 0) accumulator.notes.push(`${scan.skippedSessions} 个会话被子会话过滤或预算跳过`)
    return []
  }
  if (deps.llm.route() === undefined) {
    accumulator.record.status = 'failed'
    accumulator.notes.push('没有可用的模型路由（默认模型未配置或 provider 未注册），本轮跳过')
    return []
  }
  return scan.targets
}

/**
 * B1：每轮**顺带**跑一次记忆衰减核算，并把报告写进运行记录。
 *
 * 为什么放在门禁之前：记忆维护与"有没有新会话可整理""模型路由通不通"都无关 ——
 * 放到后面会让"这轮没扫到东西"顺手把维护也饿掉（0.1.9 的处境正是：只有检索路径顺带跑）。
 * 为什么**不**在这里判 `policy.decay` 之外的条件：`decay=false`（含记忆模块 off）时直接返回，
 * **不进核算入口** —— "跑了但什么都没做"与"根本不该跑"在账目上必须能分得开。
 */
async function sweepMemoryDecay(deps: RunnerDeps, accumulator: RunAccumulator): Promise<void> {
  // 与写回路径读**同一份**现读句柄（`classify()` 的依赖）：维护与写入不会看到两套策略。
  const handles = deps.classify()
  const store = handles.memoryStore()
  const policy = handles.memoryPolicy()
  if (store === undefined || policy === undefined) return
  if (!policy.decay) return
  try {
    // 显式传 `now`：与运行记录里其他时间戳同一个时刻源（测试里因此完全确定）。
    const { report } = await runDecayMaintenance(store, policy, deps.now?.() ?? new Date().toISOString())
    accumulator.notes.push(`记忆维护（本轮顺带核算）：${decaySummary(report)}`)
  } catch (error) {
    // 维护失败不该让这一轮整理整体失败（与检索路径同一个取舍）。
    deps.log.warn('顺带的记忆衰减核算失败（本轮整理继续）', error)
  }
}

/**
 * 造运行入口。
 * @param deps - 运行依赖（宿主接线）。
 */
export function createRunner(deps: RunnerDeps): Runner {
  let inFlight: RunRecord | undefined

  const start = async (options: RunOptions): Promise<RunRecord> => {
    if (!deps.enabled()) throw new Error('自进化模块未启用（humanity.enabled 或 evolution.enabled 为关）')
    if (options.mode === 'dream' && !deps.config().dream.enabled) throw new Error('梦境模式未启用')
    if (inFlight !== undefined) throw new Error(`已有一次整理在运行（${inFlight.mode}/${inFlight.trigger}，开始于 ${inFlight.startedAt}）`)

    const accumulator: RunAccumulator = {
      record: createRunRecord(options.mode, options.trigger, deps.now?.() ?? undefined),
      notes: [],
      insights: [],
      narratives: [],
      callsToday: 0,
      failedSessions: 0,
      capStopped: false,
      truncatedMemories: 0,
      personaBudget: undefined,
      personaGuarded: false,
      personaMerged: 0,
      personaAdditionsDropped: 0,
    }
    inFlight = accumulator.record
    await deps.state.putRun(accumulator.record)

    try {
      // 免费步骤先做：人格卡的重复条目在扫描前就并掉（不花模型调用，也让提示词立刻变干净）。
      const mergedPersona = (await deps.consolidatePersona?.()) ?? 0
      if (mergedPersona > 0) accumulator.notes.push(`人格卡合并了 ${mergedPersona} 条重复条目`)
      // A1：本轮**只读一次**人格注入预算（并掉重复条目之后读，读数才是这一轮真正生效的那个）。
      accumulator.personaBudget = deps.personaFit?.()
      // A（0.1.11）：同一份读数上判护栏（已超 or 接近上限）—— 提示词与写回层共用这一个结论。
      accumulator.personaGuarded = isPersonaBudgetGuarded(accumulator.personaBudget)
      // B1：记忆维护同样不花模型调用，且不依赖模型路由 —— 放门禁之前，每轮都跑。
      await sweepMemoryDecay(deps, accumulator)
      const targets = await gateAndScan(deps, accumulator, options)
      if (targets.length > 0) await runLoop(deps, accumulator, targets, options)
      // A4：把这一轮读到的人格预算账目写进时间线（人格未接上时没有读数，就不记）。
      if (accumulator.personaBudget !== undefined) {
        accumulator.notes.push(
          personaBudgetNote(
            accumulator.personaBudget,
            accumulator.personaGuarded,
            accumulator.personaMerged,
            accumulator.personaAdditionsDropped,
          ),
        )
      }
    } catch (error) {
      accumulator.record.status = 'failed'
      accumulator.notes.push(error instanceof Error ? error.message : String(error))
    } finally {
      inFlight = undefined
    }
    return finalizeRun(deps, accumulator)
  }

  return { current: () => inFlight, start }
}
