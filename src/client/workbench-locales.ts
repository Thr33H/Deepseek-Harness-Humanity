/**
 * 工作台外壳的文案（总览四项 / 页面清单），中英各一份。
 *
 * 为什么单独一个文件：`locales.ts` 的正文是**人格页**文案，外壳文案涨到几十条后
 * 混在一起会越过文件行数质量门（≤200 行）；按页面拆开是 `memory-locales` /
 * `evolution-locales` 已经在用的做法。
 * @module deepseek-harness-humanity/client/workbench-locales
 */

/** 中文文案。 */
export const workbenchZh = {
  // 页面级说明收进标题旁的「?」（用户 2026-09-26）：界面上不再有整段说明文字，
  // 但"这是什么、开关在哪"必须仍然问得到 —— 只是从"一直占着版面"改成"悬停才出现"。
  'workbench.titleHint':
    '人格、记忆、自进化与梦境，统一在这里配置。'
    + '各模块的开关在 DSH 设置里（搜 "Humanity"）。',
  'workbench.overview': '总览',
  'workbench.metric.name': '姓名',
  'workbench.metric.nameEmpty': '还没设置',
  'workbench.metric.policy': '当前策略摘要',
  'workbench.metric.policyHint': '记忆模式与自进化触发方式，读的是当前生效的配置。',
  'workbench.metric.activity': '最近行为',
  'workbench.metric.activityHint': '最后一次后台整理的时刻与结果；失败会如实写在这里。',
  'workbench.metric.usage': '消耗',
  'workbench.metric.usageHint':
    '只统计我们真记账的数字：今日后台调用次数与 token。'
    + '余额查不到：预付套餐的剩余额度只在阿里云百炼控制台的「模型用量」里，API 不暴露。',
  // 通道没就绪时如实说读不到：这里显示的每一个值都来自宿主投影，**不填推定数字**
  // （写死或估算的数字会被当成真实状态读，那比空着更糟——M1 的原始教训）。
  'workbench.metric.unavailable': '暂时读不到',
  'workbench.state.loading': '加载中…',
  'workbench.state.unavailable': '暂时读不到（设置服务没接上，或 Humanity 模块被关掉了）。',
  'workbench.metric.noActivity': '还没有运行记录',
  'workbench.metric.policyValue': '记忆 {memory} · 自进化 {evolution}',
  'workbench.metric.activityValue': '{time} · {status}',
  'workbench.metric.usageValue': '今日 {calls} / {cap} 次调用 · {tokens} tokens',
  'workbench.overviewHint':
    '这几项读的是当前真实状态；读不到时如实说明，不填推测的数字。'
    + '高风险改动（例如整节删除人格可变层里仍有内容的小标题）在对话里确认。',
} as const

/** 英文。键集合必须与中文完全一致，否则 `satisfies` 会在编译期报错。 */
export const workbenchEn = {
  'workbench.titleHint':
    'Persona, memory, self-evolution and dreaming, all configured here. '
    + 'Per-module switches live in the DSH settings (search for "Humanity").',
  'workbench.overview': 'Overview',
  'workbench.metric.name': 'Name',
  'workbench.metric.nameEmpty': 'Not set yet',
  'workbench.metric.policy': 'Current policy',
  'workbench.metric.policyHint': 'Memory mode and evolution trigger, read from the configuration in effect.',
  'workbench.metric.activity': 'Recent activity',
  'workbench.metric.activityHint': 'When the last background tidy-up ran and how it ended; failures are reported here.',
  'workbench.metric.usage': 'Usage',
  'workbench.metric.usageHint':
    'Only what we actually meter: background calls and tokens used today. '
    + 'The prepaid balance is not readable: it is only visible in the Alibaba Cloud Model Studio console, not via API.',
  'workbench.metric.unavailable': 'Not available right now',
  'workbench.state.loading': 'Loading…',
  'workbench.state.unavailable': 'Not readable right now (the settings service is not attached, or the Humanity module is off).',
  'workbench.metric.noActivity': 'No runs yet',
  'workbench.metric.policyValue': 'Memory: {memory} · Evolution: {evolution}',
  'workbench.metric.activityValue': '{time} · {status}',
  'workbench.metric.usageValue': '{calls} / {cap} calls · {tokens} tokens today',
  'workbench.overviewHint':
    'These read the current real state; when something is not readable they say so instead of showing a guess. '
    + 'High-risk changes are confirmed in the conversation.',
} as const
