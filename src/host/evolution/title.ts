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

/** `ctx.get('sessions')` 用到的那一小块。 */
export interface SessionsSeam {
  get(sessionId: string): unknown
}

/** `ctx.get('sessionTitle')` 用到的那一小块。 */
export interface TitleSeam {
  get(session: unknown): { title?: string } | undefined
  rename(session: unknown, title: string): unknown
}

/** 改名这一步需要的外部事实。 */
export interface TitleDeps {
  sessions(): SessionsSeam | undefined
  titles(): TitleSeam | undefined
}

/** 改名的结果。 */
export type TitleOutcome =
  | { kind: 'renamed'; title: string }
  | { kind: 'already'; title: string }
  | { kind: 'skipped'; reason: string }

/**
 * 把她房间那个会话的名字对齐到"今天"。
 *
 * 幂等：名字已经是这个就不动（`arm` 每次启动都会走一遍，不能每次都追加事件）。
 * 失败不抛 —— 名字没改成不影响她过日子，但要能说清为什么。
 * @param deps - 会话与标题服务。
 * @param sessionId - 她房间的会话 id。
 * @param dateKey - 今天（她的时区）。
 * @returns 结果（`skipped` 时带原因）。
 */
export function syncRoomTitle(deps: TitleDeps, sessionId: string, dateKey: string): TitleOutcome {
  const title = titleFor(dateKey)
  if (sessionId === '' || title === '') return { kind: 'skipped', reason: '没有会话或者没有日期' }
  const sessions = deps.sessions()
  if (sessions === undefined) return { kind: 'skipped', reason: '会话服务不在（sessions）' }
  const titles = deps.titles()
  if (titles === undefined) return { kind: 'skipped', reason: '标题服务不在（sessionTitle）' }
  const session = sessions.get(sessionId)
  if (session === undefined || session === null) {
    return { kind: 'skipped', reason: '这个会话这会儿不是活的，改不了名' }
  }
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
