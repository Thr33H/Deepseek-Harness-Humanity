/**
 * 记忆数据模型的**常量**（宿主的唯一真源）。
 *
 * 这一版是按"她自己的生活账"重写的：一条记忆不是"关于用户的短句"，而是一段**经历** ——
 * 她经历了什么、当时什么感受、现在还有多牢、说出来要付多大代价。
 *
 * 与 `types.ts` 的分工：这里只放"值"，由值派生的类型也跟着放这里，免得两处各写一份。
 * 本文件**不 import 任何东西**：纯数据契约。
 * @module humanity/memory/constants
 */

/**
 * 这件事**关于谁**。
 *
 * 它取代了旧版的"三层作用域（长期/工作/会话）" —— 那个回答的是"这条记忆归谁管"（工程视角），
 * 这个回答的是"这件事本身是关于谁的经历"（她的视角）。
 *
 * 直接后果：提醒类和对话类不会再混在一起，因为它们本来就是不同主体的经历。
 */
export const MEMORY_ABOUTS = ['self', 'user', 'us', 'world'] as const

/** 关于谁。 */
export type MemoryAbout = (typeof MEMORY_ABOUTS)[number]

/**
 * 她有多确定这件事是真的。
 *
 * 为什么必须有这一维：她在没有用户在场的时候会自己看到东西，那些内容**没法向任何人核实**，
 * 而"我亲眼看见的"和"我猜的"在后续引用时权重完全不同 —— 没有这个字段，
 * 一次推断就会被后来当成事实复述。
 */
export const MEMORY_CERTAINTIES = ['witnessed', 'told', 'inferred'] as const

/** 确定度。 */
export type MemoryCertainty = (typeof MEMORY_CERTAINTIES)[number]

/**
 * 三档：她怎么忘、怎么还查得到。
 *
 * 越往上越少、越粗、活得越久 —— 这正是人记东西的方式（你能说出"我大学那几年挺压抑"，
 * 但说不出某天下午吃了什么）。
 *
 * - `episode`：一件件具体的事，`detail` 会掉、`what` 留着。
 * - `period`：同类事合并成一句（"他老是半夜找我聊工作"）。
 * - `chapter`：一段时期的概括（"十一月那阵子我们不太顺"）。
 *
 * 为什么没有"浮着的原始片段"那一档（2026-11-22 删）：**它从来不落库**。
 * 原始片段活在 `inject.ts` 的内存缓冲里，够一段就整合成 `episode`，没被整合的重启即失 ——
 * 既然没有任何一条记录会是那一档，把它留在枚举里只是让人以为它存在（连工作台都挂着一个
 * 永远不会出现的"浮着"标签）。真要落盘的那天，再加回来也不迟。
 */
export const MEMORY_TIERS = ['episode', 'period', 'chapter'] as const

/** 记忆档位。 */
export type MemoryTier = (typeof MEMORY_TIERS)[number]

/**
 * 细节（`detail`）在 `episode` 档里最多留多久（天）。
 *
 * 过了就只丢细节、留要点。这个数字直接决定她"记得多细"。
 */
export const DETAIL_LIFETIME_DAYS = 60

/**
 * 强度衰减的参数（幂律：`strength(t) = strength₀ × (1 + t / T₀)^(−d)`）。
 *
 * 为什么不是"到点减半"：实证支持的是幂律（先快后慢，且不会归零），
 * 指数衰减会在"到点"那一刻人为跳崖。见 `decay.ts` 的推导。
 */
export const STRENGTH_T0_DAYS = 3

/** 幂律指数：越大掉得越快。0.5 对应"刚发生掉得快、之后趋缓"。 */
export const STRENGTH_DECAY = 0.5

/**
 * 一次"被想起"能把强度推回多少（边际递减：`strength += η × (1 − strength)`）。
 *
 * 取小值：检索即加固，但加固太猛会形成"越常念叨越难忘"的富者愈富，
 * 把真正相关的事挤下去。
 */
export const RECALL_REINFORCE = 0.12

/**
 * 掉到这条线以下：她平时想不起来了，但可以被特定的线索唤醒。
 */
export const DORMANT_BELOW = 0.12

/**
 * 掉到这条线以下：连"想起来"都不太可能了，但记录还在（不物理删除）。
 */
export const FADED_BELOW = 0.04

/**
 * 情绪对初始强度的权重。
 *
 * 依据：情绪唤醒会调制记忆的巩固强度（McGaugh 那条线，动物因果证据、人类药理学证据）。
 * 但它是**调制**，不是开关 —— 不能"情绪一过整段消失"。
 */
export const AROUSAL_WEIGHT = 0.5

