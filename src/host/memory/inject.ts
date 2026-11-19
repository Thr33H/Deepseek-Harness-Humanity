/**
 * 记忆注入：把"当前这句话相关的记忆"接进 Agent 的系统提示词（P-028）。
 *
 * ### 每个环节都对着 DSH 0.1.5-rc.2 的实现核实过
 *
 * 1. **`section.text` 是同步函数**（`PromptSection.text`），所以检索必须在回调里**同步**完成
 *    —— 这就是 `search.ts` 把"选条目"（{@link rankMemories}）与"记使用"（异步写盘）拆开的原因。
 * 2. **当前对方消息从 `agent/inbox/claimed` 事件里拿**：装配上下文（`AssembleContext`）只有
 *    `scope`/`signal`，**没有消息**；而 agent loop 的 `preStep` 是**先 claim（同步 emit 该事件）、
 *    再 assemble**（`dsh-agent-loop/lib/index.js:888-890`）。所以监听事件缓存"这句话"，
 *    紧接着的这次装配就能读到它 —— 不需要读会话日志，也不会有"晚一轮"的错位。
 * 3. **只声明 `systemPrompt` 依赖**：`agents` 一律用 `ctx.get`（T0 真机事故：声明 `agents`
 *    会让每个会话都创建失败）。事件监听不需要声明任何依赖。
 * 4. **`text` 里绝不能抛**：DSH 装配 provider 时没有 try/catch（`dsh-system-prompt` 说明），
 *    抛一次就毁掉这次 pre-step。异常一律收敛成"本轮不注入"。
 *
 * 内容是两段拼起来的：**引导语**（什么时候该调 `humanity_remember`，步骤 3 定的）
 * + **记忆块**（本轮检索到的 0–3 条，步骤 5）。引导语在记忆可用时一直在；记忆块按策略开关与检索结果出现。
 * @module humanity/memory/inject
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'

import { createMainAgentJudge, subjectOf } from '../agent-scope.js'
import { warnSafely, type Log } from '../log.js'
import { neutralizePromptVars } from '../text.js'
import { memoryIdentityOf, userTextOf } from './identity.js'
import { canRemember } from './policy.js'
import { BLOCK_TITLE, renderMemoryBlock } from './render.js'
import { markMemoriesUsed, rankMemories } from './search.js'
import type { SearchMood } from './search.js'
import type { MemoryStore } from './store.js'
import { MEMORY_REMEMBER_TOOL } from './tools-remember.js'
import { MEMORY_RECALL_TOOL } from './tools-recall.js'
import type { MemoryEntry, MemoryPolicy } from './types.js'

/** 注入段的名字。 */
export const MEMORY_SECTION_NAME = 'humanity:memory'

/**
 * 使用统计的**去重时间窗**（毫秒）。
 *
 * 同一轮的多步装配通常在一两秒内完成，15 秒足够覆盖；跨轮时对方几乎不可能在 15 秒内
 * 发出**一模一样**的一句话，所以"消息 + 时间窗"这个近似不会把两轮误并成一轮。
 */
const RECALL_DEDUPE_MS = 15_000

/**
 * 这一次装配该不该记"用过一次"。
 *
 * 抽成纯函数是为了能直接测：`section.text` 的调用方是 DSH，测不到它装配了几次，
 * 但可以测"同样的输入第二次不该再记"。
 * @param state - 上一次记录的消息与时刻（会被原地更新，见调用处）。
 * @param message - 这一次装配时的当前消息。
 * @param now - 现在（毫秒）。
 * @param windowMs - 去重时间窗。
 * @returns 该记则 `true`。
 */
export function shouldRecordRecall(
  state: { message: string; at: number },
  message: string,
  now: number,
  windowMs: number = RECALL_DEDUPE_MS,
): boolean {
  return !(state.message === message && now - state.at < windowMs)
}

/**
 * 注入段在系统提示词里的位置（人格 10、记忆 20：先"是谁"，再"记得什么"）。
 */
export const MEMORY_SECTION_ORDER = 20

/**
 * 触发提示正文（步骤 3 定，步骤 5 原样保留；2026-09-25 真机补召回义务子句）。
 *
 * 说的都是"什么时候做/不做什么"，不下判断标准：把"这条算不算长期偏好"交给 Agent，
 * 比在提示词里写一堆规则更可靠（写死了它就会照着规则硬套）。
 *
 * ### 召回义务子句的来由（真机事故，不是防御性补充）
 * 2026-09-25 TEST 会话取证：对方问"回忆一下我住哪（剧情里）"，模型把**自动注入的那一两条
 * 记忆当成记忆库全部**，在此之上即兴补细节并以"我记得"的口吻陈述（会话日志 turn5/turn6，
 * 模型自述："我拿系统塞给我的那两条当成了全部，没想到底下还有几条"）。
 * 工具描述里的触发条件（"当前上下文里没有时才查"）恰好被注入块满足，于是永不触发。
 * 所以义务必须写在**每轮都注入的引导语**里：注入块是线索不是全库；回忆/核对类问题先查再答；
 * 查无即未定，即兴内容不得冒充记忆。规则抽象表述（G-003），不举单点例子。
 */
