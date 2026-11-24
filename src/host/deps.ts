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
import type { DocumentStore } from './documents.js'
import type { EmotionDeps, EmotionModule } from './emotion/index.js'
import { EMOTION_LABELS, type EmotionKind } from './emotion/constants.js'
import { dominantOf } from './emotion/state.js'
import type { EvolutionDeps, EvolutionModule } from './evolution/index.js'
import type { MemoryDeps } from './memory/index.js'
import type { MemoryAbout } from './memory/constants.js'
import type { MemoryModule } from './memory/index.js'
import { MOOD_TONE } from './memory/constants.js'
import type { PersonaDeps, PersonaModule } from './persona/index.js'
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

/**
 * humanity 是否已经**正式启动**：人格封存的那一刻才算。
 *
 * ### 为什么情绪/记忆/自进化要等这一刻（用户 2026-11-22 定）
 *
 * 第一次见面时她还没有人格（底色没写、没封存），那时候的"情绪"是凭空生成的——
 * 她还不知道自己是谁，凭什么对一句话有感受？同样的道理，记忆记下的"经历"、自进化整理出的
 * "她像谁"，在人格定下来之前都建立在流沙上。所以：**人格封存之前，其他模块一律休眠。**
 *
 * ### 三条实现纪律
 *
 * 1. **每次现读，不缓存**（存储比配置晚就绪的坑踩过三次：那时读到的是默认文档、`sealedAt` 为空，
 *    把它当成"没封存"缓存下来，封存后也醒不过来了）；
 * 2. 存储没就绪、人格模块没装、文档形状残缺 —— 一律当作"没封存"（休眠是安全的那一侧）；
 * 3. 人格模块自己**不受这条限制**：它正是负责把人设下来的那个。
 * @param state - 宿主状态（`persona` 可能还没装上）。
 * @returns 已封存为 `true`。
 */
