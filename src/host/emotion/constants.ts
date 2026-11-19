/**
 * 情绪的**常量**：一套有出处的情绪模型。
 *
 * ### 用的是哪一个模型
 *
 * **Plutchik 的八种基本情绪**（1980），连同它的三档强度与四对对极：
 *
 * | 轻微 | 基本 | 强烈 | 对极 |
 * |---|---|---|---|
 * | 宁静 | **喜悦** | 狂喜 | 悲伤 |
 * | 接纳 | **信任** | 钦佩 | 厌恶 |
 * | 忧虑 | **恐惧** | 惊恐 | 愤怒 |
 * | 分心 | **惊讶** | 惊愕 | 期待 |
 * | 关注 | **期待** | 警惕 | 惊讶 |
 * | 惆怅 | **悲伤** | 悲痛 | 喜悦 |
 * | 厌烦 | **厌恶** | 憎恶 | 信任 |
 * | 恼怒 | **愤怒** | 暴怒 | 恐惧 |
 *
 * 选它而不是别的（Ekman 的六种、OCC 的二十二种）的理由：
 * - Ekman 的六种没有强度分层，也没有"谁和谁对立"的结构；
 * - OCC 的二十二种是给**认知评估**用的分类（依附于"谁做的、合不合标准"），
 *   词也偏书面（reproach / gloating），落在对话里不像人话；
 * - Plutchik 同时给了**强度**（三档，正好对应我们的档位）、**对极**（对冲的依据）、
 *   **相邻组合**（合成的依据）—— 一套结构能撑起整套机制。
 *
 * 出处：Plutchik, R. (1980). *A general psychoevolutionary theory of emotion*；
 * 三档词表见 PyPlutchik 论文的复刻表（[PLoS ONE 2021, Table 1](https://pmc.ncbi.nlm.nih.gov/articles/PMC8409663/table/pone.0256503.t001/)）。
 * @module humanity/emotion/constants
 */

/**
 * 八种基本情绪，**按 Plutchik 轮上的角度排**（喜悦 0°、信任 45°… 期待 315°）。
 *
 * 顺序即工作台展示顺序（没出现过的种类按这个顺序排在最后）。
 * 键名是英文：它进存储、进模型输出、进代码分支；中文只出现在展示层。
 */
export const EMOTION_KINDS = [
  'joy',
  'trust',
  'fear',
  'surprise',
  'sadness',
  'disgust',
  'anger',
  'anticipation',
] as const

/** 情绪种类。 */
export type EmotionKind = (typeof EMOTION_KINDS)[number]

/**
 * 情绪的**对象**：这股情绪是冲谁的。
 *
 * 来自 OCC 模型的核心一问 —— *attribution*：这件事是谁造成的？
 * 少了这一层，「愤怒」是不分对象的：对你冒火、对自己懊恼、被一件事气到，
 * 三种表现完全不同，却都叫「愤怒」。加上对象之后它们才是三条独立的状态。
 *
 * 三档就够：
 * - `user`：冲着对方（"你凭什么这么说"）；
 * - `self`：冲着自己（"我怎么又搞砸了"）；
 * - `world`：冲着事情本身（"这事儿怎么这么烦"）—— 没有具体的人可以怪。
 */
export const EMOTION_TARGETS = ['user', 'self', 'world'] as const

/** 情绪的对象。 */
export type EmotionTarget = (typeof EMOTION_TARGETS)[number]

/**
 * 注入与工作台里的**对象前缀**。
 *
 * `world` 是空串：对事的情绪不必说"对这件事"，直接说"有点烦"就够自然；
 * 其余两档必须说出来，否则"恼火"和"对自己恼火"会被读成同一件事。
 */
export const EMOTION_TARGET_LABELS: Record<EmotionTarget, string> = {
  user: '对TA',
  self: '对自己',
  world: '',
}

/** 展示名（基本档的称呼，也是工作台里的名字）。 */
export const EMOTION_LABELS: Record<EmotionKind, string> = {
  joy: '喜悦',
  trust: '信任',
  fear: '恐惧',
  surprise: '惊讶',
  sadness: '悲伤',
  disgust: '厌恶',
  anger: '愤怒',
  anticipation: '期待',
}

/**
 * 每种情绪在 Plutchik 轮上的**角度**（度）。
 *
 * 八种均匀分布在圆上：对极正好相差 180°。
 * 对立的强弱直接由角度差算出（{@link oppositionBetween}），不需要手写对偶表 ——
 * 少一张手维护的表，就少一处会漏改的地方。
 */
