/**
 * 宿主 → 命名空间的**投影补丁**：把存储现状与生效策略拼成一次 `settings.update` 的载荷。
 *
 * 为什么从 `section.ts` 拆出来：接线文件回答"什么时候写"，这里回答"写什么"。两者混在一起时，
 * 一个"投影该包含哪些字段"的问题要在订阅回调与队列逻辑里穿行才能回答。
 * 纯函数，可直接单测。
 * @module humanity/memory/projection
 */
import type { MemoryAdvancedConfig } from '../config.js'
import { EMPTY_REQUEST, type MemoryRequest } from './ops.js'
import { policyViewOf, viewOf } from './section-doc.js'
import type { MemoryEntry, MemoryPolicy } from './types.js'

/** 一次投影的全部输入。 */
export interface ProjectionInput {
  /** 存储现状（`MemoryStore.list()` 的快照）。 */
  entries: readonly MemoryEntry[]
  /** 当前生效策略。 */
  policy: MemoryPolicy
  /** 配置里的高级开关原值；未接线时省略。 */
  advanced?: MemoryAdvancedConfig
  /** 极简模式探测结果：`probed && blocked` 才提示（宁缺勿误报）。 */
  degraded: boolean
  /** 上一次命令的结论，由宿主写、工作台原样展示。 */
  notice: string
  /** 本次投影是否可以把命令槽清回空。 */
  clearRequest: boolean
}

/**
 * 拼出投影补丁。
 *
 * `request` 是否出现由 {@link shouldClearRequest} 决定：不清空时**一个字都不写**，
 * 这样客户端在宿主执行期间留下的新命令不会被投影覆盖掉。
 * @param input - 存储现状与策略。
 * @returns 可直接交给 `settings.update` 的补丁（只含宿主拥有的字段）。
 */
export function projectionPatch(input: ProjectionInput): Record<string, unknown> {
  const { advanced, policy } = input
  return {
    entries: input.entries.map(viewOf),
    policy: policyViewOf(policy, advanced?.customized === true),
    degraded: input.degraded,
    // 开关显示的是**生效值**（来自 policy），不是配置里的原值（2026-09-26 审计 C6）：
    // 配置写着"三层全关但模式是 balanced"时宿主会按模式回退（`isDegenerateAdvanced`），
    // 于是旧投影出现"生效作用域：三层全在"与"三个开关全关"并排挂着，两个控件互相打脸，
    // 用户不知道该信哪个。开关与作用域标签现在同源于 policy，物理上不可能再分叉。
    // 用户拨开关时客户端会以这份生效值为底写回（见 `memory-config.ts`），等于顺手修好配置。
    advanced: {
      longTerm: policy.scopes['long-term'],
      work: policy.scopes.workspace,
      session: policy.scopes.session,
      maxInject: advanced?.maxInject ?? policy.injectLimit,
      decay: policy.decay,
    },
    notice: input.notice,
    ...(input.clearRequest ? { request: EMPTY_REQUEST } : {}),
  }
}

/**
 * 这次投影能不能清空命令槽。
 *
 * 两条守则都是为了**不弄丢客户端的命令**：
 * 1. `consumed` 是刚执行完的那条命令，只有槽里仍是**同一条**时才清；
 * 2. 槽里已经有新命令（客户端在宿主执行期间又点了一次）时返回 false ——
 *    那条命令由它自己的 `onChange` 负责，宿主不能替它做决定。
 * @param live - 命令槽当前值。
 * @param consumed - 刚执行完的命令；缺省表示这次投影不是由命令触发的。
 * @returns 可以清空时为 true。
 */
export function shouldClearRequest(live: MemoryRequest | undefined, consumed: MemoryRequest | undefined): boolean {
  if (live === undefined) return false
  if (live.op === '') return true
  return consumed !== undefined && live.op === consumed.op && live.fingerprint === consumed.fingerprint
}
