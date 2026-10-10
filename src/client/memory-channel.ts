/**
 * 记忆工作台的**设置 RPC 通道**与命名空间名。
 *
 * 与 `persona-channel.ts` 同一取舍：官方生成的 Remote 类型面依赖一串本仓库没装的包，缺一个就
 * 整体退化成 `any`（"有类型"只是假象），所以按官方契约声明成**结构类型**。
 *
 * 契约出处（DSH 0.1.5-rc.2，`dsh-api-settings-controller/lib/typert.remote-client.d.ts`）：
 * `settings.describe()` / `settings.update(ns, patch, expectedRevision)`。
 * 记忆工作台只用这两个：读一次投影，写一条命令（`update` 是**合并补丁**，因此不会把宿主写的
 * `entries`/`policy` 一起覆盖掉 —— 这正是"字段所有权分开"能成立的前提）。
 * @module deepseek-harness-humanity/client/memory-channel
 */
import type { PersonaChannel, PersonaNamespaceView, RemoteOutcome } from './persona-channel.js'

/**
 * 记忆命名空间。
 *
 * **必须**与宿主 `src/host/memory/section.ts` 的 `MEMORY_NAMESPACE` 相同。这里重复一个字面量
 * 而不是 import 宿主模块（那会把整棵宿主树带进浏览器 bundle）；一致性由
 * `test/client-bundle.test.mjs` 直接比对两边的构建产物来断言。
 */
export const MEMORY_NAMESPACE = 'humanity-memory'

/** 工作台能发起的操作（与宿主 `ops.ts` 的 `MEMORY_OPS` 同一集合，同样由 bundle 测试比对）。 */
export const MEMORY_OPS = [
  'confirm',
  'reject',
  'archive',
  'restore',
  'pin',
  'unpin',
  'remove',
  'decay',
  'dedupe',
  'undo-dedupe',
  // 改归属（长期 ⇄ 区域）：用户 2026-09-26 令 —— 作用域判断不能只由模型说了算。
  'rescope',
] as const

/** 工作台能发起的操作。 */
export type MemoryOp = (typeof MEMORY_OPS)[number]

/** 一条命令。`op` 为空串表示"没有命令"。 */
export interface MemoryRequest {
  op: string
  fingerprint: string
  /** `rescope` 的目标作用域（`long-term` / `workspace`）。 */
  scope: string
  /** `rescope` 的目标区域 id。 */
  ownerId: string
}

/** 记忆工作台用到的通道：`describe` 读投影，`update` 写命令或改模式。 */
export type MemoryChannel = Pick<PersonaChannel, 'describe' | 'update'>

export type { PersonaNamespaceView, RemoteOutcome }
