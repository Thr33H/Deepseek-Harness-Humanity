/**
 * `humanity_skill_persist`：把**已批准、但还没写进磁盘**的技能落盘（0.1.12 的根因修复）。
 *
 * ### 为什么必须有这个工具（源码级根因，见 `docs/plans/humanity-0.1.12-skill-disk-root-fix.md` §3）
 *
 * 插件的落盘发生在两个**没有 agent 会话**的时刻：工作台批准提案、以及进程启动时的恢复。
 * 官方文件后端按**每次调用**的沙箱策略判写入，而策略里"会话模式"那一档只能从**调用会话**取：
 * `dsh-tool-str-replace-editor/lib/index.js:59-60` 逐字是
 * `resolve(exec) { return this.policy?.resolve({ ...exec.agent === void 0 ? {} : { session: exec.agent.session } }) }`。
 * 插件那一刻没有会话 ⇒ 策略里只剩部署默认（本部署 `workspace-write`，根是 `/workspace`）
 * ⇒ `$DSH_HOME/skills` 不在根下 ⇒ 被拒（0.1.11 实测原文：
 * `cannot write "…/SKILL.md": file access denied under workspace-write mode`）。
 *
 * 修法不是放宽围栏，而是**把写盘交给有会话身份的一方执行**：本工具由 agent 调用，
 * 因此 `exec.agent.session` 在场 —— 用**那次会话**的模式与 cwd 解析 per-call 策略，
 * 再连同 `exec.signal` 一起交给官方 `ctx.fs.writeText`（`dsh-fs-sandbox` 的 `checkedTarget`
 * 明确写着 `const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()`，per-call 参数优先）。
 * 于是"能不能写"由**调用会话的权限**决定：`danger-full-access` 的会话可写，
 * `workspace-write` 且根不含技能目录的会话仍被拒（这是围栏在正确工作，不是缺陷）。
 *
 * ### 安全边界（与"修一个洞不能开一个洞"直接对应）
 * - 工具**只接受技能名**，不接受任何路径：目标路径由 `skills/paths.ts` 的 `skillFile()` 唯一构造
 *   （那是全仓唯一把名字变成路径的地方，且有 `isSkillName` 的 kebab-case 校验）；
 * - 内容**不由调用方提供**：只从**已批准（`applied`）的提案**里取，模型无法借这个工具写任意文本；
 * - 仍然 `createIfAbsent`：目录里已有同名技能**绝不覆盖**（P-041），返回 `exists`；
 * - 失败一律结构化返回（含沙箱拒绝的原文与怎么办），不抛、不静默。
 * @module humanity/evolution/tools-skill-persist
 */
import type { Context } from '@deepseek-ai/cordis'
// 只借类型：运行期 `defineTool` 由 `tools-seam` 经 loadOptional 取（G-002）。
import type { defineTool as defineToolType } from '@deepseek-ai/dsh-tools'

import type { Log } from '../log.js'
import { describeError } from '../log.js'
import type { SkillStore } from '../skills/store.js'
import { isSkillName, resolveDshHome, skillFile } from '../skills/paths.js'
import { installToolsSeam, type ToolsApi } from '../tools-seam.js'
import { parseAppliedSkill, type AppliedSkill } from './skills.js'
import type { EvolutionState } from './state.js'

/** 工具名（带前缀，避免与其它插件的工具撞名）。 */
export const SKILL_PERSIST_TOOL = 'humanity_skill_persist'

/** 沙箱事实：围栏模式 + 由调用会话解析出的 per-call 策略。 */
export interface SandboxFacts {
  /** 文件后端的围栏事实（`ctx.fs.sandboxMode`）；`undefined` = 后端不设围栏（bare 后端）。 */
  mode: string | undefined
  /**
   * 由调用会话解析 per-call 策略；服务缺席时 `undefined`。
   * 没有会话（理论上不会发生：本工具由 agent 调用）时退化为部署默认（`resolve({})`）——
   * 那与后端自己会做的事等价，不是绕过。
   */
  policyFor(session: unknown): unknown | undefined
}

/** 工具运行期需要的外部事实（全部现读，避免把死句柄闭进工具）。 */
export interface SkillPersistDeps {
  /** 技能落盘入口（`ctx.fs` / `DSH_HOME` 缺席时 undefined）。 */
  store(): SkillStore | undefined
  /** 已批准、可能在磁盘上还不存在的技能（现读提案表）。 */
  pending(): readonly AppliedSkill[]
  /** 沙箱事实（现读 `ctx.fs.sandboxMode` 与 `ctx.sandboxPolicy`）。 */
  sandbox(): SandboxFacts
}

