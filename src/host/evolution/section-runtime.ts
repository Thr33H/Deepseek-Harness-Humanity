/**
 * 自进化工作台通道的**运行期**：投影刷新、命令消费与串行队列（与 `memory/section-runtime.ts` 同构）。
 *
 * 队列存在的理由与记忆相同：投影本身也会触发 `onChange`；不串行的话，"客户端发第二条命令"
 * 与"宿主投影第一条的结果"会交叉，谁最后写 `request`，另一方的命令就被吃掉。
 *
 * 投影里有一条刻意的取舍：提案**不裁剪 pending**（用户的待办一条都不能少），
 * 已处理（approved/rejected/applied）的只带最近 {@link DECIDED_VIEW_CAP} 条——
 * 提案是用户资产不自动删（存储里全量保留），但设置文档不该无限膨胀。
 * @module humanity/evolution/section-runtime
 */
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'

import type { Log } from '../log.js'
import type { SkillView } from '../skills/inventory.js'
import { EVOLUTION_NAMESPACE } from './constants.js'
import { applyEvolutionRequest, EMPTY_REQUEST, type EvolutionOps, type EvolutionRequest } from './ops.js'
import { proposalViewOf, runViewOf, type EvolutionDocument, type StatusView } from './section-doc.js'
import { utcDateOf } from './schedule-time.js'
import type { EvolutionState } from './state.js'

/** 已处理提案在投影里的条数上限（pending 永远全量）。 */
export const DECIDED_VIEW_CAP = 30

/** 运行期需要的外部事实（读取与写出都从外面现取，避免把死句柄闭进来）。 */
export interface EvolutionSectionDeps {
  /** 存储面；未就绪时 `undefined`（投影与命令都等待 `notifyStoreReady`）。 */
  state(): EvolutionState | undefined
  /** 命令动作面（runner + 提案审核）。 */
  ops(): EvolutionOps | undefined
  /**
   * 模块可用性状态（**含 `storeReady`，由宿主现算**）。
   *
   * ⚠️ 0.1.9：以前这里只收 `Omit<StatusView,'storeReady'>`，然后在投影里补一句写死的
   * `storeReady: true`。那是**断言**不是**测量** —— 2026-10-05 排查"整理一直失败"时，
   * 工作台显示"存储就绪"，而那时所有状态写入都在抛错，这个字段差点被当成"存储没问题"的证据。
   * 现在值由宿主从真实句柄算出、原样透传（见 `index.ts` 的 `status()`）。
   */
  status(): StatusView
  /** 记忆侧待确认条数（待确认页的"记忆"分类；宿主跨模块接线，投影只合并计数）。 */
  memoryPendingCount(): number
  /** 下一次定时触发（调度器现读）。 */
  nextRunAt(): number
  /** 每日调用上限（配置现读，工作台展示预算用）。 */
  dailyCallCap(): number
  /**
   * 记账用的「今天」日期键（`YYYY-MM-DD`，按**调度时区**算）。
   *
   * 必须与运行记账（`run-loop` 里的 `dayKeyOf`）用同一个键（2026-09-26 审计 E5）：
   * 两处各算一次，时区一换就会出现"界面显示今天用了 0 次、实际已经用满"。
   */
  dayKey?(): string
  /** 技能清单（M7：官方目录 + 提案表合成；缺席时技能页显示空清单）。 */
  skillViews?(): Promise<SkillView[]>
  /** 技能能不能落盘（文件服务与 DSH_HOME 是否都在场；技能页据此如实提示）。 */
  skillsWritable?(): boolean
  /** 上一次技能恢复的账（含失败原因，技能页原样显示）。 */
  skillsReport?(): string
}

/** 运行期的完整依赖（接线状态由 section.ts 补进来）。 */
interface RuntimeDeps extends EvolutionSectionDeps {
  settings(): SettingsProvider | undefined
  read(): EvolutionDocument | undefined
  log: Log
}

/** 运行期句柄。 */
export interface SectionRuntime {
  refresh(consumed?: EvolutionRequest): Promise<void>
  enqueue(): void
  notifyStoreReady(): void
}

/** 运行期内部状态：依赖 + 上一次命令的结论。 */
interface RuntimeState {
  deps: RuntimeDeps
  notice: string
}

