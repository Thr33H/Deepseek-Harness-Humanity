/**
 * 工作台外壳的文案（总览 / 页面清单），中英各一份。
 *
 * 为什么单独一个文件：`locales.ts` 的正文是**人格页**文案，外壳文案混在一起会越过
 * 文件行数质量门（≤200 行）；按页面拆开是 `memory-locales` 已经在用的做法。
 * @module deepseek-harness-humanity/client/workbench-locales
 */

/** 中文文案。 */
export const workbenchZh = {
  // 页面级说明收进标题旁的「?」（用户 2026-09-26）：界面上不再有整段说明文字，
  // 但"这是什么、开关在哪"必须仍然问得到 —— 只是从"一直占着版面"改成"悬停才出现"。
  'workbench.titleHint': '人格、情绪与记忆，统一在这里看。各模块的开关在 DSH 设置里（搜 "Humanity"）。',
  'workbench.overview': '总览',
  'workbench.metric.name': '姓名',
  'workbench.metric.nameEmpty': '还没设置',
  'workbench.metric.memory': '记忆',
  'workbench.metric.memoryHint': '她自己的经历账里现在有多少条；读不到时如实说明，不填推测的数字。',
  // 通道没就绪时如实说读不到：这里显示的每一个值都来自宿主投影，**不填推定数字**
  // （写死或估算的数字会被当成真实状态读，那比空着更糟——M1 的原始教训）。
  'workbench.metric.unavailable': '暂时读不到',
  'workbench.state.loading': '加载中…',
  'workbench.state.unavailable': '暂时读不到（设置服务没接上，或 Humanity 模块被关掉了）。',
  'workbench.metric.memoryValue': '{count} 条',
  'workbench.overviewHint':
    '这几项读的是当前真实状态；读不到时如实说明，不填推测的数字。'
    + '高风险改动（例如整节删除人格信息里仍有内容的小标题）在对话里确认。',
} as const

/** 英文。键集合必须与中文完全一致，否则 `satisfies` 会在编译期报错。 */
export const workbenchEn = {
  'workbench.titleHint': 'Persona, emotion and memory, all in one place. Per-module switches live in the DSH settings (search for "Humanity").',
  'workbench.overview': 'Overview',
  'workbench.metric.name': 'Name',
  'workbench.metric.nameEmpty': 'Not set yet',
  'workbench.metric.memory': 'Memory',
  'workbench.metric.memoryHint': 'How many entries her own record of experiences holds; when it is not readable it says so instead of showing a guess.',
  'workbench.metric.unavailable': 'Not available right now',
  'workbench.state.loading': 'Loading…',
  'workbench.state.unavailable': 'Not readable right now (the settings service is not attached, or the Humanity module is off).',
  'workbench.metric.memoryValue': '{count} entries',
  'workbench.overviewHint':
    'These read the current real state; when something is not readable they say so instead of showing a guess. '
    + 'High-risk changes are confirmed in the conversation.',
} as const
