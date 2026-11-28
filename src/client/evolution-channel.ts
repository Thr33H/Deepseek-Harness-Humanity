/**
 * 自进化工作台的**设置 RPC 通道**与命名空间名。
 *
 * 与 `memory-channel.ts` 同一取舍：官方 Remote 类型面依赖一串本仓库没装的包，
 * 所以按官方契约声明成**结构类型**。通道只用两件事：`describe()` 读投影、
 * `replace()` 把命令写进同一个命名空间（执行权在宿主）。
 * @module deepseek-harness-humanity/client/evolution-channel
 */
import type { PersonaChannel, RemoteOutcome } from './persona-channel.js'

/**
 * 自进化命名空间。**必须**与宿主 `src/host/evolution/section.ts` 的字面量相同。
 * 这里重复一份而不是 import 宿主模块（那会把整棵宿主树带进浏览器 bundle）。
 */
export const EVOLUTION_NAMESPACE = 'humanity-evolution'

/** 一条日记（正文只在打开过之后才有）。 */
export interface DiaryItemView {
  date: string
  opened: boolean
  openedAt: string
  /** 她什么时候知道的（空串 = 还不知道）。 */
  noticedAt: string
  text: string
}

/** 她的今天。 */
export interface DayStatusView {
  enabled: boolean
  started: boolean
  sleeping: boolean
  energy: number
  dayCount: number
  maxPerDay: number
  lastWakeAt: string
  nextAt: string
  taskReady: boolean
  /** 闹钟是不是因为她正在别处说话而压着。 */
  busy: boolean
  lastError: string
  /** 睡前收账最后失败的原因。 */
  lastSettleError: string
  /** 上一轮她调了几次工具。 */
  lastTurnTools: number
  /** 闹钟从什么时候起被压住（空串 = 没被压）。 */
  busySince: string
  /** 上一次自评的结果（kind:count:targets）。 */
  lastAppraise: string
  /** 「她的房间」现在填的是什么（空串 = 用老位置）。 */
  roomText: string
  /** 她**现在真的**住在哪个目录（绝对路径）。 */
  roomPath: string
  /** 配置解出来的目标目录；与 `roomPath` 不同 = 改了还没搬过去。 */
  roomTarget: string
}

/** 她留下的一样东西（只读）。 */
export interface WorkItemView {
  name: string
  size: number
  updatedAt: string
  kind: string
  preview: string
}

/** 她自己整理的一条候选（攒着、还没够次数）。 */
export interface GrowCandidateView {
  text: string
  /** `user` = 关于他；`self` = 关于她自己。 */
  about: string
  section: string
  count: number
  days: number
}

/** 她自己整理的结果。 */
export interface GrowView {
  candidates: GrowCandidateView[]
  lastRun: { at: string; wrote: string[]; queued: string[]; note: string }
}

/** 她主动留给你的东西。 */
export interface TellView {
  /** 有一句还没送出去的话（空串 = 没有）。 */
  pending: string
  /** 那句话想附带给他看的文件名。 */
  pendingShow: string
  /** 上一次真正送出的时刻（空串 = 从没送过）。 */
  lastAt: string
  /** 上一次送出的那句。 */
  lastText: string
  /** 上一次送出的那样东西。 */
  lastShow: string
  /** 他看过了没有。 */
  unread: boolean
  /** 没送成的原因。 */
  lastReason: string
}

/** 整份投影。 */
export interface EvolutionDocument {
  status: DayStatusView
  diary: DiaryItemView[]
  works: WorkItemView[]
  /** 她手上攒着的事（她自己的 todo.md）。 */
  threads: string[]
  /** 她自己整理的结果：攒着的候选 + 上次跑完的痕迹。 */
  grow: GrowView
  /** 她主动留给你的东西。 */
  tell: TellView
  /** 一次性文件传输（点了下载才有；下完就空）。 */
  transfer: { name: string; mime: string; base64: string }
  /**
   * 命令槽：`op` 想做的那件事，`value` 它的载荷（哪一天 / 几个 / 哪个名字）。
   *
   * 为什么叫 `value` 而不叫 `date`：这个槽装过"打开哪天""改成几次""删哪条"，
   * 早就不是日期专用的一条通道了 —— 名字跟用途对不上，下一个人一定会读错。
   */
  request: { op: string; value: string }
  notice: string
}

/** 空投影（通道还没读到时用它，界面据此显示"读不到"）。 */
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
      busy: false,
      lastError: '',
      lastSettleError: '',
      lastTurnTools: 0,
      busySince: '',
      lastAppraise: '',
      roomText: '',
      roomPath: '',
      roomTarget: '',
    },
    diary: [],
    works: [],
    threads: [],
    grow: { candidates: [], lastRun: { at: '', wrote: [], queued: [], note: '' } },
    tell: { pending: '', pendingShow: '', lastAt: '', lastText: '', lastShow: '', unread: false, lastReason: '' },
    transfer: { name: '', mime: '', base64: '' },
    request: { op: '', value: '' },
    notice: '',
  }
}

/**
 * 把宿主投影收窄成界面能用的形状。
 *
 * 逐字段兜底而不是 `as`：宿主升了新字段、bundle 还是旧的时，界面照常渲染旧字段，
 * 不会因为一个 `undefined.energy` 把整块面板带下去。
 * @param value - 命名空间里的原文。
 * @returns 收窄后的文档。
 */
