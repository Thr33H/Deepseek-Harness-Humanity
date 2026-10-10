/**
 * 人格模块的**唯一入口**。
 *
 * 宿主 `index.ts` 只调 `installPersona(...)` 一行；人格内部的接线（设置命名空间、Agent 工具、
 * 系统提示词注入）全在这里，加新子件时也只需要改这一个文件 —— 这是"对扩展开放、对修改关闭"的落点：
 * 扩展人格能力 = 在下面多挂一个子件 + 在返回的句柄上多暴露一项，宿主与其它模块不用动。
 *
 * 数据流（单一方向，改动前请保持）：
 * `设置命名空间` → `normalize`（无损伤整理）→ `validate`（看调用方的意图）→ `persist`（落盘 + 历史）
 * → `read`（生效口径）→ `render` → 系统提示词。每一步的输入输出都在各自模块的文件头写明。
 * @module humanity/persona
 */
import type { Context } from '@deepseek-ai/cordis'

import type { Log } from '../log.js'
import type { CompatState } from '../preset-compat.js'
import type { HumanityStore } from '../store.js'
import { createWriteSweeper, pruneHistoryByRetention } from './history-retention.js'
import { installPersonaInjection } from './prompt.js'
import { installPersonaSection, type PersonaSection } from './section.js'
import { installPersonaTools, type PersonaToolsHandle } from './tools.js'
import { installIdentityLayer } from './identity-layer.js'

/** 宿主交给人格模块的两个外部事实（依赖由宿主注入，人格内部不去猜）。 */
export interface PersonaDeps {
  /** 已就绪的存储句柄（供历史使用）；未就绪时返回 undefined。 */
  store(): HumanityStore | undefined
  /** 模块开关：配置真源在宿主，注入与工具都读它。 */
  enabled(): boolean
  /** 独立判断底层指令开关（配置真源在宿主；默认开）。 */
  independentJudgment(): boolean
  /**
   * 历史保留天数（配置真源在宿主：`modules.persona.historyRetentionDays`，默认 30）。
   * `<= 0` = 关闭清理（永久保留），语义见 `history-retention.ts`。
   */
  historyRetentionDays(): number
}

/** 人格模块的句柄：宿主用它读数据、并驱动开关。 */
export interface PersonaModule {
  /** 人格文档读写入口（工作台走设置 RPC，Agent 工具走它）。 */
  section: PersonaSection
  /** 按配置开关驱动 Agent 工具的注册与卸载。 */
  setEnabled(enabled: boolean): void
  /**
   * 立刻按保留期清理一次人格历史（启动就绪后 / 配置变更后由宿主调用）。
   * **永不抛**：清理是维护动作，失败只记日志（见 `history-retention.ts`）。
   * @returns 删除的条数。
   */
  pruneHistory(): Promise<number>
  dispose(): void
}

/**
 * 装配人格模块。
 *
 * 三个子件都挂在同一个 `ctx` 上，各自的 `ctx.inject` 决定它们何时生效（服务缺席时自动降级）。
 * @param ctx - 本插件的上下文。
 * @param log - 日志门面。
 * @param deps - 宿主提供的存储句柄与开关。
 * @param compat - preset 兼容性探测状态（极简模式会让注入被丢弃）。
 * @param onCompatProbed - 探测完成后的通知（工作台据此刷新兼容性警告条）。
 * @returns 人格模块句柄。
 */
export function installPersona(
  ctx: Context,
  log: Log,
  deps: PersonaDeps,
  compat?: CompatState,
  onCompatProbed?: () => void,
): PersonaModule {
  /**
   * 写入路径的清理调度器（0.1.13）：一次落盘会产生多条历史记录，而 sink 是同步逐条调用的 ——
   * 这个调度器让**同一批只清理一次**（`createWriteSweeper` 里有为什么这么做的说明）。
   */
  const sweepAfterWrite = createWriteSweeper(() => {
    const opened = deps.store()
    if (opened === undefined) return Promise.resolve(0)
    return pruneHistoryByRetention(opened, deps.historyRetentionDays(), new Date(), log)
  })
  /** 现清一次（启动就绪后 / 配置变更后由宿主调用）。 */
  const pruneNow = (): Promise<number> => {
    const opened = deps.store()
    if (opened === undefined) return Promise.resolve(0)
    return pruneHistoryByRetention(opened, deps.historyRetentionDays(), new Date(), log)
  }

  const section = installPersonaSection(ctx, log, () => {
    const opened = deps.store()
    return opened === undefined
      ? undefined
      : // 历史是审计用的派生数据：写失败只记日志，绝不能变成未处理的 rejection（审计 S4-1）。
        (entry) => {
          void opened
            .recordHistory(entry)
            .catch((error: unknown) => log.warn('人格历史写入失败（不影响本次保存）', error))
            // 写完之后顺带按保留期清理一次（用户 2026-10-09：历史要有限期，不能永久留）。
            // 放在这里而不是 `persistPersona`：落盘路径不该知道"清理"这件事。
            .then(sweepAfterWrite, sweepAfterWrite)
        }
  })
  const tools: PersonaToolsHandle = installPersonaTools(ctx, log, section)

  // 身份层：摘第一方身份前缀，让人格卡成为唯一自我认知（2026-09-25 真机反馈：
  // 双重身份声明把人格卡降格成「角色扮演」）。配置层那半在 cordis.patch.yml。
  installIdentityLayer(ctx, log, deps.enabled)

  // T0：把人格注入系统提示词（只主 Agent，裁决 2）。`text` 是函数 ⇒ 每轮重读；
  // `ready` 让"还没读到真文档"的那一轮连引导语都不注入（见 prompt.ts 的说明）。
  //
  // ⚠️ **F1（2026-10-04 修）**：`ready` 原先只判 `section.attached`（"命名空间接上了"），
  // **不判"存储读得到"**。存储域只要打不开（一条记录不符合 schema 就够），`state.store` 就永不赋值，
  // 于是 `read()` 回落到那份**空默认文档**、`initializedAt === ''` ⇒ 每轮注入
  // `UNINITIALIZED_PROMPT`（「人格尚未初始化…」）—— 那是一句**假声明**：用户可能早就初始化过，
  // 只是这次读不到。同一根因还会让 `humanity_recall` 整场回"存储尚未就绪"（挂起 F2 的故障可见性）。
  //
  // 修法：把「存储句柄到手」也算进就绪条件。读不到的那几轮**返回空串**（什么都不注入），
  // 而不是注入一句假话。注意 `prompt-render.ts:42-44` 本来就是为这件事写的注释
  // （"那份空文档不代表用户没初始化过"），只是当时 `ready` 没把存储算进去。
  ctx.effect(
    () =>
      installPersonaInjection(ctx, log, {
        read: () => section.read(),
        ready: () => section.attached && deps.store() !== undefined,
        enabled: deps.enabled,
        independentJudgment: deps.independentJudgment,
      }, compat, onCompatProbed),
    'humanity: 人格注入卸载',
  )

  // 卸载时先摘工具：留着一条 guard 指向已释放的人格外壳没有意义。
  ctx.effect(() => () => tools.dispose(), 'humanity: 人格工具卸载')

  return {
    section,
    setEnabled: (next) => tools.setEnabled(next),
    pruneHistory: pruneNow,
    dispose: () => tools.dispose(),
  }
}
