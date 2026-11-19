/**
 * 情绪**动力学**：对冲（opposition）。
 *
 * ### 它解决什么问题
 *
 * 存下来的情绪是各算各的：愤怒 70 的时候，上一轮的喜悦还停在 85 分，于是它可能
 * 一边在生气、一边在说"我挺开心的"——这不是复杂，是穿帮。真实的人在气头上，
 * 高兴是真的起不来。
 *
 * ### 为什么在**呈现层**做，而不是改存储
 *
 * 存储的是"每条情绪自己的强度"（时间与事件对它的作用）；对冲是"它们之间的相互作用"。
 * 两者混在一起写，压制就会变成**不可逆的削减**：愤怒消退之后，被压掉的喜悦回来了吗？
 * 如果不回来，每吵一次架它就少一部分高兴 —— 这不叫人，叫磨损。
 *
 * 所以这里只做**读时的一次换算**：`reconcile(charges) → 呈现用的强度`。
 * 愤怒 70 时喜悦被压到六成多，愤怒退到 20 时喜悦自己回到九成 —— 不需要任何"解压"事件。
 *
 * ### 关系怎么算的
 *
 * 用 Plutchik 轮上的**角度**：对极相差 180°（对立度 1），相邻相差 45°（对立度 0.25，
 * 低于 {@link OPPOSITION_MIN_DISTANCE} 就不互压）。不需要手写对偶表 ——
 * 那是模型自带的结构。
 * @module humanity/emotion/dynamics
 */
import {
  EMOTION_ANGLE,
  EMOTION_FLOOR,
  OPPOSITION_MIN_DISTANCE,
  OPPOSITION_STRENGTH,
  type EmotionKind,
} from './constants.js'
import type { EmotionCharge } from './types.js'

/**
 * 两种情绪之间的**对立度**（0 = 不构成对立，1 = 正好在对极）。
 *
 * 几何上先取轮上的最短弧：喜悦(0°) 与悲伤(180°) 是 180°，喜悦与愤怒(270°) 是 90°，
 * 喜悦与信任(45°) 是 45°（相邻）。
 *
 * 变换有两处工程取舍：
 * 1. **相邻不算对立**：弧比低于 `OPPOSITION_MIN_DISTANCE`（45°）直接返回 0 ——
 *    相邻的两种情绪会同时存在（喜悦 + 信任 = 爱），不该互相压。
 * 2. **90° 就算强对立**：弧比开平方。几何上 90° 只有一半，但感受上"喜悦"和"愤怒"
 *    是两种完全不同的状态，不是"一半相反"。不开方的话，愤怒 70 只能把喜悦压掉两成，
 *    那和"气头上高兴不起来"差得远。
 * @param a - 一种情绪。
 * @param b - 另一种。
 * @returns 0–1。
 */
export function oppositionBetween(a: EmotionCharge['kind'], b: EmotionCharge['kind']): number {
  if (a === b) return 0
  const left = EMOTION_ANGLE[a]
  const right = EMOTION_ANGLE[b]
  if (left === undefined || right === undefined) return 0
  const diff = Math.abs(left - right) % 360
  const ratio = (diff > 180 ? 360 - diff : diff) / 180
  if (ratio < OPPOSITION_MIN_DISTANCE) return 0
  return Math.sqrt(ratio)
}

/**
 * 被触碰的情绪里，有没有一条与给定的两条**对立**（相隔 90° 以上）。
 *
 * 用途是"复合词此刻成不成立"：喜悦 76 + 信任 52 本来是「爱」，
 * 但如果本轮刚冒出一条愤怒，那个词就一定是错的（实测现场：被说"你就一个工具"之后仍显示「爱」）。
 *
 * 给定的两条自己不算：它们本轮被改很正常（"喜悦又被夸了一次"）。
 * @param touched - 本轮动过的键（`kind:target`）。
 * @param first - 复合的第一条。
 * @param second - 复合的第二条。
 * @returns 存在对立则 `true`。
 */
export function hasFreshOpposition(
  touched: ReadonlySet<string>,
  first: EmotionKind,
  second: EmotionKind,
): boolean {
  for (const key of touched) {
    const kind = key.split(':')[0] as EmotionKind
    if (kind === first || kind === second) continue
    const distance = Math.max(oppositionBetween(kind, first), oppositionBetween(kind, second))
    // 0.7 ≈ 相隔 90°（`sqrt(0.5)`）：到了这个角度就不是"同一侧的情绪"，足以否决。
    if (distance >= 0.7) return true
  }
  return false
}

/**
 * 把一组情绪换算成**呈现用的强度**（对冲之后）。
 *
 * 规则：一条情绪只被**比它强**的对立情绪压制，且压制是可乘的、可逆的：
 * `有效 = 原值 × Π(1 − 系数 × 对立度 × 强者强度/100)`。
 *
 * 为什么按强度而不是别的：Plutchik 的模型只给强度这一个跨情绪可比的量。
 * 把"更抓注意力"之类的感觉写进来会变成我编的规则，而这套模型的好处正是"规则都有出处"。
 *
 * 为什么单向而不是互压：双向互压会得到"两边都掉一点"的平均结果，
 * 而真实情况是气头上那句高兴被压没了，愤怒本身不受影响。
 *
 * **豁免**：`protectedKeys` 里的情绪**不被压制**（但它们照样压制别人）。
 * 这是实测抓出来的缺口——信任攒到 100 之后，被骂一句只生出 28 分愤怒，又被信任压回 12，
 * 表现就是"它不生气"。真实的顺序是反的：**当下这件事压过长期积累**。
 * @param charges - 原始情绪（来自状态，含各自的强度）。
 * @param protectedKeys - 本轮刚被动过的情绪（`kind:target`），它们豁免被压制。
 * @returns 压制后的情绪（低于地板的会被滤掉），按强度降序。
 */
export function reconcile(
  charges: readonly EmotionCharge[],
  protectedKeys?: ReadonlySet<string>,
): EmotionCharge[] {
  const base = charges.map((charge) => ({ ...charge }))
  const result: EmotionCharge[] = []

  for (const charge of base) {
    // 本轮刚变过的情绪是"当前事实"，不参与被压制。
    if (protectedKeys?.has(`${charge.kind}:${charge.target}`) === true) {
      result.push({ ...charge })
      continue
    }
    let factor = 1
    for (const other of base) {
      if (other.kind === charge.kind) continue
      /**
       * **只在同一个对象内对冲**。
       *
       * 对TA恼火与对一件小事高兴可以同时成立（"我很高兴，但你气到我了"），
       * 它们不是反的；真正互斥的是冲着同一个人的两种对立情绪。
       * 不加这条限制，气头上的好心情会把"对事的快乐"一起吃掉，那就成了无差别压平。
       */
      if (other.target !== charge.target) continue
      // 只允许更强的压更弱的；同强度不互压（避免对称抵消成两个零）。
      if (other.intensity <= charge.intensity) continue
      const distance = oppositionBetween(other.kind, charge.kind)
      if (distance < OPPOSITION_MIN_DISTANCE) continue
      factor *= 1 - OPPOSITION_STRENGTH * distance * (other.intensity / 100)
    }
    const intensity = charge.intensity * Math.max(0, factor)
    if (intensity < EMOTION_FLOOR) continue
    result.push({ ...charge, intensity })
  }
  return result.sort((a, b) => b.intensity - a.intensity)
}
