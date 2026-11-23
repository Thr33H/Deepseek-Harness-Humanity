/**
 * 把"她此刻想起来的几条"渲染成一段给她自己看的文字（**纯函数**）。
 *
 * 两条纪律：
 * 1. **只给话，不给分**：数字会让她开始演数字（"这条 0.62 分"），话才会让她演人；
 * 2. **带时间感**：同一件事，昨天发生和三个月前发生，读起来完全不同 ——
 *    所以渲染的是"三天前"而不是一个 ISO 时间戳。
 * @module humanity/memory/render
 */
import { MEMORY_RECALL_TOOL, MEMORY_REMEMBER_TOOL, INJECT_CHAR_BUDGET } from './constants.js'
import { detailExpired } from './decay.js'
import type { MemoryHit } from './types.js'

/**
 * 那段说明的**固定标题**。
 *
 * 单独抽出来只是为了让"抬头"与下面那些条目分开维护；改它不涉及任何判定。
 */
export const MEMORY_GUIDANCE_TITLE = '## 你的记忆'

/**
 * 提示词里的**引导语**（永不变的那一段）。
 *
 * 它是唯一留在系统提示词里的记忆文本：不随每轮检索结果变化，所以不会反复打断前缀缓存。
 *
 * 三条纪律：
 * 1. **不记什么要说清**：寒暄、一次性内容、整段原文不记 —— 写入端的准入是最容易失败的一环；
 * 2. **注入的只是几条**：不写这句，模型会把自动带进来的当成记忆库全部，然后即兴补细节
 *    （2026-09-25 真机事故的原话是"我拿系统塞给我的那两条当成了全部"）；
 * 3. **查不到就是没有**：明说尚未定过，不许拿推测冒充记忆。
 */
export const MEMORY_GUIDANCE = [
  MEMORY_GUIDANCE_TITLE,
  '',
  `- 值得留下的：对方说过的长期偏好、你们之间的约定、你自己经历过的、让你有过情绪的事 —— 用 ${MEMORY_REMEMBER_TOOL} 记下来。`,
  '- 不记：寒暄、一次性内容、整段对话原文。',
  // 分界：哪些是"记忆"、哪些是"人格"。这条原本住在人格的系统提示词里，
  // 2026-11-22 搬回记忆自己这边 —— 记忆的规则只由记忆说，人格只管人格（见 `MUTABLE_OPS_GUIDE` 的说明）。
  '- **关于「怎么和你相处」的设定**（怎么称呼他、你的说话风格、行为边界、你们的关系）不记在这里 —— 那是人格那边的事。',
  '- 用「我」指你自己；其他人一律写名字。',
  // 这一条不是"记忆"，是行为要求 —— 但它必须住在同一个地方才有人看。
  // 2026-11-21 用户反馈："我说的事情她好像没去做什么"，根因是她只口头答应、没有真的安排。
  '- **答应的事要真的去做**：有时间点的（"三点提醒我吃药"）当场用定时任务安排上，不许只回一句"好"就完；',
  '  没有时间点的（"我回头帮你查一下"）记下来，并写清**还没做** —— 下次看到这条就去做，别又答应一遍。',
  `- 自动带进这一轮的只是最相关的几条，**不是记忆库全部**。要回忆、核对，或你想用"我记得/上次"的口吻说话时，先 ${MEMORY_RECALL_TOOL} 查一遍；`,
  '  查不到就是没有 —— 明说尚未定过，不许拿推测或本轮临时想到的东西冒充记忆。',
].join('\n')

/** 一天多少毫秒。 */
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 某个时刻在指定时区里是"哪一天"（`YYYY-MM-DD`）。
 *
 * `en-CA` 的输出恰好是 `YYYY-MM-DD`，省掉自己拼装；时区名不合法时返回 `undefined`
 * （脏配置不该让整条记忆渲染不出来）。
 * @param time - 毫秒时刻。
 * @param timeZone - IANA 时区名（如 `Asia/Shanghai`）。
 * @returns 日期键；读不出来时 `undefined`。
 */
function dayKeyOf(time: number, timeZone: string): string | undefined {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(time))
  } catch {
    return undefined
  }
}

