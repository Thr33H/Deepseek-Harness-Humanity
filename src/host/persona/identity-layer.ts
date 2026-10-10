/**
 * 身份层：把第一方身份前缀从装配结果里摘掉，让人格卡成为唯一自我认知。
 *
 * 为什么（2026-09-25 真机取证 + 用户视频反馈）：系统提示词开头同时出现
 * "You are an AI agent powered by DeepSeek Harness." / "You are a coding agent powered by …"
 * 与人格卡——两个互相矛盾的身份声明并存时，模型调和矛盾的唯一方式是把人格卡降格成
 * 「我（agent）在扮演的角色」。修分两层：
 * - 全局 `harness:identity` 与全局 persona 前缀在**配置层**关掉（见 `cordis.patch.yml` 的 system-prompt 行）；
 * - 各 preset 的 persona 前缀（`deployment:persona-prefix`）注册在 **agent 作用域**，配置够不着，
 *   在这里经 `system-prompt/assemble` waterfall 按名摘除（waterfall 返回值即权威，标准模式无 complete 段）。
 * 只摘前缀：suffix（工作目录事实）保留；带 complete 的净室 preset 由平台在 waterfall **之后**恢复
 * 唯一段，本摘除对其天然无效（净室语义不受影响）。
 * @module humanity/persona/identity-layer
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'

import type { Log } from '../log.js'
import { createMainAgentJudge, subjectOf } from '../agent-scope.js'

/**
 * 第一方身份前缀的 section 名。
 *
 * **为什么不从 `@deepseek-ai/dsh-system-prompt` import**（2026-09-26 审计 P6）：那是本仓库里
 * **唯一一处运行期** import 该包的地方，而本插件对它的依赖是**可选 seam** —— `prompt.ts` 只做
 * 类型 import 并靠结构类型 + 现读函数接缝。运行期 import 一个常量，等于把"这个包解析不到"
 * 升级成"整个插件加载失败"，换来的只是省一次字符串拷贝 —— 代价与收益完全不成比例。
 *
 * 名字本身是公开契约，出处在编译产物里逐字可查：
 * `dsh-system-prompt/lib/types/index.d.ts:157` ⇒ `export declare const PERSONA_PREFIX_SECTION = "deployment:persona-prefix"`。
 * 万一将来改名，最坏结果是"前缀没被摘掉"（人格卡照常注入，只是多一句第一方身份声明），不会崩。
 */
const PERSONA_PREFIX_SECTION = 'deployment:persona-prefix'

/**
 * 挂上身份层。
 * @param ctx - 本插件的上下文。
 * @param log - 日志门面。
 * @param enabled - Humanity 总开关：关掉时保留第一方身份（Humanity 不代管部署的身份）。
 */
export function installIdentityLayer(ctx: Context, log: Log, enabled: () => boolean): void {
  // 与注入同 scope（裁决 2）：只摘主 Agent 与无主体装配（如标题生成）的前缀；
  // 子代理保留它自己的 persona 前缀（那是子代理的行为契约，不是部署身份）。
  const isMainAgent = createMainAgentJudge(ctx, log)
  ctx.effect(
    () =>
      ctx.on(
        'system-prompt/assemble',
        async (assembly: PromptAssembly, context: unknown, next: () => Promise<PromptAssembly>): Promise<PromptAssembly> => {
          const assembled = await next()
          if (!enabled()) return assembled
          const subject = subjectOf(context)
          if (subject !== undefined && !isMainAgent(subject)) return assembled
          const sections = assembled.sections
          if (!sections.some((section) => section.name === PERSONA_PREFIX_SECTION)) return assembled
          return { ...assembled, sections: sections.filter((section) => section.name !== PERSONA_PREFIX_SECTION) }
        },
      ),
    'humanity: 身份层（摘第一方身份前缀）',
  )
  log.info('身份层已挂载（第一方身份前缀在 waterfall 里按名摘除）')
}