export const EMOTION_ANGLE: Record<EmotionKind, number> = {
  joy: 0,
  trust: 45,
  fear: 90,
  surprise: 135,
  sadness: 180,
  disgust: 225,
  anger: 270,
  anticipation: 315,
}

/**
 * 每种情绪的**强度半衰期**（分钟）。
 *
 * 按"这东西该多快过去"定，不是按 Plutchik 的原始排序：
 * 惊讶最快（1 小时，一下就过去了），愤怒与恐惧次之（2 小时），
 * 信任与悲伤最慢（12–24 小时）—— 关系与失去都比情绪耐用。
 */
export const EMOTION_HALF_LIFE_MINUTES: Record<EmotionKind, number> = {
  joy: 240,
  trust: 1440,
  fear: 120,
  surprise: 60,
  sadness: 720,
  disgust: 480,
  anger: 120,
  anticipation: 360,
}

/** 强度刻度的上限（0–100）。 */
export const EMOTION_MAX = 100

/**
 * 强度低于此值就当作"没有这个情绪"。
 *
 * 不留一条 0.4 的残渣：残渣会让"现在有几种情绪"永远不等于 0，
 * 渲染端于是每轮都能读到一点东西，等于一直在提示"它有点不高兴"。
 */
export const EMOTION_FLOOR = 1

/**
 * 表达档位。
 *
 * **前三档就是 Plutchik 的三档强度**（轻微 / 基本 / 强烈），`calm` 是"没有"。
 * `at` 是进入该档的下界；判定取"强度 ≥ at 的最高一档"。
 */
export const EMOTION_TIERS = [
  { id: 'calm', at: 0 },
  { id: 'faint', at: 30 },
  { id: 'clear', at: 50 },
  { id: 'burst', at: 75 },
] as const

/** 表达档位 id。 */
export type EmotionTierId = (typeof EMOTION_TIERS)[number]['id']

/**
 * 每种情绪在四档上的**说法**：`[平静, 轻微, 基本, 强烈]`。
 *
 * 前两格与后两格都取自 Plutchik 的三档词表（`calm` 那一格是占位，不会渲染）。
 * 用原词而不是"有点愤怒/非常愤怒"这种机械组合：中文里"恼怒"和"暴怒"是真的两种说法，
 * 而"有点愤怒"谁也不这么说。词表把"档位"落到了字面上 ——
 * 模型读到"暴怒"和读到"愤怒 82%"的反应完全不同。
 */
export const EMOTION_WORDS: Record<EmotionKind, readonly [string, string, string, string]> = {
  joy: ['平静', '宁静', '喜悦', '狂喜'],
  trust: ['平静', '接纳', '信任', '钦佩'],
  fear: ['平静', '忧虑', '恐惧', '惊恐'],
  surprise: ['平静', '分心', '惊讶', '惊愕'],
  sadness: ['平静', '惆怅', '悲伤', '悲痛'],
  disgust: ['平静', '厌烦', '厌恶', '憎恶'],
  anger: ['平静', '恼怒', '愤怒', '暴怒'],
  anticipation: ['平静', '关注', '期待', '警惕'],
}

/**
 * 并存情绪的条数上限。
 *
 * 八种情绪理论上可以同时存在，但超过四条时"主导情绪"就没了，渲染出来会是一串形容词。
 * 真实的人在某一刻也不会同时强烈地感到八件事。
 */
export const MAX_CHARGES = 4

/**
 * **对冲系数**：一条情绪被对立面压掉多少。
 *
 * `有效强度 = 原强度 × (1 − 系数 × 对立度 × 压制者强度/100)`。
 * 0.6 是"能压住但不压死"：愤怒 70 时喜悦掉到六成多，愤怒退到 20 时喜悦回到九成。
 * 压制是**读时换算**，所以它永远可逆（见 `dynamics.ts`）。
 */
export const OPPOSITION_STRENGTH = 0.6

/**
 * 对立度低于它就当作同侧（不互压）。
 *
 * Plutchik 轮上相邻两种相差 45°（弧比 0.25），它们本来就该同时存在
 * （喜悦 + 信任 = 爱），所以阈值取 0.3 把相邻档排除在外；
 * 90° 及以上（弧比 0.5）才算对立。
 */
export const OPPOSITION_MIN_DISTANCE = 0.3

