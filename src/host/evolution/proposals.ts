/**
 * 提案审核动作：approve / reject / delete（工作台命令槽的执行端）。
 *
 * ### 权限语义（这一节决定封存是否成立）
 * - **approve 只能由工作台命令触发**（用户真源）：人格写入用 `source: 'user'`——
 *   用户点了批准，就是用户的决定（P-023：固定层只有用户能改）。**没有**任何 Agent 工具
 *   能走到这里，所以"模型自己批准自己的提案"在结构上不可能发生。
 * - reject/delete 只动提案表，不触碰人格/记忆/技能。
 * - 应用失败（校验拒绝、技能重名、服务缺席）：提案**保持 pending**，原因原样进通知——
 *   失败的批准不是拒绝，用户改完还能再批（不静默吞，P-011）。
 *
 * 路由提案的"应用"= 标记 applied 并**只作存档**：自动路由功能已裁撤（用户 2026-09-26），
 * 该类别只为历史数据保留（可查看、可拒绝），不再由自进化产出，也不会生效。
 * @module humanity/evolution/proposals
 */
import type { Log } from '../log.js'
import { PersonaWriteRejected } from '../persona/document.js'
import type { PersonaSection } from '../persona/section.js'
import type { PersonaDocument } from '../persona/types.js'
import { mergePersonaSections } from './classify-persona.js'
import type { EvolutionState } from './state.js'
import type { SkillBridge } from './skills.js'
import { parseAppliedSkill } from './skills.js'
import type { ProposalRecord } from './types.js'

/** 审核动作依赖。 */
export interface ProposalActionDeps {
  state: EvolutionState
  persona(): PersonaSection | undefined
  skills: SkillBridge
  log: Log
  now?(): string
}

/** 审核动作入口（返回给用户看的一句话结论）。 */
export interface ProposalActions {
  approve(id: string): Promise<string>
  reject(id: string): Promise<string>
  delete(id: string): Promise<string>
}

/** 解析提案 payload；形状不对返回 `undefined`（数据损坏不抛，给中性文案）。 */
function parsePayload(proposal: ProposalRecord): Record<string, unknown> | undefined {
  try {
    const payload: unknown = JSON.parse(proposal.payload)
    return payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** 应用固定层字段提案：改现有字段或追加自定义字段，以 user 身份整份写回。 */
async function applyIdentityProposal(persona: PersonaSection, payload: Record<string, unknown>): Promise<void> {
  const fieldKey = payload.fieldKey
  const fieldValue = payload.fieldValue
  if (typeof fieldKey !== 'string' || fieldKey === '' || typeof fieldValue !== 'string') {
    throw new Error('提案数据缺少字段名或字段值')
  }
  const current = persona.read()
  const fields = current.identityCard.fields.map((field) => ({ ...field }))
  const existing = fields.find((field) => field.key === fieldKey)
  if (existing !== undefined) existing.value = fieldValue
  else fields.push({ key: fieldKey, value: fieldValue, custom: true })
  const next: PersonaDocument = { ...current, identityCard: { ...current.identityCard, fields } }
  await persona.write(next, 'user')
}

/** 应用可变层提案：把存档的小节更新重新合并进当前文档（文档可能已经变了，合并而不是覆盖）。 */
async function applyMutableProposal(persona: PersonaSection, payload: Record<string, unknown>): Promise<void> {
  const sections = payload.sections
  if (!Array.isArray(sections)) throw new Error('提案数据缺少小节更新')
  // 提案里可能**只带整合建议**（把几条同义条目并成一条）：那就没有 sections 可加。
  // 漏掉这一项时，用户点了「批准」、提案被标成 applied，人格卡却一个字没变（2026-09-26 审计）。
  const consolidations = Array.isArray(payload.consolidations) ? payload.consolidations : []
  const current = persona.read()
  const { next, added, merged } = mergePersonaSections(
    current,
    sections as Parameters<typeof mergePersonaSections>[1],
    consolidations as Parameters<typeof mergePersonaSections>[2],
  )
  if (added.length === 0 && merged === 0) return // 内容已经在文档里（用户手动做过同样的整理）：无事可做，视为成功
  await persona.write(next, 'user')
}

/** 应用一条人格提案（固定层或可变层，按 payload.type 分流）。 */
async function applyPersonaProposal(deps: ProposalActionDeps, proposal: ProposalRecord): Promise<string> {
  const persona = deps.persona()
  if (persona === undefined) return '人格模块当前不可用（已关闭或未就绪），提案保持待确认。'
  const payload = parsePayload(proposal)
  if (payload === undefined) return '提案数据已损坏，无法应用；可以删除它。'
  try {
    if (payload.type === 'identity') await applyIdentityProposal(persona, payload)
    else await applyMutableProposal(persona, payload)
    return '提案已应用（以你的名义写入人格）。'
  } catch (error) {
    if (error instanceof PersonaWriteRejected) {
      return `人格校验拒绝了这次写入：${error.issues.map((issue) => issue.message).join('；')}`
    }
    throw error
  }
}

/**
 * 造审核动作入口。
 * @param deps - 存储、人格段与技能桥。
 */
export function createProposalActions(deps: ProposalActionDeps): ProposalActions {
  const mark = async (proposal: ProposalRecord, status: ProposalRecord['status']): Promise<void> => {
    const at = deps.now?.() ?? new Date().toISOString()
    await deps.state.putProposal({ ...proposal, status, decidedAt: at })
  }

  const approve = async (id: string): Promise<string> => {
    const proposal = deps.state.getProposal(id)
    if (proposal === undefined) return '提案不存在（可能已被删除）。'
    if (proposal.status !== 'pending') return `提案已被处理过（当前状态：${proposal.status}），不再重复应用。`

    let notice = '提案已应用。'
    try {
      if (proposal.kind === 'persona') {
        notice = await applyPersonaProposal(deps, proposal)
        if (!notice.startsWith('提案已应用')) return notice // 应用未成功：保持 pending
      } else if (proposal.kind === 'skill') {
        const skill = parseAppliedSkill(proposal)
        if (skill === undefined) return '提案数据已损坏，无法应用；可以删除它。'
        await deps.skills.apply(skill)
      } else if (proposal.kind === 'route') {
        // 自动路由已裁撤（用户 2026-09-26）：route 只作为**历史类别**保留，能被查看与拒绝，
        // 但不再由自进化产出。这里如实说明，不给"以后会生效"的暗示。
        deps.log.info(`路由提案「${proposal.title}」已存档：自动路由功能已裁撤`)
        notice = '路由建议已存档。自动路由功能已裁撤，此策略不会生效。'
      }
    } catch (error) {
      deps.log.warn(`提案 ${id} 应用失败，保持待确认`, error)
      return `应用失败：${error instanceof Error ? error.message : String(error)}（提案保持待确认）`
    }
    await mark(proposal, 'applied')
    return notice
  }

  return {
    approve,
    reject: async (id) => {
      const proposal = deps.state.getProposal(id)
      if (proposal === undefined) return '提案不存在（可能已被删除）。'
      if (proposal.status !== 'pending') return `提案已被处理过（当前状态：${proposal.status}）。`
      await mark(proposal, 'rejected')
      return '已拒绝该提案（记录保留，可在工作台查看历史）。'
    },
    delete: async (id) => {
      const existed = await deps.state.removeProposal(id)
      return existed ? '提案已删除。' : '提案不存在（可能已被删除）。'
    },
  }
}
