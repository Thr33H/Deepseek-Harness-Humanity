/**
 * 自有 Remote 数据面：0.1.7 上工作台读写宿主数据的**唯一通道**。
 *
 * ### 为什么必须自己提供
 *
 * 0.1.5 上工作台走 DSH 官方的设置 RPC（`ctx.remote.settings`）读写三个设置命名空间；0.1.7 把
 * settings 重构成"配置表单"（命名空间 = Loader 条目 id、值 = 该条目 Config 的投影），
 * `installSection / get / setSource` 全被删除，我们那三个命名空间**没有归属** ——
 * 官方迁移只把内容留在 `settings.yaml.imported` 里。
 *
 * ### 走哪条线（第一轮走错了，这里记下教训）
 *
 * 走**官方 Typert 网关**：`TypertRemoteService` + `@Remote`，wire 命名空间 `humanity`，
 * HTTP 面就是 `POST /api/humanity/<method>`。
 *
 * ⚠️ **第一轮的错误**：曾经写成 `ctx.inject(['connection'], …)`，再在回调里
 * `connection.rpc.handle('/humanity', …)`。那是**客户端**服务：组合树里 `id: connection` 是
 * `@deepseek-ai/dsh-client-connection`（跑在浏览器里），宿主侧这个注入回调永远不会触发，
 * 于是路由根本没注册，`POST /humanity/*` 落到别的路由返回 405。
 * **判断依据（可复核）**：在 `@deepseek-ai` 下各官方包的 `lib/index.js` 里全树 grep `super(ctx, "connection")`
 * 只有客户端那一份；官方宿主写法的唯一范本是网关自己（`dsh-api-gateway/lib/index.js:626`
 * 用 `ctx.inject(["connection","webServer"])` 注册的是 **WebSocket upgrade** 路由，不是普通 prefix 路由）。
 *
 * ### 网关怎么发现我们（无需任何代码生成）
 *
 * `dsh-api-gateway/lib/index.js:995-1064` 的 `resolveSrcDescriptor()` 遍历 `ctx.reflect.props`，
 * 找带 `typertRemote` 绑定的服务、读原型上的 `@Remote` 标记，参数名从方法源码里解析、编解码器
 * 一律 `src-json`（0.1.5 同形）。因此第三方插件**不需要**官方那套生成产物。
 * 参数名是解析出来的，所以方法形参只能是裸标识符（不许解构 / 默认值 / rest）。
 *
 * ### 语义
 *
 * 三个 endpoint 与客户端原有通道**逐一对应**（`describe` / `replace` / `update`），
 * 控制器与页面不动，只换"这条通道怎么走线"。
 *
 * ⚠️ 宿主 → 客户端的自定义事件推送**没有第三方 seam**（转发清单写死在 `dsh-api-remotes`），
 * 因此写操作**把最新投影作为返回值带回**，客户端写完直接用返回值。
 * @module humanity/data-plane
 */
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

import type { Log } from './log.js'
import { reportBootFailure } from './log.js'

/** 服务键，同时也是 wire 命名空间（`/api/humanity/<method>`）。 */
export const DATA_PLANE_NAMESPACE = 'humanity'

/** 一个命名空间对客户端的视图。 */
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

/**
 * 一个命名空间在数据面上的行为，由各模块（人格 / 记忆 / 自进化）注册。
 *
 * 三个方法只负责"把客户端的意图交给模块自己的校验与落盘路径"，数据面本身不认识业务字段。
 */
export interface DataNamespace {
  /** 命名空间名（= 客户端看到的 `ns`）。 */
  readonly ns: string
  /** 当前投影（宿主权威，客户端只读）。 */
  view(): { value: unknown; revision: number }
  /** 整份写入。修订号对不上时应抛错（乐观并发）。 */
  replace(value: unknown, expectedRevision: number | undefined): Promise<void>
  /** 深合并补丁。修订号对不上时应抛错。 */
  update(patch: Record<string, unknown>, expectedRevision: number | undefined): Promise<void>
}

/** 数据面入口（宿主内部用它注册命名空间；客户端只经 wire 调用）。 */
export interface DataPlane {
  /**
   * 注册一个命名空间。
   * @param namespace - 命名空间行为。
   * @returns 退订动作。
   */
  register(namespace: DataNamespace): () => void
  /** 已注册的命名空间名（排序后）。 */
  mounted(): string[]
}

/** 客户端写入被拒时抛这个；网关会把它折成 `gateway/internal` + 原文（不吞、不静默）。 */
export class DataPlaneRejected extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DataPlaneRejected'
  }
}