/**
 * **复合情绪**（Plutchik 的 dyads）：两种基本情绪同时够强时，它们合起来有一个名字。
 *
 * 三层，按两种情绪在轮上相隔几格分（[Plutchik 1980 / 2001](https://en.wikipedia.org/wiki/Emotion_classification)）：
 * - **primary**：相邻一格（45°）；
 * - **secondary**：隔两格（90°）；
 * - **tertiary**：隔三格（135°）；
 * - 隔四格（180°）正好是对极，**不可能同时存在**，所以没有它们的组合。
 *
 * 8 + 8 + 8 = 24 组，这是这套模型给的全部。
 *
 * ⚠️ **复合不存储**：它是"当前两条基本情绪同时够强"时算出来的名字。
 * 没有独立的强度、不会单独衰减、也不参与对冲 —— 它只是给那股混合的味道一个说法。
 * 所以加一条 dyad 不需要改数据，只需要改这张表。
 *
 * 中文选词以"人能听懂"为准；原文里太书面的（morbidness / fatalism）我保留了对应译法，
 * 但它们在中性对话里很少会凑出来。
 */
export const EMOTION_BLENDS: ReadonlyArray<readonly [EmotionKind, EmotionKind, string]> = [
  // ── primary：相邻一格 ──────────────────────────────────────────
  ['joy', 'trust', '爱'],
  ['trust', 'fear', '顺从'],
  ['fear', 'surprise', '敬畏'],
  ['surprise', 'sadness', '失望'],
  ['sadness', 'disgust', '悔恨'],
  ['disgust', 'anger', '轻蔑'],
  ['anger', 'anticipation', '好斗'],
  ['anticipation', 'joy', '乐观'],

  // ── secondary：隔两格（90°） ───────────────────────────────────
  ['joy', 'fear', '愧疚'],
  ['trust', 'surprise', '好奇'],
  ['fear', 'sadness', '绝望'],
  ['surprise', 'disgust', '难以置信'],
  ['sadness', 'anger', '嫉妒'],
  ['disgust', 'anticipation', '愤世嫉俗'],
  ['anger', 'joy', '傲慢'],
  ['anticipation', 'trust', '宿命'],

  // ── tertiary：隔三格（135°） ───────────────────────────────────
  ['joy', 'surprise', '愉悦'],
  ['trust', 'sadness', '感伤'],
  ['fear', 'disgust', '羞耻'],
  ['surprise', 'anger', '愤慨'],
  ['sadness', 'anticipation', '悲观'],
  ['disgust', 'joy', '病态的愉快'],
  ['anger', 'trust', '支配'],
  ['anticipation', 'fear', '焦虑'],
]

/**
 * 哪一向的**变化**算"被刺痛"：`+1` = 升高是刺痛，`-1` = 下降是刺痛，`0` = 两向都不算。
 *
 * 依据是 Plutchik 轮上的极性：正面半圈（喜悦 / 信任 / 期待）受伤的方式是"被削下去"
 * （开心被浇灭、信任被打折、盼头被掐掉），负面半圈（恐惧 / 悲伤 / 厌恶 / 愤怒）受伤的方式是
 * "被顶上来"；惊讶在正中间，两向都不带好坏（评估器提示里也是这么写的）。
 *
 * 这张表只回答"这一次变化是不是一次伤害"，不回答"这次变化有多大"（那是增量本身的绝对值）。
 * 它决定两件事：敏感化的**痕迹记在哪**、以及放大**作用在谁身上** —— 好事不记账、也不放大。
 *
 * ⚠️ 它与记忆侧的 `MOOD_TONE`（心境一致性检索用的极性表）看起来是同一件事，但含义不同
 * （那边是"这条记忆的颜色偏向哪边"，这里是"这一笔变化是不是伤害"），所以两边各自维护；
 * `test/emotion-sensitivity.test.mjs` 用一个用例钉住两边在正负划分上不许分叉。
 */
export const EMOTION_STING_DIRECTION: Record<EmotionKind, 1 | -1 | 0> = {
  joy: -1,
  trust: -1,
  fear: 1,
  surprise: 0,
  sadness: 1,
  disgust: 1,
  anger: 1,
  anticipation: -1,
}

