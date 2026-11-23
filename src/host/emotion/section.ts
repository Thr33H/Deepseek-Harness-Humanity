/**
 * 情绪工作台的**设置命名空间**：宿主把当前状态投影进去，客户端只读。
 *
 * ### 为什么是独立命名空间 `humanity-emotion`
 *
 * 与人格/记忆同一条约定：`humanity` 是**开关**（配置），这一份是**数据**（会变的量）。
 * 混在一起会让"改开关"与"看状态"共用同一份写入校验。
 *
 * ### 为什么只有宿主写
 *
 * 工作台在这里是**观察窗**，不是控制器：情绪由事件与时间推动，不由人手动拨。
 * 所以文档里没有命令槽（记忆那边的 `request`），也没有客户端写入路径 ——
 * 少一个双向通道，就少一类"两个主人"的缺陷。
 *
 * ⚠️ `validate` 钩子**注册时也会跑一次**（真机事故见 `persona/section.ts` 的说明），
 * 所以这里只做最小形状检查，绝不做业务判定。
 * @module humanity/emotion/section
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'
import Schema from '@deepseek-ai/schemastery'

import type { Log } from '../log.js'
import { fallbackSettings } from '../plane-settings.js'
import { supportsDynamicSections } from '../settings.js'
import { EMOTION_NAMESPACE, ENERGY_INITIAL, WARMTH_BASELINE } from './constants.js'
import type { EmotionView } from './view.js'

/** 命名空间里的文档（= 宿主投影出来的视图 + 一条状态提示）。 */
export interface EmotionDocument extends EmotionView {
  /** 投影失败或尚未接上时给工作台的一句说明；正常为空串。 */
  notice: string
}

/**
 * 命名空间 schema：只声明形状。
 *
 * 每个字段都有默认值，理由与 `memory/section-doc.ts` 一致：注册钩子会拿旧值跑一次校验，
 * 缺字段不该让整个命名空间注册失败（那会让工作台永远连不上）。
 */
export const EmotionDocSchema = Schema.object({
  charges: Schema.array(
    Schema.object({
      kind: Schema.string().default(''),
      label: Schema.string().default(''),
      target: Schema.string().default('world'),
      targetLabel: Schema.string().default(''),
      intensity: Schema.number().default(0),
      tier: Schema.string().default('calm'),
      cause: Schema.string().default(''),
      since: Schema.string().default(''),
      delta: Schema.number().default(0),
      before: Schema.number().default(0),
    }),
  ).default([]),
  // 被磨出来的敏感：没有时是空数组（工作台据此显示"还没有哪一处被磨到"）。
  sensitivities: Schema.array(
    Schema.object({
      kind: Schema.string().default(''),
      label: Schema.string().default(''),
      target: Schema.string().default('world'),
      targetLabel: Schema.string().default(''),
      level: Schema.number().default(0),
      cause: Schema.string().default(''),
      delta: Schema.number().default(0),
      levelBefore: Schema.number().default(0),
      at: Schema.string().default(''),
    }),
  ).default([]),
  warmth: Schema.number().default(WARMTH_BASELINE),
  warmthCause: Schema.string().default(''),
  compositeLabel: Schema.string().default(''),
  compositeParts: Schema.array(Schema.string()).default([]),
  perceived: Schema.string().default(''),
  perceivedAt: Schema.string().default(''),
  energy: Schema.number().default(ENERGY_INITIAL),
  energyLevel: Schema.string().default('fresh'),
  settledAt: Schema.string().default(''),
  updatedAt: Schema.string().default(''),
  notice: Schema.string().default(''),
})

/** 情绪工作台入口。 */
export interface EmotionSection {
  /** 把当前状态投影进命名空间（宿主在状态变化后调用）。 */
  refresh(): Promise<void>
  /** 是否已接上设置服务；false 表示工作台此刻读不到。 */
  readonly attached: boolean
  /**
   * 读**另一个**命名空间的当前值（只读）。
   *
   * 用途是取人格的「立场快照」（见 `stance.ts`）：判断对方的这句话对她意味着什么，
   * 需要知道她是谁。为什么从这里读、而不是让上层把人格传进来 —— 读人格要用**已经接上的**
   * 设置句柄，而那个句柄本来就住在这里（`state.settings`）；再加一条装配参数只是多一个会漏传的入口。
   * @param ns - 命名空间名。
   * @returns 当前值；没接上、没写过或读取抛错时 `undefined`。
   */
  read(ns: string): unknown
}