export function humanityStarted(state: HostState): boolean {
  const sealedAt = state.persona?.section.read()?.identityCard?.sealedAt ?? ''
  return typeof sealedAt === 'string' && sealedAt.trim() !== ''
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
export function emotionDeps(
  settings: SettingsBridge,
  state: HostState,
  clock?: Clock,
  onApplied?: EmotionDeps['onApplied'],
): EmotionDeps {
  return {
    store: () => state.store,
    enabled: () => {
      const current = settings.read()
      // 人格没封存 = 还没正式启动：不评估、不注入（见 `humanityStarted`）。
      return current.enabled && current.modules.emotion.enabled && humanityStarted(state)
    },
    // 时间换算显式带时区（见 `emotion/index.ts` 的说明：进程的 Date 可能不跟 TZ 变）。
    timeZone: () => clock?.report().effective,
    // 精力：自进化模块是唯一真源（按 token 消耗、按睡眠曲线恢复）。
    // 它没装/没就绪时返回 undefined，情绪那边退回自己的旧算法（清晨 +60 那套）。
    energy: () => state.evolution?.energyNow(),
    // 每轮情绪落地后通知宿主：性格轴靠它被动漂移（见 `persona/drift.ts`）。
    onApplied,
  }
}

/** 记忆模块的外部事实：存储句柄、开关、写这一刻的情绪指纹、此刻的心情。 */
export function memoryDeps(settings: SettingsBridge, state: HostState, clock?: Clock): MemoryDeps {
  return {
    store: () => state.store,
    // 人格没封存 = 还没正式启动：不记录、不检索、工具也不给她（见 `humanityStarted`）。
    enabled: () => settings.read().modules.memory.enabled && humanityStarted(state),
    // 工作台要凭它说"还没开始"（而不是"没有记忆"）。
    dormant: () => !humanityStarted(state),
    maxInject: () => settings.read().modules.memory.maxInject,
    // 生效时区：她回忆时说"昨天/今天"按这个时区的日历算（半夜聊天时毫秒差会把昨晚算成今天）。
    timeZone: () => clock?.report().effective,
    // 情绪指纹：写记忆的那一刻它在什么心情。情绪模块缺席/关掉时返回 undefined（记成平静）。
    feeling: () => {
      const snapshot = state.emotion?.snapshot()
      if (snapshot === undefined) return undefined
      const dominant = dominantOf(snapshot)
      if (dominant === undefined) return undefined
      return { kind: dominant.kind, intensity: dominant.intensity }
    },
    // 想起旧事时的回声：单向通知情绪模块，失败了也只影响心情。
    onRecalled: (records) => {
      state.emotion?.echoRecalled(
        records.map((record) => ({
          content: record.what,
          affect: {
            kind: record.felt.kind,
            target: record.about === 'user' ? 'user' : record.about === 'self' ? 'self' : 'world',
            intensity: record.felt.intensity,
            warmth: 0,
          },
        })),
      )
    },
    // 心境一致：心情差时更容易捞起同向的旧事（只影响排序，不影响准入）。
    mood: () => {
      const snapshot = state.emotion?.snapshot()
      if (snapshot === undefined) return undefined
      const kind = dominantOf(snapshot)?.kind ?? ''
      return { tone: MOOD_TONE[kind] ?? 0 }
    },
    // 对方叫什么：被窥探之后她记的那一笔要用名字（记忆里出现"他/对方"会在多人时串）。
    userName: () => {
      const doc = state.persona?.section.read()
      const target = doc?.mutableLayer?.sections?.find((section) => section.title === '对TA的称呼')
      return target?.items?.[0]?.trim() ?? ''
    },
    // 她的性格：被窥探之后的反应强度由这两根轴定（见 `memory/reaction.ts`）。
    // 人格模块没开、或性格还没初始化时返回 undefined —— 记忆侧退回基准反应，
    // **不是**替她假设一个性子（那等于悄悄改了她的底色）。
    character: () => {
      const axes = state.persona?.section.read()?.character?.axes ?? []
      const valueOf = (key: string): number | undefined => axes.find((axis) => axis.key === key)?.value
      const stability = valueOf('stability')
      const agreeableness = valueOf('agreeableness')
      if (stability === undefined || agreeableness === undefined) return undefined
      return { stability, agreeableness }
    },
    // 情绪种类 → 人话：借情绪模块那张表，记忆**不自己维护第二份**（两份词表早晚会分叉）。
    feltLabel: (kind) => EMOTION_LABELS[kind as EmotionKind] ?? kind,
  }
}

/**
 * 自进化模块的外部事实：她的状态文档、开关、醒来的节奏参数、生效时区。
 *
 * 全部现读：节奏参数改了要立刻影响"下一次排在哪"，缓存一份旧值会让改动看起来没生效。
 * @param settings - 设置桥。
 * @param state - 宿主状态（要现读存储句柄：存储比配置晚就绪）。
 * @param clock - 时间基准（"今天"按它的时区算）。
 */
export function evolutionDeps(
  settings: SettingsBridge,
  state: HostState,
  clock?: Clock,
  homeDir?: () => string | undefined,
): EvolutionDeps {
  return {
    documents: (): DocumentStore | undefined => state.store?.documents,
    enabled: () => {
      const current = settings.read()
      // 人格没封存 = 还没正式启动：她不该有"自己的一天"（见 `humanityStarted`）。
      return current.enabled && current.modules.evolution.enabled && humanityStarted(state)
    },
    wake: () => {
      const current = settings.read().modules.evolution
      return {
        maxPerDay: current.maxWakesPerDay,
        minGapMinutes: current.minGapMinutes,
        maxGapMinutes: current.maxGapMinutes,
      }
    },
    timeZone: () => clock?.report().effective,
    homeDir: () => homeDir?.(),
    // 她自己的见闻交给情绪模块评估（只产出"对事/对自己"的情绪）。
    appraiseOwn: async (text) => {
      await state.emotion?.appraiseOwn(text)
    },
    // 睡前收账记下的事，走记忆模块自己的写入路径（去重、视角归一化）。
    remember: async (what, about) => {
      await state.memory?.remember({ what, about: about as MemoryAbout })
    },
  }
}
