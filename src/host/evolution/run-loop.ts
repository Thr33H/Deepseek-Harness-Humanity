/**
 * 运行主循环：逐会话消化 + 用量记账 + 收尾终态（从 `run.ts` 拆出，互斥与门禁在那边）。
 *
 * 数据流单向：`ScanTarget` → digest → analyze → classify → 推游标；任何一步失败都**不推**
 * 该会话的游标（宁可下轮重看，不可永久丢——G-007），只把原因记进注记。
 * @module humanity/evolution/run-loop
 */
import { AnalyzeError, analyzeDigest } from './analyze.js'
import type { ClassifyDeps, ClassifyResult } from './classify.js'
import { applyAnalysis } from './classify.js'
import { ANALYZE_TIMEOUT_MS, INSIGHTS_CAP, MAX_SESSION_FAILURES, NARRATIVE_CAP } from './constants.js'
import { buildDigest } from './digest.js'
import type { PersonaBudgetState } from './prompt.js'
import type { RunOptions, RunnerDeps } from './run.js'
import type { ScanTarget } from './scan.js'
import { dayKeyOf } from './schedule-time.js'
import type { RunRecord } from './types.js'

/** 运行中的可变累计（收尾时一次写进 RunRecord）。 */
export interface RunAccumulator {
  record: RunRecord
  notes: string[]
  insights: string[]
  narratives: string[]
  callsToday: number
  /** 解析失败（未推游标）的会话数——全部失败时整轮判 failed。 */
  failedSessions: number
  /** 因每日预算停摆（一个都没消化时整轮判 skipped，如实区分"没干活"与"干了没成"）。 */
  capStopped: boolean
  /**
   * 本轮有多少条记忆**超上限被截断保存**（0.1.9）。
   *
   * 收尾时写成一条注记进运行记录：用户翻时间线就能看见"有几条没存全"，
   * 不必去逐条比对正文长度（旧行为是硬切 + 静默）。
   */
  truncatedMemories: number
  /**
   * 本轮**开始时**读到的人格注入预算读数（0.1.10 · A1）。
   *
   * 为什么一轮只读一次、而不是每个会话各读一次：这一轮里逐个会话的合并会让读数一直变，
   * 而"本轮算不算超预算、要不要只做整合"必须是**一个**判断 —— 同一轮里一会儿只合并、
   * 一会儿又允许追加，行为就成了随机的。运行记录里记的也是这同一个读数，账目与行为对得上。
   */
  personaBudget: PersonaBudgetState | undefined
  /**
   * 本轮人格护栏是否触发（0.1.11 · A）：预算已超**或**接近上限（`used/budget ≥ 0.85`）。
   *
   * 与 `personaBudget` 一起在轮首算一次（同一个读数），提示词与写回层都读它 ——
   * 不允许哪一处自己按别的口径再判一次。
   */
  personaGuarded: boolean
  /** 本轮实际并掉的同义条目数（A4：写进运行记录）。 */
  personaMerged: number
  /** 本轮被护栏/预演拦下的拟新增条数（0.1.11：写进运行记录，免得看起来像"什么都没干"）。 */
  personaAdditionsDropped: number
}

/** 当日用量视图。 */
interface DailyUsage {
  calls: number
  inputTokens: number
  outputTokens: number
}

/** 读当日用量（日期变了就地清零并落盘；字段级原子合并，见 state.ts 的 mutateState 警告）。 */
async function readDailyUsage(deps: RunnerDeps, today: string): Promise<DailyUsage> {
  const current = deps.state.readState()
  if (current.dailyDate === today) {
    return { calls: current.dailyCalls, inputTokens: current.dailyInputTokens, outputTokens: current.dailyOutputTokens }
  }
  await deps.state.mutateState({ dailyDate: today, dailyCalls: 0, dailyInputTokens: 0, dailyOutputTokens: 0 })
  return { calls: 0, inputTokens: 0, outputTokens: 0 }
}

/** 把一次调用的花费同时记进运行记录与单值状态（状态写失败只警告：账丢一条不该停运行）。 */
async function recordUsage(deps: RunnerDeps, accumulator: RunAccumulator, usage: { input: number; output: number; calls: number }, today: string): Promise<void> {
  accumulator.record.calls += usage.calls
  accumulator.record.inputTokens += usage.input
  accumulator.record.outputTokens += usage.output
  accumulator.callsToday += usage.calls
  try {
    // 函数式合并：跨日时在**当前值**上清零再累计（读改写一体，不给并发留窗口）。
    await deps.state.mutateState((current) => {
      const base = current.dailyDate === today ? current : { ...current, dailyDate: today, dailyCalls: 0, dailyInputTokens: 0, dailyOutputTokens: 0 }
      return {
        ...base,
        dailyCalls: base.dailyCalls + usage.calls,
        dailyInputTokens: base.dailyInputTokens + usage.input,
        dailyOutputTokens: base.dailyOutputTokens + usage.output,
      }
    })
  } catch (error) {
    deps.log.warn('当日用量落盘失败（运行继续，账目可能少记一笔）', error)
  }
}

