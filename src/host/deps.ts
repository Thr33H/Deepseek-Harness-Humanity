/**
 * 宿主接线用的**依赖工厂**：把各模块需要的外部事实收敛成现读闭包。
 *
 * 从 `index.ts` 拆出来的理由：接线文件回答"谁在什么时候被装配"，这里回答"装配时喂什么"。
 * 三个工厂的共同纪律：**全部现读不缓存**——开关、句柄、策略随时会变（P-030 即时生效），
 * 缓存一个装配瞬间的快照就是把过期事实闭进模块。
 *
 * 跨模块句柄（自进化读记忆/人格）都从 `state` 现读：模块间不直接 import 运行时对象
 * （P-048 模块独立），那边关了或未就绪时读到 `undefined`，对应功能自动跳过。
 * @module humanity/deps
 */
import type { HumanityConfig } from './config.js'
import type { EvolutionDeps } from './evolution/index.js'
import type { MemoryDeps } from './memory/index.js'
import type { MemoryModule } from './memory/index.js'
import type { PersonaDeps, PersonaModule } from './persona/index.js'
import type { EvolutionModule } from './evolution/index.js'
import type { CompatState } from './preset-compat.js'
import type { SettingsBridge } from './settings.js'
import type { HumanityStore } from './store-schema.js'

/** 装配期间共享的可变状态：模块句柄与存储句柄在接线完成后才存在。 */
export interface HostState {
  persona?: PersonaModule
  memory?: MemoryModule
  evolution?: EvolutionModule
  store?: HumanityStore
}

/** 人格模块的外部事实：存储句柄（历史）与配置开关。 */
export function personaDeps(settings: SettingsBridge, state: HostState): PersonaDeps {
  return {
    store: () => state.store,
    enabled: () => {
      const current = settings.read()
      return current.enabled && current.modules.persona.enabled
    },
    // 独立判断底层指令：默认开（schema 默认 true）；正文写死在代码里、工作台只露出开关。
    independentJudgment: () => settings.read().independentJudgment !== false,
    // 历史保留天数（0.1.13）：默认 30，`<=0` = 关闭清理。现读不缓存 —— 改配置后立刻生效。
    historyRetentionDays: () => settings.read().modules.persona.historyRetentionDays,
  }
}

/** 记忆模块的外部事实：模式、高级开关、兼容性状态与存储句柄。 */
export function memoryDeps(settings: SettingsBridge, state: HostState, compat: CompatState): MemoryDeps {
  return {
    mode: () => settings.read().modules.memory.mode,
    advanced: () => settings.read().modules.memory.advanced,
    compat: () => compat,
    store: () => state.store,
  }
}

/** 自进化模块的外部事实：配置全量 + 跨模块句柄（记忆写入管线、人格读写段）。 */
export function evolutionDeps(settings: SettingsBridge, state: HostState): EvolutionDeps {
  return {
    store: () => state.store,
    config: (): HumanityConfig => settings.read(),
    memoryStore: () => state.memory?.store(),
    memoryPolicy: () => state.memory?.policy(),
    personaSection: () => state.persona?.section,
  }
}