/**
 * 相隔几个**日历日**。
 *
 * 为什么不用毫秒差：凌晨 00:30 说昨晚 23:30 的事，毫秒差只有 1 小时，会被算成"今天"。
 * 用户半夜聊天时这句话就是错的 —— 而"昨天/今天"正是她回忆时最常用的说法。
 * @param at - 事发时刻（毫秒）。
 * @param now - 现在（毫秒）。
 * @param timeZone - 生效时区。
 * @returns 天数差；读不出来时 `undefined`（调用方退回毫秒口径）。
 */
function calendarDaysBetween(at: number, now: number, timeZone: string): number | undefined {
  const from = dayKeyOf(at, timeZone)
  const to = dayKeyOf(now, timeZone)
  if (from === undefined || to === undefined) return undefined
  const diff = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS
  return Number.isFinite(diff) ? Math.round(diff) : undefined
}

/**
 * 把"什么时候"说成人话。
 * @param when - 事件发生时刻（ISO 8601）。
 * @param now - 现在。
 * @param timeZone - 生效时区；给了就按**日历日**算"今天/昨天"，没给就按 24 小时算。
 * @returns 人话；读不出时间时返回空串（宁可不提，也不要瞎说"很久以前"）。
 */
export function whenText(when: string, now: Date, timeZone?: string): string {
  const at = Date.parse(when)
  if (!Number.isFinite(at)) return ''
  const calendar = timeZone === undefined || timeZone === '' ? undefined : calendarDaysBetween(at, now.getTime(), timeZone)
  const days = calendar ?? Math.floor((now.getTime() - at) / DAY_MS)
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 7) return `${days} 天前`
  if (days < 30) return `${Math.floor(days / 7)} 周前`
  if (days < 365) return `${Math.floor(days / 30)} 个月前`
  return `${Math.floor(days / 365)} 年前`
}

/**
 * 会话第一次开口时那一段的抬头。
 *
 * 记忆用「我 + 人名」写（见 `write.ts`），所以这里补一句**把这些名字接到眼前这个人身上** ——
 * 人名在多人语境下是唯一不会串的写法，代价是新会话里她可能一时对不上号，这一句就是那个补丁。
 */
export const FIRST_RECALL_TITLE = [
  '【你醒着的时候一直记得的几件事】',
  '（这些是你自己经历过的事，不是设定；里面出现的人，就是正在跟你说话的这个。）',
].join('\n')

/**
 * 细节在注入里最多显示多少字。
 *
 * 细节是"当时的原话、画面"，太长会挤掉别的记忆；截到一两句，够她把那一刻想起来了。
 */
const DETAIL_RENDER_LIMIT = 120

/**
 * 渲染这一轮"想起来的事"。
 *
 * 除了"发生了什么"，**刚发生的事还会带上当时的原话**（`detail`）—— 人也是这样的：
 * 昨天的话能复述原句，半年前的只剩一句"那天不太好过"。细节到期（`detailExpired`）就不再带，
 * 于是"细节会褪"这件事第一次真的体现在她看到的东西里，而不是只存在于数据里。
 *
 * 细节受 `INJECT_CHAR_BUDGET` 约束：宁可少给一句原话，也不要把上下文塞满。
 * @param hits - 命中的记忆（已按分数排序）。
 * @param now - 现在。
 * @param title - 这一段的抬头（"想起来的" vs "你最记得的"是两种不同的语境）。
 * @param timeZone - 生效时区（"今天/昨天"按它算日历日；不传就按 24 小时）。
 * @returns 给模型看的文本；没有命中时为空串。
 */
export function renderRecalled(
  hits: readonly MemoryHit[],
  now: Date,
  title = '【想起来的几件事】',
  timeZone?: string,
): string {
  if (hits.length === 0) return ''
  const lines: string[] = []
  let used = title.length
  for (const hit of hits) {
    const when = whenText(hit.record.when, now, timeZone)
    const head = when === '' ? `- ${hit.record.what}` : `- （${when}）${hit.record.what}`
    lines.push(head)
    used += head.length
    const detail = hit.record.detail.trim()
    if (detail === '' || detailExpired(hit.record, now)) continue
    const shown = detail.length > DETAIL_RENDER_LIMIT ? `${detail.slice(0, DETAIL_RENDER_LIMIT)}…` : detail
    if (used + shown.length + 2 > INJECT_CHAR_BUDGET) continue
    lines.push(`  ${shown}`)
    used += shown.length + 2
  }
  return [title, ...lines].join('\n')
}
