/**
 * 技能桥：查重目录、注册已应用的技能、启动时恢复（P-041 的落地机制）。
 *
 * ### 对着 DSH 0.1.5-rc.2 核实过的事实
 * - `ctx.skills.register(skill)` 注册**运行时技能**：名字必须 kebab-case
 *   （`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`，编译 `dsh-skill/lib/index.js:17,465-468`），
 *   描述非空；同层同名 first-wins（重复注册只警告 + no-op，`:197-199`）；
 *   项目/用户技能 outrank 运行时技能（编译 `dsh-skill/lib/types/index.d.ts:252-253`）。
 * - 注册随 fiber 卸载自动撤销 ⇒ 已应用的技能必须**持久化**，每次装配重新落地。
 *
 * ### 2026-09-26（M7）：恢复路径改为**落盘优先**
 * 官方 `dsh-skill-filesystem` 会加载 `<DSH_HOME>/skills` 下的用户技能 —— 那才是技能该在的地方
 * （看得见、改得动、跟 `DSH_HOME` 迁移）。所以装配时逐条：**已在目录里 ⇒ 什么都不做**；
 * **不在目录里 ⇒ 先落盘**；落盘不可用（`ctx.fs` 缺席 / `DSH_HOME` 缺失）才回退运行时注册。
 * @module humanity/evolution/skills
 */
import type { Context } from '@deepseek-ai/cordis'

import type { Log } from '../log.js'
import type { SkillStore } from '../skills/store.js'
import { restoreOne, type SkillRestoreReport } from './skill-restore.js'
import type { ProposalRecord } from './types.js'

/** `ctx.skills` 注册表的结构窄面（比 SkillsLike 多一个 register：只有桥用它）。 */
interface SkillRegistryLike {
  list(options?: unknown): Promise<Array<{ name: string; description?: string }>>
  get?(name: string, options?: unknown): Promise<{ content?: string } | undefined>
  register(skill: unknown): () => void
}

/** 技能名的官方文法（抄自编译产物 `dsh-skill/lib/index.js:17`；升级时按 DEV-PLAN §3 重核）。 */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** 一条已应用技能的持久化内容（提案 payload 的窄化）。 */
export interface AppliedSkill {
  name: string
  description: string
  content: string
}

/** 技能桥入口。 */
export interface SkillBridge {
  /** `ctx.skills` 是否在场。 */
  available(): boolean
  /** 目录清单（缺席或失败时为空数组：查重降级为"当作全新技能"，由用户审核兜底）。 */
  list(): Promise<Array<{ name: string; description?: string }>>
  /**
   * 注册表里**当前**有哪些技能；服务缺席或列举失败时回 `undefined`（= 查不到，不是"没有"）。
   *
   * 与 `list()` 的差别全在失败语义：查重时"读不到"退回空数组没关系（顶多多提一个提案），
   * 而工作台拿这个清单判"这条技能到底活没活" —— 把失败当成空清单，会误报一整排"没生效"（审计 E4）。
   */
  names(): Promise<string[] | undefined>
  /** 读一条技能的正文（查重四分类的"内容是否相同"用）；缺席/失败返回 `undefined`。 */
  get(name: string): Promise<{ content?: string } | undefined>
  /** 注册一条技能；名字非法/服务缺席/**目录里已有同名**时抛（P-041：不覆盖任何已有技能）。 */
  apply(skill: AppliedSkill): Promise<void>
  /** 装配时恢复已应用的技能（已在目录的跳过、其余落盘、落盘不成退回注册）；返回可核对的账。 */
  restoreApplied(proposals: readonly ProposalRecord[]): Promise<SkillRestoreReport>
}

/**
 * 恢复结果与恢复单体都搬去了 `skill-restore.ts`（那份文件贴着 200 行行数门）。
 * 这里**原样再导出**：类型搬家不该波及消费方与测试的 import 路径。
 */
export type { SkillRestoreReport } from './skill-restore.js'