/** 消化一个会话：摘要 → 解析 → 写回 → 推游标；返回本会话的写回计数。 */
async function digestOneSession(deps: RunnerDeps, accumulator: RunAccumulator, target: ScanTarget, today: string): Promise<ClassifyResult | undefined> {
  const budget = deps.config().evolution.budget
  const digest = buildDigest(target.events, budget.maxInputBytesPerCall)
  // 游标**只推到真正看过的那一条**（预算截断时不能推到整批末尾，否则被截掉的事件永远读不到）。
  const lastSeq = digest.lastSeq > 0 ? digest.lastSeq : (target.events[0]?.seq ?? target.fromSeq)
  if (digest.truncated) {
    accumulator.notes.push(
      `会话 ${target.sessionId} 的内容超出单次输入预算：本轮只整理到 seq ${lastSeq}，其余下次接着读`,
    )
  }
  if (digest.text === '') {
    // 全是噪声事件：游标照推（这些事件已被"看过"，留着只会永远堵住后面的新事件）。
    await deps.state.putCursor({ sessionId: target.sessionId, lastSeq, lastRunAt: accumulator.record.startedAt, failures: 0 })
    return undefined
  }

  // 人格卡缺席（人格未接上 / 测试替身）就是空数组：提示词少一段，不影响这一轮整理。
  const card = deps.personaCard?.() ?? []
  const outcome = await analyzeDigest(
    { llm: deps.llm },
    {
      digest: digest.text,
      mode: accumulator.record.mode,
      workspaceLabel: target.cwd,
      sectionTitles: card.map((section) => section.title),
      personaCard: card,
      // 护栏触发（已超 / 接近上限）时提示词追加"只做整合、禁止追加新条目"；预算充足时这一段不出现（V4）。
      ...(accumulator.personaBudget === undefined ? {} : { personaBudget: accumulator.personaBudget }),
      maxOutputTokens: budget.maxOutputTokensPerCall,
      timeoutMs: ANALYZE_TIMEOUT_MS,
    },
  )
  await recordUsage(deps, accumulator, { input: outcome.inputTokens, output: outcome.outputTokens, calls: outcome.attempts }, today)

  const classifyDeps: ClassifyDeps = deps.classify()
  const result = await applyAnalysis(
    classifyDeps,
    {
      runId: accumulator.record.id,
      sessionId: target.sessionId,
      cwd: target.cwd,
      mode: accumulator.record.mode,
      // 写回层的兜底（A3；0.1.11 起含"接近预算"）：护栏触发就只认整合建议 —— 不指望模型听提示词的话。
      personaGuardActive: accumulator.personaGuarded,
    },
    outcome.output,
  )
  // 解析+写回都成功才推游标（失败会话下一轮重看）；成功清零熔断计数。
  await deps.state.putCursor({ sessionId: target.sessionId, lastSeq, lastRunAt: accumulator.record.startedAt, failures: 0 })

  if (accumulator.record.mode === 'dream') {
    accumulator.insights.push(...outcome.output.insights)
    if (outcome.output.narrative !== '') accumulator.narratives.push(outcome.output.narrative)
  }
  return result
}

/** 解析失败后的游标处置：计失败数；连败到上限则熔断推进（宁可丢一批，不可无限烧）。 */
async function recordSessionFailure(deps: RunnerDeps, accumulator: RunAccumulator, target: ScanTarget, message: string): Promise<void> {
  const previous = deps.state.getCursor(target.sessionId)
  const failures = (previous?.failures ?? 0) + 1
  if (failures >= MAX_SESSION_FAILURES) {
    const lastSeq = target.events[target.events.length - 1]?.seq ?? target.fromSeq
    await deps.state.putCursor({ sessionId: target.sessionId, lastSeq, lastRunAt: accumulator.record.startedAt, failures: 0 })
    accumulator.notes.push(`会话 ${target.sessionId} 连续 ${failures} 次解析失败，已熔断跳过该批（游标推进，避免每次触发都重试烧钱）：${message}`)
    return
  }
  // 失败不推进水位，但失败计数要落盘（跨运行累计）；lastSeq 保持原值。
  await deps.state.putCursor({
    sessionId: target.sessionId,
    lastSeq: previous?.lastSeq ?? target.fromSeq,
    lastRunAt: accumulator.record.startedAt,
    failures,
  })
  accumulator.notes.push(`会话 ${target.sessionId} 解析失败（第 ${failures} 次，${MAX_SESSION_FAILURES} 次后熔断跳过）：${message}`)
}

