/**
 * 记忆的两个工具：**记住**（`humanity_remember`）与**回想**（`humanity_recall`）。
 *
 * ### 为什么工具是必须的，而不只是自动注入
 *
 * 自动注入的永远只有最相关的 0–3 条。真机事故（2026-09-25）就是这么来的：模型把注入的
 * 那两条**当成了记忆库全部**，然后即兴补细节、用"我记得"的口吻陈述。工具给了它一条
 * "我可以去查"的正路 —— 查不到就是没有，不许拿推测冒充。
 *
 * ### 为什么"记住"的参数不问"重要度"
 *
 * 重要度是绝对值，模型打分的方差会漂。问三个具体问题更稳：发生了什么、关于谁、你多确定。
 * 强度由 `model.ts` 按当时的情绪与自我相关算出来。
 * @module humanity/memory/tools
 */
import type { defineTool as defineToolType } from '@deepseek-ai/dsh-tools'

import type { Log } from '../log.js'
import { MEMORY_ABOUTS, MEMORY_CERTAINTIES, MEMORY_RECALL_TOOL, MEMORY_REMEMBER_TOOL } from './constants.js'
import { splitByDisclosure } from './disclosure.js'
import { whenText } from './render.js'
import { recall, strongest } from './search.js'
import type { MemoryStore } from './store.js'
import type { MemoryAbout, MemoryCertainty } from './constants.js'
import type { MemoryHit, MemoryRecord } from './types.js'
import { remember } from './write.js'

/** 工具结果：一句话结论 + 当前生效的那几条（让模型看到实际写了什么）。 */
export interface MemoryToolValue {
  ok: boolean
  message: string
  entries: Array<{ what: string; when: string; about: string }>
}

/** 输出契约（宽类型：它的作用是让结果可回放，不是替模型做约束）。 */
export const MEMORY_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true, description: '是否成功' },
    message: { type: 'string', required: true, description: '一句话结论；失败时说清为什么' },
    entries: {
      type: 'array',
      required: true,
      description: '这次涉及的那几条记忆',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          what: { type: 'string', required: true },
          when: { type: 'string', required: true },
          about: { type: 'string', required: true },
        },
      },
    },
  },
} as const

/** 工具结果 → 文本块（工具渲染器只认这一种形状）。 */
const text = (content: string): Array<{ type: 'text'; text: string }> => [{ type: 'text', text: content }]

/** 把记录压成结果里的条目。 */
const entryOf = (
  record: MemoryRecord,
  now: Date,
  timeZone?: string,
): { what: string; when: string; about: string } => ({
  what: record.what,
  when: whenText(record.when, now, timeZone),
  about: record.about,
})

/**
 * 「记住」的工具描述（模型可见）。
 *
 * 措辞纪律与人格那边一致：**用"你/我"，不许出现"这个 AI"** —— 模型会照抄描述里的词，
 * 真机上它因此写过"为这个 AI 定下设定"这种第三人称的自我描述。
 */
export const REMEMBER_DESCRIPTION =
  '把一件事记进你的记忆。' +
  '什么时候用：对方说过的长期偏好、你们之间的约定、你自己经历过的、让你有过情绪的事。' +
  '不记：寒暄、一次性的安排、整段对话原文。' +
  // 与人格的分界：这条原来只写在人格的系统提示词里，2026-11-22 搬回记忆自己的说明（工具说明常驻，最不容易丢）。
  '关于「怎么和对方相处」的设定（称呼、说话风格、行为边界、关系）不记在这里，那是人格的事。' +
  '用「我」指你自己，**其他人一律写名字**（"火火说他会来"，不要写"他说他会来"、"你说你会来"）。' +
  '记忆要留很久，将来会有不止一个人，所以指代用名字、不用"你/他/对方"。' +
  '关于谁（about）：self 关于我自己 / user 关于对方 / us 关于我们之间 / world 关于外面的事。' +
  '多确定（certain）：witnessed 我亲身经历 / told 他告诉我的 / inferred 我自己推的。' +
  '代价（cost，0–1）：这件事如果哪天要说出来，我会有多为难。0 是随口就能说，1 是打死不说。'

/** 「回想」的工具描述。 */
export const RECALL_DESCRIPTION =
  '按线索检索你的记忆。' +
  '什么时候用：对方问你还记不记得某件事、你要用"上次/之前/我记得"的口吻说话、或者你要核对一件旧事时。' +
  '检索不到就说明没有 —— 不要拿推测或本轮临时想到的东西冒充记忆。'

/**
 * 把检索结果变成工具返回值 —— **秘密只报"有这么一条"，正文一个字都不给模型**。
 *
 * 为什么必须有这一道（2026-11-22 发现）：注入那条路一直守着披露门槛，工具这条路
 * **一个都没守**。模型只要主动 `humanity_recall` 一次，秘密就整段看到了 ——
 * "她不想说"当场形同虚设。她是可以想起来的（影响心情那条通道照旧），只是不能说出口。
 * @param hits - 命中的记忆（已排序）。
 * @param now - 现在。
 * @param timeZone - 生效时区（"昨天/今天"按日历日算）。
 * @param fallback - 走的是"没有直接对应、退回最牢几条"那条路时，说法不同。
 * @returns 工具结果。
 */
export function hitsToValue(
  hits: readonly MemoryHit[],
  now: Date,
  timeZone?: string,
  fallback = false,
): MemoryToolValue {
  const { speakable, withheld } = splitByDisclosure(hits)
  const entries = speakable.map((hit) => entryOf(hit.record, now, timeZone))
  if (entries.length === 0) {
    return {
      ok: true,
      message: withheld.length > 0 ? '你想起了那件事，但你不想说。' : '没有找到。',
      entries: [],
    }
  }
  const note = withheld.length > 0 ? '（还有一条你想起来了，但不想说。）' : ''
  return {
    ok: true,
    message: fallback ? `没有和这条线索直接对应的；不过你最记得的是这几件：${note}` : `找到 ${entries.length} 条。${note}`,
    entries,
  }
}

