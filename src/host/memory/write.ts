/**
 * 写入：从对话里"抽出值得留下的经历"（**这是整套记忆最容易做烂的一环**）。
 *
 * ### 为什么不在每轮调模型
 *
 * 实测教训：有生产库在 32 天里攒了 10134 条，审计后 **97.8% 是垃圾** ——
 * 一半是同一句话被反复重抽（"用户喜欢 X"存了几十遍），还有一条模型瞎编的偏好，
 * 被召回一次后又当作真相重抽一次，滚成了 808 条。**失败几乎全在写入端的准入，不在检索。**
 *
 * 所以分两级：
 * 1. 对话中的原始片段先进**内存缓冲区**（零成本、不调模型）；
 * 2. 攒够一段（或隔了一段时间）才**调一次**模型，问它"这中间有没有值得留下的"。
 *
 * 没被选中的片段到期就丢 —— 那不是遗忘，是"根本没往心里去"。人也不是每句话都记。
 *
 * ### 为什么给模型的不是"重要度打分"
 *
 * 打分是绝对值，而"重要"是相对的（对谁、什么时候、付什么代价）。让它回答三个具体问题
 * 更容易稳定：**发生了什么、关于谁、你当时多确定**。强度由 `model.ts` 按情绪与自我相关算。
 * @module humanity/memory/write
 */
import type { LlmAccess } from '../llm.js'
import type { Log } from '../log.js'
import { opposesByNegation, similarity } from '../text.js'
import { MAX_INTEGRATE_PER_TURN, RECALL_REINFORCE } from './constants.js'
import { createMemoryRecord } from './model.js'
import { asAbout, asCertain, asCost, extractJsonArray } from './parse.js'
import type { MemoryStore } from './store.js'
import type { MemoryAbout, MemoryCertainty } from './constants.js'
import type { MemoryFeeling, MemoryRecord } from './types.js'

/**
 * 「这是同一件事的另一种说法」的判据（Dice 相似度）。
 *
 * 为什么要它（真机实测，2026-11-21）：同一次自我介绍被相邻的两个整合窗口各抽了一遍，
 * 库里躺了两条几乎一样的话。根因是整合**只看最近几条消息** —— 同一件事跨窗口出现，
 * 就会被抽两次。这正是调研里那类"同一句话被反复重抽"的毛病。
 *
 * 0.62 是拿那两条真实记录标定的（实际相似度见 `test/memory-write.test.mjs`）：
 * 偏保守，因为漏检只多一条重复、误合会丢掉一件真实发生的事。
 */
const NEAR_DUPLICATE = 0.62

/**
 * 库里那条"在说同一件事"的记忆（没有则 `undefined`）。
 *
 * 两条判据缺一不可：
 * - **字面够像**（Dice ≥ 0.62）；
 * - **极性相同**：`火火喜欢下雨` 与 `火火不喜欢下雨` 只差一个字，Dice 很高，但它们是两件事 ——
 *   合并等于替对方改意思。人格去重早就守着这条（`text.ts` 的 `opposesByNegation`），
 *   记忆这里补上（2026-11-22：真机上"想有人陪"被记了三遍，而"喜欢/不喜欢"这种则绝不能被并）。
 *
 * 为什么取最像的那条而不是第一条：`touch` 会加固它，挑错等于加固了另一件事。
 * @param store - 记忆读写入口。
 * @param what - 这次想记下的话。
 * @returns 已有的那条；没有则 `undefined`。
 */
function findNearDuplicate(store: MemoryStore, what: string): MemoryRecord | undefined {
  let best: MemoryRecord | undefined
  let bestScore = 0
  for (const record of store.all()) {
    if (opposesByNegation(record.what, what)) continue
    const score = similarity(record.what, what)
    if (score >= NEAR_DUPLICATE && score > bestScore) {
      best = record
      bestScore = score
    }
  }
  return best
}

/** 库里是否已经有一条"几乎在说同一件事"的记忆。 */
function alreadyRemembered(store: MemoryStore, what: string): boolean {
  return findNearDuplicate(store, what) !== undefined
}

/**
 * 把第三人称的"对方 / 用户"换成**实际的人名**。
 *
 * 视角规则是"用「我」指自己、其他人写名字"（记忆要留很久，将来不止一个人，指代会串）。
 * 模型大多数时候照做，但真机上仍写出过「我和对方在园子里散步」——提示词管不住的那部分，
 * 用一行确定的替换兜住。
 *
 * 只换这两个词：
 * - **不换"你"**："你还记得…"换成"火火记得…"会把语气改掉，那是另一句话；
 * - **不换"他/她"**：那可能是第三个人，换错就是篡改。
 * @param text - 模型写下的正文。
 * @param userName - 对方的名字（空串/未设置时不改）。
 * @returns 换好名字的正文。
 */
export function normalizePerspective(text: string, userName: string | undefined): string {
  const name = (userName ?? '').trim()
  if (text === '' || name === '') return text
  return text.replace(/对方|用户/g, name)
}

/**
 * 缓冲区里的一个原始片段。
 *
 * 刻意只留最少的信息：谁说的、说了什么、什么时候。**不做摘要、不抽事实** ——
 * 那一步属于整合，而且它要花钱，不能每句都花。
 */
