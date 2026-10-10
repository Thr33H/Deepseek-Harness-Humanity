/**
 * 设置 RPC 的**客户端通道类型**与工作台用的命名空间名。
 *
 * 为什么自己声明而不 import 官方类型：生成出来的 Remote 类型面要一串本仓库没有安装的 DSH 包
 * （typert-protocol / api-settings-controller / credentials…）才能解析；缺一个，
 * `ClientRemote['settings']` 就整体退化成 `any` —— 那时类型检查表面通过、实际什么都没查。
 * 与其依赖一条随时会断的链，不如把**我们真正调用的两个方法**按官方契约声明成结构类型
 * （与宿主 `store.ts` 声明 `DefineDomainModule` 同一取舍），并写明契约出处。
 *
 * 契约出处（DSH 0.1.5-rc.2，`dsh-api-settings-controller/lib/typert.remote-client.d.ts`）：
 * `settings.describe()` / `settings.replace(ns, section, expectedRevision)` / `settings.update(ns, patch, expectedRevision)`。
 * @module deepseek-harness-humanity/client/persona-channel
 */
// ⚠️ 这行 type-only 导入不是摆设：它把 `@deepseek-ai/cordis` 的模块图**完整载入**排在下面那条
// `declare module` 增补之前。缺了它时，增补的生效与否取决于根文件处理顺序（M5 新增客户端文件
// 改变了字母序，实测同一批文件换个顺序 Context 的成员就整批消失——cordis 的 context.d.ts 与
// fiber.d.ts 互为循环增补，对首次载入路径敏感）。显式导入让载入顺序不再靠运气。
import type {} from '@deepseek-ai/cordis'

/**
 * 人格命名空间。
 *
 * **必须**与宿主 `src/host/persona/section.ts` 的 `PERSONA_NAMESPACE` 相同。这里重复一个字面量
 * 而不是 import 那个模块：`section.ts` 会牵连 `model.ts`（schemastery）与 cordis 的服务面，
 * 整棵宿主树都不该进浏览器 bundle。两边一致性由 `test/client-bundle.test.mjs` 断言（直接比对
 * 宿主构建产物里的同一个常量），所以这不是"靠人记得改"。
 */
export const PERSONA_NAMESPACE = 'humanity-persona'

/**
 * Remote 调用的返回信封（与 `@deepseek-ai/dsh-typert-protocol` 的 `RemoteResult` 同形）。
 */
export type RemoteOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly message: string } }

/**
 * 设置命名空间的视图（只声明我们读的字段）。
 *
 * `revision` 是**必须**带回去的：它是"我读到的是第几版"，写回时带上，宿主的乐观并发控制
 * 才能在有人并发改动时拒绝这次写入，而不是静默覆盖。
 */
export interface PersonaNamespaceView {
  readonly ns: string
  /** 已解析（schema 默认 → 组合层 → 用户层）的命名空间值。 */
  readonly value: unknown
  /** 读取时的用户层修订号；写回时必须带回去。 */
  readonly revision: number
}

/**
 * 独立判断开关所在的命名空间（= 宿主 `settings.ts` 的 `SETTINGS_NAMESPACE`）。
 *
 * 与 `PERSONA_NAMESPACE` 同一约定：字面量在这里重复一份（不 import 宿主模块，否则整棵宿主树进 bundle），
 * 一致性由 `test/client-bundle.test.mjs` 断言。
 */
export const HUMANITY_NAMESPACE = 'humanity'

/** 设置 RPC 的客户端面：本工作台用到的全部通道（裁决 3：复用设置 RPC，不新建 gateway）。 */
export interface PersonaChannel {
  describe(): Promise<RemoteOutcome<{ readonly writable: boolean; readonly namespaces: readonly PersonaNamespaceView[] }>>
  replace(
    ns: string,
    section: Record<string, unknown>,
    expectedRevision: number | undefined,
  ): Promise<RemoteOutcome<PersonaNamespaceView>>
  /**
   * 把一个补丁**合并**进命名空间的用户层（官方语义：`update` 是深合并，不动没提到的字段）。
   *
   * 为什么开关用它而不是 `replace`：`replace` 是整体替换，只写一个字段会把用户对同一个命名空间的
   * 其它覆盖（模块开关、记忆模式…）全部退回默认值 —— 那是数据丢失。
   */
  update(
    ns: string,
    patch: Record<string, unknown>,
    expectedRevision: number | undefined,
  ): Promise<RemoteOutcome<PersonaNamespaceView>>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * 浏览器侧 Remote 面（由 shell 的 `@deepseek-ai/api-remotes` 客户端装配提供，
     * 该装配在 Web 组合里 `immediately: true`）。
     *
     * 只声明本工作台用到的那一个命名空间，理由见本文件头部：官方生成类型面依赖一串未安装的包，
     * import 进来会整体退化成 `any` —— 那样"有类型"只是假象。声明成结构类型后，
     * `ctx.inject(['remote', 'remote.settings'], …)` 里的 `sctx.remote.settings` 是**真的**被检查的。
     */
    readonly remote: { readonly settings: PersonaChannel }
  }
}
