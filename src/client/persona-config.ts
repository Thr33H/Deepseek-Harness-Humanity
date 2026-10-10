/**
 * 工作台对**顶层配置**（命名空间 `humanity`）的读写。
 *
 * 为什么单独一个文件：人格文档（`humanity-persona`）与顶层配置是**两份不同的数据** ——
 * 前者有历史、封存、校验规则，后者只是几个开关。把开关的读写混进人格状态机，读代码的人会以为
 * 它也是人格卡的一部分（不会被封存、也不进历史）。
 *
 * 目前这里只有一项：独立判断底层指令（`independentJudgment`）。以后再加与人格注入相关的开关，也放这里。
 * @module deepseek-harness-humanity/client/persona-config
 */
import { HUMANITY_NAMESPACE, type PersonaChannel, type PersonaNamespaceView } from './persona-channel.js'

/** 顶层配置里我们关心的字段。字段名必须与宿主 `config.ts` 的 schema 一致。 */
export interface PersonaConfigView {
  independentJudgment: boolean
  revision: number
}

/**
 * 从 `describe()` 的结果里读独立判断开关。
 *
 * 默认 `true`：命名空间缺席 / 字段没写过时按 schema 默认值显示"开" —— 显示成"关"会让用户
 * 以为功能没生效，而事实相反。返回 `undefined` 表示"这次没读到"，调用方应保持上一次的值。
 * @param namespaces - describe 返回的命名空间视图列表。
 * @returns 开关值与修订号；读不到时为 undefined。
 */
export function readIndependentJudgment(
  namespaces: readonly PersonaNamespaceView[],
): { value: boolean; revision: number } | undefined {
  const view = namespaces.find((entry) => entry?.ns === HUMANITY_NAMESPACE)
  if (view === undefined) return undefined
  const value = view.value as { independentJudgment?: unknown } | undefined
  return { value: value?.independentJudgment !== false, revision: view.revision }
}

/**
 * 写入独立判断开关。
 *
 * 用 `update`（合并补丁）而不是 `replace`（整体替换）：后者只写这一个字段，会把用户对同一个命名空间的
 * 其它覆盖（模块开关、记忆模式…）全部退回默认值 —— 那是数据丢失。带上读取时的修订号，
 * 宿主的乐观并发控制才会在有人并发修改时拒绝这次写入。
 * @param channel - 设置 RPC 通道。
 * @param next - 目标状态。
 * @param expectedRevision - 读取时的修订号。
 * @returns 成功时是新的开关值与修订号；失败时是宿主给的原因。
 */
export async function writeIndependentJudgment(
  channel: PersonaChannel,
  next: boolean,
  expectedRevision: number | undefined,
): Promise<{ ok: true; view: PersonaConfigView } | { ok: false; message: string }> {
  const result = await channel.update(HUMANITY_NAMESPACE, { independentJudgment: next }, expectedRevision)
  if (result === undefined || result === null || result.ok !== true) {
    return { ok: false, message: result?.error?.message ?? '宿主没有返回可用的结果' }
  }
  // ⚠️ 宿主 `settings.update` 的契约是 **Promise<void>**（0.1.5-rc.2 源码逐字）：写回响应里
  // **没有**新值与新修订号。曾把响应当 view 解析 ⇒ 开关值恒被算成 true、修订号恒落 0
  // （真机症状：拨开关界面不动、服务端却已写入，刷新才对上）。改为写后回读：
  // describe 与 load 同一条正确读路径，值与修订号一次拿齐。
  const described = await channel.describe()
  if (described === undefined || described === null || described.ok !== true) {
    return { ok: false, message: described?.error?.message ?? '写入成功但回读失败，请刷新核对' }
  }
  const view = readIndependentJudgment(described.value.namespaces)
  if (view === undefined) return { ok: false, message: '回读不到顶层配置命名空间，请刷新核对' }
  return { ok: true, view: { independentJudgment: view.value, revision: view.revision } }
}
