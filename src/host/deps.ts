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
import type { Clock } from './clock.js'
import type { EmotionDeps, EmotionModule } from './emotion/index.js'
import { dominantOf } from './emotion/state.js'
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
  emotion?: EmotionModule
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

/** 情绪模块的外部事实：存储句柄、开关与生效时区。 */
export function emotionDeps(settings: SettingsBridge, state: HostState, clock?: Clock): EmotionDeps {
  return {
    store: () => state.store,
    enabled: () => {
      const current = settings.read()
      return current.enabled && current.modules.emotion.enabled
    },
    // 时间换算显式带时区（见 `emotion/index.ts` 的说明：进程的 Date 可能不跟 TZ 变）。
    timeZone: () => clock?.report().effective,
  }
}

/** 记忆模块的外部事实：模式、高级开关、兼容性状态与存储句柄。 */
export function memoryDeps(settings: SettingsBridge, state: HostState, compat: CompatState): MemoryDeps {
  return {
    mode: () => settings.read().modules.memory.mode,
    advanced: () => settings.read().modules.memory.advanced,
    compat: () => compat,
    store: () => state.store,
    // 情绪指纹：写记忆的那一刻它在什么心情。情绪模块缺席/关掉时返回 undefined（记成平静）。
    affect: () => {
      const snapshot = state.emotion?.snapshot()
      if (snapshot === undefined) return undefined
      const dominant = dominantOf(snapshot)
      return {
        kind: dominant?.kind ?? '',
        // 对象必须一起记：回声靠它加回同一条情绪（见 `MemoryAffect.target`）。
        target: dominant?.target ?? 'world',
        intensity: dominant?.intensity ?? 0,
        warmth: snapshot.warmth,
      }
    },
    // 想起旧事时的回声：单向通知情绪模块，失败了也只影响心情。
    onRecalled: (entries) => {
      state.emotion?.echoRecalled(entries)
    },
    // 心境一致：心情差时更容易捞起同向的旧事（只影响排序，不影响准入）。
    mood: () => {
      const snapshot = state.emotion?.snapshot()
      if (snapshot === undefined) return undefined
      return { kind: dominantOf(snapshot)?.kind ?? '', warmth: snapshot.warmth }
    },
  }
}

/** 自进化模块的外部事实：配置全量 + 跨模块句柄（记忆写入管线、人格读写段）+ 时间基准。 */
export function evolutionDeps(settings: SettingsBridge, state: HostState, clock?: Clock): EvolutionDeps {
  return {
    store: () => state.store,
    config: (): HumanityConfig => settings.read(),
    memoryStore: () => state.memory?.store(),
    memoryPolicy: () => state.memory?.policy(),
    personaSection: () => state.persona?.section,
    // 时间基准的状态：工作台靠它显示"这个钟是哪个时区、从哪来的"（见 `clock.ts`）。
    clock: () => clock?.report(),
  }
}
