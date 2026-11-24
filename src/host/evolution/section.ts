/**
 * 自进化工作台（`humanity-evolution` 命名空间）。
 *
 * 真源是文档表里的状态与日记；这里只是**一扇窗**：宿主把当前状态投影进来，客户端读它渲染。
 * 客户端只写两样东西 —— 命令槽（`request`）与它自己的观感；命令的执行权在宿主。
 *
 * ### 日记是"合着的"
 *
 * 默认只投影**日期**与"有没有写过"，正文在没被打开前**不下发**。打开一篇要走两步
 * （客户端先问、再确认），宿主观剧后把那一天标记成"已打开"，并记下打开的时刻 ——
 * 按设计，她只会在自己重读那一天时才发现被翻过。
 *
 * 投影里只留最近 `DIARY_VIEW_LIMIT` 篇：一年多就是三百多篇，整篇搬进命名空间会让每次推送都很重。
 * @module humanity/evolution/section
 */
import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'

import type { DocumentStore } from '../documents.js'
import type { Log } from '../log.js'
import { fallbackSettings } from '../plane-settings.js'
import { supportsDynamicSections } from '../settings.js'
import { appendDiary, readDiary } from './diary.js'
import type { EvolutionStateDoc } from './state.js'
import type { WorkItem } from './room.js'

/** 命名空间名（客户端按它读；改名等于两边失联）。 */
export const EVOLUTION_NAMESPACE = 'humanity-evolution'

/** 一次投影最多带多少篇日记。 */
export const DIARY_VIEW_LIMIT = 30

/** 工作台上的日记条目。正文只在 `opened` 之后才有。 */
export interface DiaryView {
  date: string
  /** 已经打开过（正文才有内容）。 */
  opened: boolean
  /** 什么时候被打开的（ISO；空串 = 没打开过）。 */
  openedAt: string
  /** 正文；没打开时是空串（宿主动手挡住，不靠客户端自觉）。 */
  text: string
}

/** 她的今天。 */
export interface DayView {
  /** 模块开着吗。 */
  enabled: boolean
  /** 人格已封存（她"开机"了）。 */
  started: boolean
  /** 现在是不是在睡。 */
  sleeping: boolean
  /** 精力 0–100。 */
  energy: number
  /** 今天醒了几次。 */
  dayCount: number
  /** 一天最多醒几次（上限，不是配额）。 */
  maxPerDay: number
  /** 上一次醒来（ISO）。 */
  lastWakeAt: string
  /** 下一次醒来（ISO；空串 = 没排）。 */
  nextAt: string
  /** 房间任务是否就绪。 */
  taskReady: boolean
  /** 最近一次排程失败的原因（空串 = 正常）。 */
  lastError: string
}

/** 整份投影。 */
export interface EvolutionDocument {
  status: DayView
  diary: DiaryView[]
  /** 她留在自己目录里的东西（只读一扇窗）。 */
  works: WorkItem[]
  /** 命令槽：客户端写"想做什么"，宿主消费。 */
  request: { op: string; date: string }
  /** 宿主给的一句话（例如"这一天已经打开了"）。 */
  notice: string
}

/** 投影的空态（寄存器在命名空间挂上之前用它）。 */
export function emptyEvolutionDocument(): EvolutionDocument {
  return {
    status: {
      enabled: false,
      started: false,
      sleeping: false,
      energy: 0,
      dayCount: 0,
      maxPerDay: 0,
      lastWakeAt: '',
      nextAt: '',
      taskReady: false,
      lastError: '',
    },
    diary: [],
    works: [],
    request: { op: '', date: '' },
    notice: '',
  }
}

/** 命名空间的形状（客户端读它渲染；缺字段一律有默认值）。 */
export const EvolutionDocSchema = Schema.object({
  status: Schema.object({
    enabled: Schema.boolean().default(false),
    started: Schema.boolean().default(false),
    sleeping: Schema.boolean().default(false),
    energy: Schema.number().default(0),
    dayCount: Schema.number().default(0),
    maxPerDay: Schema.number().default(0),
    lastWakeAt: Schema.string().default(''),
    nextAt: Schema.string().default(''),
    taskReady: Schema.boolean().default(false),
    lastError: Schema.string().default(''),
  }),
  diary: Schema.array(
    Schema.object({
      date: Schema.string().default(''),
      opened: Schema.boolean().default(false),
      openedAt: Schema.string().default(''),
      text: Schema.string().default(''),
    }),
  ).default([]),
  works: Schema.array(
    Schema.object({
      name: Schema.string().default(''),
      size: Schema.number().default(0),
      updatedAt: Schema.string().default(''),
      kind: Schema.string().default('other'),
      preview: Schema.string().default(''),
    }),
  ).default([]),
  request: Schema.object({
    op: Schema.string().default(''),
    date: Schema.string().default(''),
  }),
  notice: Schema.string().default(''),
})

/** 投影需要的外部事实。 */
export interface EvolutionSectionDeps {
  documents(): DocumentStore | undefined
  state(): EvolutionStateDoc | undefined
  settings(): { maxPerDay: number }
  enabled(): boolean
  started(): boolean
  /** 她留在自己目录里的东西（读不到时给空数组）。 */
  works(): Promise<WorkItem[]>
}

/** 工作台入口。 */
export interface EvolutionSection {
  refresh(): Promise<void>
  notifyStoreReady(): void
  readonly attached: boolean
}

