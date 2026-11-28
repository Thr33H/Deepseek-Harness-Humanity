/**
 * Humanity 自己的 agent 预设。封存前只有一个（极简），封存后有两个（沉浸 / 功能）。
 *
 * ### 为什么用代码注册，而不是写进 `cordis.patch.yml`
 * 预设要随"人格是否已封存"出现：封存前只该有 `humanity`（极简内容），封存后才该出现
 * `humanity-functional`。YAML 补丁是静态的；注册表提供 `register → unregister`，
 * 于是这件事是纯内存动作，不动任何配置文件。
 *
 * ### 为什么 `humanity` 的 id 不变、只换内容
 * `agent-preset-registry` 只允许**首轮之前**换预设（`select()` 在会话开过一轮后抛
 * `agent-preset/locked`）。而"第一次见面"这件事本身就发生在对话里 —— 所以正在进行的那个
 * 会话**永远**留在它开始时的清单上，这恰好是我们想要的：见面那次只需要读文件与搜索。
 * 新会话会绑定到新内容：旧 generation 只要还有会话用着就不会被回收（`users > 0`），
 * 所以换内容不会打断任何人。
 *
 * ### 两个预设的分工（用户 2026-11-14 定）
 * - **Humanity 沉浸**：能读能搜，封存后再加写文件 / 时间 / 定时提醒。工具清单锁死。
 * - **Humanity 功能**：带着人设去干活 —— 命令、代码、技能、Office、子代理之外的工作类工具全开。
 *   它只在**封存之后**注册：没有身份之前不该能干活。
 *
 * ### 插件清单从哪来
 * 包名与配置**逐个核对自** DSH 0.2.2-rc.3 的实际合成配置（`dsh --profile web --dump-config`），
 * 不是照文档猜的。`compaction` 那一行是 loader 的 group（`name: cordis:group`），
 * 子项放在 `config` 数组里，与官方写法逐字一致。
 * @module humanity/presets
 */
import type { Context } from '@deepseek-ai/cordis'

import { describeError, reportBootFailure, type Log } from './log.js'

/** 沉浸式预设的 id（静态默认值也指向它）。 */
export const HUMANITY_PRESET_ID = 'humanity'

/** 功能预设的 id（封存后才注册）。 */
export const HUMANITY_FUNCTIONAL_ID = 'humanity-functional'

/** 工作台里显示的名字。 */
export const HUMANITY_PRESET_NAME = 'Humanity 沉浸'
export const HUMANITY_FUNCTIONAL_NAME = 'Humanity 功能'

/**
 * 工具闸的教训（2026-11-14，真机）：**闸不能装在预设作用域**。
 *
 * `dsh-tools` 的可见性是"自己的注册不受限、继承来的受限"；对**会话**来说，预设里的工具
 * 正是"继承来的"，于是在预设层放一个 allow 白名单会把 `web_search` / `read` 一起遮掉
 * （症状：模型看得见工具、调用时报 `unknown tool "web_search"`）。
 * 正确位置是**会话作用域**（`agent.ctx.tools.restrict`，dsh-subagent 就是这么用的），
 * 而且白名单必须把预设里的工具名也列全。这一版先不装闸：预设本身已经限定了插件清单，
 * 真正要防的是"以后装的宿主平面插件把工具塞进来"，那需要单独一版正确的实现。
 */

/** loader 的插件条目（与 `cordis.patch.yml` 的方言一一对应）。 */
interface Entry {
  id: string
  name: string
  config?: unknown
  group?: true
  isolate?: Record<string, boolean>
}