export const MEMORY_GUIDANCE = [
  '## 你的记忆',
  '',
  `- 对方说过的长期偏好、对TA的称呼、稳定事实（职业、项目名）、长期目标、固定约定 —— 主动用 ${MEMORY_REMEMBER_TOOL} 记下来，不要为此再问一次。`,
  '- 不记：寒暄、一次性内容、整段对话原文。',
  '- **第一人称**：记你自己时写「我是…」「我叫…」，不要用第三人称指代自己。',
  `- 敏感信息（密码、密钥、财务、健康、隐私地址、身份号码）只有对方明确说"记住"时才记，并标成敏感 —— 它会进待确认，对方确认之前不生效。`,
  `- 自动注入的记忆块只是本轮最相关的几条，**不是记忆库全部**。对方要你回忆、核对，或你要用"我记得/上次/之前定过"的口吻说话时，先 ${MEMORY_RECALL_TOOL} 查一遍；`,
  '  查不到就是没有 —— 明说尚未定过，不许拿推测或本会话的即兴内容冒充记忆。',
].join('\n')

/** 注入需要的外部事实（都由 `index.ts` 现取，避免把死句柄闭进来）。 */
export interface MemoryInjectionDeps {
  /** 记忆读写入口；存储未就绪时返回 `undefined`。 */
  store(): MemoryStore | undefined
  /** 当前生效策略。 */
  policy(): MemoryPolicy
  /** 记忆模块是否启用（配置总开关）。 */
  enabled(): boolean
  /**
   * 这一轮**想起了哪几条**（供情绪模块把当时的温度带回来一点）。
   *
   * 为什么由记忆侧通知而不是情绪侧去查记忆：召回这件事只有记忆模块知道（它选了哪几条、
   * 打了几分）；情绪侧如果自己去查，就会变成两套检索。通知是单向的、最窄的一根线。
   * 缺席时静默跳过（情绪模块被关掉、或旧组合里没接这条线）。
   */
  onRecalled?(entries: readonly MemoryEntry[]): void
  /**
   * 此刻的心情（"心境一致"：同向的旧事更容易被想起）。
   *
   * 缺席时检索行为与没有这个能力时逐位相同 —— 它只是排序上的一个偏向，不是前置条件。
   */
  mood?(): SearchMood | undefined
}

/**
 * 把记忆接进系统提示词（只对主 Agent 生效）。
 *
 * 注册两件东西：一个事件监听（记住"当前这句话"）与一个提示词段。两者都随 fiber 卸载 ——
 * 监听器只持有 `WeakMap`，会话结束后不留下引用。
 * @param ctx - 本插件的上下文。
 * @param log - 日志门面。
 * @param deps - 存储、策略与开关。
 * @returns 卸载动作。
 */
export function installMemoryInjection(ctx: Context, log: Log, deps: MemoryInjectionDeps): () => void {
  let disposeAll: (() => void) | undefined
  const isMainAgent = createMainAgentJudge(ctx, log)
  /** 每个 agent 最近一次"被 claim 的对方消息"。用 WeakMap：会话结束即随之释放。 */
  const latestMessage = new WeakMap<object, string>()
  /**
   * 上一轮的使用统计记在了哪句话上。
   *
   * `section.text` 是**每次装配提示词都会调用**的，而一轮多步（工具调用）会装配多次。
   * 如果每次装配都记一次"用过"，`useCount` 就按步数虚高、`lastUsedAt` 被反复刷新 ——
   * 而 `lastUsedAt` 是衰减评分的"新鲜度"依据，等于让刚写的记忆永远不比实际旧。
   * 实测症状：一条记忆创建后 66ms 就被标记使用过（同一轮的第 2 步命中了它）。
   *
   * 去重键取"这句话"：同一轮内消息不变，下一轮对方换一句话就自然换了键。
   * 时间窗只是兜底（对方连续发两句一样的"嗯"时，靠它区分成两轮）。
   */
  const recall = { message: '', at: 0 }

  // 事件声明在 `dsh-agent` 的类型里，而本插件不依赖那个包（G-002），所以按结构监听：
  // 事件名与 payload 形状都在文件头写明了，改 DSH 版本时对着那里核。
  const on = ctx.on as unknown as (name: string, listener: (payload: unknown) => void) => () => void
  const disposeListener = on('agent/inbox/claimed', (payload) => {
    const { agent, message } = (payload ?? {}) as { agent?: unknown; message?: unknown }
    if (agent === null || typeof agent !== 'object') return
    const text = userTextOf(message)
    if (text !== '') latestMessage.set(agent, text)
  })

  // ⚠️ 依赖里**只有** systemPrompt（T0 教训：声明 agents 会让每个会话都创建失败）。
  ctx.inject(['systemPrompt'], (sctx) => {
    // 与人格同理用 `section`（system role 遵从度更高）。极简模式会把本段吞掉 ——
    // 那是 DSH 的 `complete` 语义下的平台限制，取舍见 `persona/prompt.ts` 的说明。
    const disposeSection = sctx.systemPrompt.section({
      name: MEMORY_SECTION_NAME,
      order: MEMORY_SECTION_ORDER,
      text: (context) => renderSectionText(context, { deps, latestMessage, isMainAgent, log, recall }),
    })

    log.info('记忆注入已接入系统提示词（依赖只声明 systemPrompt；按 agent/inbox/claimed 取当前消息）')

    disposeAll = () => {
      disposeSection()
      disposeAll = undefined
    }
    return disposeAll
  })

  return () => {
    disposeListener()
    disposeAll?.()
  }
}