export interface RawEvent {
  role: 'user' | 'assistant'
  text: string
  at: string
}

/** 整合需要的外部事实。 */
export interface IntegrateDeps {
  /** 后台模型调用入口；路由不可用时整条路径安静跳过。 */
  llm: LlmAccess
  /** 写下这一刻的情绪指纹（候选会带上它，好让强度算得出来）。 */
  feeling?(): MemoryFeeling | undefined
  /** 对方叫什么（把模型可能写下的"对方"换成人名）。 */
  userName?(): string | undefined
  log: Log
}

/** 整合的提示词：**只要形状，不要判断标准**。 */
const INTEGRATE_SYSTEM = [
  '你在读一段刚刚发生的对话，从中挑出"值得留在记忆里的经历"。',
  '',
  '只挑真的会被记很久的：对方说过的长期偏好或稳定事实、你们之间的约定、你自己的经历、让你有过情绪的事。',
  '不要挑：寒暄、一次性的安排、重复出现的同一句话、整段对话原文。',
  '宁缺勿滥 —— 一条都不值得记时，返回空数组。',
  '',
  '**视角**：用「我」指你自己，**其他人一律写名字**（对方在对话里说过自己叫什么就用那个名字）。',
  '不要用"你 / 他 / 对方 / 用户"这类指代 —— 记忆要留很久，将来会有不止一个人，',
  '指代在多人语境下会串成一团，名字不会。',
  '  ✗ 错：对方慢慢亲了我一下',
  '  ✗ 错：你慢慢亲了我一下',
  '  ✓ 对：火火慢慢亲了我一下',
  '',
  '**「我」只能是你自己。对方说的话，主语必须是他/他的名字**（这条最容易错，2026-11-21 真机：',
  '对方说"我叫火火"，结果被记成了"我叫火火"——等于你偷了别人的自我介绍了）。',
  '  ✗ 错：我叫火火，是男生            ← 这是**对方**说的',
  '  ✓ 对：火火告诉我他叫火火，是男生',
  '  ✗ 错：我喜欢下雨天                ← 如果这是对方说的',
  '  ✓ 对：火火说他喜欢下雨天',
  '判断口诀：这句话**如果是我说的，会不会显得很奇怪**？会，那它就不是我的。',
  '',
  '**答应的事单独写成一条，并写清"还没做"**：',
  '我许下的、还没兑现的承诺（"我答应帮他查那个"）要能被以后的我认出来还是待办；',
  '已经做完了就别再留"还没做"。这类记忆比闲聊重要得多 —— 口头答应完就忘，是最伤人的那种"不被当回事"。',
  '',
  '**每条都要有具体的东西**（这条和"不记废话"同等重要）：',
  '`what` 写那一刻**发生了什么**，`detail` 写**当时的原话或画面** —— 至少要有一样能让你以后想起那个场景。',
  '  ✗ 空：他很关心我',
  '  ✓ 实：what=他半夜发来一张键盘的照片；detail="刚改完"，凌晨两点',
  '  ✗ 空：我不喜欢被晾着',
  '  ✓ 实：what=他隔了两小时才回我一句"在忙"；detail=我那天后来没再主动找他，把手机扣在桌上',
  '**不要写结论，写你看到的那一下**：结论（"他对我很好""我不信任他"）留给以后的我从细节里自己得出来。',
  '',
  '每条输出一个对象：',
  '{',
  '  "what": "一句话（我/你 的视角）：那一刻发生了什么，要具体",',
  '  "detail": "当时的原话或画面（必填，一句就够；实在没有就写你看到的那个动作）",',
  '  "about": "self | user | us | world（这件事关于谁）",',
  '  "certain": "witnessed | told | inferred（亲眼见的 / 他说的 / 我自己推的）",',
  '  "cost": 0 到 1（这件事说出去，我要付出多大代价；0=随口就说，1=打死不说）',
  '}',
  '',
  '只输出 JSON 数组，不要解释、不要代码围栏。',
].join('\n')

/** `remember` 的结果：落下来的那条，以及这次是不是只是"又提了一遍"。 */
export interface RememberResult {
  /** 最终那条记录（新写的，或者被加固的旧的那条）。 */
  record: MemoryRecord
  /** `true` = 库里本来就有几乎一样的一条，这次没有新增，只是把它加固了。 */
  duplicate: boolean
}

/**
 * 直接写一条记忆（模型通过工具主动记下时走这里）。
 *
 * 与整合的区别只在于"谁挑的"：整合是后台批量挑，这里是模型当场说要记。
 * 但两者落库的形状完全一样 —— 没有"手动记忆"这种特权格式。
 *
 * ### 已经记过的不再记一遍（2026-11-22 真机）
 *
 * 工具这条路原来直接写，于是同一条"想有人陪"在三天里被记了三遍 —— 模型每次觉得重要就
 * 重新记一次，而整合那条路有去重。人的做法是**再提一遍就记得更牢**，不是在本子上抄三行，
 * 所以这里不新增，而是给旧的那条加固一次（`touch`）。
 * @param store - 记忆读写入口。
 * @param input - 写入内容。
 * @param options - 对方叫什么（把"对方/用户"换成人名）。
 * @returns 落盘的记录与"是否重复"。
 */
