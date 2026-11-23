/**
 * 记忆工作台的**设置 RPC 通道**与命名空间名。
 *
 * 与 `persona-channel.ts` 同一取舍：官方生成的 Remote 类型面依赖一串本仓库没装的包，缺一个就
 * 整体退化成 `any`（"有类型"只是假象），所以按官方契约声明成**结构类型**。
 *
 * 通道用到两件事：`describe()` 读投影；`replace()` 把命令写进同一个命名空间
 * （命令的执行权在宿主，见 `section-runtime` 的 `consume`）。
 * @module deepseek-harness-humanity/client/memory-channel
 */
import type { PersonaChannel, PersonaNamespaceView, RemoteOutcome } from './persona-channel.js'

/**
 * 记忆命名空间。
 *
 * **必须**与宿主 `src/host/memory/section.ts` 的 `MEMORY_NAMESPACE` 相同。这里重复一个字面量
 * 而不是 import 宿主模块（那会把整棵宿主树带进浏览器 bundle）。
 */
export const MEMORY_NAMESPACE = 'humanity-memory'

/** 记忆工作台用到的通道：`describe` 读投影，`replace` 写命令槽。 */
export type MemoryChannel = Pick<PersonaChannel, 'describe' | 'replace'>

export type { PersonaNamespaceView, RemoteOutcome }
