/**
 * 人格的 Agent 工具：注册、封存 guard、以及生命周期的收敛。
 *
 * 为什么单独一个文件：这里管**生命周期**（何时注册/卸载），与工具业务（`init.ts`/`update.ts`）是两件事。
 *
 * 三条设计约束（改动前先读）：
 * 1. **零硬依赖**（G-002）：`defineTool` 走 `loadOptional`，官方包缺失时只关掉"Agent 工具"；
 * 2. **封存在工具体之前拦**：`ctx.tools.guard()` 判掉已封存还想初始化与夹带底色字段这类越权
 *    —— 不依赖参数 schema 是否写了这些字段；
 * 3. **审批可用性 fail-closed**：没有审批入口时"会丢内容的改动"一律拒绝、不写。
 * @module humanity/persona/tools
 */
// 只借类型：`ctx.approval` 的类型合并由这个包提供（不导入它，`ctx.inject(['approval'], …)` 编译期就不存在）；
// 运行期走 `ctx.inject` ⇒ 包缺席时插件照常工作，只是会丢内容的改动一律拒绝。
import type {} from '@deepseek-ai/dsh-user-approval'
import type { Context } from '@deepseek-ai/cordis'
// 只借类型：`ctx.tools` 的类型合并由这个包提供；运行期的 `defineTool` 走 `loadOptional`（G-002）。
import type { defineTool as defineToolType } from '@deepseek-ai/dsh-tools'

import type { Log } from '../log.js'
import { installToolsSeam, type ToolsApi } from '../tools-seam.js'
import { defineIdentityTool, PERSONA_IDENTITY_TOOL } from './identity.js'
import { defineInitTool, PERSONA_INIT_TOOL } from './init.js'
import { isUntouchedIdentityCard } from './predicates.js'
import type { PersonaSection } from './section.js'
import { requestApproval, watchApproval, type ApprovalSeam } from './tool-approval.js'
import { carriesIdentityWrite, NOT_INITIALIZED_REASON, SEALED_REASON } from './tool-helpers.js'
import { defineUpdateTool, PERSONA_UPDATE_TOOL } from './update.js'

/** 卸载动作。与 cordis `ctx.effect` 的返回值同形。 */
export type Disposer = () => void

/**
 * 人格工具句柄。
 *
 * `setEnabled` 与 `dispose` 都是幂等的：配置每次变化都会调用一次，不需要调用方自己去重。
 */
export interface PersonaToolsHandle {
  setEnabled(enabled: boolean): void
  dispose(): void
}

/**
 * 注册两个工具 + 一条封存 guard。
 * @param tools - 已就位的工具服务。
 * @param defineTool - 官方工具定义助手（经 `loadOptional` 取得）。
 * @param log - 日志门面。
 * @param persona - 人格读写入口。
 * @param approvalOf - 取当前审批服务（可选 seam）；每次调用时现取，避免把死句柄闭进工具里。
 * @param includeInit - 是否注册 init；封存后必须为 false（见下）。
 * @returns 一次性卸载全部注册的动作。
 */
function registerAll(
  tools: ToolsApi,
  defineTool: typeof defineToolType,
  log: Log,
  persona: PersonaSection,
  approvalOf: () => ApprovalSeam | undefined,
  includeInit: boolean,
): Disposer {
  const disposers: Disposer[] = [
    // 封存后 init **整个工具下线**：它的描述里「先在对话里引导对方…」是引导泄漏的根因 ——
    // complete 吞提示词但不吞工具目录，极简/已初始化会话的模型会照着这段模仿初始化流程
    // （2026-09-25 真机实证：极简净室里出现引导与重复 init）。看不见才模仿不了，比描述里写禁令硬。
    ...(includeInit ? [tools.register(defineInitTool(defineTool, persona))] : []),
    // 封存后才有它：底色修正的唯一通道，写入前一定在对话里问一次（见 `identity.ts`）。
    ...(includeInit
      ? []
      : [
          tools.register(
            defineIdentityTool(defineTool, {
              persona,
              confirm: (exec, reason) => requestApproval(approvalOf(), exec, PERSONA_IDENTITY_TOOL, log, reason),
            }),
          ),
        ]),
    tools.register(
      defineUpdateTool(defineTool, {
        persona,
        // 审批句柄每次调用时现取（`approvalOf`），不把可能过期的服务闭进工具。
        confirm: (exec, reason) => requestApproval(approvalOf(), exec, PERSONA_UPDATE_TOOL, log, reason),
      }),
    ),
    tools.guard((execution) => guardExecution(execution, persona)),
  ]

  log.info('人格封存 guard 已注册（底色对 Agent 的写入在函数体之前拦截）')
  return () => {
    for (const dispose of disposers.splice(0)) dispose()
  }
}

/**
 * 封存 guard：在工具体之前拦掉两类**结构上就能看出**的越权。
 * @param execution - 工具调用（名字 + 原始参数）。
 * @param persona - 人格读写入口。
 * @returns 拒绝理由；放行时返回 undefined。
 */
