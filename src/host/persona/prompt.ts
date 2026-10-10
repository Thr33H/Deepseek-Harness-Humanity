/**
 * 人格注入（T0）：把 `humanity-persona` 命名空间里的**内容**拼进 Agent 的系统提示词。
 *
 * 这个文件只管**生命周期**：什么时候注册 section、这次装配的主体该不该注入、异常怎么收敛。
 * 渲染规则在 `render.ts`（纯函数），数据读写在 `section.ts`。
 *
 * ### 两个关键机制（都已对着 DSH 0.1.5-rc.2 的实现核实）
 *
 * 1. **热更新不需要失效机制**：`PromptSection.text` 可以是函数，DSH 每次装配都会
 *    `typeof section.text === "function" ? section.text(context) : section.text`
 *    （`dsh-system-prompt/lib/index.js:339`）。所以我们注册一个**函数**，它每轮重读数据：
 *    改名 → 下一轮就生效，不必重开会话、不必重新注册。
 * 2. **scope 按裁决 2（只注入主 Agent）**：装配主体是 agent 本身（`assembleContextFor` 返回
 *    `{ agent, scope: agent, signal }`），所以在 `text` 里判定"主体在不在 `agents.roots()`"即可。
 * 3. **极简模式的已知限制**：preset 的 persona section 带 `complete: true`，DSH 装配会把其余
 *    sections 全部丢掉（真机：人格与记忆一起消失）。改走 `context` 能绕开，但代价是降到 user role ——
 *    标准模式必须用 section，故接受"极简模式不注入"这条平台限制。
 *    这条限制**必须被如实探测出来**（工作台警告条）：触发点就在下面的 `text` 回调里，
 *    用当前 agent 的作用域探测（见 `preset-compat.ts` 解释为什么全局装配看不到它）。
 *
 * ### ⛔ 最重要的一条：**绝不把 `agents` 声明成依赖**
 *
 * 真机事故（2026-09-23）：早先这里写的是 `ctx.inject(['agents', 'systemPrompt'], …)`，
 * 结果**每个会话都创建失败**（`cannot get required service "agents" in inactive context`）：
 * `ctx.inject([...])` 会把 `agents` 写进本插件 fiber 的依赖声明，而会话创建走另一个尚未激活的
 * 组合上下文。**只声明 `systemPrompt` 是安全的**，需要看注册表时用不声明依赖的 `ctx.get('agents')`
 * （读不到就是 undefined，不抛）。
 *
 * @module humanity/persona/prompt
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'

import { createMainAgentJudge, subjectOf } from '../agent-scope.js'
import { probeInjectionSurvived, type CompatState } from '../preset-compat.js'
import type { Log } from '../log.js'
import { renderSectionText } from './prompt-render.js'
import type { PersonaDocument } from './types.js'

/**
 * 注入的名字。
 *
 * 主 Agent 与子 Agent 用的是**同一个名字** —— 这正是子 Agent 那条空贡献能"遮蔽"掉继承来的内容的
 * 原因（按名字合并，最近作用域赢）。
 */
export const PERSONA_SECTION_NAME = 'humanity:persona'

/**
 * 注入段在系统提示词里的位置。
 *
 * `HARNESS_IDENTITY` 是 -1000，DSH 自己的 `DEPLOYMENT_PERSONA_PREFIX` 是 0；
 * 人格底色属于"比工具说明更靠前的底色"，所以取一个紧跟其后的正数。
 */
export const PERSONA_SECTION_ORDER = 10

/**
 * 一个可注入的人格源。
 *
 * 注入只需要三件事：**读当前文档**、**知道开关是否打开**、**知道这份文档是不是"真的读到了"**。
 * 用具名接口而不是直接塞 `PersonaSection`，是为了让"开关"由调用方（index.ts）决定，
 * 而注入模块不必知道配置结构。
 */