/**
 * 数据面服务本体。
 *
 * 构造即注册（`TypertRemoteService` 的契约），因此**不需要**任何注入回调：
 * 服务一存在，网关照 `ctx.reflect.props` 就能看到它并认领 `/api/humanity/*`。
 */
export class HumanityDataPlane extends TypertRemoteService {
  private readonly namespaces = new Map<string, DataNamespace>()

  /**
   * @param ctx - 本插件的上下文（服务注册在它的 fiber 上，随插件卸载自动摘除）。
   * @param log - 日志门面。
   */
  constructor(ctx: Context, log: Log) {
    super(ctx, DATA_PLANE_NAMESPACE)
    this.log = log
  }

  private readonly log: Log

  /**
   * 注册一个命名空间。
   * @param namespace - 命名空间行为。
   * @returns 退订动作（重复注册同名直接抛，避免"后注册的悄悄顶掉前一个"）。
   */
  register(namespace: DataNamespace): () => void {
    if (this.namespaces.has(namespace.ns)) throw new Error(`数据面命名空间 ${namespace.ns} 已被注册`)
    this.namespaces.set(namespace.ns, namespace)
    this.log.info(`数据面已挂载命名空间 ${namespace.ns}`)
    return () => {
      this.namespaces.delete(namespace.ns)
    }
  }

  /** 已注册的命名空间名（测试与诊断用）。 */
  mounted(): string[] {
    return [...this.namespaces.keys()].sort()
  }

  /**
   * 工作台读：列出所有命名空间的值与修订号。
   * @returns 描述结果。
   */
  @Remote('describe')
  async describe(): Promise<DescribeResult> {
    const namespaces = [...this.namespaces.values()]
      .sort((left, right) => left.ns.localeCompare(right.ns))
      .map((namespace) => this.viewOf(namespace))
    return { writable: true, namespaces }
  }

  /**
   * 工作台写：整份替换一个命名空间。
   * @param ns - 命名空间名。
   * @param section - 新的整份值。
   * @param expectedRevision - 客户端读到的修订号；对不上就拒绝（乐观并发）。
   * @returns 写入后的视图。
   */
  @Remote('replace')
  async replace(ns: string, section: Record<string, unknown>, expectedRevision: number | undefined): Promise<NamespaceView> {
    const namespace = this.require(ns)
    await namespace.replace(section, expectedRevision)
    return this.viewOf(namespace)
  }

  /**
   * 工作台写：把一个补丁深合并进命名空间（没提到的字段保持原样）。
   * @param ns - 命名空间名。
   * @param patch - 待合并的字段。
   * @param expectedRevision - 客户端读到的修订号；对不上就拒绝。
   * @returns 写入后的视图。
   */
  @Remote('update')
  async update(ns: string, patch: Record<string, unknown>, expectedRevision: number | undefined): Promise<NamespaceView> {
    const namespace = this.require(ns)
    try {
      await namespace.update(patch, expectedRevision)
    } catch (error) {
      // 客户端拿到显式失败（不再是"页面莫名空白"），同时留一条日志便于事后对账。
      this.log.warn(`数据面 update(${ns}) 被拒：${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
    return this.viewOf(namespace)
  }

  private require(ns: string): DataNamespace {
    const namespace = this.namespaces.get(ns)
    if (namespace === undefined) {
      throw new DataPlaneRejected(
        `数据面没有命名空间 ${JSON.stringify(ns)}（已挂载：${this.mounted().join(', ') || '无'}）`,
      )
    }
    return namespace
  }

  private viewOf(namespace: DataNamespace): NamespaceView {
    const { value, revision } = namespace.view()
    return { ns: namespace.ns, value, revision }
  }
}

/**
 * 把数据面挂进插件。
 *
 * 失败**必须响**（验收项 4）：构造失败时既走日志门面，也直写 stdout —— 容器里
 * `ctx.logger` 的输出不进 `docker logs`，只写日志等于静默（第一轮就是这样漏掉的）。
 * @param ctx - 本插件的上下文。
 * @param log - 日志门面。
 * @returns 数据面；构造失败时为 `undefined`（工作台会显示未就绪，而不是假装可用）。
 */
export function installDataPlane(ctx: Context, log: Log): HumanityDataPlane | undefined {
  try {
    const plane = new HumanityDataPlane(ctx, log)
    log.info(`数据面已挂载：POST /api/${DATA_PLANE_NAMESPACE}/<method>（describe / replace / update）`)
    return plane
  } catch (error) {
    reportBootFailure(log, `数据面挂载失败（工作台将不可读写）：POST /api/${DATA_PLANE_NAMESPACE}/<method> 不可用`, error)
    return undefined
  }
}
