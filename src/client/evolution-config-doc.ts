/**
 * 自进化设置表单的**配置视图与解析**（从 `evolution-document.ts` 拆出：那边管投影文档，
 * 这边管顶层 `humanity` 配置里的 `modules.evolution`——两个数据源、两套兜底规则）。
 *
 * 防御性读取：缺字段回工程默认值（与宿主 `config.ts` schema 默认一致），不 NaN 进表单。
 * @module deepseek-harness-humanity/client/evolution-config-doc
 */

/** 调度/扫描/预算配置的界面视图（与宿主 `config.ts` 的 `modules.evolution` 同形）。 */
export interface EvolutionConfigView {
  schedule: {
    mode: string
    idleMinutes: number
    timeOfDay: string
    weekday: number
    monthDay: number
    timezone: string
  }
  scan: { includeSubSessions: boolean }
  budget: {
    maxSessionsPerRun: number
    maxEventsPerSession: number
    maxInputBytesPerCall: number
    maxOutputTokensPerCall: number
    dailyCallCap: number
  }
}

/** 配置默认值（与宿主 schema 默认一致；describe 未就绪时表单显示它）。 */
export function defaultEvolutionConfig(): EvolutionConfigView {
  return {
    schedule: { mode: 'idle', idleMinutes: 30, timeOfDay: '03:00', weekday: 1, monthDay: 1, timezone: '' },
    scan: { includeSubSessions: false },
    budget: {
      maxSessionsPerRun: 5,
      maxEventsPerSession: 200,
      maxInputBytesPerCall: 32768,
      maxOutputTokensPerCall: 4000,
      dailyCallCap: 20,
    },
  }
}

/** 防御性解析顶层配置里的 `modules.evolution`（缺字段回默认，不 NaN 进表单）。 */
export function asEvolutionConfig(value: unknown): EvolutionConfigView {
  const fallback = defaultEvolutionConfig()
  if (value === null || typeof value !== 'object') return fallback
  const record = value as Record<string, unknown>
  const schedule = (record.schedule ?? {}) as Record<string, unknown>
  const scan = (record.scan ?? {}) as Record<string, unknown>
  const budget = (record.budget ?? {}) as Record<string, unknown>
  const numOf = (input: unknown, fallbackValue: number): number =>
    typeof input === 'number' && Number.isFinite(input) ? input : fallbackValue
  return {
    schedule: {
      mode: typeof schedule.mode === 'string' ? schedule.mode : fallback.schedule.mode,
      idleMinutes: numOf(schedule.idleMinutes, fallback.schedule.idleMinutes),
      timeOfDay: typeof schedule.timeOfDay === 'string' ? schedule.timeOfDay : fallback.schedule.timeOfDay,
      weekday: numOf(schedule.weekday, fallback.schedule.weekday),
      monthDay: numOf(schedule.monthDay, fallback.schedule.monthDay),
      timezone: typeof schedule.timezone === 'string' ? schedule.timezone : '',
    },
    scan: { includeSubSessions: scan.includeSubSessions === true },
    budget: {
      maxSessionsPerRun: numOf(budget.maxSessionsPerRun, fallback.budget.maxSessionsPerRun),
      maxEventsPerSession: numOf(budget.maxEventsPerSession, fallback.budget.maxEventsPerSession),
      maxInputBytesPerCall: numOf(budget.maxInputBytesPerCall, fallback.budget.maxInputBytesPerCall),
      maxOutputTokensPerCall: numOf(budget.maxOutputTokensPerCall, fallback.budget.maxOutputTokensPerCall),
      dailyCallCap: numOf(budget.dailyCallCap, fallback.budget.dailyCallCap),
    },
  }
}
