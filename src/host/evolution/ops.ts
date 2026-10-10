/**
 * 工作台对自进化的**操作**：命令形状与执行端。
 *
 * 与 `memory/ops.ts` 同一条纪律：命令来自浏览器，每条都要能应付"东西已经没了/正在跑"——
 * 结论如实返回（一句话通知），不抛异常；所有操作幂等（重复到达不产生第二次副作用）。
 *
 * `run`/`rescan` 是**发射后不管**：整理运行可能持续几分钟，命令消费队列不能被它占住
 * （否则这期间用户点"批准提案"都没响应）。启动结果立刻回通知；运行结局进时间线，
 * 失败由 runner 记账、投影刷新带出去。批准/拒绝/删除是快操作，照常等待结果。
 * @module humanity/evolution/ops
 */
import type { RescanRange } from './scan.js'
import type { Runner } from './run.js'
import type { ProposalActions } from './proposals.js'
import type { SkillDraft, SkillEditor } from '../skills/edit-ops.js'

/** 一条来自工作台的命令。`op` 为空串表示"没有命令"（命名空间稳态）。 */
export interface EvolutionRequest {
  op: string
  /** approve/reject/delete 的目标提案 id。 */
  id: string
  /** run 的形态：'incremental' | 'dream'。 */
  mode: string
  /** rescan 范围：'days' | 'workspace' | 'session' | 'all'。 */
  rescanKind: string
  /** rescan 范围的参数（天数/工作区路径/会话 id；all 时忽略）。 */
  rescanValue: string
  /** 技能编辑表单（M7；`skill-create` / `skill-update` 用）。 */
  skillName: string
  skillDescription: string
  skillContent: string
}

/** 没有待执行命令时的取值。 */
export const EMPTY_REQUEST: EvolutionRequest = {
  op: '',
  id: '',
  mode: '',
  rescanKind: '',
  rescanValue: '',
  skillName: '',
  skillDescription: '',
  skillContent: '',
}

/** 执行一条命令需要的动作面。 */
export interface EvolutionOps {
  runner: Runner
  proposals: ProposalActions
  /** 技能编辑（M7：新建 / 修改 / 停用 / 恢复）。 */
  skills: SkillEditor
  /** 运行结束（无论成败）后刷新投影：时间线要能看到结局。 */
  refresh(): void
  /** 启动被拒（模块已关/互斥竞态）时的告警出口。 */
  warn(message: string, error: unknown): void
}

/** 把命令槽的形状解析成回扫范围；形状不对返回 `undefined`。 */
function rescanRangeOf(request: EvolutionRequest): RescanRange | undefined {
  if (request.rescanKind === 'all') return { kind: 'all' }
  if (request.rescanKind === 'days') {
    const days = Number(request.rescanValue)
    return Number.isInteger(days) && days > 0 ? { kind: 'days', days } : undefined
  }
  if (request.rescanKind === 'workspace') {
    return request.rescanValue !== '' ? { kind: 'workspace', cwd: request.rescanValue } : undefined
  }
  if (request.rescanKind === 'session') {
    return request.rescanValue !== '' ? { kind: 'session', sessionId: request.rescanValue } : undefined
  }
  return undefined
}

/** 发射一次运行：立即回通知，结局异步进时间线（失败也要刷投影，让原因可见）。 */
function launchRun(ops: EvolutionOps, mode: 'incremental' | 'dream', rescan?: RescanRange): string {
  // 互斥预检：runner 的闸仍然是最终裁决，这里只是让"已经在跑"立刻回到用户眼前，
  // 而不是被发射后不管的 catch 吞掉。
  if (ops.runner.current() !== undefined) return '已有一次整理在运行，等它结束再试（时间线可看进度）。'
  const label = rescan === undefined ? (mode === 'dream' ? '梦境整理' : '增量整理') : '回扫整理'
  void ops.runner
    .start({ mode, trigger: 'manual', rescan })
    .catch((error: unknown) => ops.warn(`${label}未能启动`, error))
    .then(() => ops.refresh())
  return `${label}已启动；完成后运行时间线会出现记录（可能需要几分钟）。`
}

/**
 * 执行一条命令并返回给用户看的结论。
 * @param ops - 动作面。
 * @param request - 命令。
 */
/** 从命令里取出技能编辑表单。 */
function draftOf(request: EvolutionRequest): SkillDraft {
  return { name: request.skillName, description: request.skillDescription, content: request.skillContent }
}

export async function applyEvolutionRequest(ops: EvolutionOps, request: EvolutionRequest): Promise<string> {
  switch (request.op) {
    case 'run': {
      const mode = request.mode === 'dream' ? 'dream' : 'incremental'
      return launchRun(ops, mode)
    }
    case 'rescan': {
      const range = rescanRangeOf(request)
      if (range === undefined) return '回扫范围不合法：需要正整数天数、非空工作区路径或会话 id。'
      return launchRun(ops, 'incremental', range)
    }
    case 'approve':
      return ops.proposals.approve(request.id)
    case 'reject':
      return ops.proposals.reject(request.id)
    case 'delete':
      return ops.proposals.delete(request.id)
    case 'skill-create':
      return ops.skills.create(draftOf(request))
    case 'skill-update':
      return ops.skills.update(draftOf(request))
    case 'skill-disable':
      return ops.skills.setDisabled(request.skillName, true)
    case 'skill-enable':
      return ops.skills.setDisabled(request.skillName, false)
    default:
      return `不认识的操作：${request.op}`
  }
}
