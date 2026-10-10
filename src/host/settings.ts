import type { Context } from '@deepseek-ai/cordis'
// 这个 type-only 导入不是装饰：`Context.settings` 的类型合并（declare module '@deepseek-ai/cordis'）
// 由 `@deepseek-ai/dsh-settings` 提供；不导入它，下面 `sctx.settings` 在编译期就不存在。
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'

import { Config, type HumanityConfig } from './config.js'
import type { DataPlane } from './data-plane.js'
import type { DocumentStore } from './documents.js'
import { mergeDocument } from './documents.js'
import type { Log } from './log.js'

/**
 * 设置命名空间名。
 *
 * 它同时是用户在工作台配置面里看到的分组名，因此与包名解耦：包名可以改，
 * 已经写在用户设置文件里的分节名不能改（改了就等于让老用户丢掉自己的覆盖值，违反 G-004）。
 */
export const SETTINGS_NAMESPACE = 'humanity'

/**
 * 当前 settings 服务是否还提供**动态命名空间** API（`installSection`）。
 *
 * 为什么需要探测（G-002 升级兼容）：DSH 0.1.7 重构了 settings 服务 —— 它改为从插件
 * schema 派生「可编辑字段」，`installSection` / `get` / `setSource` 全被删除。本插件的
 * 人格文档、记忆命令槽都建在 `installSection` 上，直接调用会抛 `TypeError`，而抛在
 * `ctx.inject` 回调里会连带打挂插件组合。所以先把"支持不支持"问清楚：不支持就**关掉
 * 受影响的工作台数据面、留下明确日志**，对话与 Agent 工具照常（"停插件不停 DSH"）。
 *
 * 0.1.5-rc.2 的 `installSection` 是实例方法；这里按结构读，不依赖类型面。
 * @param settings - 已就绪的设置服务。
 * @returns 提供该 API 时为 true。
 */
export function supportsDynamicSections(settings: SettingsProvider): boolean {
  return typeof (settings as { installSection?: unknown }).installSection === 'function'
}

/** 开关的读取入口。 */
export interface SettingsBridge {
  /** 当前生效配置：schema 默认 → 组合配置 → 用户覆盖。 */
  read(): HumanityConfig
  /**
   * 是否已接上 DSH 设置服务。
   * `false` 表示开关只来自组合配置，用户在工作台里改不动——工作台据此显示只读提示。
   */
  readonly attached: boolean
  /**
   * 0.1.7 路径：开关是否已挂到**自有数据面**上（同样是"可改"，但走我们自己的 endpoint）。
   * 装配方据此判断"要不要再同步一次模块"（挂载时会回调一次变更，重复同步会挂两次模块）。
   */
  readonly planeAttached: boolean
}

/**
 * 把开关接进 DSH 设置服务。
 *
 * **为什么要用 `ctx.inject(['settings'], …)` 而不是 `ctx.get('settings')`**：
 * `ctx.get` 是「此刻取一次」，只覆盖"插件加载时设置服务已经在"这一种情形。设置服务若在插件之后
 * 才挂载（或中途摘除再挂回来），`ctx.get` 版本既不会补注册命名空间、也不会回退——一次探测定终身。
 * `ctx.inject` 把服务的整个 attach / detach 生命周期交给 cordis：服务出现时回调执行、消失时执行
 * 我们返回的清理函数。DSH 官方第三方插件 `dsh-web-search-searxng` 的注释把这点写得很直白：
 * *"that injection IS the attach/detach lifecycle"*。这正是 G-002 要的「可选 seam 的正确接法」。
 *
 * `installSection` 仍是我们注册命名空间的方式：它把"服务在 / 不在"收敛到同一个入口——服务在就用
 * schema 默认 + 组合配置 + 用户覆盖，服务不在就继续用组合配置，行为与之前完全一致。
 *
 * @param ctx - 本插件的上下文（同时作为 `installSection` 的 owner fiber）。
 * @param entry - 组合配置里的入口值，作为 `base` 层，也是服务不在时的回退值。
 * @param onChange - 已提交变更的回调；**attach 时也会立刻触发一次**，调用方不必再手动同步一次。
 * @param log - 日志门面。
 */
