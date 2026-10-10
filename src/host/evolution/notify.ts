/**
 * 对话内提案提醒（P-043 的 B 方案落地）：有待确认批次时，在下一次主 Agent 装配里
 * 注入一小段指令，让 Agent 用两三句话告知用户，然后**同一批只提醒一次**。
 *
 * ### 形态说明（如实记录，不假装是 UI 卡片）
 * DSH 没有"插件直接向对话发 UI 卡片"的 seam；能在系统提示词层做到的最接近形态是
 * 「引导模型在本次回复开头组织一段简短告知」——内容、分类数量与工作台入口都在指令里，
 * 措辞由 Agent 按人格组织（P-011 的职责边界）。若用户认为必须是字面 UI 卡片，
 * 那是新 seam 的裁决事项（DEV-PLAN §5.4 已注明）。
 *
 * ### 水位机制（"同一批只提醒一次"）
 * 水位 = 当前全部 pending（提案 id + 记忆指纹）排序拼接的哈希。渲染出非空提醒后异步落盘；
 * 下次装配哈希相同 → 空串。新提案/新 pending 记忆改变哈希 → 再提醒一次。
 * 用户处理掉提案也会改变哈希——但那只会让提醒**消失**（total 归零直接空串），不会误报。
 *
 * 红线纪律：`text` 绝不抛（S1-2）；输出经 `neutralizePromptVars`（S1-3）；
 * 只对主 Agent 注入（`agent-scope.ts` 判定，不声明 `agents` 依赖——T0 事故）。
 * @module humanity/evolution/notify
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'

import { createMainAgentJudge, subjectOf } from '../agent-scope.js'
import { warnSafely, type Log } from '../log.js'
import { neutralizePromptVars } from '../text.js'
import { PROPOSALS_SECTION_NAME, PROPOSALS_SECTION_ORDER } from './constants.js'
import type { EvolutionState } from './state.js'

/** 提醒需要的待确认事实（宿主跨模块接线：提案在自进化存储，记忆 pending 在记忆存储）。 */
export interface PendingFacts {
  /** 待确认提案 id（pending 状态）。 */
  proposalIds(): string[]
  /** 待确认记忆指纹（pending 状态）。 */
  memoryFingerprints(): string[]
  /** 分类计数（文案里报给用户）。 */
  counts(): { memory: number; persona: number; skill: number; route: number; total: number }
}

/** 提醒注入的依赖。 */
export interface NotifyDeps {
  state(): EvolutionState | undefined
  pending(): PendingFacts | undefined
  enabled(): boolean
}

/** djb2 字符串哈希（水位用；不是安全场景，只要"同批同值、异批异值"够稳即可）。 */
export function hashBatch(ids: readonly string[]): string {
  let hash = 5381
  for (const id of ids) {
    for (let index = 0; index < id.length; index += 1) {
      hash = ((hash << 5) + hash + id.charCodeAt(index)) | 0
    }
  }
  return (hash >>> 0).toString(36)
}

/** 渲染提醒正文；不该提醒时返回空串。 */
function renderNotice(counts: { memory: number; persona: number; skill: number; route: number; total: number }): string {
  const parts: string[] = []
  if (counts.memory > 0) parts.push(`记忆 ${counts.memory} 条`)
  if (counts.persona > 0) parts.push(`人格 ${counts.persona} 条`)
  if (counts.skill > 0) parts.push(`技能 ${counts.skill} 条`)
  if (counts.route > 0) parts.push(`路由 ${counts.route} 条`)
  return (
    `【待确认提案】现在有 ${counts.total} 条内容在等待用户确认（${parts.join('、')}）。` +
    '请在本次回复的开头用两三句话告知用户：有多少条待确认、大致是哪些类别，' +
    '以及可以打开 Humanity 工作台的「待确认」页逐条处理。' +
    '只简短提醒这一次，不要展开内容细节，不要替用户做决定，也不要在之后的回复里重复。'
  )
}

/**
 * 装上提案提醒段。
 * @param ctx - 插件上下文。
 * @param log - 日志门面。
 * @param deps - 待确认事实与开关（现读）。
 * @returns 卸载动作。
 */
export function installProposalNotification(ctx: Context, log: Log, deps: NotifyDeps): () => void {
  const isMainAgent = createMainAgentJudge(ctx, log)
  let disposeSection: (() => void) | undefined

  // ⚠️ 依赖里只有 systemPrompt（T0 教训：声明 agents 会让每个会话都创建失败）。
  ctx.inject(['systemPrompt'], (sctx) => {
    disposeSection = sctx.systemPrompt.section({
      name: PROPOSALS_SECTION_NAME,
      order: PROPOSALS_SECTION_ORDER,
      text: (context) => renderSectionText(context, { deps, isMainAgent, log }),
    })
    return () => {
      disposeSection?.()
      disposeSection = undefined
    }
  })

  return () => disposeSection?.()
}

/** text 回调的运行时输入。 */
interface NotifyRuntime {
  deps: NotifyDeps
  isMainAgent: (subject: object) => boolean
  log: Log
}

/**
 * 提示词片段提供者。**绝不能抛**（装配路径没有兜底，S1-2）：一切异常收敛成本轮不提醒。
 * @param context - 装配上下文。
 * @param runtime - 依赖与判定。
 */
function renderSectionText(context: unknown, runtime: NotifyRuntime): string {
  const { deps, isMainAgent, log } = runtime
  try {
    const subject = subjectOf(context)
    if (subject === undefined || !isMainAgent(subject)) return ''
    if (!deps.enabled()) return ''
    const state = deps.state()
    const pending = deps.pending()
    if (state === undefined || pending === undefined) return ''

    const counts = pending.counts()
    if (counts.total === 0) return ''
    const watermark = hashBatch([...pending.proposalIds(), ...pending.memoryFingerprints()].sort())
    if (state.readState().notifiedWatermark === watermark) return '' // 同一批只提醒一次

    // 水位落盘是异步补记（字段级原子合并，不碰别人的字段）：写失败最多让下一轮重复提醒一次，
    // 不值得毁掉这一轮（try/catch 包裹）。
    void state
      .mutateState({ notifiedWatermark: watermark })
      .catch((error: unknown) => warnSafely(log, '提醒水位落盘失败（下轮可能重复提醒一次）', error))
    return neutralizePromptVars(renderNotice(counts))
  } catch (error) {
    warnSafely(log, '提案提醒渲染失败：本轮不提醒（不影响对话继续）', error)
    return ''
  }
}
