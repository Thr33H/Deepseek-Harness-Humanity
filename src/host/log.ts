import type { Context } from '@deepseek-ai/cordis'

/**
 * 本插件的日志门面。
 *
 * 为什么自己包一层：DSH 的 logger 在极简组合里可能不存在（本插件声明了零硬依赖，
 * 见 index.ts 的 `inject`）。这种情况下退回 `console`——宁可吵，也不能把故障静默吞掉，
 * 因为 G-002 要求「兼容失败必须留下明确原因」。
 *
 * 消息一律由调用方拼成完整字符串，额外参数只放错误对象本身，不做 printf 占位符替换，
 * 这样两条日志通路（logger 与 console）的输出完全一致。
 */
export interface Log {
  info(message: string, ...rest: unknown[]): void
  warn(message: string, ...rest: unknown[]): void
  error(message: string, ...rest: unknown[]): void
}

/** 把任意抛出物整理成一行可读原因。日志、工作台状态与测试断言都用它。 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 记一条警告，**连记日志本身失败也吞掉**。
 *
 * 为什么需要它：提示词注入的 `text` 回调跑在**没有 try/catch 的装配路径**上
 * （`dsh-system-prompt` 逐字 `section.text(context)`），所以注入内部必须收敛异常。
 * 但 `log.warn` 背后是 `ctx.logger`，插件 fiber 已卸载时它自己也会抛 —— 那就等于
 * 把刚吞下的异常又还回去了。这条路径上的取舍永远是"对话继续优先"（审计 S1-2）。
 * @param log - 日志门面。
 * @param message - 完整消息（不带占位符，见 `createLog` 的约定）。
 * @param error - 原始抛出物。
 */
export function warnSafely(log: Log, message: string, error: unknown): void {
  try {
    log.warn(message, error)
  } catch {
    // 日志都写不出去时只能静默：调用方已经处于"不能抛"的路径上。
  }
}

/** 以 `scope` 为前缀创建一个日志门面。 */
export function createLog(ctx: Context, scope = 'humanity'): Log {  const emit = (level: 'info' | 'warn' | 'error', message: string, rest: readonly unknown[]): void => {
    const logger = ctx.logger as
      | Partial<Record<'info' | 'warn' | 'error', (...args: unknown[]) => void>>
      | undefined
    const write = logger?.[level]
    if (write !== undefined) {
      write.call(logger, `${scope}: ${message}`, ...rest)
      return
    }
    const fallback = level === 'info' ? console.log : level === 'error' ? console.error : console.warn
    fallback(`${scope}: ${message}`, ...rest)
  }

  return {
    info: (message, ...rest) => emit('info', message, rest),
    warn: (message, ...rest) => emit('warn', message, rest),
    error: (message, ...rest) => emit('error', message, rest),
  }
}

/**
 * 报一次**启动级**失败：既走日志门面，也直写 stdout / stderr。
 *
 * 为什么不能只写日志：部署容器的 `ctx.logger` 输出**不进 `docker logs`**
 * （实测：靶机启动日志只有 23 行，插件所有 info/error 都不在里面）。只写日志 = 静默失败，
 * 而这正是本项目第一轮踩的坑（数据面根本没挂上，外部却看不到任何异常）。
 * 直写只允许出现在本文件（仓库约定：`console` 只在这里兜底）。
 * @param log - 日志门面。
 * @param message - 完整消息。
 * @param error - 原始抛出物。
 */
export function reportBootFailure(log: Log, message: string, error: unknown): void {
  try {
    log.error(message, error)
  } catch {
    // 日志门面自己出错也不能把启动带崩：下面还有一条直写路径。
  }
  console.error(`[humanity] ${message}`, error)
}
