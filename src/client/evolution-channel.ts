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
}

/** 她留下的一样东西（只读）。 */
export interface WorkItemView {
  name: string
  size: number
  updatedAt: string
  kind: string
  preview: string
}

/** 整份投影。 */
export interface EvolutionDocument {
  status: DayStatusView
  diary: DiaryItemView[]
  works: WorkItemView[]
  /** 一次性文件传输（点了下载才有；下完就空）。 */
  transfer: { name: string; mime: string; base64: string }
  request: { op: string; date: string }
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
    },
    diary: [],
    works: [],
    transfer: { name: '', mime: '', base64: '' },
    request: { op: '', date: '' },
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
    },
    diary,
    works,
    transfer: {
      name: typeof (raw.transfer as { name?: unknown } | undefined)?.name === 'string' ? String((raw.transfer as { name?: unknown }).name) : '',
      mime: typeof (raw.transfer as { mime?: unknown } | undefined)?.mime === 'string' ? String((raw.transfer as { mime?: unknown }).mime) : '',
      base64: typeof (raw.transfer as { base64?: unknown } | undefined)?.base64 === 'string' ? String((raw.transfer as { base64?: unknown }).base64) : '',
    },
    request: {
      op: typeof request.op === 'string' ? request.op : '',
      date: typeof request.date === 'string' ? request.date : '',
    },
    notice: typeof raw.notice === 'string' ? raw.notice : '',
  }
}

/** 工作台用到的通道：`describe` 读投影，`replace` 写命令槽。 */
export type EvolutionChannel = Pick<PersonaChannel, 'describe' | 'replace'>

export type { RemoteOutcome }