/**
 * 「这件事跟我自己有关」对初始强度的权重。
 *
 * 依据：自我参照效应是记忆心理学里最稳的效应之一（Rogers et al. 1977；Symons & Johnson 1997 元分析）。
 */
export const SELF_WEIGHT = 0.25

/** 初始强度的基础分：再平淡的事也留一点，不至于一写入就等于"没有"。 */
export const STRENGTH_BASE = 0.2

/**
 * 负性情绪的褪色比正性快（fading affect bias：事情还在，但疼劲先没）。
 *
 * Walker, Vogl & Thompson (1997), Applied Cognitive Psychology 11(5), 399–413。
 * 只作用于负性情绪的强度衰减，不改记录。
 */
export const NEGATIVE_FADE_FACTOR = 1.5

/**
 * 披露代价的默认值（0–1）：说出来有多难。
 *
 * 0 = 随口就说；1 = 打死不说。写入时初判，之后随关系与时间变。
 */
export const DEFAULT_DISCLOSURE_COST = 0.2

/**
 * 平时她愿意承受的代价上限（0–1）。
 *
 * 超过它就不主动提 —— 但仍然会想起、仍然影响心情。这是"不说 ≠ 忘了"的落点。
 * 由性格（宜人性、情绪稳定性）与当下心情共同调整。
 */
export const DISCLOSURE_THRESHOLD = 0.5

/**
 * 被窥探后的反应强度：**基准值**（性格未知时就是它）。
 *
 * 为什么是一个常数而不是"由模型当场即兴"：即兴出来的数每次都不一样，
 * 同一件事今天 30、明天 70，读起来就是随机。这个数只由性格决定一次。
 */
export const PEEK_BASE_INTENSITY = 45

/**
 * 情绪稳定性每偏离中点 0.5，反应强度增减多少（总计 ±30）。
 *
 * 取 60 是为了让"最稳的人"和"最容易崩的人"拉开距离（15 vs 75），
 * 又都不至于贴到 0/100 那两个端点上 —— 端点会让记录看起来像坏了。
 */
export const PEEK_INTENSITY_SPREAD = 60

/**
 * 宜人性低于它：更可能是"恼"而不是"怕"。
 *
 * 【判断】不是查到的结论。低宜人性的人被冒犯时更倾向于把矛头朝外（凭什么翻我东西），
 * 高宜人性的人更容易把矛头朝内（是不是我自己不好）—— 这个方向取自大五人格对宜人性的
 * 通行描述，但"怕 / 恼"的对应是我们的取舍，不是实证结论。
 */
export const PEEK_ANGER_BELOW = 0.5

/**
 * 她记下"你翻了我东西"这一笔的代价。
 *
 * 低于 `DISCLOSURE_THRESHOLD`：它是**关系的账**，她有资格直接提（"你动我东西了"），
 * 不是她藏着的事。给高了会变成"又冒出一个新秘密、又能点开"，那是个死循环。
 */
export const PEEK_ACK_COST = 0.15

/**
 * 归拢：几条同类经历才够合成一句概括。
 *
 * 取 3 而不是 2：两件事就下结论是"过拟合"，人会再等等；3 件才像"那阵子他总……"。
 */
export const PERIOD_MIN_SOURCES = 3

/**
 * 阶段：几条归拢才够合成"一段时期"。
 *
 * 同上取 3：一个月里至少有三类事，才谈得上"那阵子"的整体样子。
 */
export const CHAPTER_MIN_SOURCES = 3

/**
 * 归拢只挑"已经放了一会儿"的经历（毫秒）。
 *
 * 为什么不是立刻：刚说完的话还在这一场对话里，当场就把它压缩成概括，
 * 等于把细节从她手里抢走。放半天，等这一段过去再回头整理。
 */
export const CONSOLIDATE_MIN_AGE_MS = 12 * 60 * 60 * 1000

/**
 * 两次归拢之间至少隔多久（毫秒）。
 *
 * 一天一次：像人睡觉时整理，不是每隔几分钟就来一轮。
 * 判断依据是**库里最新一条概括的写入时刻**，不额外存状态 —— 进程重启也不会把冷却弄丢。
 */
export const CONSOLIDATE_COOLDOWN_MS = 24 * 60 * 60 * 1000

/**
 * 一次归拢最多把多少条经历交给模型。
 *
 * 上限是硬的：库大了以后一次塞几百条既贵又容易让模型乱分组；
 * 没被这次挑中的下一轮还在，不会丢。
 */
export const CONSOLIDATE_MAX_INPUT = 40


/** 每条记忆的要点长度上限（字符）。要点是一句话，不是一段话。 */
export const WHAT_CHAR_LIMIT = 240