/** 提示词段的运行时输入。 */
interface SectionRuntime {
  deps: MemoryInjectionDeps
  latestMessage: WeakMap<object, string>
  isMainAgent: (subject: object) => boolean
  log: Log
  /** 使用统计的去重状态（跨多次装配共享，见 `installMemoryInjection` 里的说明）。 */
  recall: { message: string; at: number }
}

/**
 * 提示词片段提供者（`section.text` 的实现）。
 *
 * ⚠️ 这里**绝不能抛**：见文件头第 4 条。任何异常都收敛成"这轮不注入"。
 * @param context - 装配上下文（`agent` / `scope`）。
 * @param runtime - 依赖与判定函数。
 * @returns 提示词片段；不该注入时返回空串。
 */
function renderSectionText(context: unknown, runtime: SectionRuntime): string {
  const { deps, latestMessage, isMainAgent, log, recall } = runtime
  try {
    const subject = subjectOf(context)
    if (subject === undefined || !isMainAgent(subject)) return ''
    if (!deps.enabled()) return ''
    const policy = deps.policy()

    const guidance = canRemember(policy) ? MEMORY_GUIDANCE : ''
    const block = renderBlock(subject, latestMessage.get(subject) ?? '', deps, policy, log, recall)
    // 中和 `{{`：记忆正文由模型/对方写入，可能是代码片段或模板语法；DSH 的变量插值遇到
    // 解析不了的 `{{…}}` 会抛错，而装配路径没有兜底（审计 S1-3）。
    return neutralizePromptVars([guidance, block].filter((part) => part !== '').join('\n\n'))
  } catch (error) {
    warnSafely(log, '记忆注入渲染失败：本轮不注入（不影响对话继续）', error)
    return ''
  }
}

/**
 * 检索并渲染记忆块。
 *
 * 使用统计的写入是**异步补记**（`section.text` 没法 await）：它只影响排序与衰减，
 * 写失败不该毁掉这一轮对话，所以失败只记日志。没有当前消息 / 存储未就绪 / 未开启自动注入
 * 时都返回空串（P-028：没有就不注入）。
 */
function renderBlock(
  subject: object,
  message: string,
  deps: MemoryInjectionDeps,
  policy: MemoryPolicy,
  log: Log,
  recall: { message: string; at: number },
): string {
  if (!policy.autoInject || message === '') return ''
  const store = deps.store()
  if (store === undefined) return ''

  const identity = memoryIdentityOf(subject)
  const hits = rankMemories(store, policy, {
    message,
    sessionId: identity.sessionId,
    workspaceId: identity.workspaceId,
    mood: deps.mood?.(),
  })
  const block = renderMemoryBlock(hits, policy.injectTokenBudget, new Date().toISOString())
  if (block === '') return ''

  /**
   * 同一轮只记一次。判断依据：消息没变、且距上次召回很近（见 `installMemoryInjection`）。
   * 轮内的第 2、3 步会反复装配提示词，跳过它们，才不会把"一条记忆"记成"三步都用过"。
   */
  const now = Date.now()
  if (!shouldRecordRecall(recall, message, now)) return block
  recall.message = message
  recall.at = now

  void markMemoriesUsed(store, hits, (error) => {
    log.warn(`记忆使用统计写入失败（不要紧，只影响排序）：${BLOCK_TITLE}`, error)
  })

  // 想起了哪几条 ⇒ 告诉情绪模块，让它把当时的温度带回来一点（单向、失败无害）。
  try {
    deps.onRecalled?.(hits)
  } catch (error) {
    warnSafely(log, '记忆召回的情绪回声失败（只影响心情，不影响这一轮）', error)
  }

  return block
}
