/**
 * 情绪页文案（与 `memory-locales.ts` / `evolution-locales.ts` 同构，末尾合并进主字典）。
 *
 * 键的命名沿用模块前缀 `emotion.`：这一页要能被单独翻译，不需要读懂人格页的键。
 * @module deepseek-harness-humanity/client/emotion-locales
 */

export const emotionZh = {
  'emotion.tab': '情绪',
  'emotion.title': '它此刻',
  'emotion.hint':
    '这里显示它现在的心情：由对话里发生的事推动，随时间自己退。'
    + '它只在「Humanity 沉浸」里生效；功能模式完全不读不写。'
    + '这一页只是观察窗——心情不靠手动拨，靠你们之间发生的事。',
  'emotion.calm': '平静',
  'emotion.empty': '现在没有明显的情绪。',
  'emotion.composite': '合起来是',
  'emotion.compositeHint': '两种基本情绪同时够强时，它们合起来有一个名字 —— 这一行不是另加的情绪，是上面两条的合成。',
  'emotion.sensitivity': '磨出来的敏感',
  'emotion.sensitivityHint':
    '同一个人的同一类事反复落在同一处，这一处就会越来越容易被点着：下一次最多比第一次重一半。'
    + '它自己也会退：一天剩一半，两三天不碰就淡了。好事不记在这里。',
  'emotion.sensitivityEmpty': '还没有哪一处被反复磨到。',
  'emotion.sensitivityNoCause': '这一处被磨过，但没记下是因为什么',
  'emotion.sensitivityDelta': '这是最近一次磨它的那笔增减',
  'emotion.warmth': '关系温度',
  'emotion.warmthHint': '它此刻对你的感觉（会变），不是「我们是什么关系」（那个在人格里）。',
  'emotion.perceived': '它眼里的你',
  'emotion.perceivedHint': '它从这句话里读到的你的状态。看得准不准另说，但它确实在看你。',
  'emotion.energy': '精力',
  'emotion.energyHint': '它会累：白天消耗、每过一天恢复。累了话会变短 —— 跟心情好坏无关，是没力气。',
  'emotion.params.title': '它怎么算的（这些数不在这页改）',
  'emotion.params.hint':
    '这几条是标定过的：改动它们等于改她的性子，所以只能改代码，不给你一个随时能拨的旋钮。写在这里是为了让你看得见。',
  'emotion.params.floor': '触发线：{floor} 分以上才写进她读到的那一段',
  'emotion.params.tiers': '档位：{faint} / {clear} / {burst} 分（有点 / 明显 / 爆发）',
  'emotion.params.sensitivity': '磨出来的敏感：同一处反复被刺，最多放大到 {boost} 倍，{hours} 小时减半',
  'emotion.params.soothe': '自调节：{minutes} 分钟没再被刺，负面情绪退得快一倍',
  'emotion.energy.fresh': '有精神',
  'emotion.energy.tired': '有点累',
  'emotion.energy.exhausted': '很累',
  'emotion.cause': '因为',
  'emotion.deltaUp': '比上一次评估多了 {n}',
  'emotion.deltaDown': '比上一次评估少了 {n}',
  'emotion.noCause': '没有具体原因，只是残留',
  'emotion.since': '已经 {duration}',
  'emotion.duration.minutes': '{n} 分钟',
  'emotion.duration.hours': '{n} 小时',
  'emotion.duration.days': '{n} 天',
  'emotion.ago': '{duration}前',
  'emotion.agoNow': '刚刚',
  'emotion.tier.calm': '微弱',
  'emotion.absent': '没有',
  'emotion.tier.faint': '轻微',
  'emotion.tier.clear': '明显',
  'emotion.tier.burst': '强烈',
  'emotion.tier.burstHint': '到了这一档，它可以直接说出来（只说一次）。',
  'emotion.loading': '正在读取…',
  'emotion.unavailable': '情绪模块未就绪（宿主那一半没挂上，或模块被关掉了）。',
  'emotion.failed': '读取失败：{message}',
  'emotion.reload': '重新读取',
  'emotion.settledAt': '上次结算：{time}',
  'emotion.globalHint': '这一份状态是全局的：换会话不会重置，也不按会话分开记。',
} as const