/** 细节长度上限（字符）。细节会先丢，不需要留太长。 */
export const DETAIL_CHAR_LIMIT = 600

/**
 * 一轮对话结束后，一次整合最多产出几条记忆。
 *
 * 上限是硬的：写入端的准入是最容易失败的地方（实测有生产库 32 天攒一万条、97.8% 是垃圾）。
 */
export const MAX_INTEGRATE_PER_TURN = 3

/** 一次注入进对话的条数上限。 */
export const MAX_INJECT = 3

/**
 * 会话**第一次开口**时最多带几条。
 *
 * 比平时多：她刚"醒来"，还不知道自己是谁、对方是谁。前几条里挤不下"他叫什么"，
 * 后面整场对话就会一直把对方当陌生人（2026-11-21 真机：她说"第一次见面"，
 * 而库里明明有"小明告诉我他叫小明"那条，只是没排进前三）。
 */
export const FIRST_INJECT = 5

/**
 * 「这条在说对方是谁」的线索词（**近似**，不精确）。
 *
 * 为什么用线索词而不是加字段：加一个 `identity` 标记要改写入路径与所有旧数据；
 * 而这件事只需要**排序上的一次微调**，漏认的代价是"回到按强度排"，错认的代价也很小。
 * 宁可漏认，不要错认。
 */
export const IDENTITY_HINTS: readonly string[] = ['我叫', '他叫', '她叫', '名字', '自我介绍', '叫我', '我是']

/** 注入的字数预算：三条很长的记忆照样能吃掉上下文。 */
export const INJECT_CHAR_BUDGET = 420

/**
 * 相关度阈值：低于它宁可不注入。空着比塞错更安全。
 */
export const RELEVANCE_THRESHOLD = 0.3

/**
 * 长句子的第二条准入线：**至少接住这么多个词**，且相关度不低于
 * {@link MIN_SHARED_RELEVANCE}。
 *
 * 为什么需要它（2026-11-22 真机）：相关度的分母是"这句话切出多少词"，
 * 一句正常的长话（"我们那天在园子里散步，你还念树牌给我听"）会切成十几个词，
 * 即使接住了"园子/子里/散步/念树/树牌"五个词，比值也只有 0.28 —— 明明就是同一件事，
 * 却被 0.3 挡在门外。**话越说得具体，越容易被自己的长度稀释**，这是算法的错，不是用户的错。
 */
export const MIN_SHARED_TOKENS = 3

/** 走"接住的词够多"这条线时，相关度至少要有的值（挡住"我们/那天"这种泛词凑数）。 */
export const MIN_SHARED_RELEVANCE = 0.2

/** 记忆表名（数据契约，写进存储后改名等于旧数据找不到）。必须匹配 `^[a-z][a-z0-9_]*$`。 */
export const MEMORY_TABLE = 'memories'

/** 写入记忆的工具名（名字属于契约：排除守卫与预设都要引它）。 */
export const MEMORY_REMEMBER_TOOL = 'humanity_remember'

/** 主动回忆的工具名。 */
export const MEMORY_RECALL_TOOL = 'humanity_recall'

/**
 * 注入消息在会话里的 `source.kind`（也是判断"这个会话是不是已经给过记忆说明"的依据）。
 *
 * 名字属于契约：改它等于让历史里已有的注入认不出来，同一个会话会重新"醒来"一次。
 */
export const MEMORY_SOURCE_KIND = 'humanity-memory'

/** 条目结构版本。 */
export const MEMORY_ENTRY_VERSION = 1

/**
 * 情绪的**极性**（`+1` 正面 / `0` 中性 / `-1` 负面）。
 *
 * ⚠️ 这张表必须与 `emotion/constants.ts` 的 `EMOTION_KINDS` **逐项对应**：
 * 记忆侧不 import 情绪模块（模块互相隔离），所以这份"几十个字符的知识"是刻意复制的，
 * 由测试钉住两边一致 —— 加一种情绪却忘了这里，测试会红。
 *
 * 用途有两处：
 * - **心境一致**：心情差的时候更容易想起同向的旧事（起作用的是"同向"，不是"同名"）；
 * - **fading affect bias**：负性情绪的记忆褪色更快（坏情绪先退，好情绪留得久）。
 */
export const MOOD_TONE: Readonly<Record<string, 1 | 0 | -1>> = {
  joy: 1,
  trust: 1,
  anticipation: 1,
  // 惊讶不带好坏：它是"没想到"，本身不构成心情。
  surprise: 0,
  sadness: -1,
  disgust: -1,
  anger: -1,
  fear: -1,
}
