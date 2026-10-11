/**
 * 工作台外壳的文案（总览四项 / 页面清单 / 技能页），中英各一份。
 *
 * 为什么单独一个文件：`locales.ts` 的正文是**人格页**文案，外壳与技能页文案涨到几十条后
 * 混在一起会越过文件行数质量门（≤200 行）；按页面拆开是 `memory-locales` /
 * `evolution-locales` 已经在用的做法。
 * @module deepseek-harness-humanity/client/workbench-locales
 */

/** 中文文案。 */
export const workbenchZh = {
  // 页面级说明收进标题旁的「?」（用户 2026-09-26）：界面上不再有整段说明文字，
  // 但"这是什么、开关在哪"必须仍然问得到 —— 只是从"一直占着版面"改成"悬停才出现"。
  'workbench.titleHint':
    '人格、记忆、技能、自进化与梦境，统一在这里配置。'
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
  'skills.tab': '技能',
  'skills.title': '技能',
  'skills.mechanism':
    '技能不会自动执行：DSH 把技能的名字与说明给模型看，模型判断当前任务用得上时，才按需载入全文。'
    + '它影响的是"这类事怎么做"，不是"替你做"。',
  'skills.location':
    '技能存成文件放在 DSH 的用户技能目录里 —— 文件在，技能就在：你可以直接用编辑器打开看或改，'
    + '它也会跟着 DSH 一起搬到新机器。',
  'skills.empty': '还没有技能。自进化整理对话时会提出技能建议，你在「待确认」页批准后就会出现在这里。',
  'skills.notWritable':
    '⚠️ 暂时写不进技能目录（文件服务没接上）：这些技能只在本次运行里有效，重启后由插件重新注册。',
  'skills.report': '上次写入',
  'skills.new': '新建技能',
  'skills.edit': '编辑',
  'skills.disable': '停用',
  'skills.enable': '恢复',
  'skills.disabledBadge': '已停用',
  'skills.disabledHint':
    '已停用：文件里现在写着 disable-model-invocation: true —— 这就是官方认的那一行'
    + '（上面路径里的 SKILL.md 可以直接打开核对）。模型不会再自动调用它；点「恢复」会把这行删掉。',
  'skills.pluginDeps':
    '⚠️ 这条技能用到了这些插件的能力：**{plugins}**。卸载对应插件后，这条技能将无法正常使用（技能文件本身还在、仍会被 DSH 加载）。',
  'skills.deleteHint':
    '这里没有「删除」：DSH 的文件服务与官方工具都只提供读/写/改，有意不给删除能力。'
    + '要下线就用「停用」；真要删文件，跟运维通道说一声，我帮你删（会先备份）。',
  'skills.editor.file': '这个技能的文件',
  'skills.editor.newTitle': '新建技能',
  'skills.editor.editTitle': '编辑技能',
  'skills.editor.name': '技能名（只能小写字母、数字、连字符）',
  'skills.editor.description': '一句话说明（官方必需）',
  'skills.editor.content': '正文（模型按需载入的说明书全文）',
  'skills.editor.hint': '保存后会写进技能目录，DSH 自动加载它。你手写的其他字段会原样保留。',
  'skills.editor.save': '保存',
  'skills.editor.cancel': '取消',
  'skills.status.on-disk': '已存成文件',
  'skills.status.runtime-only': '还没存成文件',
  'skills.status.unregistered': '现在没生效',
  'skills.status.file-only': '目录里的',
  'skills.status.diverged': '文件已改动',
  'skills.statusHint.runtimeOnly': '⚠️ 还没写进技能目录：现在只靠插件每次启动时重新注册。',
  'skills.statusHint.unregistered':
    '⚠️ 提案记着「已应用」，但技能目录里没有这个文件、本次启动的注册表里也查不到它 —— '
    + '这条技能**现在用不了**（多半是注册失败，原因见上方的恢复账）。重建一次即可。',
  'skills.statusHint.diverged': '文件内容与提案不一致（你或别的工具改过）——以**文件**为准，模型用的就是文件里那份。',
  'skills.fileRuntime': '（还没写进文件）',
} as const

/** 英文。键集合必须与中文完全一致，否则 `satisfies` 会在编译期报错。 */
export const workbenchEn = {
  'workbench.titleHint':
    'Persona, memory, skills, self-evolution and dreaming, all configured here. '
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
  'skills.tab': 'Skills',
  'skills.title': 'Skills',
  'skills.mechanism':
    'Skills are never executed automatically: DSH shows the model each skill\'s name and description, and the model loads the full text only when the task calls for it. '
    + 'A skill shapes *how* that kind of work is done — it does not do the work for you.',
  'skills.location':
    'Skills are stored as files in the user skill directory DSH itself reads — if the file is there, the skill is there. '
    + 'Open or edit it with any editor; it travels with DSH.',
  'skills.empty': 'No skills yet. Self-evolution proposes them while tidying conversations; approve one on the Pending page and it shows up here.',
  'skills.notWritable':
    '⚠️ Writing to the skill directory is unavailable (file service not reachable): these skills only exist for the current run and are re-registered on each start.',
  'skills.report': 'Last write',
  'skills.new': 'New skill',
  'skills.edit': 'Edit',
  'skills.disable': 'Disable',
  'skills.enable': 'Enable',
  'skills.disabledBadge': 'Disabled',
  'skills.disabledHint':
    'Disabled: the file now contains disable-model-invocation: true — the one line DSH itself reads '
    + '(open the SKILL.md at the path above to check). The model will not invoke it automatically; “Enable” removes that line.',
  'skills.pluginDeps':
    '⚠️ This skill relies on these plugins: **{plugins}**. Uninstall them and the skill stops working (the file itself stays and is still loaded by DSH).',
  'skills.deleteHint':
    'No “delete” here: DSH\'s file service and its official tools only offer read/write/edit — deletion is deliberately absent. '
    + 'Use “Disable” to retire a skill; to really remove the file, ask through the ops channel and I will do it (with a backup first).',
  'skills.editor.file': 'File for this skill',
  'skills.editor.newTitle': 'New skill',
  'skills.editor.editTitle': 'Edit skill',
  'skills.editor.name': 'Skill name (lowercase letters, digits, hyphens only)',
  'skills.editor.description': 'One-line description (required by DSH)',
  'skills.editor.content': 'Body (the instructions the model loads on demand)',
  'skills.editor.hint': 'Saving writes the file into the skill directory; DSH loads it automatically. Any other fields you wrote stay untouched.',
  'skills.editor.save': 'Save',
  'skills.editor.cancel': 'Cancel',
  'skills.status.on-disk': 'Saved as file',
  'skills.status.runtime-only': 'Not saved yet',
  'skills.status.unregistered': 'Not in effect',
  'skills.status.file-only': 'From directory',
  'skills.status.diverged': 'File changed',
  'skills.statusHint.runtimeOnly': '⚠️ Not written to the skill directory yet: it only exists in this process and is re-registered on each start.',
  'skills.statusHint.unregistered':
    '⚠️ The proposal says "applied", but there is no such file in the skill directory and this start\'s registry '
    + 'does not list it — this skill **does not work right now** (registration most likely failed; see the restore log above). Recreate it.',
  'skills.statusHint.diverged': 'The file differs from the proposal (you or another tool edited it) — the **file** wins; that is what the model reads.',
  'skills.fileRuntime': '(no file yet)',
} as const
