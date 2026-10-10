/**
 * 对话内审批 seam：一次性改动的"先问再写"。
 *
 * 单独一个文件的原因：这是一条**可选**的外部依赖（G-002），它缺席或出错时的处理方式
 * （fail-closed：一律不写）是这里的核心语义，混在工具注册里会被当成实现细节。
 * @module humanity/persona/tool-approval
 */
import type { Context } from '@deepseek-ai/cordis'

import type { Log } from '../log.js'

/** 审批服务的返回值（与 DSH `ApprovalService#request` 同形）。 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/**
 * 审批 seam 的形状。
 *
 * 只声明我们真正用到的那一个方法：声明得越窄，将来 DSH 调整其它部分时越不容易牵连到这里。
 */
export interface ApprovalSeam {
  request(request: {
    agent?: unknown
    toolName: string
    callId: string
    reason: string
    signal?: AbortSignal
  }): Promise<ApprovalOutcome>
}

/**
 * 确认请求被拒 / 取消 / 不可用时，分别对 Agent 说的一句话。
 *
 * 三句话都**不**指向任何页面：真机踩过"把用户指向一个不存在的确认入口"的死结，
 * 这里只说清事实（谁拒绝的、为什么没写），让 Agent 用它自己的语气转达。
 */
export const OUTCOME_REASON: Record<Exclude<ApprovalOutcome, 'allowed-once'>, string> = {
  rejected: '用户拒绝了这次改动，没有写入。',
  cancelled: '这次改动被取消，没有写入。',
  unavailable: '当前环境没有可用的确认入口，所以没有写入。请告诉用户这一改动需要他确认。',
}

/**
 * 在当前对话里请求一次确认。
 *
 * 没有 seam（审批服务未挂载）时**不抛**：返回 `unavailable`，由调用方走"fail closed、不写"。
 * 这条路径必须能跑通 —— 极简组合里确实没有审批服务。
 * @param seam - 审批服务；缺席时为 undefined。
 * @param exec - 工具执行上下文（带上 agent 与 callId 才能问对人和对话）。
 * @param toolName - 发起确认的工具名。
 * @param log - 日志门面。
 * @param reason - 给用户看的一句话理由。
 * @returns 审批结论。
 */
export async function requestApproval(
  seam: ApprovalSeam | undefined,
  exec: { agent?: unknown; callId?: string },
  toolName: string,
  log: Log,
  reason: string,
): Promise<ApprovalOutcome> {
  if (seam === undefined || typeof seam.request !== 'function') return 'unavailable'
  try {
    return await seam.request({
      agent: exec.agent,
      toolName,
      callId: exec.callId ?? 'humanity-persona-update',
      reason,
    })
  } catch (error) {
    log.warn('审批请求失败：按"没有可用确认入口"处理（不写入）', error)
    return 'unavailable'
  }
}

/**
 * 接上**可选**的审批 seam。
 *
 * 为什么是可选（G-002）：Web 组合里 `dsh-user-approval` 恒在，但它缺席时人格工具仍要能用 ——
 * 只是"会丢内容的改动"退回成拒绝，而不是崩溃或假装问过了（fail-closed）。
 * 住在这里而不是 `tools.ts`：审批的接线与审批的语义同主题；tools.ts 只管注册生命周期。
 * @param ctx - 本插件的上下文。
 * @param log - 日志门面。
 * @param onChange - 服务出现/摘除时的回调；摘除时传 `undefined`。
 */
export function watchApproval(ctx: Context, log: Log, onChange: (seam: ApprovalSeam | undefined) => void): void {
  ctx.inject(['approval'], (actx) => {
    onChange(actx.approval as ApprovalSeam)
    log.info('人格改动确认已接入对话内审批')
    return () => {
      onChange(undefined)
      log.info('审批服务已摘除：会丢内容的改动将一律拒绝')
    }
  })
}