export const emotionEn = {
  'emotion.tab': 'Mood',
  'emotion.title': 'How it feels right now',
  'emotion.hint':
    'What it is feeling **right now**: pushed by what happens in the conversation and decaying on its own over time. '
    + 'It only applies to the "Humanity Immersive" preset; the functional preset never reads or writes it. '
    + 'This page is a window, not a dial — mood is moved by what happens between you.',
  'emotion.calm': 'Calm',
  'emotion.empty': 'No strong emotion right now.',
  'emotion.composite': 'Together that reads as',
  'emotion.compositeHint': 'When two basic emotions are both strong, they have a combined name — this line is not a third emotion, it is the blend of the two above.',
  'emotion.sensitivity': 'What has worn thin',
  'emotion.sensitivityHint':
    'When the same kind of thing keeps landing on the same spot, that spot gets easier to set off: '
    + 'at most half again as heavy as the first time. It fades on its own — half gone in a day, mostly gone after two or three. '
    + 'Good things are not counted here.',
  'emotion.sensitivityEmpty': 'Nothing has been worn thin yet.',
  'emotion.sensitivityNoCause': 'This spot was worn, but what wore it was not recorded',
  'emotion.sensitivityDelta': 'How much the last sting moved it',
  'emotion.warmth': 'Warmth',
  'emotion.warmthHint': 'How it feels about you at this moment (moves fast), not "what we are to each other" (that lives in the persona).',
  'emotion.perceived': 'What it noticed about you',
  'emotion.perceivedHint': 'The state it read from your last message. It may be wrong — but it is looking.',
  'emotion.energy': 'Energy',
  'emotion.energyHint': 'It gets tired: drains through the day, recovers once a day. Tired means shorter answers — not bad mood, just no fuel.',
  'emotion.params.title': 'How it is computed (not editable here)',
  'emotion.params.hint':
    'These are calibrated together: changing them changes her temperament, so they stay in code instead of a dial. They are listed here so you can see them.',
  'emotion.params.floor': 'Floor: only above {floor} reaches the paragraph she reads',
  'emotion.params.tiers': 'Tiers: {faint} / {clear} / {burst} (slight / clear / burst)',
  'emotion.params.sensitivity': 'Worn-in sensitivity: repeated stings at one spot amplify up to {boost}x, halving in {hours}h',
  'emotion.params.soothe': 'Self-soothing: after {minutes} quiet minutes a negative feeling fades twice as fast',
  'emotion.energy.fresh': 'fresh',
  'emotion.energy.tired': 'a bit tired',
  'emotion.energy.exhausted': 'exhausted',
  'emotion.cause': 'Because',
  'emotion.deltaUp': '{n} more than the last reading',
  'emotion.deltaDown': '{n} less than the last reading',
  'emotion.noCause': 'No specific reason; just residue',
  'emotion.since': 'for {duration}',
  'emotion.duration.minutes': '{n} min',
  'emotion.duration.hours': '{n} h',
  'emotion.duration.days': '{n} d',
  'emotion.ago': '{duration} ago',
  'emotion.agoNow': 'just now',
  'emotion.tier.calm': 'slight',
  'emotion.absent': 'none',
  'emotion.tier.faint': 'faint',
  'emotion.tier.clear': 'clear',
  'emotion.tier.burst': 'strong',
  'emotion.tier.burstHint': 'At this level it may say it outright (once).',
  'emotion.loading': 'Reading…',
  'emotion.unavailable': 'The emotion module is not ready (host side missing, or the module is off).',
  'emotion.failed': 'Could not read: {message}',
  'emotion.reload': 'Reload',
  'emotion.settledAt': 'Last settled: {time}',
  'emotion.globalHint': 'This state is global: switching sessions does not reset it, and it is not stored per session.',
} satisfies Record<keyof typeof emotionZh, string>
