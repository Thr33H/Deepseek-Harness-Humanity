/**
 * 记忆回声：**想起一件事**时，把当时的情绪带回来一点点。
 *
 * ### 为什么这件事值得做
 *
 * 记忆如果只是干巴巴的字符串，"想起"就没有温度——它记得你说过什么，但对那句话没有感觉。
 * 这条线让一段旧事在浮起来的时候，顺带带回一点当时的心情：不是重新经历，是"嗯，那次确实难受"。
 *
 * ### 为什么系数压得这么低
 *
 * 想起 ≠ 重新经历。同一条记忆可能一天被召回十几次，如果每次都按原强度加一遍，
 * 它的情绪会被自己的记忆反复点着，最后完全脱离眼前的对话。所以：
 * - 按指纹强度的 {@link ECHO_RATIO} 折算，并夹在 [{@link ECHO_MIN}, {@link ECHO_MAX}]；
 * - 一次最多取 {@link ECHO_MAX_ENTRIES} 条；
 * - 指纹本身太弱（< {@link ECHO_MIN_INTENSITY}）的直接忽略——一条 5 分的旧记忆带来的回声
 *   没有意义，只会让情绪在无关话题上无端浮动。
 * @module humanity/emotion/echo
 */
import {
  ECHO_MAX,
  ECHO_MAX_ENTRIES,
  ECHO_MIN,
  ECHO_MIN_INTENSITY,
  ECHO_RATIO,
  EMOTION_KINDS,
  type EmotionKind,
  type EmotionTarget,
} from './constants.js'
import type { EmotionShift } from './state.js'

/**
 * 回声的输入：一条被召回的记忆里，只有这两样用得上。
 *
 * 结构读取而不是 import `MemoryEntry`：情绪模块不该依赖记忆模块（模块互相隔离），
 * 而这条线本来就是单向的——记忆说"我想起了这些"，情绪不必知道记忆还长什么样。
 */
export interface RecallEchoSource {
  /** 正文（只用来写一句"想起…"的原因）。 */
  content: string
  /** 写下它时的情绪指纹。 */
  affect: {
    kind: string
    /** 当时冲谁（`user` / `self` / `world`）；旧条目没有，按 `world` 处理。 */
    target?: string
    intensity: number
  }
}

/** 原因句里正文的截断长度（再长会把一句提醒撑成一条新闻）。 */
const CAUSE_TEXT = 16

/**
 * 把"想起了哪几条"折算成一组情绪增减。
 * @param entries - 这一轮召回的记忆（按相关度排序）。
 * @returns 可直接施加的增减列表；没有值得回响的条目时是空数组。
 */
export function buildEcho(entries: readonly RecallEchoSource[]): EmotionShift[] {
  const shifts: EmotionShift[] = []
  for (const entry of entries.slice(0, ECHO_MAX_ENTRIES)) {
    const affect = entry?.affect
    // 平静写下的一条没有回声可言：`kind` 为空表示当时就没情绪。
    if (affect === undefined || affect.kind === '' || affect.intensity < ECHO_MIN_INTENSITY) continue
    if (!(EMOTION_KINDS as readonly string[]).includes(affect.kind)) continue
    shifts.push({
      kind: affect.kind as EmotionKind,
      // 用记忆里记下的**对象**：想起"她对我说的那句话"，要加回"对TA"那一条，
      // 不能默认落到 world（那会让 trust:user 40 旁边凭空多出一条 trust:world 5）。
      target: (affect.target as EmotionTarget | undefined) ?? 'world',
      delta: Math.min(ECHO_MAX, Math.max(ECHO_MIN, Math.round(affect.intensity * ECHO_RATIO))),
      cause: `想起「${entry.content.slice(0, CAUSE_TEXT)}」`,
      // 标记它是回声：本轮评估的原因比"想起旧事"更能解释此刻的状态（见 `EmotionShift.echo`）。
      echo: true,
    })
  }
  return shifts
}
