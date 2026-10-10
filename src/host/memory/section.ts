/**
 * 记忆的设置命名空间接线（裁决 3：复用 settings RPC，不新建 gateway）。
 *
 * ### 为什么是独立命名空间 `humanity-memory`
 *
 * 与人格同理：`humanity` 是**开关**（schema 化的配置），记忆条目是**内容**（用户长期持有的数据）。
 * 混在一起会让设置文档里出现一大块内容，也让"改开关"和"改记忆"共用一份写入校验。
 *
 * ### 命名空间里放的是什么（这一句决定后面所有事）
 *
 * **不是**真源。记忆的真源是存储领域里的 `memory_entries` 表（P-027）。这个命名空间是
 * **工作台的一扇窗 + 一个命令槽**，字段的所有权严格分开：
 *
 * | 字段 | 谁写 | 用途 |
 * |---|---|---|
 * | `entries` / `policy` / `notice` | **只有宿主**（投影） | 工作台读：当前有哪些记忆、生效策略是什么、上一次操作的结果 |
 * | `request` | **只有客户端**（工作台） | 一条待执行命令（确认/拒绝/归档/恢复/固定/删除） |
 *
 * 这样就没有"两个主人"：客户端写的那一次**只带 request**（`update` 是合并补丁），宿主执行完
 * 再用投影覆盖 `entries`/`policy`/`notice` 并把 `request` 清回空。宿主**从不相信**客户端传来的
 * `entries`（那可能已经过时），客户端也**从不**自己改 `entries`。
 *
 * ⚠️ 步 1 的教训在这里同样成立：`validate` 钩子**注册时也会跑一次**，它一抛整个命名空间就注册失败、
 * 工作台永远连不上。所以这里只做最小形状检查（命令名与指纹是字符串、命令名在允许集合内），
 * 绝不检查 `entries` 的内容 —— 条目形状的校验属于存储边界（`MemoryEntrySchema`）。
 *
 * 运行期（投影 / 命令队列 / 就绪通知）在 `section-runtime.ts`。
 * @module humanity/memory/section
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'

import type { Log } from '../log.js'
import { fallbackSettings } from '../plane-settings.js'
import { supportsDynamicSections } from '../settings.js'
import { MEMORY_OPS } from './ops.js'
import { MemoryDocSchema, type MemoryDocument } from './section-doc.js'
import { createSectionRuntime, type SectionRuntime } from './section-runtime.js'
import type { MemoryStore } from './store.js'
import type { MemoryAdvancedConfig } from '../config.js'
import type { CompatState } from '../preset-compat.js'
import type { MemoryPolicy } from './types.js'

/**
 * 记忆命名空间名。它写在用户的设置文件里，因此**改名等于丢用户数据**（G-004）。
 *
 * 中间是连字符而不是驼峰：设置服务要求命名空间是小写连字符标识符（与 `humanity-persona` 同一约定）。
 */
export const MEMORY_NAMESPACE = 'humanity-memory'

/** 记忆工作台入口（由 `installMemory` 装配并驱动）。 */
export interface MemorySection {
  /**
   * 重新投影一次（把存储里的现状写进命名空间）。宿主在装配时、以及每次执行完命令后调用。
   * @returns 无（失败只记日志：投影失败不该影响对话）。
   */
  refresh(): Promise<void>
  /**
   * **存储刚就绪**时调用：补消费积压的命令，并把现状投影一次。
   *
   * 为什么必须有这个入口：存储是异步打开的，而命名空间注册通常更早完成。在存储就绪之前，
   * 命令会被跳过、投影会提前返回 —— 没有这个回调，工作台就会一直停在空列表上
   * （真机症状：存储里已有记忆，工作台的 `entries` 仍是 `[]`）。
   * @returns 无（两条动作都排进同一条串行队列）。
   */
  notifyStoreReady(): void
  /** 是否已接上设置服务；false 表示工作台此刻读不到记忆。 */
  readonly attached: boolean
}

/** 装配这个命名空间需要的外部事实。 */
export interface MemorySectionDeps {
  store(): MemoryStore | undefined
  policy(): MemoryPolicy
  /** 配置里的高级开关（工作台要显示并编辑它们）。 */
  advanced?(): MemoryAdvancedConfig
  /** preset 兼容性探测状态（极简模式会丢弃注入）。 */
  compat?(): CompatState
}