/** 命令槽能不能清空（与记忆同一守则：只清"刚消费的那条"，不吞新命令）。 */
export function shouldClearRequest(live: EvolutionRequest | undefined, consumed: EvolutionRequest | undefined): boolean {
  if (live === undefined) return false
  if (live.op === '') return true
  if (consumed === undefined) return false
  // **逐字段**比对（2026-09-26 审计抓到的静默丢命令）：原来只比 op/id/mode/rescanKind/rescanValue，
  // 而技能命令把这三项全留空、真正的内容在 skillName/Description/Content 里 ——
  // 于是"第一条技能命令的投影"会把窗口内提交的第二条技能命令一起清掉，用户按了保存却什么都没发生。
  // 写法上不写死字段名：任一侧多出的键都参与比较，以后加字段不会再漏。
  const keys = new Set([...Object.keys(live), ...Object.keys(consumed)])
  return [...keys].every(
    (key) => (live as unknown as Record<string, unknown>)[key] === (consumed as unknown as Record<string, unknown>)[key],
  )
}

/** 拼投影补丁（只含宿主拥有的字段；`request` 按守则决定清不清）。 */
function projectionPatch(
  state: RuntimeState,
  skills: readonly SkillView[],
  consumed?: EvolutionRequest,
): Record<string, unknown> {
  const { deps } = state
  const store = deps.state()
  if (store === undefined) return {}
  const proposals = store.listProposals()
  const pending = proposals.filter((record) => record.status === 'pending')
  const decided = proposals.filter((record) => record.status !== 'pending').slice(0, DECIDED_VIEW_CAP)
  const counts = store.countPending()
  const memoryCount = deps.memoryPendingCount()
  const record = store.readState()
  // 跨天归零：账本按日期记，昨天的数字不该显示成"今天用了多少"。
  // 「今天」由宿主按**调度时区**算好传进来（审计 E5）：这里再算一遍就是第二个真源，早晚分叉。
  const today = record.dailyDate === (deps.dayKey?.() ?? utcDateOf(Date.now()))

  return {
    runs: store.listRuns().map(runViewOf),
    proposals: [...pending, ...decided].map(proposalViewOf),
    pendingCounts: { ...counts, memory: memoryCount, total: counts.total + memoryCount },
    status: deps.status(),
    nextRunAt: deps.nextRunAt(),
    baselineAt: record.baselineAt,
    dailyCalls: today ? record.dailyCalls : 0,
    dailyInputTokens: today ? record.dailyInputTokens : 0,
    dailyOutputTokens: today ? record.dailyOutputTokens : 0,
    dailyCallCap: deps.dailyCallCap(),
    notice: state.notice,
    skills: [...skills],
    skillsWritable: deps.skillsWritable?.() ?? false,
    skillsReport: deps.skillsReport?.() ?? "",
    ...(shouldClearRequest(deps.read()?.request, consumed) ? { request: EMPTY_REQUEST } : {}),
  }
}

/** 投影当前命名空间值；设置服务或存储未就绪时什么都不写（不拿空投影盖真数据）。 */
async function refreshProjection(state: RuntimeState, consumed?: EvolutionRequest): Promise<void> {
  const { deps } = state
  const settings = deps.settings()
  if (settings === undefined || deps.state() === undefined) return
  // 技能清单要读官方目录（IO）：在投影外先取好，`projectionPatch` 保持纯同步（好测）。
  // 取不到不算错误：技能页显示空清单，其余投影照常写。
  let skills: readonly SkillView[] = []
  try {
    skills = (await deps.skillViews?.()) ?? []
  } catch (error) {
    deps.log.warn('技能清单读取失败（本次投影的技能页为空）', error)
  }
  try {
    await settings.update(EVOLUTION_NAMESPACE, projectionPatch(state, skills, consumed))
  } catch (error) {
    deps.log.warn('自进化投影写入失败（工作台可能看到旧数据）', error)
  }
}

/** 执行客户端留下的一条命令，然后投影一次。 */
async function consumeOnce(state: RuntimeState): Promise<void> {
  const { deps } = state
  const store = deps.state()
  const ops = deps.ops()
  const request = deps.read()?.request
  if (store === undefined || ops === undefined || request === undefined || request.op === '') return
  try {
    state.notice = await applyEvolutionRequest({ ...ops, refresh: () => void refreshProjection(state) }, request)
  } catch (error) {
    state.notice = '执行这条操作时出错，已保持不变。'
    deps.log.error('自进化工作台操作失败', error)
  }
  deps.log.info(`自进化工作台操作 ${request.op}：${state.notice}`)
  await refreshProjection(state, request)
}

/**
 * 造出运行期。
 * @param deps - 外部事实 + 接线状态读取。
 */
export function createSectionRuntime(deps: RuntimeDeps): SectionRuntime {
  const state: RuntimeState = { deps, notice: '' }
  let queue: Promise<void> = Promise.resolve()
  const enqueue = (task: () => Promise<void> = () => consumeOnce(state)): void => {
    queue = queue.then(task, task)
  }

  return {
    refresh: (consumed) => refreshProjection(state, consumed),
    enqueue,
    notifyStoreReady(): void {
      enqueue()
      enqueue(() => refreshProjection(state))
    },
  }
}
