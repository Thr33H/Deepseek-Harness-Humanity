/**
 * 工作台与**自有数据面**之间的客户端通道。
 *
 * ### 它替掉了什么
 *
 * 0.1.5 上三个工作台通道走的是 DSH 官方的设置 RPC（`ctx.remote.settings.describe/replace/update`）。
 * 0.1.7 把 settings 重构成"配置表单"（命名空间 = Loader 条目 id），我们那四个命名空间没有归属，
 * 宿主改用自己的远端数据面承载（`TypertRemoteService` + `@Remote`，见 `src/host/data-plane.ts`），
 * 于是客户端也要换到同一条线上：`POST /api/humanity/<method>`。
 *
 * ### 走的调用面
 *
 * 客户端 `connection` 服务（`@deepseek-ai/dsh-client-connection` 的浏览器半边）提供
 * `rpc.call(channel, endpoint, payload, signal)`：POST `/api/humanity/describe`，
 * 信封 `{ type: 'client-request', rpcId, method: 'humanity/<method>', payload: { args } }`，
 * 返回 `{ ok: true, value }` / `{ ok: false, error }` —— 与我们原来的 `RemoteOutcome` 同形，
 * 所以控制器的 `if (!result.ok)` 分支一行都不用改。
 *
 * 为什么不走 `ctx.remote.humanity.*`（官方生成的 Remote 命名空间）：那条路要求每个命名空间有
 * **构建期生成的 strict codec**（客户端挂载时会校验，带参数的方法缺了直接抛），而第三方插件
 * 拿不到官方的生成管线。低层 `rpc.call` 是官方自己也在用的调用面，且两版同形。
 *
 * ### 两段式写入（记忆/自进化）
 *
 * 客户端只把**命令**放进命令槽（`request`），宿主消费完才更新投影。0.1.5 靠官方转发的
 * `settings/document-updated` 事件知道"第二段写完了"；**第三方没有事件推送 seam**
 * （转发清单写死在 `dsh-api-remotes`），所以这里退化为"写完再读一次、必要时短暂重读"，
 * 拿到的是**命令消费后**的投影。残留项已登记在 `docs/reports/VERIFY-ADAPT-017-*.md`。
 * @module deepseek-harness-humanity/client/plane-channel
 */

/** 远端调用的返回信封（与 `@deepseek-ai/dsh-typert-protocol` 的 `RemoteResult` 同形）。 */
export type RemoteOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly message: string } }

/** 一个命名空间在客户端看到的视图（`revision` 必须原样带回，宿主据此做乐观并发）。 */
export interface NamespaceView {
  readonly ns: string
  readonly value: unknown
  readonly revision: number
}

/** `describe` 的返回。 */
export interface DescribeResult {
  readonly writable: boolean
  readonly namespaces: readonly NamespaceView[]
}

/** 三个通道共用的形状（人格 / 记忆 / 自进化在客户端完全同构）。 */
export interface PlaneChannel {
  describe(): Promise<RemoteOutcome<DescribeResult>>
  replace(
    ns: string,
    section: Record<string, unknown>,
    expectedRevision: number | undefined,
  ): Promise<RemoteOutcome<NamespaceView>>
  update(
    ns: string,
    patch: Record<string, unknown>,
    expectedRevision: number | undefined,
  ): Promise<RemoteOutcome<NamespaceView>>
}

/** 低层 RPC 调用面（只声明我们用到的那一个方法）。 */
export interface RpcCaller {
  call(
    channel: string,
    endpoint: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<RemoteOutcome<unknown>>
}

/** 命令消费的等待窗口：客户端写完等这么久再重读一次（见文件头"两段式写入"）。 */
const COMMAND_SETTLE_MS = 250

/** 命令槽类命名空间（需要等宿主消费完再读）。 */
const COMMAND_NAMESPACES = ['humanity-memory', 'humanity-evolution']

/** 等一会儿；`setTimeout` 在浏览器与 Node 里都有。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * 造一个走自有数据面的通道。
 * @param rpc - 客户端 `connection.rpc`。
 * @returns 与旧设置通道同形的三个方法。
 */
export function createPlaneChannel(rpc: RpcCaller): PlaneChannel {
  const call = async <T>(endpoint: string, args: Record<string, unknown>): Promise<RemoteOutcome<T>> => {
    try {
      return (await rpc.call('/api', `humanity/${endpoint}`, { args })) as RemoteOutcome<T>
    } catch (error) {
      // 传输层异常（断线、HTTP 5xx）也折成同一个信封：控制器只认 `ok` 分支。
      return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } }
    }
  }

  /** 写入后：命令槽类命名空间要等宿主消费完再读一次，否则工作台停在中间态（见文件头）。 */
  const settle = async (ns: string, written: RemoteOutcome<NamespaceView>): Promise<RemoteOutcome<NamespaceView>> => {
    if (!written.ok || !COMMAND_NAMESPACES.includes(ns)) return written
    await delay(COMMAND_SETTLE_MS)
    const fresh = await call<DescribeResult>('describe', {})
    if (!fresh.ok) return written
    const view = fresh.value.namespaces.find((candidate) => candidate.ns === ns)
    return view === undefined ? written : { ok: true, value: view }
  }

  return {
    describe: () => call<DescribeResult>('describe', {}),
    replace: async (ns, section, expectedRevision) =>
      settle(ns, await call<NamespaceView>('replace', { ns, section, expectedRevision })),
    update: async (ns, patch, expectedRevision) =>
      settle(ns, await call<NamespaceView>('update', { ns, patch, expectedRevision })),
  }
}
