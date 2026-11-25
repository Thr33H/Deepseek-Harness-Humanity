/**
 * 把性格的四根轴翻成**一句人话**（纯函数）。
 *
 * ### 为什么给话、不给数
 *
 * 十字军之王 3 是 8 根隐藏数值轴（−100 到 +100），玩家只看得到「勇敢」「懦弱」这类词，
 * 从不显示数字。玩家的体验因此是"这个人是什么样"，而不是"这个角色的属性是多少"。
 * 模型同理：看到数字会开始演数字，看到话才会演人。
 *
 * ### 2026-11-25 改了什么（用户："性格也要更细腻"）
 *
 * 旧写法只有两档，而且"落在自己范围中间三成"时**整根不说话**。真机上她的宜人性是 0.375，
 * 正好落在沉默区 —— 于是"护着自己、只对认下的人松口"这条根本不在她读到的自己里；
 * 她读到的是"很稳、话多、爱凑近"，与她本人几乎相反。同一时刻的稳定性 0.665 和 0.95，
 * 也会被说成同一句"很稳，事过就过"。
 *
 * 现在：**五档**（很低 / 低 / 中间 / 高 / 很高），**四根一律都给**。中间档说的是
 * "两头顶着、看人看时候"，那本身就是一句人话，不是没有倾向。
 * @module humanity/persona/render-character
 */
import { CHARACTER_AXES, CHARACTER_AXIS_TEXT } from './constants.js'
import type { CharacterAxisEntry, CharacterLayer } from './types.js'

/**
 * 五档的分界线（从低到高）。
 *
 * 为什么仍用**绝对值**而不是"在范围里的相对位置"：笼子本身已经说明了倾向 ——
 * 一个人的开放性范围是 0.72–0.96，那她落在自己范围的正中间（0.84）时，
 * 绝对意义上依然是"看见没见过的东西就想凑近"。用相对位置会把这个结论整个丢掉。
 */
const EDGES = [0.2, 0.35, 0.65, 0.85] as const

/**
 * 这根轴此刻落在第几档（0 = 很低，4 = 很高）。
 * @param axis - 一根轴。
 * @returns 档位；数值不是有效数字时 `undefined`（这条就不写）。
 */
export function bandOf(axis: CharacterAxisEntry): number | undefined {
  if (!Number.isFinite(axis.value)) return undefined
  const value = Math.min(1, Math.max(0, axis.value))
  for (let index = 0; index < EDGES.length; index += 1) {
    if (value < EDGES[index]!) return index
  }
  return EDGES.length
}

/**
 * 渲染性格那一行。
 * @param character - 性格层（可能不存在或形状残缺）。
 * @returns 一行文本；还没有性格时返回空串（**四根都会有话说**，不再有沉默的那根）。
 */
export function characterLine(character: CharacterLayer | undefined): string {
  if (character === undefined || character === null) return ''
  if (character.derivedAt === '' || !Array.isArray(character.axes)) return ''
  const parts: string[] = []
  for (const key of CHARACTER_AXES) {
    const axis = character.axes.find((item) => item?.key === key)
    if (axis === undefined) continue
    const band = bandOf(axis)
    if (band === undefined) continue
    parts.push(CHARACTER_AXIS_TEXT[key].bands[band]!)
  }
  if (parts.length === 0) return ''
  return `- 此刻的你：${parts.join('；')}。`
}
