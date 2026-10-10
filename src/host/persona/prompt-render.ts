/**
 * 人格提示词段的**渲染**（`section.text` 的实现）。
 *
 * 与 `prompt.ts`（生命周期接线）分开：那边回答"什么时候注册、探测怎么触发"，
 * 这里回答"这一轮的字面内容是什么、异常怎么收敛"。
 * @module humanity/persona/prompt-render
 */
import { subjectOf } from '../agent-scope.js'
import { warnSafely, type Log } from '../log.js'
import { neutralizePromptVars } from '../text.js'
import { renderPersonaPrompt } from './render.js'
import type { PersonaPromptSource } from './prompt.js'

/** 提示词段的运行时输入。 */
export interface PersonaSectionRuntime {
  source: PersonaPromptSource
  isMainAgent: (subject: object) => boolean
  /** 首次主 Agent 装配时触发一次作用域内兼容性探测（见 `preset-compat.ts`）。 */
  probe(context: unknown): void
  log: Log
}

/**
 * 提示词片段提供者（`section.text` 的实现）。
 *
 * ⚠️ **这里绝不能抛**：`assemble()` 调用 provider 时没有任何 try/catch
 * （`dsh-system-prompt/lib/index.js:339`），我们抛一次就毁掉这一次 pre-step，会话直接开不起来。
 * 任何异常都收敛成"这轮不注入" —— 这是唯一一处允许吞异常的地方，别把它复制到别处。
 * @param context - 装配上下文（`agent` / `scope`）。
 * @param runtime - 人格内容、判定与探测入口。
 * @returns 提示词片段；不该注入时返回空串。
 */
export function renderSectionText(context: unknown, runtime: PersonaSectionRuntime): string {
  const { source, isMainAgent, probe, log } = runtime
  try {
    // 没有装配主体（全局拼装）、或主体不是主 Agent（子代理）⇒ 不注入（裁决 2）。
    const subject = subjectOf(context)
    if (subject === undefined || !isMainAgent(subject)) return ''
    // 探测的也是**主 Agent 的作用域**：本插件的注入只针对主 Agent。
    probe(context)
    if (!source.enabled()) return ''
    // 文档还读不到（设置服务未就绪 / 根本没有设置服务）⇒ 这一轮什么都不注入。
    // 特别是**不要**注入"人格尚未初始化"的引导语：那份空文档不代表用户没初始化过。
    if (source.ready !== undefined && !source.ready()) return ''
    // 中和 `{{`：人格是用户写的自然语言，里面的模板语法会让 DSH 的变量插值抛错、毁掉整轮
    // pre-step（审计 S1-3）。内容在 `collectPersonaContent` 里已经中和过一次（那里才能算进预算），
    // 这里再走一遍是**幂等**的兜底 —— 人格段外还有固定文案，两道都比一道强，代价是一次正则。
    return neutralizePromptVars(
      renderPersonaPrompt(source.read(), {
        enabled: true,
        independentJudgment: source.independentJudgment?.() ?? true,
      }),
    )
  } catch (error) {
    // ⚠️ 这里**只能吞**：本函数在提示词装配路径上被调用，那一层没有 try/catch，
    // 抛一次就毁掉这一轮 pre-step。连"记日志"都必须再包一层（见 `warnSafely`，审计 S1-2）。
    warnSafely(log, '人格注入渲染失败：本轮不注入（不影响对话继续）', error)
    return ''
  }
}