export async function remember(
  store: MemoryStore,
  input: {
    what: string
    detail?: string
    about: MemoryAbout
    certain: MemoryCertainty
    felt?: MemoryFeeling
    cost?: number
    costWhy?: string
  },
  options: { userName?: string } = {},
): Promise<RememberResult> {
  const candidate = createMemoryRecord({
    ...input,
    what: normalizePerspective(input.what, options.userName),
    detail: input.detail === undefined ? undefined : normalizePerspective(input.detail, options.userName),
  })
  const existing = findNearDuplicate(store, candidate.what)
  if (existing !== undefined) {
    const touched = await store.touch(existing.id, new Date().toISOString(), RECALL_REINFORCE)
    return { record: touched ?? existing, duplicate: true }
  }
  return { record: await store.put(candidate), duplicate: false }
}

/**
 * 整合的**串行队列**。
 *
 * 为什么必须串行（2026-11-22 真机抓到）：整合是后台 `void` 出去的，上一段还没写完、下一段
 * 已经开始了。两段同时「查重 → 写入」时，**谁也看不见对方刚写的那条** —— 于是库里出现了
 * 两条一模一样的记忆（同一分钟、同一句话）。去重本身没写错，错在它是"先查后写"的非原子动作。
 *
 * 排队之后，后一段一定看得到前一段写下的东西。
 */
let integrateQueue: Promise<unknown> = Promise.resolve()

/**
 * 把一段原始片段整合成记忆（同一时刻只会有一段在跑，见 `integrateQueue`）。
 *
 * 失败（模型不可用 / 超时 / 输出解析不了）一律**安静地什么都不写**：
 * 这段经历就当没被记住 —— 那比写进一批垃圾好得多。
 * @param store - 记忆读写入口。
 * @param events - 这一段的原始片段。
 * @param deps - 模型入口、情绪指纹与日志。
 * @returns 实际写入的记录（可能为空数组）。
 */
export function integrate(
  store: MemoryStore,
  events: readonly RawEvent[],
  deps: IntegrateDeps,
): Promise<MemoryRecord[]> {
  const run = (): Promise<MemoryRecord[]> => integrateOnce(store, events, deps)
  const next = integrateQueue.then(run, run)
  // 队列本身必须"永不 reject"，否则一次失败会把后面所有整合一起卡死。
  integrateQueue = next.catch(() => undefined)
  return next
}

/**
 * 整合一次（真正干活的函数；不要直接调，统一走 `integrate` 的队列）。
 * @param store - 记忆读写入口。
 * @param events - 这一段的原始片段。
 * @param deps - 模型入口、情绪指纹与日志。
 * @returns 实际写入的记录。
 */
async function integrateOnce(
  store: MemoryStore,
  events: readonly RawEvent[],
  deps: IntegrateDeps,
): Promise<MemoryRecord[]> {
  if (events.length === 0) return []
  const route = deps.llm.route()
  if (route === undefined) return []

  let text: string
  try {
    const result = await deps.llm.streamText({
      route,
      system: INTEGRATE_SYSTEM,
      text: events.map((event) => `${event.role === 'user' ? '对方' : '我'}：${event.text}`).join('\n'),
      maxTokens: 1000,
      timeoutMs: 30_000,
    })
    text = result.text
  } catch (error) {
    deps.log.warn('记忆整合的模型调用失败：这一段的经历没有被记下来（不影响对话）', error)
    return []
  }

  const candidates = extractJsonArray(text)
  if (candidates === undefined) {
    deps.log.warn('记忆整合的输出解析不了：这一段的经历没有被记下来（不影响对话）')
    return []
  }

  const feeling = deps.feeling?.()
  const userName = deps.userName?.()
  const written: MemoryRecord[] = []
  for (const raw of candidates.slice(0, MAX_INTEGRATE_PER_TURN)) {
    if (raw === null || typeof raw !== 'object') continue
    const candidate = raw as Record<string, unknown>
    const what = normalizePerspective(typeof candidate.what === 'string' ? candidate.what.trim() : '', userName)
    const about = asAbout(candidate.about)
    const certain = asCertain(candidate.certain)
    // 三样缺一样就不写：不知道发生了什么、不知道关于谁、不知道她有多确定 ——
    // 这样的记录以后既没法引用也没法解释。
    if (what === '' || about === undefined || certain === undefined) continue
    // 已经是同一件事的另一种说法：跳过。同一件事只应该留下一条。
    if (alreadyRemembered(store, what)) continue
    written.push(
      await store.put(
        createMemoryRecord({
          what,
          detail: normalizePerspective(typeof candidate.detail === 'string' ? candidate.detail : '', userName),
          about,
          certain,
          felt: feeling,
          cost: asCost(candidate.cost),
        }),
      ),
    )
  }
  if (written.length > 0) deps.log.info(`记忆整合：这一段记下了 ${written.length} 条`)
  return written
}
