/**
 * 会话的名字：**她自己那间，按当天日期命名**。
 *
 * ### 为什么要自己改名
 *
 * DSH 会给会话自动起标题（模型读前几轮对话生成一个），对我们这件事不合适：
 * 她的房间每天是一个新会话，名字应该是**日期**，这样一年以后你能一眼找到"11 月 25 日她做了什么"。
 *
 * ### 能不能做到（2026-11-25 查证）
 *
 * 能。DSH 有个专门的服务 `sessionTitle`（包 `@deepseek-ai/dsh-session-title`）：
 * - `get(session)` 读当前标题；
 * - `rename(session, title)` 往会话里追加一条 `session/title` 事件，`source: 'user'`，
 *   **并且把标题钉住** —— 之后自动起名不会再覆盖它。
 *
 * 前提：会话必须是**活着的**（`sessions.get(id)` 拿得到的那个对象），所以这一步必须在她
 * 的会话刚被建出来／正在跑的时候做，不能拿一个 id 去凭空改。
 * @module humanity/evolution/title
 */

/** 她房间某一刻该叫什么（就是那天的日期）。 */
export function titleFor(dateKey: string): string {
  return dateKey
}

/** `ctx.get('sessionTitle')` 用到的那一小块。 */
export interface TitleSeam {
  get(session: unknown): { title?: string } | undefined
  rename(session: unknown, title: string): unknown
}

/** 改名这一步需要的外部事实。 */
export interface TitleDeps {
  titles(): TitleSeam | undefined
}

/** 改名的结果。 */
export type TitleOutcome =
  | { kind: 'renamed'; title: string }
  | { kind: 'already'; title: string }
  | { kind: 'skipped'; reason: string }

/**
 * 把一个**活的会话**的名字对齐到"今天"。
 *
 * ⚠️ 参数必须是会话对象本身，不是 id：真机 2026-11-25 试过用
 * `ctx.get('sessions').get(id)` 去找它，那条路在插件的作用域里拿不到对象
 * （一直报"这个会话这会儿不是活的"），而 `session/event` 回调里**本来就把活的会话对象递过来了**。
 * `sessionTitle.rename` 也要求"是同一个对象"（它内部会断言 `sessions.get(id) === session`）。
 *
 * 幂等：名字已经是这个就不动（`arm` 与事件回调都可能走到这里）。
 * 失败不抛 —— 名字没改成不影响她过日子，但要能说清为什么。
 * @param deps - 标题服务。
 * @param session - 活的会话对象（拿不到就传 `undefined`）。
 * @param dateKey - 今天（她的时区）。
 * @returns 结果（`skipped` 时带原因）。
 */
export function renameSession(deps: TitleDeps, session: unknown, dateKey: string): TitleOutcome {
  const title = titleFor(dateKey)
  if (title === '') return { kind: 'skipped', reason: '没有日期' }
  if (session === undefined || session === null) return { kind: 'skipped', reason: '没有活的会话对象' }
  const titles = deps.titles()
  if (titles === undefined) return { kind: 'skipped', reason: '标题服务不在（sessionTitle）' }
  let current: string | undefined
  try {
    current = titles.get(session)?.title
  } catch {
    current = undefined
  }
  if (current === title) return { kind: 'already', title }
  try {
    titles.rename(session, title)
  } catch (error) {
    return { kind: 'skipped', reason: `改名失败：${error instanceof Error ? error.message : String(error)}` }
  }
  return { kind: 'renamed', title }
}
