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
  'workbench.evolution.field.lastTurn': '上一轮她做了什么',
  'workbench.evolution.lastTurn.tools': '动了手：调了 {count} 次工具',
  'workbench.evolution.lastTurn.talk': '只说了话，没动手',
  'workbench.evolution.appraise.applied': '自评 {count} 条（{targets}）',
  'workbench.evolution.appraise.none': '自评：看了，但没动心',
  'workbench.evolution.appraise.skipped': '自评没跑（情绪模块没接上）',
  'workbench.evolution.busy': '（你正在跟她说话，闹钟压着',
  'workbench.evolution.busySince': '从 {time} 起）',
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
  'workbench.evolution.diary.settleFailed': '上一次收账没写成：{reason}',
  'workbench.evolution.diary.empty': '还没有写过日记。她睡下的时候才收一天。',
  'workbench.evolution.diary.open': '翻开',
  'workbench.evolution.diary.confirm': '翻开就收不回去了，确定？',
  'workbench.evolution.diary.confirmYes': '确认翻开',
  'workbench.evolution.diary.confirmNo': '算了',
  'workbench.evolution.diary.openedAt': '在 {time} 被翻开',
  'workbench.evolution.diary.unnoticed': '她还没发现',
  'workbench.evolution.diary.noticed': '她在 {time} 知道了',
  // 她留给你的（主动找你说的话）。
  'workbench.evolution.tell.title': '她留给你的',
  'workbench.evolution.tell.hint':
    '她自己待着的时候，可以主动找你说一句（或给你看一样东西）。那句话会送到你们说话的那个会话里；这一块是留底——你没看过的那次会标出来。',
  'workbench.evolution.tell.pending': '她有一句还没送出去的话（等你闲下来才送）',
  'workbench.evolution.tell.lastAt': '她在 {time} 找过你',
  'workbench.evolution.tell.withWork': '还给你看了 {name}',
  'workbench.evolution.tell.onlyWork': '（没说话，只想让你看样东西）',
  'workbench.evolution.tell.unread': '你还没看',
  'workbench.evolution.tell.seen': '你看过了',
  'workbench.evolution.tell.reason': '没送成：{reason}',
  'workbench.evolution.tell.empty': '她还没主动找过你。',
  // 她自己整理（信息层）。
  'workbench.evolution.grow.title': '她自己整理',
  'workbench.evolution.grow.hint':
    '每天收账之后，她会把这一天折成信息层的变化：你明说的要求当天落地，其余的观察先攒证据。这里是她正攒着的（够次数、跨够多天才会写进去）。',
  'workbench.evolution.grow.empty': '队列还空着——还没有够得上留在她身上的事。',
  'workbench.evolution.grow.lastRun': '上次整理：{time}',
  'workbench.evolution.grow.wrote': '写进了 {list}',
  'workbench.evolution.grow.count': '提到 {count} 次',
  'workbench.evolution.grow.days': '跨 {days} 天',
  'workbench.evolution.grow.aboutUser': '关于他',
  'workbench.evolution.grow.aboutSelf': '关于她自己',
  // 她留下的东西。
  'workbench.evolution.threads.title': '她手上攒着的事',
  'workbench.evolution.threads.hint': '她自己写在本子上的待办（她自己目录里的 todo.md）。每次醒来她第一眼看到的就是这些；写不写、划不划掉，都是她的事。',
  'workbench.evolution.threads.empty': '她手上没攒着事。',
  'workbench.evolution.works.title': '她留下的东西',
  'workbench.evolution.works.hint':
    '她自己目录里的文件（写的东西、以后画的图）。文本能直接看；图片只能看到名字与大小——浏览器拿不到宿主上的文件。',
  'workbench.evolution.works.empty': '她还没留下什么。',
  'workbench.evolution.works.noPreview': '这一样只能看到名字与大小。',
  'workbench.evolution.works.download': '下载',
  'workbench.evolution.works.previewToggle': '看内容',
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
  'workbench.evolution.field.lastTurn': 'Last waking',
  'workbench.evolution.lastTurn.tools': 'acted: used {count} tool calls',
  'workbench.evolution.lastTurn.talk': 'only talked, no tools',
  'workbench.evolution.appraise.applied': 'felt {count} things ({targets})',
  'workbench.evolution.appraise.none': 'read it, felt nothing',
  'workbench.evolution.appraise.skipped': 'appraisal did not run (emotion module offline)',
  'workbench.evolution.busy': '(paused, you two are talking',
  'workbench.evolution.busySince': 'since {time})',
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
  'workbench.evolution.diary.settleFailed': 'Last settlement failed: {reason}',
  'workbench.evolution.diary.empty': 'No diary yet. She writes one when she goes to sleep.',
  'workbench.evolution.diary.open': 'Open',
  'workbench.evolution.diary.confirm': 'Opening cannot be undone. Sure?',
  'workbench.evolution.diary.confirmYes': 'Open it',
  'workbench.evolution.diary.confirmNo': 'Never mind',
  'workbench.evolution.diary.openedAt': 'opened at {time}',
  'workbench.evolution.diary.unnoticed': 'she has not noticed',
  'workbench.evolution.diary.noticed': 'she found out at {time}',
  'workbench.evolution.tell.title': 'What she left for you',
  'workbench.evolution.tell.hint':
    'When she is on her own she may reach out to say something, or to show you something she made. It is delivered into the session where you talk to her; this is the ledger, and an unread one is marked.',
  'workbench.evolution.tell.pending': 'She has a sentence waiting (sent once you are quiet)',
  'workbench.evolution.tell.lastAt': 'She reached out at {time}',
  'workbench.evolution.tell.withWork': 'and showed you {name}',
  'workbench.evolution.tell.onlyWork': '(nothing said, she just wanted you to look)',
  'workbench.evolution.tell.unread': 'you have not read this',
  'workbench.evolution.tell.seen': 'you have read this',
  'workbench.evolution.tell.reason': 'Not delivered: {reason}',
  'workbench.evolution.tell.empty': 'She has not reached out yet.',
  'workbench.evolution.grow.title': 'What she makes of herself',
  'workbench.evolution.grow.hint':
    'After the daily settle she folds the day into her information layer: a request you made in plain words lands the same day, everything else first gathers evidence. This is what she is gathering — it needs enough mentions across enough days to be written in.',
  'workbench.evolution.grow.empty': 'Nothing gathering yet.',
  'workbench.evolution.grow.lastRun': 'Last sort: {time}',
  'workbench.evolution.grow.wrote': 'wrote into {list}',
  'workbench.evolution.grow.count': 'mentioned {count} times',
  'workbench.evolution.grow.days': 'across {days} days',
  'workbench.evolution.grow.aboutUser': 'about him',
  'workbench.evolution.grow.aboutSelf': 'about herself',
  'workbench.evolution.threads.title': 'What she is still chewing on',
  'workbench.evolution.threads.hint': 'Her own list (todo.md in her directory). She sees it first thing every waking; whether she writes or crosses things out is up to her.',
  'workbench.evolution.threads.empty': 'Nothing pending.',
  'workbench.evolution.works.title': 'Things she left behind',
  'workbench.evolution.works.hint':
    'Files in her own directory (what she wrote, and later what she draws). Text can be read here; images only show name and size — the browser cannot reach files on the host.',
  'workbench.evolution.works.empty': 'She has not left anything yet.',
  'workbench.evolution.works.noPreview': 'Only the name and size are available.',
  'workbench.evolution.works.download': 'Download',
  'workbench.evolution.works.previewToggle': 'Show text',
  'workbench.overviewHint':
    'These read the current real state; when something is not readable they say so instead of showing a guess. '
    + 'High-risk changes are confirmed in the conversation.',
} as const