export function installSettings(
  ctx: Context,
  entry: HumanityConfig,
  onChange: (next: HumanityConfig) => void,
  log: Log,
  plane?: DataPlane,
  documents?: () => DocumentStore | undefined,
): SettingsBridge {
  /** 当前权威配置的来源。默认指向组合入口，接上设置服务后由 `installSection` 换掉。 */
  let source: () => HumanityConfig = () => entry
  let attached = false
  let planeAttached = false

  ctx.inject(['settings'], (sctx) => {
    const settings: SettingsProvider = sctx.settings
    // 见 `supportsDynamicSections`：0.1.7+ 没有这个 API。改由**自有数据面**承载开关
    // （settings 在 0.1.7 已退化为"配置表单"，见 `plane-settings.ts` 的文件头）。
    if (!supportsDynamicSections(settings)) {
      if (plane === undefined || documents === undefined) {
        log.error(
          '当前的 DSH settings 服务不提供 installSection（0.1.7+ 已重构），且自有数据面缺席：' +
            '模块开关本次只能读组合配置、无法在工作台修改；其余功能不受影响。',
        )
        return
      }
      const off = mountPlaneSwitches(plane, documents, entry, (next) => {
        source = () => next
        attached = true
        planeAttached = true
        onChange(next)
      }, log)
      log.info('0.1.7：模块开关改由自有数据面承载（POST /api/humanity/replace|update）')

      return () => {
        source = () => entry
        attached = false
        planeAttached = false
        off()
        log.info('数据面摘除：开关回退到组合配置，工作台转为只读')
      }
    }
    settings.installSection(ctx, SETTINGS_NAMESPACE, Config, entry, {
      // attach 与 detach 都会调用它：detach 时传回来的就是上面的组合入口，天然完成回退。
      setSource: (current) => {
        source = current
        attached = true
      },
      // 开关要即时生效（P-030），所以每次提交都重新同步一遍模块，而不是等重启。
      onChange: () => onChange(source()),
    })
    log.info('设置服务已接入：开关可由用户在工作台修改')

    // 服务摘除：配置回退到组合入口，并把「可改」翻回 false，让工作台显示只读。
    return () => {
      source = () => entry
      attached = false
      log.info('设置服务已摘除：开关回退到组合配置，工作台转为只读')
    }
  })

  return {
    read: () => source(),
    get attached() {
      return attached
    },
    get planeAttached() {
      return planeAttached
    },
  }
}

/**
 * 把开关命名空间挂到自有数据面上（0.1.7 路径）。
 *
 * 语义必须与官方 settings 逐条对齐：
 * - 客户端读到的 `value` 是**已解析**的配置（schema 默认 → 组合入口 → 用户覆盖），
 *   而不是"只有用户改过的那几个字段" —— 否则工作台会把没改过的开关显示成未设置；
 * - 用户层（落盘的那份）只存**覆盖**：`update` 合并的是覆盖层，不是解析后的全量，
 *   不然一次拨动就会把组合配置里的值冻成用户值；
 * - 每次提交后回调 `onChanged`，让模块开关即时生效（P-030）。
 * @param plane - 数据面。
 * @param documents - 文档表句柄。
 * @param entry - 组合入口（base 层）。
 * @param onChanged - 每次提交后回调（拿到的是已解析配置）。
 * @param log - 日志门面。
 * @returns 摘除动作。
 */
function mountPlaneSwitches(
  plane: DataPlane,
  documents: () => DocumentStore | undefined,
  entry: HumanityConfig,
  onChanged: (next: HumanityConfig) => void,
  log: Log,
): () => void {
  const overrides = (): Record<string, unknown> => {
    const stored = documents()?.read(SETTINGS_NAMESPACE)?.value
    return typeof stored === 'object' && stored !== null && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {}
  }
  const resolved = (): HumanityConfig => Config(mergeDocument(entry, overrides()) as unknown as HumanityConfig)

  const write = async (next: unknown, expectedRevision: number | undefined): Promise<void> => {
    const store = documents()
    if (store === undefined) throw new Error('存储未就绪，模块开关本次无法写入（请稍后重试）')
    const current = store.read(SETTINGS_NAMESPACE)?.revision ?? 0
    if (expectedRevision !== undefined && expectedRevision !== current) {
      throw new Error(`${SETTINGS_NAMESPACE} 的修订号对不上（读到 ${String(expectedRevision)}，当前 ${String(current)}），请重读后再写`)
    }
    await store.write(SETTINGS_NAMESPACE, next)
    onChanged(resolved())
  }

  const off = plane.register({
    ns: SETTINGS_NAMESPACE,
    view: () => ({ value: resolved(), revision: documents()?.read(SETTINGS_NAMESPACE)?.revision ?? 0 }),
    replace: (value, expectedRevision) => write(value, expectedRevision),
    update: (patch, expectedRevision) => write(mergeDocument(overrides(), patch), expectedRevision),
  })
  // 初始同步：官方 attach 时也会立刻触发一次（调用方不必自己再同步一遍）。
  onChanged(resolved())
  log.info(`开关命名空间 ${SETTINGS_NAMESPACE} 已挂到自有数据面`)
  return off
}