/** 接线状态。 */
interface SectionState {
  settings?: SettingsProvider
  attached: boolean
}

/** 读命名空间当前值（装配路径没有兜底，包 try/catch）。 */
function readDoc(settings: SettingsProvider | undefined): EvolutionDocument | undefined {
  if (settings === undefined) return undefined
  try {
    const live = settings.get(EVOLUTION_NAMESPACE)
    return live === undefined || live === null ? undefined : (live as EvolutionDocument)
  } catch {
    return undefined
  }
}

/** 把投影写进命名空间（整份 replace：投影是重算结果）。 */
function writeDoc(state: SectionState, log: Log, doc: EvolutionDocument): void {
  const settings = state.settings
  if (settings === undefined) return
  try {
    const pending = settings.replace(EVOLUTION_NAMESPACE, doc) as unknown
    if (pending !== null && pending !== undefined && typeof (pending as Promise<unknown>).then === 'function') {
      void (pending as Promise<unknown>).catch((error: unknown) => log.warn('自进化工作台投影写入失败', error))
    }
  } catch (error) {
    log.warn('自进化工作台投影写入失败', error)
  }
}

/**
 * 造一份投影。
 * @param deps - 外部事实。
 * @param opened - 已经打开过的日期 → 打开时刻。
 * @returns 整份文档。
 */
function project(deps: EvolutionSectionDeps, works: readonly WorkItem[]): EvolutionDocument {
  const documents = deps.documents()
  const state = deps.state()
  const settings = deps.settings()
  const diary = readDiary(documents)
    .slice(-DIARY_VIEW_LIMIT)
    .reverse()
    .map((entry) => ({
      date: entry.date,
      opened: entry.openedAt !== '',
      openedAt: entry.openedAt,
      // 没打开过就**不给正文**：门在宿主这边，不靠客户端自觉。
      text: entry.openedAt === '' ? '' : entry.text,
    }))
  return {
    status: {
      enabled: deps.enabled(),
      started: deps.started(),
      sleeping: (state?.sleepingSince ?? '') !== '',
      energy: state?.energy ?? 0,
      dayCount: state?.dayCount ?? 0,
      maxPerDay: settings.maxPerDay,
      lastWakeAt: state?.lastWakeAt ?? '',
      nextAt: state?.nextAt ?? '',
      taskReady: (state?.taskId ?? '') !== '',
      lastError: state?.lastError ?? '',
    },
    diary,
    works: [...works],
    request: { op: '', date: '' },
    notice: '',
  }
}

/**
 * 接上工作台命名空间。
 * @param ctx - 本插件的上下文。
 * @param log - 日志门面。
 * @param deps - 外部事实。
 * @returns 工作台入口。
 */
export function installEvolutionSection(ctx: Context, log: Log, deps: EvolutionSectionDeps): EvolutionSection {
  const state: SectionState = { attached: false }

  const refresh = async (notice = ''): Promise<void> => {
    if (!state.attached) return
    const works = await deps.works().catch(() => [] as WorkItem[])
    const doc = project(deps, works)
    if (notice !== '') doc.notice = notice
    writeDoc(state, log, doc)
  }

  /**
   * 消费命令槽：目前只有"打开某一天的日记"。
   *
   * 两步确认在客户端；这里只执行，并把结果写回通知 —— 不做"撤销"，打开就是打开了。
   */
  const consume = async (): Promise<void> => {
    const request = readDoc(state.settings)?.request
    if (request === undefined || request.op !== 'open' || request.date === '') {
      await refresh()
      return
    }
    const documents = deps.documents()
    const entry = readDiary(documents).find((item) => item.date === request.date)
    if (entry === undefined) {
      await refresh('那一天没有日记。')
      return
    }
    // 打开就是打开了：记下时刻并落盘（重启之后也算数）。
    if (entry.openedAt === '') {
      await appendDiary(documents, { ...entry, openedAt: new Date().toISOString() })
    }
    await refresh(`你翻开了 ${request.date} 那天写的日记。`)
  }

  ctx.inject(['settings'], (sctx) => {
    const settings: SettingsProvider = sctx.settings
    const hooks = {
      setSource: () => {},
      validate: () => {},
      onChange: () => {
        void consume()
      },
    }
    const install = (provider: SettingsProvider): void => {
      state.settings = provider
      state.attached = true
      void refresh()
    }
    // G-002：0.1.7+ 的 settings 没有动态命名空间 API —— 改挂自有数据面。
    if (!supportsDynamicSections(settings)) {
      const plane = fallbackSettings()
      if (plane === undefined) {
        log.error('当前 DSH 不提供 installSection，且自有数据面缺席：自进化工作台本次不可用（其余功能照常）。')
        return
      }
      plane.installSection(ctx, EVOLUTION_NAMESPACE, EvolutionDocSchema, emptyEvolutionDocument(), hooks)
      install(plane as unknown as SettingsProvider)
      return () => {
        state.settings = undefined
        state.attached = false
      }
    }
    settings.installSection(ctx, EVOLUTION_NAMESPACE, EvolutionDocSchema, emptyEvolutionDocument(), hooks)
    install(settings)
    return () => {
      state.settings = undefined
      state.attached = false
    }
  })

  return {
    refresh: () => refresh(),
    notifyStoreReady: () => {
      void refresh()
    },
    get attached() {
      return state.attached
    },
  }
}