/** 接线状态：设置服务句柄与就绪标记（读、写、注册三条路径共享同一个对象）。 */
interface MemorySectionState {
  settings?: SettingsProvider
  attached: boolean
}

/**
 * 读命名空间当前值（读取路径只有这一条：注入回调里捕获的句柄）。
 *
 * 服务未接上 / 已摘除 ⇒ `undefined`。读取包 try/catch：装配路径上没有兜底，读一次抛出去
 * 会毁掉整轮 pre-step。
 * @param settings - 设置服务句柄。
 * @returns 命名空间文档；读不到时为 undefined。
 */
function readDoc(settings: SettingsProvider | undefined): MemoryDocument | undefined {
  if (settings === undefined) return undefined
  try {
    const live = settings.get(MEMORY_NAMESPACE)
    return live === undefined || live === null ? undefined : (live as MemoryDocument)
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
function attachMemorySection(
  ctx: Context,
  log: Log,
  state: MemorySectionState,
  runtime: SectionRuntime,
): void {
  ctx.inject(['settings'], (sctx) => {
    const settings: SettingsProvider = sctx.settings
    // 两条路径共用同一组钩子：契约一样（`plane-settings.ts`），只有"注册在哪"不同。
    const hooks = {
      // 读取走 `readDoc`（现取句柄），这个钩子如实签收但不使用 —— 与人格同一条约定。
      setSource: () => {},
      validate: (value: unknown) => {
        // 最小形状检查：只认命令槽。**绝不检查 entries**（旧数据的形状问题不该让命名空间注册失败）。
        const op = (value as MemoryDocument).request?.op ?? ''
        if (op !== '' && !MEMORY_OPS.includes(op as never)) {
          throw new Error(`不认识的记忆操作：${op}`)
        }
      },
      // 客户端写入（request）与宿主投影都会走到这里；队列里的 consume 自己会判断要不要动作。
      onChange: () => runtime.enqueue(),
    }

    // G-002 的升级兼容：DSH 0.1.7 起 settings 移除了动态命名空间 API。
    // 那时改挂**自有数据面**；数据面也缺席才降级为"工作台不可用"（并留下明确日志，不静默）。
    if (!supportsDynamicSections(settings)) {
      const plane = fallbackSettings()
      if (plane === undefined) {
        log.error(
          '当前的 DSH settings 服务不提供 installSection（0.1.7+ 已重构），且自有数据面缺席：' +
            '记忆工作台本次降级为不可用；对话与 Agent 工具不受影响。',
        )
        return
      }
      plane.installSection(ctx, MEMORY_NAMESPACE, MemoryDocSchema, MemoryDocSchema({}), hooks)
      state.settings = plane as unknown as SettingsProvider
      state.attached = true
      log.info('0.1.7：记忆工作台改由自有数据面承载')
      void runtime.refresh()

      return () => {
        state.settings = undefined
        state.attached = false
        log.info('数据面摘除：记忆工作台转为不可用')
      }
    }
    state.settings = settings

    settings.installSection(ctx, MEMORY_NAMESPACE, MemoryDocSchema, MemoryDocSchema({}), hooks)

    log.info('记忆命名空间已接入设置服务')
    state.attached = true
    void runtime.refresh()

    return () => {
      state.settings = undefined
      state.attached = false
      log.info('设置服务已摘除：记忆工作台回到不可用')
    }
  })
}

/**
 * 把记忆接进设置服务（工作台的读写通道）。
 *
 * 依赖只声明 `settings`（与人格同一根因同一改法：服务后挂载能补上注册、摘除时降级）。
 * @param ctx - 本插件的上下文。
 * @param log - 日志门面。
 * @param deps - 存储与策略。
 */
export function installMemorySection(ctx: Context, log: Log, deps: MemorySectionDeps): MemorySection {
  const state: MemorySectionState = { attached: false }
  const runtime = createSectionRuntime({
    settings: () => state.settings,
    read: () => readDoc(state.settings),
    store: deps.store,
    policy: deps.policy,
    advanced: deps.advanced,
    compat: deps.compat,
    namespace: MEMORY_NAMESPACE,
    log,
  })
  attachMemorySection(ctx, log, state, runtime)

  return {
    refresh: runtime.refresh,
    notifyStoreReady: runtime.notifyStoreReady,
    get attached() {
      return state.attached
    },
  }
}
