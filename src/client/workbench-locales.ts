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
  'workbench.titleHint': '人格、情绪、记忆，和她自己的时间，统一在这里看。各模块的开关在 DSH 设置里（搜 "Humanity"）。',
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
  // 自进化页（她自己的时间）。
  'workbench.evolution.tab': '自进化',
  'workbench.evolution.today': '她的今天',
  'workbench.evolution.todayHint':
    '她自己的一天：醒来几次、还剩多少力气、下一次什么时候醒。她不会闲聊时被叫醒，安静一阵之后才有她自己的时间。',
  'workbench.evolution.notStarted': '人格还没封存，她还没有开始过日子。',
  'workbench.evolution.field.state': '现在',
  'workbench.evolution.field.energy': '精力',
  'workbench.evolution.field.wakes': '今天醒过',
  'workbench.evolution.field.lastWake': '上一次醒',
  'workbench.evolution.field.nextWake': '下一次醒',
  'workbench.evolution.busy': '（你正在跟她说话，闹钟压着）',
  'workbench.evolution.state.awake': '醒着',
  'workbench.evolution.state.sleeping': '在睡',
  'workbench.evolution.energy.fresh': '还有力气（{value}/100）',
  'workbench.evolution.energy.ok': '还行（{value}/100）',
  'workbench.evolution.energy.tired': '有点累（{value}/100）',
  'workbench.evolution.energy.spent': '快没力气了（{value}/100）',
  'workbench.evolution.wakesValue': '{count} 次（上限 {max} 次）',
  'workbench.evolution.cap.aria': '一天最多醒几次（回车生效）',
  'workbench.evolution.error': '上一次没排上：{reason}',
  'workbench.evolution.diary.title': '她的日记',
  'workbench.evolution.diary.hint':
    '一天一篇，用她自己的口气写。默认是合着的 —— 只显示日期；翻开之后那一天的正文才给你看，而且翻了就是翻了。',
  'workbench.evolution.diary.empty': '还没有写过日记。她睡下的时候才收一天。',
  'workbench.evolution.diary.open': '翻开',
  'workbench.evolution.diary.confirm': '翻开就收不回去了，确定？',
  'workbench.evolution.diary.confirmYes': '确认翻开',
  'workbench.evolution.diary.confirmNo': '算了',
  'workbench.evolution.diary.openedAt': '在 {time} 被翻开',
  'workbench.evolution.diary.unnoticed': '她还没发现',
  'workbench.evolution.diary.noticed': '她在 {time} 知道了',
  // 她留下的东西。
  'workbench.evolution.works.title': '她留下的东西',
  'workbench.evolution.works.hint':
    '她自己目录里的文件（写的东西、以后画的图）。文本能直接看；图片只能看到名字与大小——浏览器拿不到宿主上的文件。',
  'workbench.evolution.works.empty': '她还没留下什么。',
  'workbench.evolution.works.noPreview': '这一样只能看到名字与大小。',
  'workbench.evolution.works.download': '下载',
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
  'workbench.evolution.tab': 'Self-evolution',
  'workbench.evolution.today': 'Her day',
  'workbench.evolution.todayHint':
    'Her own day: how many times she woke, how much energy is left, when she wakes next. She is never woken while you two are talking.',
  'workbench.evolution.notStarted': 'The persona is not sealed yet; she has not started having days.',
  'workbench.evolution.field.state': 'Now',
  'workbench.evolution.field.energy': 'Energy',
  'workbench.evolution.field.wakes': 'Woke today',
  'workbench.evolution.field.lastWake': 'Last wake',
  'workbench.evolution.field.nextWake': 'Next wake',
  'workbench.evolution.busy': '(paused: you two are talking)',
  'workbench.evolution.state.awake': 'Awake',
  'workbench.evolution.state.sleeping': 'Asleep',
  'workbench.evolution.energy.fresh': 'Has energy ({value}/100)',
  'workbench.evolution.energy.ok': 'Fine ({value}/100)',
  'workbench.evolution.energy.tired': 'A little tired ({value}/100)',
  'workbench.evolution.energy.spent': 'Nearly spent ({value}/100)',
  'workbench.evolution.wakesValue': '{count} times (cap {max})',
  'workbench.evolution.cap.aria': 'Wakes per day cap (press Enter to apply)',
  'workbench.evolution.error': 'Last scheduling attempt failed: {reason}',
  'workbench.evolution.diary.title': 'Her diary',
  'workbench.evolution.diary.hint':
    'One entry a day, in her own voice. Closed by default — only the date shows; opening one reveals that day, and opening cannot be undone.',
  'workbench.evolution.diary.empty': 'No diary yet. She writes one when she goes to sleep.',
  'workbench.evolution.diary.open': 'Open',
  'workbench.evolution.diary.confirm': 'Opening cannot be undone. Sure?',
  'workbench.evolution.diary.confirmYes': 'Open it',
  'workbench.evolution.diary.confirmNo': 'Never mind',
  'workbench.evolution.diary.openedAt': 'opened at {time}',
  'workbench.evolution.diary.unnoticed': 'she has not noticed',
  'workbench.evolution.diary.noticed': 'she found out at {time}',
  'workbench.evolution.works.title': 'Things she left behind',
  'workbench.evolution.works.hint':
    'Files in her own directory (what she wrote, and later what she draws). Text can be read here; images only show name and size — the browser cannot reach files on the host.',
  'workbench.evolution.works.empty': 'She has not left anything yet.',
  'workbench.evolution.works.noPreview': 'Only the name and size are available.',
  'workbench.evolution.works.download': 'Download',
  'workbench.overviewHint':
    'These read the current real state; when something is not readable they say so instead of showing a guess. '
    + 'High-risk changes are confirmed in the conversation.',
} as const