/** 工具返回值（成败都由 `ok` 表达，理由进 `message`）。 */
export interface SkillPersistValue {
  ok: boolean
  /** written 已落盘 / exists 目录里已有同名的（不覆盖）/ refused 没写（原因见 message）。 */
  status: string
  name: string
  /** 目标文件的展示路径；没写时为要写的位置或空串。 */
  file: string
  message: string
}

/** 输出契约（与记忆工具同一条宽类型约定：枚举用字符串，逐字段 `required`）。 */
export const PERSIST_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true, description: '是否真的写进了磁盘' },
    status: { type: 'string', required: true, description: 'written / exists / refused' },
    name: { type: 'string', required: true, description: '技能名' },
    file: { type: 'string', required: true, description: '目标文件路径（展示用）' },
    message: { type: 'string', required: true, description: '面向 Agent/用户的一句话结论' },
  },
} as const

/** 参数契约（模型看得到的说明）。 */
const PERSIST_PARAMETERS = {
  name: {
    type: 'string',
    required: true,
    description:
      '要落盘的技能名（kebab-case，与提案里的 name 一致）。本工具只接受**名字**，不接受路径，' +
      '也不会覆盖目录里已有的同名技能。',
  },
} as const

/** 工具描述（模型可见）：说清什么时候该调用、以及为什么它值得调用。 */
const PERSIST_DESCRIPTION =
  '把**已批准但还没写进磁盘**的技能落盘到 `$DSH_HOME/skills/<name>/SKILL.md`。' +
  '主动调用：当工作台/技能页显示"落盘写入 0 条"或有技能只活在运行时注册里（关掉会话就没了）、' +
  '或你刚批准了一条技能提案时，调用本工具把它写进磁盘。' +
  '写入使用**你当前会话的权限**：会话权限不足（沙箱围栏）时本工具会如实告诉你被拒的原因，' +
  '这时不要重试或绕路，交给用户换一个允许写工作区外目录的会话再试。' +
  '内容取自已批准提案，本工具**不能**用来写任意文件或任意内容。'

/** 从进化状态里现读"已批准（applied）的技能"。 */
export function pendingSkillPersists(state: EvolutionState | undefined): AppliedSkill[] {
  if (state === undefined) return []
  const found: AppliedSkill[] = []
  for (const proposal of state.listProposals('applied')) {
    if (proposal.kind !== 'skill') continue
    const skill = parseAppliedSkill(proposal)
    if (skill !== undefined) found.push(skill)
  }
  return found
}

/**
 * 现读沙箱事实（结构探测，与 `wiring.ts` 同一纪律：缺方法就当缺席，不半信半疑地调用）。
 * @param ctx - 插件上下文（`ctx.get` 只读查找，不声明依赖）。
 * @returns 围栏模式与策略解析器。
 */
export function sandboxFactsOf(ctx: Context): SandboxFacts {
  const fs = ctx.get('fs') as { sandboxMode?: unknown } | undefined
  const service = ctx.get('sandboxPolicy') as { resolve?: (request?: unknown) => unknown } | undefined
  return {
    mode: typeof fs?.sandboxMode === 'string' ? fs.sandboxMode : undefined,
    policyFor: (session) => {
      if (typeof service?.resolve !== 'function') return undefined
      return session === undefined ? service.resolve({}) : service.resolve({ session })
    },
  }
}

/** 沙箱拒绝的错误码（`dsh-fs-sandbox` 的 `FS_SANDBOX_DENIED`）。 */
function isSandboxDenied(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'FS_SANDBOX_DENIED'
}

/** 造一条工具返回值。 */
function value(ok: boolean, status: string, name: string, file: string, message: string): SkillPersistValue {
  return { ok, status, name, file, message }
}

/**
 * 定义技能落盘工具。
 * @param defineTool - 官方工具定义助手（经 `loadOptional` 取得）。
 * @param deps - 落盘入口、待落盘清单与沙箱事实（每次调用现取）。
 * @returns 可交给 `tools.register` 的工具定义。
 */