/** 上下文压缩组：没有它，长对话会在上下文窗口里硬撞（与官方 standard 同构）。 */
const COMPACTION_GROUP: Entry = {
  id: 'compaction',
  name: 'cordis:group',
  group: true,
  isolate: { compaction: true, toolResultPruner: true },
  config: [
    { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
    { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
    {
      id: 'tool-result-pruner',
      name: '@deepseek-ai/dsh-compaction-tool-result-pruner',
      config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
    },
  ],
}

/** 两套清单共用的取内容部分。 */
function contentOnly(readOnly: boolean): Entry[] {
  return [
    // 前缀交给 humanity 的身份层处理；这里显式置空，避免 preset 自带那句"coding agent"。
    // 后缀也要清空：它的默认内容是"工作目录事实"（模板里用了 {{cwd}}），而这个 DSH 版本的提示词装配
    // 只注册 provider/model —— 留着它每一轮都会报 unknown prompt variable，整轮失败（真机 2026-11-26）。
    { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: '' } },
    {
      id: 'tool-fs',
      name: '@deepseek-ai/dsh-tool-fs',
      config: readOnly ? { write: false, edit: false, applyPatch: false } : {},
    },
    { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
    { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true } },
    // 不用 tool-ask-user（2026-11-15 用户裁定）：「弹出一个提问框」会把对话切成办手续，
    // 破坏沉浸感。要问就直接在话里问。
  ]
}

/** 未封存：只能取内容，别的什么也做不了。 */
export function minimalPlugins(): Entry[] {
  return [...contentOnly(true), COMPACTION_GROUP]
}

/** 已封存：在取内容之上打开"写"、时间与定时提醒。 */
export function immersivePlugins(): Entry[] {
  return [
    ...contentOnly(false),
    { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
    { id: 'tool-schedule', name: '@deepseek-ai/dsh-tool-schedule' },
    { id: 'present', name: '@deepseek-ai/dsh-tool-present' },
    COMPACTION_GROUP,
  ]
}

/**
 * 功能预设：带着人设去干活。
 *
 * 与沉浸式的差别只在"多出来的工作类工具"：命令、后台任务、目标、待办、技能、Office、
 * 插件开发（tool-cordis）。**不含**子代理/工作流/计划模式 —— 那些是多人协作与项目管理的语言，
 * 与"陪伴"相冲；需要时再单独加。
 */
export function functionalPlugins(): Entry[] {
  return [
    { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: '' } },
    { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
    { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
    { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash' },
    { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs', config: { applyPatch: false } },
    { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
    { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },
    { id: 'tool-schedule', name: '@deepseek-ai/dsh-tool-schedule' },
    { id: 'command-goal', name: '@deepseek-ai/dsh-command-goal' },
    { id: 'tool-goal', name: '@deepseek-ai/dsh-tool-goal' },
    { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
    { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
    { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true } },
    { id: 'tool-cordis', name: '@deepseek-ai/dsh-tool-cordis' },
    { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
    { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
    { id: 'tool-office', name: '@deepseek-ai/dsh-tool-office' },
    { id: 'present', name: '@deepseek-ai/dsh-tool-present' },
    COMPACTION_GROUP,
  ]
}

/** 注册表服务的窄面（只声明我们用到的两个方法，不固化官方类型面）。 */
interface PresetRegistry {
  register(definition: {
    id: string
    name?: string
    description?: string
    order?: number
    plugins: readonly unknown[]
  }): Promise<() => Promise<void>>
}

/** 预设模块句柄。 */
export interface PresetHandle {
  /** 按当前封存状态对齐一次（幂等；同一状态重复调用不重复注册）。 */
  sync(): void
  dispose(): void
}

/** 当前注册的是哪一套（`undefined` = 没注册上）。 */
type Mode = 'minimal' | 'immersive'

/**
 * 装配预设切换。
 * @param ctx - 宿主上下文。
 * @param log - 日志门面。
 * @param sealed - 人格是否已封存（现读，不缓存）。
 * @returns 句柄；注册表缺席时是空实现（插件其余功能照常）。
 */
export function installPresets(ctx: Context, log: Log, sealed: () => boolean): PresetHandle {
  /**
   * ⚠️ **必须走 `ctx.inject` 等它就绪**（2026-11-14 真机实测）：
   * `agentPresets` 是 `TypertRemoteService`，它在自己的 `[Service.init]` 里才对外可用；
   * humanity 的 `apply()` 跑得更早，此时 `ctx.get('agentPresets')` 拿到的是 `undefined` ——
   * 症状就是"设置页的自定义里根本没有 humanity 预设"，而且没有任何可见报错。
   * `ctx.inject` 是**软**依赖：服务一直不来就只是这段能力不生效，不会让插件停在 waiting。
   */
  let handle: PresetHandle | undefined

  // 注入回调的返回值是"服务消失时"的清理动作；插件整体卸载由调用方的 ctx.effect 负责。
  ctx.inject(['agentPresets'], (sctx) => {
    const registry = (sctx as unknown as { agentPresets?: PresetRegistry }).agentPresets
    if (registry === undefined || typeof registry.register !== 'function') {
      reportBootFailure(
        log,
        'humanity 预设未注册：agentPresets 已就绪但缺 register 方法（接口变了？）',
        new Error('agentPresets.register unavailable'),
      )
      return
    }
    handle = createSwitcher(log, registry, sealed)
    return () => handle?.dispose()
  })

  return {
    sync: () => handle?.sync(),
    dispose: () => {
      handle?.dispose()
      handle = undefined
    },
  }
}

/**
 * 真正干活的那一半：拿到注册表之后才创建。
 * @param log - 日志门面。
 * @param registry - 已就绪的预设注册表。
 * @param sealed - 人格是否已封存（现读）。
 */
function createSwitcher(log: Log, registry: PresetRegistry, sealed: () => boolean): PresetHandle {
  let content: Mode | undefined
  let functional = false
  let unregisterMain: (() => Promise<void>) | undefined
  let unregisterFunctional: (() => Promise<void>) | undefined
  let disposed = false
  let queue: Promise<void> = Promise.resolve()

  /** 注册（或换内容）`humanity` 这一个预设。 */
  const applyMain = async (mode: Mode): Promise<void> => {
    // 先注销旧的：同一 id 重复注册会被注册表直接拒绝（Duplicate agent preset）。
    if (unregisterMain !== undefined) {
      const stop = unregisterMain
      unregisterMain = undefined
      await stop()
    }
    if (disposed) return
    unregisterMain = await registry.register({
      id: HUMANITY_PRESET_ID,
      name: HUMANITY_PRESET_NAME,
      description:
        mode === 'minimal'
          ? '第一次见面：只能读文件、搜索与提问。给出名字与性格之前，做不了别的事。'
          : '沉浸式陪伴：能读能写、能联网、能定时提醒。',
      order: 0,
      plugins: mode === 'minimal' ? minimalPlugins() : immersivePlugins(),
    })
    content = mode
    log.info(`预设已注册：${HUMANITY_PRESET_NAME}（${mode === 'minimal' ? '极简' : '沉浸'}）`)
  }

  /** 封存后才有功能预设：没有身份之前不该能干活。 */
  const applyFunctional = async (present: boolean): Promise<void> => {
    if (present === functional) return
    if (!present) {
      const stop = unregisterFunctional
      unregisterFunctional = undefined
      functional = false
      await stop?.()
      log.info(`预设已注销：${HUMANITY_FUNCTIONAL_NAME}（人格未封存）`)
      return
    }
    if (disposed) return
    unregisterFunctional = await registry.register({
      id: HUMANITY_FUNCTIONAL_ID,
      name: HUMANITY_FUNCTIONAL_NAME,
      description: '带着人设去干活：命令、代码、技能、Office、插件开发。工具全开。',
      order: 1,
      plugins: functionalPlugins(),
    })
    functional = true
    log.info(`预设已注册：${HUMANITY_FUNCTIONAL_NAME}`)
  }

  const applyState = async (wantSealed: boolean): Promise<void> => {
    const want: Mode = wantSealed ? 'immersive' : 'minimal'
    if (want !== content) await applyMain(want)
    await applyFunctional(wantSealed)
  }

  const sync = (): void => {
    if (disposed) return
    const wantSealed = sealed()
    // ⚠️ 必须显式比"想要的内容形态"，不能拿 `content === 'immersive'` 当代理：
    // 首次启动时 `content` 还是 undefined，那样写会判成"已经是未封存态"而直接返回,
    // 结果一个预设都不注册（2026-11-14 真机：列表里只剩内置四套，且没有任何报错）。
    const want: Mode = wantSealed ? 'immersive' : 'minimal'
    if (want === content && wantSealed === functional) return
    queue = queue
      .then(() => applyState(wantSealed))
      .catch((error: unknown) =>
        reportBootFailure(log, `预设切换失败（保持上一套清单）：${describeError(error)}`, error),
      )
  }

  // 注册是异步的：先排进队列，避免与首次同步竞争。
  sync()

  return {
    sync,
    dispose: () => {
      disposed = true
      const stops = [unregisterMain, unregisterFunctional]
      unregisterMain = undefined
      unregisterFunctional = undefined
      for (const stop of stops) if (stop !== undefined) void stop().catch(() => {})
    },
  }
}
