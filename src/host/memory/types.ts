/**
 * 记忆数据模型的**类型**（宿主侧的窄契约）。
 *
 * 一条记忆 = 一段经历。要点永不改写、细节会先丢、强度一直在掉 ——
 * 这三件事构成了"她还记得、但记得没那么清了"。
 * @module humanity/memory/types
 */
import type { MemoryAbout, MemoryCertainty, MemoryTier } from './constants.js'

/**
 * 写下这一刻她的感觉（**历史，不可改写**）。
 *
 * 为什么是历史：她当时被那句话刺到，是既成事实，不能因为三天后想通了就抹掉。
 * "现在再想起这件事是什么感觉"是**另一次计算**（由当前情绪与关系决定），不是改这条记录。
 */
export interface MemoryFeeling {
  /** 情绪种类（取值与情绪模块的 `EMOTION_KINDS` 同一套，见 `emotion/constants.ts`）。 */
  kind: string
  /** 当时有多强（0–100，与情绪模块同一个刻度）。 */
  intensity: number
}

/**
 * 她的性格里**能参与计算**的那两根轴（0–1）。
 *
 * 为什么只拿两根：记忆只需要回答"被冒犯时她有多容易被撼动、她更容易气还是更容易怕"，
 * 其余两根轴跟这件事没有关系 —— 接口窄一点，接线那边也就不会顺手把别的语义塞进来。
 *
 * 为什么不在记忆里 import 人格模块：模块之间不互相 import（见 `index.ts` 的说明），
 * 人格那边有四根轴，这里只声明自己用得上的两根，由宿主接线时投影过来。
 */
export interface MemoryCharacter {
  /** 情绪稳定性（0–1）：越低，同一件事对她的撼动越大。 */
  stability: number
  /** 宜人性（0–1）：越高越容易把冒犯接成"受伤"，越低越可能直接恼。 */
  agreeableness: number
}

/**
 * 一条记忆。
 *
 * 命名不用 `content` / `importance` 这类旧词：那些词带着"待办清单"的味道，
 * 而这条记录要能装下"我看到一段讲深海鱼的视频，有点发毛"这种事。
 */
export interface MemoryRecord {
  /** 主键（`globalThis.crypto.randomUUID()`）。 */
  id: string
  /**
   * 发生了什么，一句话。**永不改写** —— 这是她"还记得这件事"的全部凭据。
   */
  what: string
  /**
   * 当时的原话、画面、片段。**会先丢**。
   *
   * 丢的是细节，不是事情：这正是人真实的状态（记得那年冬天不好过，说不出某天吃了什么）。
   */
  detail: string
  /** 什么时候发生的（ISO 8601）。`when` 与 `createdAt` 不同：一件事可以是三天前发生的、今天才被想起。 */
  when: string
  /** 这件事关于谁。 */
  about: MemoryAbout
  /** 当时的感觉。 */
  felt: MemoryFeeling
  /** 她多确定。 */
  certain: MemoryCertainty
  /** 现在有多牢（0–1）。按幂律随时间掉，被想起时回升。 */
  strength: number
  /** 被想起过几次。 */
  recalled: number
  /** 上一次被想起的时刻（ISO 8601）。 */
  recalledAt: string
  /**
   * 说出来要付多大代价（0–1）。
   *
   * 不是"是不是敏感信息"那个布尔值：那是分类，这是**代价**。代价会变 ——
   * 关系热了降、时间久了降、气消了降。
   */
  cost: number
  /** 为什么贵（一句她自己的话）。 */
  costWhy: string
  /** 哪一档。 */
  tier: MemoryTier
  /** 写入时刻。 */
  createdAt: string
  /**
   * 这一条是从哪些条目归拢上来的（`period` / `chapter` 才有）。
   *
   * 有它才能回答"这句话是哪几件事攒出来的" —— 没有它，归拢就是一次不可追溯的压缩。
   */
  covers: string[]
  /** 条目结构版本。 */
  version: number
}

/** 写入一条记忆时，调用方一定知道的那部分。 */
export interface MemoryInput {
  what: string
  detail?: string
  when?: string
  about: MemoryAbout
  felt?: MemoryFeeling
  certain: MemoryCertainty
  cost?: number
  costWhy?: string
  tier?: MemoryTier
  covers?: string[]
  /** 显式给强度（导入/迁移用）；省略时按情绪与自我相关算。 */
  strength?: number
}

/**
 * 检索时"她此刻的心情"（心境一致：同向的旧事更容易被想起）。
 *
 * 缺席时检索行为与没有这个能力时完全相同 —— 它只是排序上的一个偏向。
 */
export interface MemoryMood {
  tone: 1 | 0 | -1
}

/** 检索命中：带分数，好让上层能解释"为什么是这条"。 */
export interface MemoryHit {
  record: MemoryRecord
  /** 综合得分（0–1）。 */
  score: number
  /** 拆开的三个来源，工作台要显示"她为什么会想起这条"。 */
  parts: { relevance: number; strength: number; mood: number }
}
