/**
 * 人格文档的设置命名空间接线（裁决 3：复用 settings RPC，不新建 gateway）。
 *
 * 为什么用**独立的**命名空间 `humanity-persona` 而不是塞进 `humanity`：一个是开关（schema 化的配置），
 * 一个是内容（用户长期持有的数据）。混在一起会让设置文档里出现一大块内容、也让"改开关"与"改人格"
 * 共用一份写入校验。
 *
 * 为什么写入用 `replace` 而不是 `update`：P-017 要求可变层的修改是**重新生成完整当前快照**，
 * 而不是不断追加补丁。`update` 是深合并语义，正好与那条要求相反。
 *
 * 校验分两层，缺一不可：命名空间的 `validate` 钩子拦**浏览器直接写入**（工作台走这条路，
 * 它不经过我们的代码），`write()` 的显式校验拦**我们自己的代码**（Agent 工具）。
 * 两层判定不同是有意的（见 `validate.ts` 文件头）。
 *
 * ⚠️ **读取必须每次现取**（真机反馈：工作台改了固定层、对话里读不到）：`installSection` 的
 * `setSource` 给的是**注册那一刻**的 sink，而写入落在设置服务注册表里**当前**那一条 registration 上。
 * 两者一旦分叉（重新注册 / detach 后重挂 / 组合被再次实例化），只信 sink 就会"写进新的、读出旧的"。
 * 所以读取只走一处：注入回调里捕获的 `settings` 句柄 —— 读和写必然查同一张表。
 * @module humanity/persona/section
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'

import type { Log } from '../log.js'
import { fallbackSettings } from '../plane-settings.js'
import { supportsDynamicSections } from '../settings.js'
import type { HistorySink } from './persist.js'
import { PersonaSchema } from './model.js'
import { effectivePersona, normalizePersona } from './normalize.js'
import { validatePersona } from './validate.js'
import { PERSONA_NAMESPACE, PersonaWriteRejected, readCurrent, writePersona, type SectionState } from './document.js'
import type { PersonaDocument, ValidateOptions, WriteSource } from './types.js'

// 命名空间名与"写入被拒"的错误类型都住在 `document.ts`（读写的家）。这里转出去，
// 让调用方只认 `persona/section` 一个入口。
export { PERSONA_NAMESPACE, PersonaWriteRejected } from './document.js'

/** 人格读写入口。 */
export interface PersonaSection {
  /** 当前生效文档（已规范化）。 */
  read(): PersonaDocument
  /**
   * 写入一份完整快照。
   * @param next - 待写入的文档（会被规范化）。
   * @param source - 写入来源，决定校验强度。
   * @param options - `confirmed`：用户已在对话里确认放行的问题代码（白名单见 `constants.ts`）。
   * @throws PersonaWriteRejected 当校验出现 rejected 级问题时。
   */
  write(next: PersonaDocument, source: WriteSource, options?: ValidateOptions): Promise<void>
  /** 是否已接上设置服务；false 表示只读。 */
  readonly attached: boolean
  /**
   * 订阅「文档写入成功」（任何来源）；返回退订动作。
   * 唯一用途：初始化状态翻转后重判工具注册（封存后 init 下线），见 `tools.ts`。
   */
  onDocumentChanged(listener: () => void): () => void
}

/**
 * 把命名空间接进设置服务；服务摘除时回退到默认文档。
 *
 * 用 `ctx.inject(['settings'], …)` 而不是一次性探测，与 `settings.ts` / `store.ts` 同一根因同一改法。
 * ⚠️ `validate` 钩子**注册时也会跑一次**，它一抛整个命名空间就注册失败、客户端永远连不上
 * （2026-09-23 真机事故：旧数据缺新增的核心字段「主语言」）。所以凡属"旧数据形状问题"的，
 * 都在 `normalizePersona` 里迁移掉，不要留到这里拒。
 * @param ctx - 本插件的上下文。
 * @param log - 日志门面。
 * @param state - 接线状态（本函数负责填 `settings` / `attached`）。
 */