/**
 * **敏感化**（sensitization）的四个参数。
 *
 * 要解决的问题：同一种方式被伤过五次，第六次和第一次的反应完全一样 —— 因为每条情绪
 * 各算各的，没有任何东西记得"这件事又来了"。这里给"同一个地方被反复碰到"留一道痕迹，
 * 下一次同样的伤害会更重一点。
 *
 * 为什么是这个形状（依据与取舍见 `sensitivity.ts` 的模块说明）：痕迹按
 * 「哪种情绪 + 冲谁」记，不按原因的逐字比较 —— 敏感化那一半本来就不挑具体措辞；
 * 水平是 0–1 的**饱和累积**，所以不需要额外的硬上限；按天自行消退，所以不会攒一辈子。
 *
 * - {@link SENSITIVITY_HALF_LIFE_MINUTES}：痕迹的半衰期。取一天，是为了让它落在
 *   "急性情绪（愤怒 2 小时）"与"关系温度（7 天）"之间 —— 今天的火气到明天已经退了，
 *   但"这两天老是这样"还压在那儿；隔两三天不碰就淡得差不多。
 * - {@link SENSITIVITY_STEP}：一次完整刺激把痕迹往满推多少（按剩余空间推，所以越往后越慢）。
 * - {@link SENSITIVITY_MAX_BOOST}：放大倍数的上限，即最重 1.5 倍。**这个上限是刻意的**：
 *   没有它，几十轮之后一句普通的话就能把它点炸。
 * - {@link SENSITIVITY_REFERENCE_DELTA}：多大的增量算"一次完整刺激"。取 20 是因为评估器
 *   提示词里的标尺把 15–22 定义为"明显有感"——两处用的是同一把尺子，不需要新定一套。
 *
 * 下面两个是清理阈值，不是行为参数：
 * - {@link SENSITIVITY_FLOOR}：痕迹低于它就丢掉。一道 0.02 的痕迹只值 1% 的放大，
 *   留着只会让"没有敏感"永远不成立（与 `EMOTION_FLOOR` 同一条纪律）。
 * - {@link MAX_SENSITIVITIES}：最多记几条。八种情绪 × 三个对象最多 24 条，
 *   全留着会把状态撑成一张表；超过时丢最浅的那条。
 */
export const SENSITIVITY_HALF_LIFE_MINUTES = 1440
export const SENSITIVITY_STEP = 0.3
export const SENSITIVITY_MAX_BOOST = 0.5
export const SENSITIVITY_REFERENCE_DELTA = 20
export const SENSITIVITY_FLOOR = 0.02
export const MAX_SENSITIVITIES = 6

/**
 * 精力（独立一维，不是情绪）。
 *
 * 为什么单独一维：**"累"和"不高兴"是两件事**。累的人话少、懒得展开，但不一定生气；
 * 生气的人可以精力充沛地跟你吵。把两者合成一个数，"它今天敷衍"就分不清是没心情还是没力气。
 *
 * 模型刻意做得简单：醒着每小时掉，每跨过一次本地清晨视为睡了一觉。
 * 它不知道对方真实的作息，只是"按天恢复"—— 这是有意的简化。
 */
export const ENERGY_MAX = 100
export const ENERGY_INITIAL = 80
export const ENERGY_DRAIN_PER_HOUR = 3
export const ENERGY_DAWN_RECOVERY = 60
export const ENERGY_SLEEP_HOURS = 7
export const ENERGY_DAWN_HOUR = 6

/** 低于它就"有点累"。 */
export const ENERGY_TIRED = 40

/** 低于它就"很累"（话会更短、更懒得解释）。 */
export const ENERGY_EXHAUSTED = 20

/**
 * 关系温度。
 *
 * 它**不是**人格里那个「关系」小节（那个是"我们是什么关系"，由自进化慢慢更新）；
 * 这里是"它此刻对你的感觉"，几句话就能移动。
 */
export const WARMTH_BASELINE = 50
export const WARMTH_HALF_LIFE_DAYS = 7

/** 情绪状态的结构版本（G-004）。**换模型必须升它**：旧数据自动重置，不做映射。 */
export const EMOTION_STATE_VERSION = 2

/**
 * 存储表名。属于数据契约，写进存储后改名等于旧数据找不到。
 *
 * 必须是 `^[a-z][a-z0-9_]*$`（storage-domain 的 `UNIT_NAME_RE`）。
 */
export const EMOTION_TABLE = 'emotion_state'

/** 这张表只有**一行**：情绪是"一个人"的状态，不是一次会话的属性。 */
export const EMOTION_STATE_KEY = 'current'

/**
 * 记忆回声的强度参数。
 *
 * - {@link ECHO_RATIO}：按记忆指纹强度的这个比例折算；
 * - {@link ECHO_MAX} / {@link ECHO_MIN}：单条记忆的影响上限与下限；
 * - {@link ECHO_MIN_INTENSITY}：指纹强度低于它就不再带情绪。
 *
 * 系数压得这么低是刻意的：**想起 ≠ 重新经历**。它只该在原本就有的情绪上添一笔。
 */
export const ECHO_RATIO = 0.08
export const ECHO_MAX = 6
export const ECHO_MIN = 2
export const ECHO_MIN_INTENSITY = 20

/** 一次回声最多取几条记忆（多了会把心情整个改写）。 */
export const ECHO_MAX_ENTRIES = 2

/** 工作台看到的命名空间名（与 `humanity-persona` / `humanity-memory` 同一约定）。 */
export const EMOTION_NAMESPACE = 'humanity-emotion'
