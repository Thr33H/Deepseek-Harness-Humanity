/**
 * 分类写回的**提案生成助手**（从 `classify.ts` 拆出）：固定层字段 → 提案。
 * 只提案、不落生效数据（P-038），生成动作都经 `ProposalFactory`（跨轮去重 + 落表）。
 *
 * 路由建议已随 M4 裁撤一并删除（用户 2026-09-26）：不再产出，也就不再为它花模型 token。
 * @module humanity/evolution/classify-proposals
 */
import type { ClassifyContext, ProposalFactory } from './classify.js'
import type { ClassifyResult } from './classify.js'
import type { AnalysisOutput } from './model.js'

/** 固定层字段 → 提案（P-038：只提案）。返回 [生成数, 跳过数]。 */
export function addFixedProposals(context: ClassifyContext, output: AnalysisOutput, addProposal: ProposalFactory): [number, number] {
  let created = 0
  let skipped = 0
  for (const fixed of output.personaFixed) {
    const ok = addProposal(context, {
      kind: 'persona',
      title: `身份卡字段：${fixed.fieldKey} → ${fixed.fieldValue}`,
      reason: fixed.reason,
      payload: { type: 'identity', fieldKey: fixed.fieldKey, fieldValue: fixed.fieldValue },
      diff: `建议把「${fixed.fieldKey}」设为「${fixed.fieldValue}」（固定层只能由用户确认后修改）`,
    })
    if (ok) created += 1
    else skipped += 1
  }
  return [created, skipped]
}

/** 把一组 [生成, 跳过] 计数并进结果。 */
export function addCounted(result: ClassifyResult, counts: [number, number]): void {
  result.proposalsCreated += counts[0]
  result.proposalsSkipped += counts[1]
}