function attachSection(ctx: Context, log: Log, state: SectionState): void {
  ctx.inject(['settings'], (sctx) => {
    const settings: SettingsProvider = sctx.settings
    // 两条路径共用同一组钩子：契约一样（`plane-settings.ts` 的文件头逐条对齐官方语义），
    // 只有"注册在哪"不同 —— 官方 settings（0.1.5）或我们自己的数据面（0.1.7）。
    const hooks = {
      // 设置服务会把"怎么读当前值"交给我们；我们不用它（见 `readCurrent` 的说明），
      // 但这个钩子是 `installSection` 契约的一部分，仍然如实签收。
      setSource: () => {},
      // 浏览器直接写入时，schema 只判类型；语义规则必须由我们在这里拦（P-010）。
      validate: (value: unknown) => {
        const result = validatePersona(normalizePersona(value as PersonaDocument), effectivePersona(readCurrent(state)), 'user')
        if (!result.ok) throw new PersonaWriteRejected(result.issues)
      },
      onChange: () => {
        // 目前无需重判派生状态：人格是按需读取的，没有驻留内存的派生对象。
      },
    }

    // G-002 升级兼容：0.1.7+ 删除了 installSection（见 `supportsDynamicSections`）。
    // 那时改挂**自有数据面**；数据面也缺席才降级为只读默认值（并留下明确日志，不静默）。
    if (!supportsDynamicSections(settings)) {
      const plane = fallbackSettings()
      if (plane === undefined) {
        log.error(
          '当前的 DSH settings 服务不提供 installSection（0.1.7+ 已重构），且自有数据面缺席：' +
            '人格文档本次降级为只读默认值；Agent 工具与对话不受影响。',
        )
        return
      }
      plane.installSection(ctx, PERSONA_NAMESPACE, PersonaSchema, state.fallback, hooks)
      // 句柄类型与官方不同，但 section 只用到 get / replace / update（窄接口），行为一致。
      state.settings = plane as unknown as SettingsProvider
      state.attached = true
      log.info('0.1.7：人格文档改由自有数据面承载')

      return () => {
        // 句柄必须一起清掉：留着一个已摘除的服务引用会继续读一份不再被写入的值。
        state.settings = undefined
        state.attached = false
        log.info('数据面摘除：人格文档回退到默认值')
      }
    }
    // 记下这个句柄：它是"设置服务确实存在"的凭证，也是**唯一**的读取入口。
    state.settings = settings

    settings.installSection(ctx, PERSONA_NAMESPACE, PersonaSchema, state.fallback, hooks)

    log.info('人格命名空间已接入设置服务')
    state.attached = true

    return () => {
      // 句柄必须一起清掉：留着一个已摘除的服务引用会继续读一份不再被写入的值。
      state.settings = undefined
      state.attached = false
      log.info('设置服务已摘除：人格文档回退到默认值')
    }
  })
}

/**
 * 把人格文档接进设置服务。
 * @param ctx - 本插件的上下文。
 * @param log - 日志门面。
 * @param history - 历史接收方；存储未就绪时返回 undefined 即可。
 * @returns 人格读写入口。
 */
export function installPersonaSection(ctx: Context, log: Log, history: () => HistorySink | undefined): PersonaSection {
  const state: SectionState = { attached: false, fallback: PersonaSchema({}), changedListeners: new Set() }
  attachSection(ctx, log, state)

  return {
    // 生效口径（规范化 + 删空的自定义节）：见 `effectivePersona` 的说明。历史遗留的空壳
    // 在这里就被滤掉 —— 界面与提示词上"看不见"它，等于它不存在，下一次保存会把它从存储里清掉。
    read: () => effectivePersona(readCurrent(state)),
    write: (next, writeSource, options) => writePersona(state, history, next, writeSource, options),
    get attached() {
      return state.attached
    },
    onDocumentChanged: (listener) => {
      state.changedListeners?.add(listener)
      return () => {
        state.changedListeners?.delete(listener)
      }
    },
  }
}