/** 命名空间接线状态：设置句柄与就绪标记（注册与投影共享同一个对象）。 */
interface SectionState {
  settings?: SettingsProvider
  attached: boolean
}

/** 读命名空间需要的两个外部事实（都现读，不把装配瞬间的快照闭进来）。 */
interface SectionDeps {
  state: SectionState
  view: () => EmotionView | undefined
  log: Log
}

/**
 * 投影一次：把当前视图覆盖进命名空间。
 *
 * 状态尚未装载 / 设置服务未接上时**什么都不写**（G-002 降级，而不是用一份空投影盖掉真数据）。
 * @param deps - 设置句柄与现读视图。
 */
async function project(deps: SectionDeps): Promise<void> {
  const { state, view, log } = deps
  const settings = state.settings
  const snapshot = view()
  if (settings === undefined || snapshot === undefined) return
  try {
    // 用 `update` 而不是 `replace`：缺的字段由 schema 默认值补，语义上是"覆盖这次投影的字段"。
    await settings.update(EMOTION_NAMESPACE, { ...snapshot, notice: '' })
  } catch (error) {
    log.warn('情绪投影写入失败（工作台可能看到旧数据）', error)
  }
}

/**
 * 把命名空间接进设置服务；服务摘除时回到"工作台不可用"。
 * @param ctx - 本插件的上下文。
 * @param deps - 接线状态与现读视图。
 */
function attachSection(ctx: Context, deps: SectionDeps): void {
  const { state, log } = deps
  ctx.inject(['settings'], (sctx) => {
    const settings: SettingsProvider = sctx.settings
    const hooks = {
      // 读取只走 `state.settings` 现取，这个钩子如实签收但不使用（与人格/记忆同一条约定）。
      setSource: () => {},
      // 这里**没有**语义规则要拦：命名空间不接受客户端写入。形状不对由 schema 管。
      validate: () => {},
      // 客户端理论上不会写这份文档；真被写了就重投影一次盖回去（唯一主人是宿主）。
      onChange: () => {
        void project(deps)
      },
    }

    // G-002 升级兼容：0.1.7 起 settings 移除了动态命名空间 API，那时改挂自有数据面。
    if (!supportsDynamicSections(settings)) {
      const plane = fallbackSettings()
      if (plane === undefined) {
        log.error(
          '当前的 DSH settings 服务不提供 installSection（0.1.7+ 已重构），且自有数据面缺席：' +
            '情绪工作台本次降级为不可用；对话与注入不受影响。',
        )
        return
      }
      plane.installSection(ctx, EMOTION_NAMESPACE, EmotionDocSchema, EmotionDocSchema({}), hooks)
      state.settings = plane as unknown as SettingsProvider
      state.attached = true
      log.info('0.1.7：情绪命名空间改由自有数据面承载')
      void project(deps)

      return () => {
        state.settings = undefined
        state.attached = false
      }
    }

    state.settings = settings
    settings.installSection(ctx, EMOTION_NAMESPACE, EmotionDocSchema, EmotionDocSchema({}), hooks)
    log.info('情绪命名空间已接入设置服务')
    state.attached = true
    void project(deps)

    return () => {
      state.settings = undefined
      state.attached = false
      log.info('设置服务已摘除：情绪工作台回到不可用')
    }
  })
}

/**
 * 把情绪接进设置服务（工作台的只读窗口）。
 * @param ctx - 本插件的上下文。
 * @param log - 日志门面。
 * @param view - 现读视图。
 * @returns 工作台入口。
 */
export function installEmotionSection(
  ctx: Context,
  log: Log,
  view: () => EmotionView | undefined,
): EmotionSection {
  const state: SectionState = { attached: false }
  const deps: SectionDeps = { state, view, log }
  attachSection(ctx, deps)
  return {
    refresh: () => project(deps),
    get attached() {
      return state.attached
    },
    read: (ns) => {
      const settings = state.settings
      if (settings === undefined) return undefined
      try {
        return settings.get(ns)
      } catch (error) {
        // 读不到人格只影响"判断得更准一点"，不该让情绪评估整条挂掉（G-002 同一条纪律）。
        log.warn(`读命名空间 ${ns} 失败：这次按通用判断（不影响对话）`, error)
        return undefined
      }
    },
  }
}
