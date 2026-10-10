/**
 * 分类写回：把一份解析输出按 P-038 的权限分层落到该落的地方。
 *
 * | 内容 | 去向 | 依据 |
 * |---|---|---|
 * | 记忆候选 | `remember()` 完整管线（策略门/去重/冲突/敏感→pending 全由记忆模块把关） | P-025/P-033/P-038 |
 * | 可变层小节 | `classify-persona.ts`（完整快照合并 + agent 写入；被拒转提案） | P-017/P-038 |
 * | 固定层字段 | **只生成提案**（approve 仅工作台可发，见 proposals.ts） | P-023/P-038 |
 * | 技能 | 先查目录四分类，**只生成提案** | P-041 |
 * | 路由 | **只生成提案**，绝不自动启用 | P-039 |
 *
 * 模块独立（P-048）：记忆/人格句柄都是宿主喂进来的**现读函数**，模块关闭或未就绪时
 * 是 `undefined`，对应分类直接跳过并如实计数——自进化不能替关掉的模块写数据。
 * @module humanity/evolution/classify
 */
import type { Log } from '../log.js'
import { remember } from '../memory/write.js'
import type { MemoryStore } from '../memory/store.js'
import type { MemoryPolicy } from '../memory/types.js'
import type { PersonaSection } from '../persona/section.js'
import type { PersonaDocument } from '../persona/types.js'
import { writePersonaSections } from './classify-persona.js'
import { addCounted, addFixedProposals } from './classify-proposals.js'
import { MAX_PROPOSAL_PAYLOAD_BYTES, MAX_PROPOSAL_TEXT_CHARS } from './constants.js'
import { createProposal, type AnalysisOutput, type ProposalInput } from './model.js'
import type { PersonaBudgetState } from './prompt.js'
import type { EvolutionState } from './state.js'
import type { RunMode, SkillsLike } from './types.js'

/** 分类写回的依赖（全部现读，宿主接线）。 */
export interface ClassifyDeps {
  memoryStore(): MemoryStore | undefined
  memoryPolicy(): MemoryPolicy | undefined
  persona(): PersonaSection | undefined
  skills(): SkillsLike | undefined
  state: EvolutionState
  log: Log
  /**
   * **预算拟合器**（0.1.11 · A，可选）：传入一份候选人格文档，返回它的注入预算读数。
   *
   * 为什么要把这个函数喂进来：写回层要做"写入前预演"（把拟新增的条目先合进去看看会不会超），
   * 而"会不会超"只有一处算得对 —— `persona/render.ts` 的 `personaPromptReport`
   * （与真实注入同一套拟合，连 `independentJudgment` 占用的预算都一致）。
   * 写回层自己再算一遍预算，迟早出现"预演说能放、注进去却被截断"的分叉。
   * 缺席时（旧接线 / 测试替身）回退到同一函数 + 默认 `independentJudgment: true`：
   * **保守方向**（该口径下预算更小 ⇒ 只会少放一条，不会多放一条），见 `classify-persona.ts`。
   */
  personaFit?(doc: PersonaDocument): PersonaBudgetState | undefined
}

