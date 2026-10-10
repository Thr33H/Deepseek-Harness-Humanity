/**
 * P-048 默认值快照的**唯一测试真源**。
 *
 * 此前 `host-config.test.mjs` 与 `host-apply.test.mjs` 各钉一份，M5 加 evolution
 * 调度/扫描/预算字段时两边都要改（漏一边就是假红）。默认值本身仍是产品决策
 * （改它 = 改 DECISIONS），这里只是把"同一份快照"收敛到一个文件。
 *
 * 出处：DECISIONS P-048（模块默认）+ 2026-09-23 independentJudgment（用户定）
 * + 2026-09-25 M5 按 P-035/P-036/P-051 的既有工程默认补 evolution 细项
 * （空闲 30 分钟、每日 03:00、周一、1 日、只扫主会话、预算从低——逐项出自冻结决策，非新裁决）。
 */
export const EXPECTED_DEFAULTS = {
  enabled: true,
  independentJudgment: true,
  modules: {
    // 0.1.13（用户 2026-10-09）：「删除的进历史，要有个保留天数，而不是永久保留」⇒ 新增这一项，
    // 默认 30 天（值取自 `persona/constants.ts` 的 HISTORY_RETENTION_DAYS，不漂移）。
    persona: { enabled: true, historyRetentionDays: 30 },
    memory: {
      mode: 'balanced',
      advanced: {
        customized: false,
        longTerm: true,
        work: true,
        session: true,
        maxInject: 3,
        decay: true,
        // 0.1.10（B2）：衰减窗口接成可配项，默认仍是 90 天（值取自 memory/constants.ts，不漂移）。
        decayUnusedDays: 90,
        vector: false,
      },
    },
    evolution: {
      enabled: true,
      schedule: { mode: 'idle', idleMinutes: 30, timeOfDay: '03:00', weekday: 1, monthDay: 1, timezone: '' },
      scan: { includeSubSessions: false },
      budget: {
        maxSessionsPerRun: 5,
        maxEventsPerSession: 200,
        maxInputBytesPerCall: 32768,
        maxOutputTokensPerCall: 4000,
        dailyCallCap: 20,
      },
    },
    dream: { enabled: true },
  },
}
