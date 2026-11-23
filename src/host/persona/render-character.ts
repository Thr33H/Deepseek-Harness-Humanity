/**
 * 把性格的四根轴翻成**一句人话**（纯函数）。
 *
 * ### 为什么给话、不给数
 *
 * 十字军之王 3 是 8 根隐藏数值轴（−100 到 +100），玩家只看得到「勇敢」「懦弱」这类词，
 * 从不显示数字。玩家的体验因此是"这个人是什么样"，而不是"这个角色的属性是多少"。
 * 模型同理：看到数字会开始演数字，看到话才会演人。
 *
 * ### 为什么只说不偏的那几根
 *
 * 一根轴此刻落在自己范围中间的三成里时**什么都不说** —— 人也有这种时候：
 * 说不上来自己是哪一种。硬要给个说法，只会让她变成一个每时每刻都有明确倾向的机器。
 * @module humanity/persona/render-character
 */
import { CHARACTER_AXES, CHARACTER_AXIS_TEXT } from './constants.js'
import type { CharacterAxisEntry, CharacterLayer } from './types.js'

/**
 * 偏向的绝对阈值：数值在 0.35 以下算低、0.65 以上算高，中间三成留给"说不准"。
 *
 * 用**绝对值**而不是"在范围里的相对位置"：笼子本身已经说明了倾向 ——
 * 一个人的开放性范围是 0.72–0.96，那她落在自己范围的正中间（0.84）时，
 * 绝对意义上依然是"看见没见过的东西就想凑近"。用相对位置会把这个结论整个丢掉。
 */
const LOW = 0.35
const HIGH = 0.65

/** 这根轴此刻偏向哪一端；落在中间返回 `undefined`（她本人也说不太准）。 */
function leanOf(axis: CharacterAxisEntry): 'low' | 'high' | undefined {
  if (!Number.isFinite(axis.value)) return undefined
  if (axis.value <= LOW) return 'low'
  if (axis.value >= HIGH) return 'high'
  return undefined
}

/**
 * 渲染性格那一行。
 * @param character - 性格层（可能不存在或形状残缺）。
 * @returns 一行文本；还没有性格、或四根都落在中间时返回空串。
 */
export function characterLine(character: CharacterLayer | undefined): string {
  if (character === undefined || character === null) return ''
  if (character.derivedAt === '' || !Array.isArray(character.axes)) return ''
  const parts: string[] = []
  for (const key of CHARACTER_AXES) {
    const axis = character.axes.find((item) => item?.key === key)
    if (axis === undefined) continue
    const lean = leanOf(axis)
    if (lean === undefined) continue
    parts.push(CHARACTER_AXIS_TEXT[key][lean])
  }
  if (parts.length === 0) return ''
  return `- 此刻的你：${parts.join('；')}。`
}