/** 主循环：预算与取消在每步之前检查。 */
export async function runLoop(deps: RunnerDeps, accumulator: RunAccumulator, targets: ScanTarget[], options: RunOptions): Promise<void> {
  const cap = deps.config().evolution.budget.dailyCallCap
  // 日期键按**调度时区**算（审计 E5），与工作台展示「今日用量」同一个函数：两处不会分叉。
  const nowMs = Date.parse(deps.now?.() ?? new Date().toISOString())
  const today = dayKeyOf(nowMs, deps.config().evolution.schedule, (m) => deps.log.warn(m))
  accumulator.callsToday = (await readDailyUsage(deps, today)).calls

  for (const target of targets) {
    if (options.signal?.aborted === true) {
      accumulator.record.status = 'failed'
      accumulator.notes.push('运行被取消')
      return
    }
    if (cap > 0 && accumulator.callsToday >= cap) {
      // P-051：超预算只警告并停止，不偷偷烧钱；已消化的部分保留（游标已推进）。
      accumulator.capStopped = true
      accumulator.notes.push(`已到每日调用上限（${cap} 次），剩余会话留待下次`)
      return
    }
    try {
      const result = await digestOneSession(deps, accumulator, target, today)
      accumulator.record.scannedSessions += 1
      accumulator.record.parsedEvents += target.events.length
      if (result !== undefined) {
        accumulator.record.memoriesWritten += result.memoriesWritten
        accumulator.record.proposalsCreated += result.proposalsCreated
        // A4：并了几条要能进运行记录（自进化"整理过人格"要有可核对的读数）。
        accumulator.personaMerged += result.personaMerged
        // 0.1.11：被护栏/预演拦下的新增也要记账（"什么都没干"与"守住了预算"是两回事）。
        accumulator.personaAdditionsDropped += result.personaAdditionsDropped
        // 0.1.9：把"有记忆被截断保存"这件事**记进时间线**（记的是运行记录，不是只打日志）——
        // 否则用户只能靠逐条比对正文才能发现有内容被切掉了尾巴。
        accumulator.truncatedMemories += result.memoriesTruncated
      }
    } catch (error) {
      if (error instanceof AnalyzeError) {
        // 单会话解析失败：把失败路径烧掉的钱记进账（P-051）、游标按熔断规则处置、继续下一个。
        if (error.spent !== undefined) {
          await recordUsage(deps, accumulator, { input: error.spent.inputTokens, output: error.spent.outputTokens, calls: error.spent.calls }, today)
        }
        accumulator.failedSessions += 1
        await recordSessionFailure(deps, accumulator, target, `${error.code}：${error.message}`)
        continue
      }
      throw error
    }
  }
}

/** 收尾：把累计写进运行记录并落盘。 */
export async function finalizeRun(deps: RunnerDeps, accumulator: RunAccumulator): Promise<RunRecord> {
  const record = accumulator.record
  record.finishedAt = deps.now?.() ?? new Date().toISOString()
  if (record.status === 'running') {
    // 终态三分，**失败优先于预算停摆**（2026-09-26 审计 E6：旧顺序把"先失败一个会话、随后撞上
    // 每日上限"判成 `skipped`，而那一轮真的失败了、也真的花了钱 —— `skipped` 的语义是"没干活"）；
    // 其余（含部分失败）判 completed，错误注记如实展示。信息性注记不改终态。
    if (record.scannedSessions === 0 && accumulator.failedSessions > 0) record.status = 'failed'
    else if (accumulator.capStopped && record.scannedSessions === 0) record.status = 'skipped'
    else record.status = 'completed'
  }
  record.insights = accumulator.insights.slice(0, INSIGHTS_CAP)
  record.narrative = accumulator.narratives.join('\n\n').slice(0, NARRATIVE_CAP)
  // 0.1.9：**截断过的记忆必须留痕**（旧行为是静默硬切）。这算信息性注记，不改终态。
  if (accumulator.truncatedMemories > 0) {
    accumulator.notes.push(
      `${accumulator.truncatedMemories} 条记忆正文超过上限、已截断保存（原文更长；要保留全文请拆成多条）`,
    )
  }
  record.error = accumulator.notes.join('；').slice(0, 2000)
  await deps.state.putRun(record)
  void deps.state.pruneCursors(record.finishedAt).catch(() => {})
  return record
}