/** 从提案 payload 里解析技能内容；形状不对返回 `undefined`。 */
export function parseAppliedSkill(proposal: ProposalRecord): AppliedSkill | undefined {
  try {
    const payload = JSON.parse(proposal.payload) as Partial<AppliedSkill>
    if (typeof payload.name !== 'string' || typeof payload.content !== 'string') return undefined
    if (typeof payload.description !== 'string') return undefined
    return { name: payload.name, description: payload.description, content: payload.content }
  } catch {
    return undefined
  }
}

/**
 * 造技能桥。
 * @param ctx - 插件上下文（`ctx.get` 只读查找，不声明依赖——`agents` 事故同款纪律）。
 * @param log - 日志门面。
 * @param store - 技能落盘入口（可选：缺席时恢复路径退回纯运行时注册）。
 */
export function createSkillBridge(ctx: Context, log: Log, store?: SkillStore): SkillBridge {
  const registry = (): SkillRegistryLike | undefined => {
    const skills = ctx.get('skills') as SkillRegistryLike | undefined
    return skills !== undefined && typeof skills.register === 'function' ? skills : undefined
  }

  const listCatalog = async (): Promise<Array<{ name: string; description?: string }>> => {
    const skills = registry()
    if (skills === undefined) return []
    return skills.list().catch((error: unknown) => {
      log.warn('技能目录读取失败：查重降级为空目录（提案照常生成，由用户审核兜底）', error)
      return []
    })
  }

  const apply = async (skill: AppliedSkill): Promise<void> => {
    const skills = registry()
    if (skills === undefined) throw new Error('技能服务（ctx.skills）不可用，无法注册')
    if (!SKILL_NAME_RE.test(skill.name)) throw new Error(`技能名「${skill.name}」不符合 kebab-case 文法`)
    if (skill.description.trim() === '') throw new Error(`技能「${skill.name}」缺少描述`)
    // 同层同名 first-wins 只会静默 no-op、项目技能还会盖过运行时技能——与其让用户以为应用成功，
    // 不如在注册前明确拒绝（P-041：不覆盖、不替换任何已有技能，冲突走变体或新命名）。
    const catalog = await listCatalog()
    if (catalog.some((entry) => entry.name === skill.name)) {
      throw new Error(`技能「${skill.name}」已存在于目录（不覆盖已有技能——P-041），请改名或走更新提案`)
    }
    skills.register({ name: skill.name, description: skill.description, content: skill.content, source: 'runtime' })
  }

  return {
    available: () => registry() !== undefined,
    list: listCatalog,
    names: async () => {
      const skills = registry()
      if (skills === undefined) return undefined
      try {
        return (await skills.list()).map((entry) => entry.name)
      } catch (error) {
        log.warn('技能注册表列举失败：本次不判"已注册与否"（沿用未证实的状态）', error)
        return undefined
      }
    },
    get: async (name) => {
      const skills = registry()
      if (skills?.get === undefined) return undefined
      return skills.get(name).catch(() => undefined)
    },
    apply,
    restoreApplied: async (proposals) => {
      const report: SkillRestoreReport = { restored: 0, written: 0, failed: 0, note: '' }
      const notes: string[] = []
      for (const proposal of proposals) {
        if (proposal.kind !== 'skill' || proposal.status !== 'applied') continue
        const skill = parseAppliedSkill(proposal)
        if (skill === undefined) {
          log.warn(`已应用技能「${proposal.title}」的 payload 形状不对，跳过`)
          notes.push(`${proposal.title}: payload 形状不对`)
          continue
        }
        const outcome = await restoreOne(skill, { store, apply, log })
        if (outcome.restored) report.restored += 1
        if (outcome.written) report.written += 1
        if (outcome.note !== '') notes.push(outcome.note)
      }
      report.failed = notes.length
      report.note = notes.slice(0, 2).join('；')
      return report
    },
  }
}