export interface PersonaPromptSource {
  read(): PersonaDocument
  enabled(): boolean
  /**
   * 独立判断底层指令是否注入（配置项 independentJudgment；缺省视为开）。
   *
   * 为什么是可选的：它是**底层立场**，测试与别的组合可能只想验人格内容本身；
   * 缺省为开（与 schema 默认值一致），显式传 `false` 才关。
   */
  independentJudgment?(): boolean
  /**
   * 人格文档是否**真的可读**（设置命名空间已注册）。
   *
   * 为什么需要它：读取路径在设置服务就绪前会返回一份**空默认文档**，而空默认文档的
   * `initializedAt` 也是空串 —— 只看文档形状的话，那个启动窗口里会向模型宣告"人格尚未初始化"，
   * 可实际上用户早就初始化过了。所以引导语只在"读到了真文档、且它确实没初始化"时才注入。
   * 缺省（undefined）视为可读。
   */
  ready?(): boolean
}

/**
 * 把人格接进系统提示词：**只对主 Agent 生效**（裁决 2）。
 *
 * 主/子判定本身在 `agent-scope.ts`（三级降级 + "绝不把 agents 声明成依赖"的教训），
 * 与记忆注入共用同一份实现；这里只负责"注册 section、按判定决定注不注入、异常收敛"。
 *
 * @param ctx - 本插件的上下文。
 * @param log - 日志门面。
 * @param source - 人格内容与开关。
 * @param compat - 兼容性探测结果的共享状态（极简模式会让本段被丢弃）。
 * @param onCompatProbed - 探测完成后的通知（工作台投影据此刷新 `degraded`）。
 * @returns 卸载动作。
 */
export function installPersonaInjection(
  ctx: Context,
  log: Log,
  source: PersonaPromptSource,
  compat?: CompatState,
  onCompatProbed?: () => void,
): () => void {
  let disposeAll: (() => void) | undefined
  // 主/子判定与记忆注入共用同一份实现（`agent-scope.ts`）—— 尤其是「绝不把 agents
  // 声明成依赖」这条，写两遍迟早有一边会写错。
  const isMainAgent = createMainAgentJudge(ctx, log)

  // ⚠️ 依赖里**只有** systemPrompt —— 见上文事故说明，别把 agents 加回来。
  ctx.inject(['systemPrompt'], (sctx) => {
    /**
     * 首次主 Agent 装配时，用**这个 agent 的作用域**做一次兼容性探测。
     *
     * 为什么不能在这里同步探测：`assemble()` 不带 scope 只看全局层，而极简 preset 的
     * `complete` 段注册在 agent 作用域 —— 全局装配永远看不到它（见 `preset-compat.ts` 的说明）。
     * 触发点只能是"真的有 agent 在装配"的那一刻，所以放在 `text` 里。
     */
    let probing = false
    const probe = (context: unknown): void => {
      if (compat === undefined || compat.probed || probing) return
      const scope = subjectOf(context)
      if (scope === undefined) return
      probing = true
      void probeInjectionSurvived(sctx.systemPrompt, PERSONA_SECTION_NAME, compat, scope).finally(() => {
        probing = false
        onCompatProbed?.()
      })
    }

    // 用 `section`（system role）：模型对系统提示词的遵从度高于 user role 的动态上下文。
    //
    // ⚠️ 已知平台限制：极简模式（preset 里 persona section 带 `complete: true`）下，DSH 的
    // `assemble()` 会把 `sections` 替换成只剩那一个
    // （`dsh-system-prompt` 的 `assemble`：`sections: completeSection === void 0 ? transformed.sections
    // : [completeSection]`），我们的段会被整段丢掉。改走 `context()` 能绕开这条替换，
    // 但那会把注入降到 **user role**，得不偿失——**标准模式必须用 section**。
    // 因此极简模式下本插件不注入：这是 DSH 的设计取舍，不是本插件的缺陷（回归用例把它钉住）。
    const disposeSection = sctx.systemPrompt.section({
      name: PERSONA_SECTION_NAME,
      order: PERSONA_SECTION_ORDER,
      text: (context) => renderSectionText(context, { source, isMainAgent, probe, log }),
    })

    log.info('人格注入已接入系统提示词（依赖只声明 systemPrompt；主/子判定在拼装时进行）')

    disposeAll = () => {
      disposeSection()
      disposeAll = undefined
    }
    return disposeAll
  })

  return () => disposeAll?.()
}
