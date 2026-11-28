/**
 * P-048 默认值快照的**唯一测试真源**。
 *
 * 此前 `host-config.test.mjs` 与 `host-apply.test.mjs` 各钉一份，加字段时两边都要改
 * （漏一边就是假红）。默认值本身仍是产品决策（改它 = 改 DECISIONS），这里只是把
 * "同一份快照"收敛到一个文件。
 *
 * 出处：DECISIONS P-048（模块默认）+ 2026-09-23 independentJudgment（用户定）
 * + 2026-11-23 自进化重做（她自己的时间：四个模块，醒来的节奏是上限 + 随机间隔）。
 */
export const EXPECTED_DEFAULTS = {
  enabled: true,
  independentJudgment: true,
  // 2026-11-23：时间基准从 `modules.evolution.schedule` 搬到顶层 ——
  // 它是整套共用的事实（情绪算清晨、记忆算"昨天"），不是某个模块的开关。
  timeZone: { auto: true, fixed: '' },
  modules: {
    // 0.1.13（用户 2026-10-09）：「删除的进历史，要有个保留天数，而不是永久保留」⇒ 新增这一项，
    // 默认 30 天（值取自 `persona/constants.ts` 的 HISTORY_RETENTION_DAYS，不漂移）。
    persona: { enabled: true, historyRetentionDays: 30 },
    // 0.1.18（用户 2026-11-17）：「让它有情感」——默认开，只在沉浸模式生效。
    emotion: { enabled: true },
    // 2026-11-20（记忆重构）：旧的 mode / 高级覆盖 / 三层作用域 / 向量检索整组删除 ——
    // 新的记忆只有"记不记、带几条、忘不忘"三件事。
    memory: {
      enabled: true,
      maxInject: 3,
      decay: true,
    },
    // 2026-11-23（自进化重做）：调度模式 / 扫描 / 预算随旧引擎一起删除。
    // 现在只有"一天最多醒几次 + 两次之间随机多久"。
    evolution: {
      enabled: true,
      maxWakesPerDay: 8,
      minGapMinutes: 40,
      maxGapMinutes: 150,
      // 2026-11-26：她的房间放在哪。空串 = 老位置（升级后不搬家）。
      room: '',
    },
  },
}