/** 工具依赖。 */
export interface MemoryToolDeps {
  store(): MemoryStore | undefined
  /** 此刻的情绪指纹（写进去的记忆要带上当时的感觉）。 */
  feeling?(): { kind: string; intensity: number } | undefined
  /** 写入/检索后让工作台重新投影。 */
  changed?(): void
  /** 生效时区（"昨天/今天"按日历日算；不传就按 24 小时）。 */
  timeZone?(): string | undefined
  /** 对方叫什么（把模型可能写下的"对方/用户"换成人名）。 */
  userName?(): string
  log: Log
}

/**
 * 定义两个记忆工具。
 * @param defineTool - 官方工具定义助手（经 `loadOptional` 取得）。
 * @param deps - 存储入口与副作用。
 * @returns 可交给 `tools.register` 的工具定义数组。
 */
export function defineMemoryTools(defineTool: typeof defineToolType, deps: MemoryToolDeps) {
  const rememberTool = defineTool({
    name: MEMORY_REMEMBER_TOOL,
    description: REMEMBER_DESCRIPTION,
    parameters: {
      what: { type: 'string', required: true, description: '发生了什么，一句话（第一人称）' },
      about: { type: 'string', required: true, description: `关于谁：${MEMORY_ABOUTS.join(' / ')}` },
      certain: { type: 'string', required: true, description: `多确定：${MEMORY_CERTAINTIES.join(' / ')}` },
      detail: { type: 'string', description: '当时的原话或画面（可省略，它比要点先褪）' },
      cost: { type: 'number', description: '说出来的代价，0–1（0=随口就说，1=打死不说）' },
      costWhy: { type: 'string', description: '为什么这么为难（一句你自己的话）' },
    },
    output: {
      schema: MEMORY_RESULT_SCHEMA,
      render: (_args, value) => text(renderValue(value as MemoryToolValue)),
    },
    async execute(args: Record<string, unknown>) {
      const store = deps.store()
      if (store === undefined) return { ok: false, message: '记忆存储还没就绪，这次没有记下来。', entries: [] }
      const what = typeof args.what === 'string' ? args.what.trim() : ''
      if (what === '') return { ok: false, message: '要记的内容是空的，这次没有写入。', entries: [] }
      const about = (MEMORY_ABOUTS as readonly string[]).includes(String(args.about))
        ? (args.about as MemoryAbout)
        : undefined
      const certain = (MEMORY_CERTAINTIES as readonly string[]).includes(String(args.certain))
        ? (args.certain as MemoryCertainty)
        : undefined
      if (about === undefined || certain === undefined) {
        return {
          ok: false,
          message: `about 只认 ${MEMORY_ABOUTS.join(' / ')}，certain 只认 ${MEMORY_CERTAINTIES.join(' / ')}。`,
          entries: [],
        }
      }
      const cost = Number(args.cost)
      const { record, duplicate } = await remember(
        store,
        {
          what,
          detail: typeof args.detail === 'string' ? args.detail : '',
          about,
          certain,
          felt: deps.feeling?.(),
          cost: Number.isFinite(cost) ? Math.min(1, Math.max(0, cost)) : undefined,
          costWhy: typeof args.costWhy === 'string' ? args.costWhy : '',
        },
        { userName: deps.userName?.() },
      )
      deps.changed?.()
      return {
        ok: true,
        // 重复时不加一行、只加固旧的 —— 并且要**明说**，否则模型会以为这次没记上，再记一遍。
        message: duplicate ? '这条以前就记着了，这次只是又提了一遍（没有重复写）。' : '记下来了。',
        entries: [entryOf(record, new Date(), deps.timeZone?.())],
      }
    },
  })

  const recallTool = defineTool({
    name: MEMORY_RECALL_TOOL,
    description: RECALL_DESCRIPTION,
    parameters: {
      query: { type: 'string', required: true, description: '要找的线索：一句话、一个词、一个人名都行' },
    },
    output: {
      schema: MEMORY_RESULT_SCHEMA,
      render: (_args, value) => text(renderValue(value as MemoryToolValue)),
    },
    async execute(args: Record<string, unknown>) {
      const store = deps.store()
      if (store === undefined) return { ok: false, message: '记忆存储还没就绪，这次查不了。', entries: [] }
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      if (query === '') return { ok: false, message: '没有给要找的线索。', entries: [] }
      const now = new Date()
      const hits = recall(store.all(), query, { now }).slice(0, 8)
      if (hits.length > 0) return hitsToValue(hits, now, deps.timeZone?.())
      // 字面上一条都没对上时，退回"她最牢的几件"。
      //
      // 为什么不能直接说"没有"：「你还记得我吗」这种话一个具体的词都没有，
      // 和任何记忆都不重合 —— 回一句"没有"就等于说"我不认识你"。
      // 真正该回答的是"没有直接对应的，但我最清楚的是这几件"。
      const fallback = strongest(store.all(), 3, now)
      if (fallback.length === 0) {
        return { ok: true, message: '记忆里还是空的（还没有值得留下的事）。', entries: [] }
      }
      return hitsToValue(fallback, now, deps.timeZone?.(), true)
    },
  })

  return [rememberTool, recallTool]
}

/** 把结果渲染成给模型看的文案。 */
export function renderValue(value: MemoryToolValue): string {
  const lines = [value.message]
  if (value.entries.length > 0) {
    lines.push('')
    for (const entry of value.entries) lines.push(`- （${entry.when}）${entry.what}`)
  }
  return lines.join('\n')
}