/** 写回上下文（提案溯源用）。 */
export interface ClassifyContext {
  runId: string
  sessionId: string
  cwd: string
  mode: RunMode
  /**
   * 本轮该会话开始时，人格护栏是否已触发（0.1.10 · A3；0.1.11 扩到"接近预算"）。
   *
   * 两种触发方式：注入预算**已超**（`truncated`）或**接近上限**（`used/budget ≥ 0.85`）。
   * 为什么要在写回层再判一次：提示词里那句"禁止追加新条目"是**请求**，不是保证 ——
   * 模型完全可能忽略它；护栏触发时如果还照单追加，结果就是"越整理越长"（正是要修的病）。
   * 触发时 `personaSections` 一律不写，只认 `sectionConsolidations`。
   */
  personaGuardActive?: boolean
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
   * （`run-loop.ts` 会把它写成一条注记）⇒ 用户翻时间线就能看到"有几条没存全"，
   * 不必去逐条比对正文。
   */
  memoriesTruncated: number
  /**
   * 本轮可变层**实际并掉**的同义条目数（0.1.10 · A4）。
   *
   * 为什么要进运行记录：自进化接管"人格预算整理"之后，用户要能看见"这轮到底并掉了几条"——
   * 不然"自进化说它整理了人格"只是一句自述，无从核对。
   */
  personaMerged: number
  /**
   * 本轮有多少条**拟新增的条目被护栏/预演拦下**（0.1.11 · A）。
   *
   * 为什么单独记账：护栏现在会在"接近预算"时就停追加，用户需要能看见"模型提了、但没写进去几条"——
   * 否则表现是"自进化好像什么都没干"，而真相是它守住了预算。运行记录注记会读这个数。
   */
  personaAdditionsDropped: number
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

/** 记忆候选逐条走记忆管线；返回成功写入数。 */
async function writeMemories(deps: ClassifyDeps, context: ClassifyContext, output: AnalysisOutput): Promise<[number, number]> {
  const store = deps.memoryStore()
  const policy = deps.memoryPolicy()
  if (store === undefined || policy === undefined) return [0, 0]
  let written = 0
  let truncated = 0
  for (const candidate of output.memories) {
    const result = await remember(store, policy, {
      content: candidate.content,
      scope: candidate.scope,
      tags: [...candidate.tags],
      sensitivity: candidate.sensitive ? 'sensitive' : 'normal',
      origin: 'agent-derived',
      sessionId: context.sessionId,
      workspaceId: context.cwd,
    })
    if (result.ok) written += 1
    // 0.1.9：截断过的记忆要能被**计数**（`run-loop.ts` 会把它写进运行记录的时间线注记）。
    if (result.truncated === true) truncated += 1
  }
  return [written, truncated]
}

/** 技能候选四分类（P-041）：duplicate 不生成；update/variant/new 生成提案。 */
async function classifySkills(
  deps: ClassifyDeps,
  context: ClassifyContext,
  output: AnalysisOutput,
  addProposal: ProposalFactory,
): Promise<[number, number]> {
  const skills = deps.skills()
  const catalog = skills === undefined ? [] : await skills.list().catch(() => [])
  let created = 0
  let skipped = 0
  for (const candidate of output.skills) {
    const exact = catalog.find((entry) => entry.name === candidate.name)
    if (exact !== undefined && skills?.get !== undefined) {
      const existing = await skills.get(candidate.name).catch(() => undefined)
      if (existing?.content === candidate.content) {
        skipped += 1 // 完全重复：只记录命中，不生成（P-041.1）
        continue
      }
    }
    const parent = exact?.name ?? catalog.find((entry) => entry.name !== '' && candidate.name.includes(entry.name))?.name ?? ''
    const title =
      exact !== undefined
        ? `更新技能：${candidate.name}`
        : parent !== ''
          ? `技能变体：${candidate.name}（父：${parent}）`
          : `新技能：${candidate.name}`
    const createdOne = addProposal(context, {
      kind: 'skill',
      title,
      reason: candidate.reason,
      payload: { name: candidate.name, description: candidate.description, content: candidate.content, parent },
      diff: exact !== undefined ? '与现有同名技能内容不同（更新）' : parent !== '' ? `引用父技能 ${parent}，适用场景不同` : '全新技能',
    })
    if (createdOne) created += 1
    else skipped += 1
  }
  return [created, skipped]
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
    personaAdditionsDropped: 0,
  }
  const addProposal = createProposalFactory(deps)

  ;[result.memoriesWritten, result.memoriesTruncated] = await writeMemories(deps, context, output)
  const persona = await writePersonaSections(deps, context, output, addProposal)
  result.personaUpdated = persona.updated
  result.personaMerged = persona.merged
  result.personaAdditionsDropped = persona.additionsDropped
  result.proposalsCreated += persona.proposals

  addCounted(result, addFixedProposals(context, output, addProposal))
  addCounted(result, await classifySkills(deps, context, output, addProposal))

  if (context.mode === 'dream' && output.insights.length > 0) {
    // 洞察不自动写记忆（联想产物的证据强度低）：进运行记录，由用户在时间线里决定。
    deps.log.info(`梦境产出 ${output.insights.length} 条洞察（已存入运行记录，不自动入库）`)
  }
  return result
}
