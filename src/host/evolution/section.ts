/**
 * 自进化工作台的设置命名空间接线（`humanity-evolution`）。
 *
 * 与 `memory/section.ts` 完全同构（同一份裁决：复用 settings RPC，不新建 gateway）：
 * 命名空间是**工作台的一扇窗 + 一个命令槽**，真源在 storageDomain（G-008 易变层禁令）。
 * `runs`/`proposals`/`pendingCounts`/`status`/`notice` 只有宿主写；`request` 只有客户端写。
 *
 * ⚠️ validate 钩子**注册时也会跑一次**（2026-09-23 真机事故教训）：只做最小形状检查
 * （命令名在允许集合内），绝不校验投影内容——旧数据形状问题不该让命名空间注册失败。
 *
 * 运行期（投影 / 命令队列 / 就绪通知）在 `section-runtime.ts`。
 * @module humanity/evolution/section
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'

import type { Log } from '../log.js'
import { fallbackSettings } from '../plane-settings.js'
import { supportsDynamicSections } from '../settings.js'
import { EVOLUTION_NAMESPACE, EVOLUTION_OPS } from './constants.js'
import { EvolutionDocSchema, type EvolutionDocument } from './section-doc.js'
import { createSectionRuntime, type EvolutionSectionDeps, type SectionRuntime } from './section-runtime.js'

/** 自进化工作台入口（由 `installEvolution` 装配并驱动）。 */
export interface EvolutionSection {
  /** 重新投影一次（存储现状 → 命名空间）。失败只记日志。 */
  refresh(): Promise<void>
  /** **存储刚就绪**：补消费积压命令并重新投影（时序说明见 memory/section.ts 同款注释）。 */
  notifyStoreReady(): void
  /** 是否已接上设置服务；false 表示工作台此刻读不到自进化数据。 */
  readonly attached: boolean
}

/** 接线状态：设置服务句柄与就绪标记。 */
interface EvolutionSectionState {
  settings?: SettingsProvider
  attached: boolean
}

/** 读命名空间当前值（读取包 try/catch：装配路径没有兜底，抛出去会毁掉整轮）。 */
function readDoc(settings: SettingsProvider | undefined): EvolutionDocument | undefined {
  if (settings === undefined) return undefined
  try {
    const live = settings.get(EVOLUTION_NAMESPACE)
    return live === undefined || live === null ? undefined : (live as EvolutionDocument)
  } catch {
    return undefined
  }
}

/**
 * 把命名空间接进设置服务；服务摘除时回到"工作台不可用"。
 * @param ctx - 本插件的上下文。
 * @param log - 日志门面。
 * @param state - 接线状态（本函数负责填 `settings` / `attached`）。
 * @param runtime - 运行期（变更时排队消费 / 投影）。
 */
function attachEvolutionSection(ctx: Context, log: Log, state: EvolutionSectionState, runtime: SectionRuntime): void {
  ctx.inject(['settings'], (sctx) => {
    const settings: SettingsProvider = sctx.settings
    // 两条路径共用同一组钩子：契约一样（`plane-settings.ts`），只有"注册在哪"不同。
    const hooks = {
      setSource: () => {},
      validate: (value: unknown) => {
        // 最小形状检查：只认命令槽（与记忆同一纪律）。
        const op = (value as EvolutionDocument).request?.op ?? ''
        if (op !== '' && !EVOLUTION_OPS.includes(op as never)) {
          throw new Error(`不认识的自进化操作：${op}`)
        }
      },
      onChange: () => runtime.enqueue(),
    }

    // G-002 升级兼容：0.1.7+ 的 settings 服务没有动态命名空间 API——改挂**自有数据面**
    // （与人格/记忆同一处置）；数据面也缺席才降级，且留明确日志。
    if (!supportsDynamicSections(settings)) {
      const plane = fallbackSettings()
      if (plane === undefined) {
        log.error(
          '当前的 DSH settings 服务不提供 installSection（0.1.7+ 已重构），且自有数据面缺席：' +
            '自进化工作台本次降级为不可用；后台整理与对话提醒不受影响。',
        )
        return
      }
      plane.installSection(ctx, EVOLUTION_NAMESPACE, EvolutionDocSchema, EvolutionDocSchema({}), hooks)
      state.settings = plane as unknown as SettingsProvider
      state.attached = true
      log.info('0.1.7：自进化工作台改由自有数据面承载')
      void runtime.refresh()

      return () => {
        state.settings = undefined
        state.attached = false
        log.info('数据面摘除：自进化工作台回到不可用')
      }
    }
    state.settings = settings

    settings.installSection(ctx, EVOLUTION_NAMESPACE, EvolutionDocSchema, EvolutionDocSchema({}), hooks)

    log.info('自进化命名空间已接入设置服务')
    state.attached = true
    void runtime.refresh()

    return () => {
      state.settings = undefined
      state.attached = false
      log.info('设置服务已摘除：自进化工作台回到不可用')
    }
  })
}

/** 运行期装配所需的外部事实（形状见 section-runtime.ts）。 */
export type { EvolutionSectionDeps } from './section-runtime.js'

/**
 * 把自进化接进设置服务（工作台的读写通道）。
 * @param ctx - 本插件的上下文。
 * @param log - 日志门面。
 * @param deps - 运行期需要的外部事实（存储、动作面、状态读取）。
 */
export function installEvolutionSection(ctx: Context, log: Log, deps: EvolutionSectionDeps): EvolutionSection {
  const state: EvolutionSectionState = { attached: false }
  const runtime = createSectionRuntime({
    ...deps,
    settings: () => state.settings,
    read: () => readDoc(state.settings),
    log,
  })
  attachEvolutionSection(ctx, log, state, runtime)

  return {
    refresh: runtime.refresh,
    notifyStoreReady: runtime.notifyStoreReady,
    get attached() {
      return state.attached
    },
  }
}
