/**
 * 记忆工作台看到的**文档形状**：条目视图、策略视图、命名空间 schema。
 *
 * 与接线分家的理由：这里回答"工作台看到的记忆长什么样"（形状 + 纯投影函数），
 * `section.ts` 回答"它怎么进出设置服务"。混在一起时，读形状要在订阅回调与错误处理里穿行。
 *
 * 字段的所有权写在 `section.ts` 的文件头：`entries`/`policy`/`notice` 只有宿主写，
 * `request` 只有客户端写。
 * @module humanity/memory/section-doc
 */
import Schema from '@deepseek-ai/schemastery'

import { EMPTY_REQUEST, type MemoryRequest } from './ops.js'
import type { MemoryEntry, MemoryPolicy } from './types.js'

/** 工作台看到的一条记忆（只给界面需要的叶子字段，不带内部记录）。 */
export interface MemoryEntryView {
  fingerprint: string
  scope: string
  /** 归属区域（长期记忆为空串）：工作台据此显示与切换归属。 */
  ownerId: string
  status: string
  content: string
  tags: string[]
  importance: number
  sensitive: boolean
  pinned: boolean
  /** 是否与别的记忆可能矛盾（工作台据此提示用户处理）。 */
  conflictCount: number
  updatedAt: string
}

/** 工作台看到的生效策略（P-030：工作台必须显示**当前生效**策略，而不是让用户猜）。 */
export interface MemoryPolicyView {
  mode: string
  scopes: Record<string, boolean>
  autoInject: boolean
  autoWrite: boolean
  injectLimit: number
  relevanceThreshold: number
  decay: boolean
  vector: boolean
  /** 高级开关是否被单独调过（工作台据此把模式显示成「自定义」）。 */
  customized: boolean
}

/** 命名空间里的文档（字段所有权见文件头）。 */
export interface MemoryDocument {
  entries: MemoryEntryView[]
  policy: MemoryPolicyView
  /** 配置里的高级开关原值（工作台编辑那一组开关用）。 */
  advanced: { longTerm: boolean; work: boolean; session: boolean; maxInject: number; decay: boolean }
  notice: string
  /** 这次组合会丢弃插件注入（极简模式）；工作台据此显示醒目的兼容性提示。 */
  degraded: boolean
  request: MemoryRequest
}

/** 命名空间 schema：只声明**形状**，不在这里表达语义规则（见文件头的 validate 说明）。 */
export const MemoryDocSchema = Schema.object({
  entries: Schema.array(
    Schema.object({
      fingerprint: Schema.string().default(''),
      scope: Schema.string().default(''),
      // 归属区域（长期为空串）：界面据此显示与切换归属。
      ownerId: Schema.string().default(''),
      status: Schema.string().default(''),
      content: Schema.string().default(''),
      tags: Schema.array(Schema.string()).default([]),
      importance: Schema.number().default(0),
      sensitive: Schema.boolean().default(false),
      pinned: Schema.boolean().default(false),
      conflictCount: Schema.number().default(0),
      updatedAt: Schema.string().default(''),
    }),
  ).default([]),
  policy: Schema.object({
    mode: Schema.string().default('balanced'),
    scopes: Schema.object({
      'long-term': Schema.boolean().default(true),
      workspace: Schema.boolean().default(true),
      session: Schema.boolean().default(true),
    }),
    autoInject: Schema.boolean().default(true),
    autoWrite: Schema.boolean().default(true),
    injectLimit: Schema.number().default(3),
    relevanceThreshold: Schema.number().default(0.35),
    decay: Schema.boolean().default(true),
    vector: Schema.boolean().default(false),
    customized: Schema.boolean().default(false),
  }),
  advanced: Schema.object({
    longTerm: Schema.boolean().default(true),
    work: Schema.boolean().default(true),
    session: Schema.boolean().default(true),
    maxInject: Schema.number().default(3),
    decay: Schema.boolean().default(true),
  }),
  notice: Schema.string().default(''),
  degraded: Schema.boolean().default(false),
  request: Schema.object({
    op: Schema.string().default(''),
    fingerprint: Schema.string().default(''),
    // 改归属（rescope）用：目标作用域与目标区域 id。
    scope: Schema.string().default(''),
    ownerId: Schema.string().default(''),
  }).default(EMPTY_REQUEST),
})

/** 一条记忆 → 界面视图。 */
export function viewOf(entry: MemoryEntry): MemoryEntryView {
  return {
    fingerprint: entry.dedupeKey,
    scope: entry.scope,
    // 归属区域（长期记忆为空串）：工作台据此显示与切换归属。
    ownerId: entry.ownerId,
    status: entry.status,
    content: entry.content,
    tags: [...entry.tags],
    importance: entry.importance,
    sensitive: entry.sensitive,
    pinned: entry.pinned,
    conflictCount: entry.conflictWith.length,
    updatedAt: entry.updatedAt,
  }
}

/**
 * 生效策略 → 界面视图（工作台显示的就是它，不另算一遍）。
 * @param policy - 生效策略。
 * @param customized - 高级开关是否被单独调过。
 */
export function policyViewOf(policy: MemoryPolicy, customized: boolean): MemoryPolicyView {
  return {
    mode: policy.mode,
    scopes: { ...policy.scopes },
    autoInject: policy.autoInject,
    autoWrite: policy.autoWrite,
    injectLimit: policy.injectLimit,
    relevanceThreshold: policy.relevanceThreshold,
    decay: policy.decay,
    vector: policy.vector,
    customized,
  }
}