function guardExecution(
  execution: { name: string; arguments: unknown },
  persona: PersonaSection,
): string | undefined {
  if (
    execution.name !== PERSONA_INIT_TOOL &&
    execution.name !== PERSONA_UPDATE_TOOL &&
    execution.name !== PERSONA_IDENTITY_TOOL
  ) {
    return undefined
  }

  const card = persona.read().identityCard
  if (execution.name === PERSONA_INIT_TOOL && !isUntouchedIdentityCard(card)) return SEALED_REASON
  if (execution.name === PERSONA_UPDATE_TOOL && isUntouchedIdentityCard(card)) return NOT_INITIALIZED_REASON
  // 底色工具只在封存后注册；走到这里还能被调用，说明注册状态与文档不一致 —— 直接拒。
  if (execution.name === PERSONA_IDENTITY_TOOL && isUntouchedIdentityCard(card)) return NOT_INITIALIZED_REASON
  if (carriesIdentityWrite(execution.name, execution.arguments)) return SEALED_REASON
  return undefined
}

/** 工具注册状态：开关、已加载的入口、当前那次注册的卸载动作与注册时的封存快照。 */
interface PersonaToolsState {
  enabled: boolean
  api?: { tools: ToolsApi; defineTool: typeof defineToolType }
  registered?: Disposer
  /** 当前注册对应的「已封存」判定；翻转时需要重注册（init 的可见性跟着它走）。 */
  sealed?: boolean
}

/**
 * 让"开关状态"与"已注册状态"收敛到同一个目标上（幂等，可反复调用）。
 * @param state - 注册状态。
 * @param log - 日志门面。
 * @param persona - 人格读写入口。
 * @param approvalOf - 取当前审批服务（可选 seam）。
 */
function syncTools(
  state: PersonaToolsState,
  log: Log,
  persona: PersonaSection,
  approvalOf: () => ApprovalSeam | undefined,
): void {
  // **数据还没真正可读时，什么决定都不做。**
  //
  // 真机事故（2026-11-22）：`attached` 只表示"命名空间注册上了"，而 `get(ns)` 在存储没就绪时
  // 返回的是**默认文档**（`sealedAt` 为空）。于是已封存的实例被判成未封存，注册了 `init` 那套；
  // 等存储就绪后没人再叫它重判，就一直错着。现在等 `ready`（= 接上 **且** 存储就绪），
  // 就绪那一刻由 `PersonaSection.notifyStoreReady` 叫回来（宿主在 `index.ts` 里统一派发）。
  //
  // 判定写成 `=== false` 而不是 `!persona.ready`：**只有明确"没就绪"才等**。
  // 结构化的假 section（测试里那些）没有这个字段，`undefined` 应当照旧放行 ——
  // 用 `!` 会让它们全部停在"等待就绪"，表现为整个测试套挂住（2026-11-22 踩过）。
  if (persona.ready === false) return

  const want = state.enabled && state.api !== undefined
  // 初始化状态决定 init 是否可见：封存翻转时重注册一次（便宜：两条注册 + 一条 guard）。
  const sealed = !isUntouchedIdentityCard(persona.read().identityCard)
  if (want && state.api !== undefined && (state.registered === undefined || state.sealed !== sealed)) {
    state.registered?.()
    state.sealed = sealed
    state.registered = registerAll(state.api.tools, state.api.defineTool, log, persona, approvalOf, !sealed)
    return
  }
  if (!want && state.registered !== undefined) {
    state.registered()
    state.registered = undefined
    state.sealed = undefined
    log.info('人格 Agent 工具已卸载')
  }
}

/**
 * 安装人格的 Agent 工具。
 *
 * `defineTool` 走 `loadOptional`：官方包缺失时这里只记一条日志并跳过注册，人格的其余部分
 * （命名空间读写、工作台编辑）照常工作（G-002 零硬依赖）。
 * @param ctx - 本插件的上下文（同时是注册的 owner fiber）。
 * @param log - 日志门面。
 * @param persona - 人格读写入口。
 * @returns 带开关把手的句柄；调用方负责在配置变更与卸载时驱动它。
 */
export function installPersonaTools(ctx: Context, log: Log, persona: PersonaSection): PersonaToolsHandle {
  const state: PersonaToolsState = { enabled: true }
  /** 审批服务（可选 seam）。缺席时工具照常注册，只是"会丢内容的改动"一律拒绝、不写。 */
  let approval: ApprovalSeam | undefined
  const sync = (): void => syncTools(state, log, persona, () => approval)

  watchApproval(ctx, log, (seam) => {
    approval = seam
  })

  // 写入成功后重判注册（封存翻转把 init 下线 / 上线）；退订随本模块 fiber 卸载。
  // `notifyStoreReady` 走的也是这一组监听者，所以"存储就绪"和"文档被改"共用这条重判路径。
  ctx.effect(() => persona.onDocumentChanged(sync), 'humanity: 人格文档变化后重判工具注册')

  // "终于接上了"也重判一次（等 `ready` 的人要靠它，见 `syncTools` 开头）。
  ctx.effect(() => persona.onAttached(sync), 'humanity: 人格文档接上后重判工具注册')

  installToolsSeam(
    ctx,
    log,
    (tools, defineTool) => {
      state.api = { tools, defineTool }
      log.info(`人格 Agent 工具已注册（${PERSONA_INIT_TOOL} / ${PERSONA_UPDATE_TOOL}）`)
      sync()
    },
    () => {
      state.api = undefined
      state.registered?.()
      state.registered = undefined
    },
  )

  return {
    setEnabled(next) {
      state.enabled = next
      sync()
    },
    dispose() {
      state.enabled = false
      sync()
    },
  }
}
