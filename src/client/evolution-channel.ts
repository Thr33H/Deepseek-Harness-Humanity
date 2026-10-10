/**
 * 自进化工作台的**设置 RPC 通道**与命名空间名。
 *
 * 与 `memory-channel.ts` 同一取舍：官方 Remote 类型面依赖一串本仓库没装的包，缺一个就整体
 * 退化成 `any`，所以按官方契约声明成**结构类型**（`describe` / `update` 两个方法）。
 *
 * 契约出处（DSH 0.1.5-rc.2，`dsh-api-settings-controller/lib/typert.remote-client.d.ts`）：
 * `settings.describe()` / `settings.update(ns, patch, expectedRevision)`。
 * @module deepseek-harness-humanity/client/evolution-channel
 */
import type { PersonaChannel } from './persona-channel.js'

/**
 * 自进化命名空间。
 *
 * **必须**与宿主 `src/host/evolution/constants.ts` 的 `EVOLUTION_NAMESPACE` 相同。
 * 这里重复一个字面量而不是 import 宿主模块（那会把整棵宿主树带进浏览器 bundle）；
 * 一致性由 `test/client-evolution.test.mjs` 直接比对两边构建产物来断言。
 */
export const EVOLUTION_NAMESPACE = 'humanity-evolution'

/** 工作台能发起的操作（与宿主 `evolution/ops.ts` 的 `EVOLUTION_OPS` 同一集合，同样由测试比对）。 */
export const EVOLUTION_OPS = [
  'run',
  'rescan',
  'approve',
  'reject',
  'delete',
  // M7 技能编辑（与宿主 ops.ts 同一集合，由 bundle 测试比对）。
  'skill-create',
  'skill-update',
  'skill-disable',
  'skill-enable',
] as const

/** 工作台能发起的操作。 */
export type EvolutionOp = (typeof EVOLUTION_OPS)[number]

/** 一条命令（与宿主 `EvolutionRequest` 同形；`op` 为空串表示"没有命令"）。 */
export interface EvolutionRequest {
  op: string
  id: string
  mode: string
  rescanKind: string
  rescanValue: string
}

/** 没有待执行命令时的取值。 */
export const EMPTY_EVOLUTION_REQUEST: EvolutionRequest = { op: '', id: '', mode: '', rescanKind: '', rescanValue: '' }

/** 自进化工作台用到的通道：`describe` 读投影，`update` 写命令或改调度/预算配置。 */
export type EvolutionChannel = Pick<PersonaChannel, 'describe' | 'update'>