export function defineSkillPersistTool(defineTool: typeof defineToolType, deps: SkillPersistDeps) {
  return defineTool({
    name: SKILL_PERSIST_TOOL,
    description: PERSIST_DESCRIPTION,
    parameters: PERSIST_PARAMETERS,
    output: {
      schema: PERSIST_RESULT_SCHEMA,
      render: (_args, result) => [{ type: 'text', text: (result as SkillPersistValue).message }],
    },
    async execute(args, exec): Promise<SkillPersistValue> {
      const name = typeof args.name === 'string' ? args.name.trim() : ''
      // 展示用目标路径：与真实写入**同一个** `skillFile()`（全仓唯一把名字变成路径的地方）——
      // 这里只用于回报，不参与写入，因此不存在第二条路径来源。
      const home = resolveDshHome()
      const target = isSkillName(name) && home !== undefined ? skillFile(home, name) : ''
      // ① 名字闸（V4 的第一道）：非 kebab-case 一律不碰文件系统。这也是路径安全的源头 ——
      //    `..`、`/`、绝对路径都不是合法技能名，因此**结构上**构造不出技能目录之外的路径。
      if (!isSkillName(name)) {
        return value(false, 'refused', name, target, `技能名「${name}」不是合法 kebab-case（小写字母/数字/连字符），本次没有写入。`)
      }
      // ② 内容闸：只认"已批准提案"里的技能，调用方**不能**自带正文。
      const skill = deps.pending().find((entry) => entry.name === name)
      if (skill === undefined) {
        return value(false, 'refused', name, target, `没有找到已批准（applied）的技能提案「${name}」：本工具只负责把已批准的内容落盘，不接受自带正文。`)
      }
      const store = deps.store()
      if (store === undefined || !store.available()) {
        return value(false, 'refused', name, target, '文件服务（ctx.fs）或 DSH_HOME 不可用，本次没有写入（技能仍可在本次会话里以运行时注册使用）。')
      }
      // ③ 策略闸：围栏后端必须有策略可用（官方 `dsh-tool-str-replace-editor` 在缺服务时直接抛，
      //    这里改为结构化拒绝 —— 同一个判断，但不对模型抛异常）。
      const sandbox = deps.sandbox()
      const session = (exec as { agent?: { session?: unknown } }).agent?.session
      const sandboxPolicy = sandbox.policyFor(session)
      if (sandbox.mode !== undefined && sandboxPolicy === undefined) {
        return value(false, 'refused', name, target, `当前文件后端会围栏写入（${sandbox.mode}），但读不到沙箱策略服务（ctx.sandboxPolicy），本次没有写入。`)
      }
      try {
        const outcome = await store.write(skill, {
          ...(sandboxPolicy === undefined ? {} : { sandboxPolicy }),
          ...(exec.signal === undefined ? {} : { signal: exec.signal }),
        })
        if (outcome === 'exists') {
          return value(true, 'exists', name, target, `技能「${name}」在技能目录里已经有同名文件，本次没有覆盖（要改内容请走技能页的编辑）。`)
        }
        return value(true, 'written', name, target, `技能「${name}」已落盘（按本次会话的权限写入）：关掉会话也还在，技能页会显示为已写入文件。`)
      } catch (error) {
        if (isSandboxDenied(error)) {
          return value(false, 'refused', name, target, `被沙箱拒绝：本次会话的权限不允许写技能目录（${describeError(error)}）。这不是插件缺陷，也不要重试或绕路 —— 换一个允许写工作区之外目录的会话/权限预设，或把正文手动复制到技能目录。`)
        }
        return value(false, 'refused', name, target, `技能「${name}」落盘失败：${describeError(error)}`)
      }
    },
  })
}

/** 工具定义助手与工具服务；两者都拿到才谈得上注册。 */
interface ToolsApiLoaded {
  tools: ToolsApi
  defineTool: typeof defineToolType
}

/** 卸载动作。与 cordis `ctx.effect` 的返回值同形。 */
type Disposer = () => void

/** 技能落盘工具句柄。`dispose` 幂等。 */
export interface SkillPersistToolHandle {
  dispose(): void
}

/**
 * 安装技能落盘工具（与 `memory/tools.ts` 同构：服务与 `defineTool` 都就位才注册，摘除时先卸再清句柄）。
 * @param ctx - 本插件的上下文。
 * @param log - 日志门面。
 * @param deps - 工具运行期依赖（每次调用现取）。
 * @returns 句柄（卸载由调用方驱动）。
 */
export function installSkillPersistTool(ctx: Context, log: Log, deps: SkillPersistDeps): SkillPersistToolHandle {
  let api: ToolsApiLoaded | undefined
  let registered: Disposer | undefined

  const unregister = (): void => {
    registered?.()
    registered = undefined
  }

  installToolsSeam(
    ctx,
    log,
    (tools, defineTool) => {
      api = { tools, defineTool }
      if (registered !== undefined) return
      const dispose = api.tools.register(defineSkillPersistTool(api.defineTool, deps))
      registered = () => {
        dispose()
      }
      log.info(`技能落盘工具已注册（${SKILL_PERSIST_TOOL}）`)
    },
    () => {
      unregister()
      api = undefined
    },
  )

  return {
    dispose() {
      unregister()
    },
  }
}
