/**
 * 分类写回：把一份解析输出按 P-038 的权限分层落到该落的地方。
 *
 * | 内容 | 去向 | 依据 |
 * |---|---|---|
 * | 记忆候选 | `remember()` 完整管线（策略门/去重/冲突/敏感→pending 全由记忆模块把关） | P-025/P-033/P-038 |
 * | 信息小节 | `classify-persona.ts`（完整快照合并 + agent 写入；被拒转提案） | P-017/P-038 |
 * | 底色字段 | **只生成提案**（approve 仅工作台可发，见 proposals.ts） | P-023/P-038 |
 * | 路由 | **只生成提案**，绝不自动启用 | P-039 |
 *
 * 模块独立（P-048）：记忆/人格句柄都是宿主喂进来的**现读函数**，模块关闭或未就绪时
 * 是 `undefined`，对应分类直接跳过并如实计数——自进化不能替关掉的模块写数据。
 * @module humanity/evolution/classify
 */
import type { Log } from '../log.js'
import { WHAT_CHAR_LIMIT } from '../memory/constants.js'
import { createMemoryRecord } from '../memory/model.js'
import type { MemoryStore } from '../memory/store.js'
import type { PersonaSection } from '../persona/section.js'
import type { PersonaDocument } from '../persona/types.js'
import { writePersonaSections } from './classify-persona.js'
import { addCounted, addFixedProposals } from './classify-proposals.js'
import { MAX_PROPOSAL_PAYLOAD_BYTES, MAX_PROPOSAL_TEXT_CHARS } from './constants.js'
import { createProposal, type AnalysisOutput, type ProposalInput } from './model.js'
import type { EvolutionState } from './state.js'
import type { RunMode } from './types.js'

/** 分类写回的依赖（全部现读，宿主接线）。 */
export interface ClassifyDeps {
  memoryStore(): MemoryStore | undefined
  persona(): PersonaSection | undefined
  state: EvolutionState
  log: Log
}

/** 写回上下文（提案溯源用）。 */
export interface ClassifyContext {
  runId: string
  sessionId: string
  cwd: string
  mode: RunMode
}

/** 写回结果计数（进运行记录）。 */
export interface ClassifyResult {
  memoriesWritten: number
  proposalsCreated: number
  proposalsSkipped: number
  personaUpdated: boolean
  /**
   * 本轮有多少条记忆**因超上限被截断保存**（0.1.9 新增）。
   *
   * 为什么要有：截断以前是静默的（硬切 200 字、回执照报成功）。这条路径的读者是**运行记录**
   * （`run-loop.ts` 会把它写成一条注记）⇒ 对方翻时间线就能看到"有几条没存全"，
   * 不必去逐条比对正文。
   */
  memoriesTruncated: number
  /**
   * 本轮信息**实际并掉**的同义条目数（0.1.10 · A4）。
   *
   * 为什么要进运行记录：自进化接管"人格预算整理"之后，对方要能看见"这轮到底并掉了几条"——
   * 不然"自进化说它整理了人格"只是一句自述，无从核对。
   */
  personaMerged: number
}

/** 提案落表入口（带跨轮去重）；返回是否真的生成了。 */
export type ProposalFactory = (context: ClassifyContext, input: ProposalInput) => boolean

/**
 * 造提案工厂：同类同名提案仍 pending 时不再生成（跨轮去重，防刷屏）。
 *
 * 生成失败（payload 超限等）只警告不抛：一条失控的提案不该毁掉整轮运行。
 */
export function createProposalFactory(deps: ClassifyDeps): ProposalFactory {
  return (context, input) => {
    const title = input.title.slice(0, MAX_PROPOSAL_TEXT_CHARS)
    const duplicate = deps.state
      .listProposals('pending')
      .some((record) => record.kind === input.kind && record.title === title)
    if (duplicate) return false
    try {
      const record = createProposal(
        { ...input, title, sourceRunId: context.runId, sourceSessionIds: [context.sessionId] },
        MAX_PROPOSAL_PAYLOAD_BYTES,
      )
      void deps.state.putProposal(record)
      return true
    } catch (error) {
      deps.log.warn(`提案生成失败（kind=${input.kind}，已跳过）`, error)
      return false
    }
  }
}

/**
 * 记忆候选逐条落库；返回 `[写入数, 因超长被截断数]`。
 *
 * 2026-11-20：待确认区（pending）随记忆重构一起删除 —— 那条路把"可能是模糊/敏感的信息"
 * 隔离开等对方点头，但在新设计里它变成了"她看了但不想说"（`cost` 那一维），
 * 而不是"等她审核"。所以这里直接写入。
 *
 * `certain: 'inferred'`：这些候选是**模型从对话里推出来的**，不是她亲眼所见 ——
 * 记住这一点，以后引用时才不会把推断当成事实复述。
 */
async function writeMemories(deps: ClassifyDeps, context: ClassifyContext, output: AnalysisOutput): Promise<[number, number]> {
  const store = deps.memoryStore()
  if (store === undefined) return [0, 0]
  let written = 0
  let truncated = 0
  for (const candidate of output.memories) {
    const raw = candidate.content.trim()
    if (raw === '') continue
    // 超长不是拒绝，是**截断并计数**：自进化抽出的长条目仍然值得留下能用的部分，
    // 但这件事必须让运行记录看得到（`run-loop.ts` 会把它写进时间线注记）。
    if (raw.length > WHAT_CHAR_LIMIT) truncated += 1
    await store.put(
      createMemoryRecord({
        what: raw.slice(0, WHAT_CHAR_LIMIT),
        // 候选来自"这段对话里发生了什么"：工作区级的多半是你们之间的事，
        // 长期级的多半是关于对方的稳定事实。
        about: candidate.scope === 'workspace' ? 'us' : 'user',
        certain: 'inferred',
      }),
    )
    written += 1
  }
  return [written, truncated]
}

/**
 * 把一份解析输出写回各归属地。
 * @param deps - 各模块句柄（现读）。
 * @param context - 溯源上下文。
 * @param output - 已过合同校验的解析结果。
 */
export async function applyAnalysis(deps: ClassifyDeps, context: ClassifyContext, output: AnalysisOutput): Promise<ClassifyResult> {
  const result: ClassifyResult = {
    memoriesWritten: 0,
    proposalsCreated: 0,
    proposalsSkipped: 0,
    personaUpdated: false,
    memoriesTruncated: 0,
    personaMerged: 0,
  }
  const addProposal = createProposalFactory(deps)

  ;[result.memoriesWritten, result.memoriesTruncated] = await writeMemories(deps, context, output)
  const persona = await writePersonaSections(deps, context, output, addProposal)
  result.personaUpdated = persona.updated
  result.personaMerged = persona.merged
  result.proposalsCreated += persona.proposals

  addCounted(result, addFixedProposals(context, output, addProposal))

  if (context.mode === 'dream' && output.insights.length > 0) {
    // 洞察不自动写记忆（联想产物的证据强度低）：进运行记录，由对方在时间线里决定。
    deps.log.info(`梦境产出 ${output.insights.length} 条洞察（已存入运行记录，不自动入库）`)
  }
  return result
}
