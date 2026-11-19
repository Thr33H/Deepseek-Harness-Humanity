/**
 * 情绪状态的存储面：把领域里的一张 KV 表包装成"读一份 / 写一份"。
 *
 * 为什么只有一行（{@link EMOTION_STATE_KEY}）：情绪是**一个人的状态**，不是会话的属性。
 * 按会话分键的实现换个会话就"不记得刚才为什么难过"，那是把情绪当成聊天窗口的皮肤。
 *
 * 为什么表句柄是结构化窄接口而不是 import storage-domain：与 `memory/store.ts` 同一条纪律 ——
 * 数据模块不该依赖某个具体后端，用到哪几个方法就声明哪几个。
 * @module humanity/emotion/store
 */
import { EMOTION_STATE_KEY, EMOTION_STATE_VERSION } from './constants.js'
import { createInitialEmotionState, EmotionStateSchema } from './model.js'
import type { EmotionState } from './types.js'

/** 领域表的窄视图（字段含义与 storage-domain 的 `KvTable` 一致）。 */
export interface EmotionTableHandle {
  /** 同步读一条；不存在返回 `undefined`。 */
  get(key: string): EmotionState | undefined
  /** 落盘写入/覆盖（整体替换，不做部分合并）。 */
  put(key: string, value: EmotionState): Promise<void>
}

/** 情绪读写入口。 */
export interface EmotionStore {
  /**
   * 读出当前状态。
   *
   * 表里没有、或形状已经读不出来时，返回**出厂状态**（平静）而不是抛错：
   * 这条路径会在每一轮沉浸对话里被调用，一份坏数据不该让对话变得无法进行。
   * @param now - 当前时刻（出厂状态要用它做 `settledAt`）。
   */
  load(now: string): EmotionState
  /** 落盘一份完整状态（不做合并：状态是一个整体，部分写回只会得到半份真相）。 */
  save(state: EmotionState): Promise<void>
}

/**
 * 造情绪存储入口。
 * @param table - 情绪表的句柄（存储就绪后由宿主喂进来）。
 */
export function createEmotionStore(table: EmotionTableHandle): EmotionStore {
  return {
    load: (now) => {
      const stored = table.get(EMOTION_STATE_KEY)
      if (stored === undefined) return createInitialEmotionState(now)
      // 表在打开/写入时已按 `domainTable` 的 schema 校验过；这里再解一次是给
      // "手改过磁盘文件"留一条兜底路径，代价是一次 safeParse。
      const parsed = EmotionStateSchema.safeParse(stored)
      if (!parsed.success) return createInitialEmotionState(now)
      // **换模型就把旧状态整体重置**，不做逐类映射。
      // 理由：情绪是短时状态（几小时内自己会衰减完），为它写一套"旧十二种 → 新八种"的
      // 映射，既不值得也很容易映错；而留着一份用旧词表的状态，会让渲染端读到不认识的种类。
      if (parsed.data.version !== EMOTION_STATE_VERSION) return createInitialEmotionState(now)
      return parsed.data
    },
    save: async (state) => {
      await table.put(EMOTION_STATE_KEY, state)
    },
  }
}