export function asEvolutionDocument(value: unknown): EvolutionDocument {
  const empty = emptyEvolutionDocument()
  if (typeof value !== 'object' || value === null) return empty
  const raw = value as Partial<Record<keyof EvolutionDocument, unknown>>
  const status = (typeof raw.status === 'object' && raw.status !== null ? raw.status : {}) as Record<string, unknown>
  const diary = Array.isArray(raw.diary)
    ? raw.diary.map((item) => {
        const entry = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>
        return {
          date: typeof entry.date === 'string' ? entry.date : '',
          opened: entry.opened === true,
          openedAt: typeof entry.openedAt === 'string' ? entry.openedAt : '',
          noticedAt: typeof entry.noticedAt === 'string' ? entry.noticedAt : '',
          text: typeof entry.text === 'string' ? entry.text : '',
        }
      })
    : []
  const works = Array.isArray(raw.works)
    ? raw.works.map((item) => {
        const entry = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>
        return {
          name: typeof entry.name === 'string' ? entry.name : '',
          size: typeof entry.size === 'number' ? entry.size : 0,
          updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : '',
          kind: typeof entry.kind === 'string' ? entry.kind : 'other',
          preview: typeof entry.preview === 'string' ? entry.preview : '',
        }
      })
    : []
  const request = (typeof raw.request === 'object' && raw.request !== null ? raw.request : {}) as Record<string, unknown>
  const growRaw = (typeof raw.grow === 'object' && raw.grow !== null ? raw.grow : {}) as Record<string, unknown>
  const candidates = Array.isArray(growRaw.candidates)
    ? growRaw.candidates.map((item) => {
        const entry = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>
        return {
          text: typeof entry.text === 'string' ? entry.text : '',
          about: typeof entry.about === 'string' ? entry.about : 'self',
          section: typeof entry.section === 'string' ? entry.section : '',
          count: typeof entry.count === 'number' ? entry.count : 0,
          days: typeof entry.days === 'number' ? entry.days : 0,
        }
      })
    : []
  const lastRunRaw = (typeof growRaw.lastRun === 'object' && growRaw.lastRun !== null ? growRaw.lastRun : {}) as Record<string, unknown>
  const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((line): line is string => typeof line === 'string') : [])
  const tellRaw = (typeof raw.tell === 'object' && raw.tell !== null ? raw.tell : {}) as Record<string, unknown>
  return {
    status: {
      enabled: status.enabled === true,
      started: status.started === true,
      sleeping: status.sleeping === true,
      energy: typeof status.energy === 'number' ? status.energy : 0,
      dayCount: typeof status.dayCount === 'number' ? status.dayCount : 0,
      maxPerDay: typeof status.maxPerDay === 'number' ? status.maxPerDay : 0,
      lastWakeAt: typeof status.lastWakeAt === 'string' ? status.lastWakeAt : '',
      nextAt: typeof status.nextAt === 'string' ? status.nextAt : '',
      taskReady: status.taskReady === true,
      busy: status.busy === true,
      lastError: typeof status.lastError === 'string' ? status.lastError : '',
      lastSettleError: typeof status.lastSettleError === 'string' ? status.lastSettleError : '',
      lastTurnTools: typeof status.lastTurnTools === 'number' ? status.lastTurnTools : 0,
      busySince: typeof status.busySince === 'string' ? status.busySince : '',
      lastAppraise: typeof status.lastAppraise === 'string' ? status.lastAppraise : '',
      roomText: typeof status.roomText === 'string' ? status.roomText : '',
      roomPath: typeof status.roomPath === 'string' ? status.roomPath : '',
      roomTarget: typeof status.roomTarget === 'string' ? status.roomTarget : '',
    },
    diary,
    works,
    threads: Array.isArray(raw.threads) ? raw.threads.filter((line) => typeof line === 'string') : [],
    grow: {
      candidates,
      lastRun: {
        at: typeof lastRunRaw.at === 'string' ? lastRunRaw.at : '',
        wrote: strings(lastRunRaw.wrote),
        queued: strings(lastRunRaw.queued),
        note: typeof lastRunRaw.note === 'string' ? lastRunRaw.note : '',
      },
    },
    tell: {
      pending: typeof tellRaw.pending === 'string' ? tellRaw.pending : '',
      pendingShow: typeof tellRaw.pendingShow === 'string' ? tellRaw.pendingShow : '',
      lastAt: typeof tellRaw.lastAt === 'string' ? tellRaw.lastAt : '',
      lastText: typeof tellRaw.lastText === 'string' ? tellRaw.lastText : '',
      lastShow: typeof tellRaw.lastShow === 'string' ? tellRaw.lastShow : '',
      unread: tellRaw.unread === true,
      lastReason: typeof tellRaw.lastReason === 'string' ? tellRaw.lastReason : '',
    },
    transfer: {
      name: typeof (raw.transfer as { name?: unknown } | undefined)?.name === 'string' ? String((raw.transfer as { name?: unknown }).name) : '',
      mime: typeof (raw.transfer as { mime?: unknown } | undefined)?.mime === 'string' ? String((raw.transfer as { mime?: unknown }).mime) : '',
      base64: typeof (raw.transfer as { base64?: unknown } | undefined)?.base64 === 'string' ? String((raw.transfer as { base64?: unknown }).base64) : '',
    },
    request: {
      op: typeof request.op === 'string' ? request.op : '',
      value: typeof request.value === 'string' ? request.value : '',
    },
    notice: typeof raw.notice === 'string' ? raw.notice : '',
  }
}

/** 工作台用到的通道：`describe` 读投影，`replace` 写命令槽。 */
export type EvolutionChannel = Pick<PersonaChannel, 'describe' | 'replace'>

export type { RemoteOutcome }
