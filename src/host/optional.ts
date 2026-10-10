import type { Log } from './log.js'

/**
 * 载入一个**可选**的 DSH 官方包。
 *
 * 为什么不用静态 `import`：DSH 升级后官方包可能改名、被拆分、整体移除，或只是版本不兼容。
 * 静态 import 会让本插件在 loader 阶段就加载失败，把 DSH 主体一起拖下水。G-002 要求
 * 「即使不兼容也要自己安全降级/禁用并留下日志，不能把整个 DSH 带崩」，所以宿主半边
 * 所有**非必需**的官方依赖都必须从这里进来：失败只关掉对应子功能，并留下原因。
 *
 * 类型由调用方以结构化接口声明（`loadOptional<{ open(...): ... }>`），因此这里不需要、
 * 也不应该把 DSH 的类型面固化进来。
 * @param specifier - 官方包名。
 * @param log - 调用方日志门面；失败原因写在这里。
 * @returns 模块命名空间；不可用时返回 `undefined`。
 */
export async function loadOptional<T>(specifier: string, log: Log): Promise<T | undefined> {
  try {
    return (await import(specifier)) as T
  } catch (error) {
    log.warn(`可选依赖 ${specifier} 不可用，相关子功能已关闭`, error)
    return undefined
  }
}
