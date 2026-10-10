/**
 * 技能清单：把"官方目录里有什么"与"提案里有什么"合成工作台要显示的一份视图。
 *
 * 两个来源各自都不完整，合起来才回答得了用户的问题：
 * - **目录**（`$DSH_HOME/skills`）是技能的**存在形式** —— 文件在，技能就在（官方加载器会认它）；
 * - **提案表**是技能的**来历** —— 谁在什么时候、根据哪段对话提的，用户批没批。
 *
 * 四态就是两个来源的差集（DEV-PLAN-M7 §4）：都有且一致＝`on-disk`；只有提案＝`runtime-only`
 * （= 落盘还没成功，那时技能只活在插件的运行时注册里）；只有文件＝`file-only`（用户手写或别处来的）；
 * 都有但内容不同＝`diverged`（用户改过文件，**以文件为准**）。
 *
 * ⚠️ **2026-09-26 审计 E4：`runtime-only` 必须被证实**。旧实现只凭"有提案、文件不在"就写下
 * `runtime-only` —— 于是**注册失败**的技能（`restoreApplied` 里那条 `注册失败` 的账）也会显示成
 * "还没存成文件：现在只靠插件每次启动时重新注册"，读起来像"它是活的，只是没落盘"。
 * 现在把注册表的实际清单传进来：**查到了才是 `runtime-only`，查不到就是 `unregistered`**
 * （提案说已应用，但这条技能现在既不在磁盘、也不在注册表里 —— 它用不了）。
 * @module humanity/skills/inventory
 */
import type { ProposalRecord } from '../evolution/types.js'
import { parseAppliedSkill } from '../evolution/skills.js'
import type { SkillStore } from './store.js'

/** 一条技能在工作台里的样子。 */
export interface SkillView {
  name: string
  description: string
  content: string
  /** 五态：见模块头注释。 */
  status: 'on-disk' | 'runtime-only' | 'unregistered' | 'file-only' | 'diverged'
  /** 文件路径（`runtime-only` / `unregistered` 为空）—— 直接回答用户"技能在哪"。 */
  file: string
  /** 来源提案标题（`file-only` 为空）。 */
  origin: string
  /** 批准时刻（ISO；`file-only` 为空）。 */
  decidedAt: string
  /** 是否被停用（官方 `disable-model-invocation`）。 */
  disabled: boolean
  /** 这条技能**用到了哪些插件**（卸载对应插件后它就做不到自己写的事了）。 */
  pluginDeps: string[]
}

/**
 * 工具名 → 提供它的插件（技能正文里出现这些名字，那条技能就依赖对应插件）。
 *
 * 依据是工具命名约定 `<插件>_<动作>`：Humanity 自己的是 `humanity_recall`；
 * dsh-im 的是 `dsh_im_source` / `dsh_im_reply_to`（2026-09-26 在实机包内核实过）。
 * **宁少勿错**：没核实过的插件不要往这张表里加 —— 一条误报就会让"狼来了"变成常态，
 * 真到卸载那天用户反而不信了。要加就先去包里核实工具名。
 */
const PLUGIN_TOOLS: readonly { plugin: string; re: RegExp }[] = [
  { plugin: 'Humanity', re: /\bhumanity_[a-z_]+/ },
  { plugin: 'dsh-im', re: /\bdsh_im_[a-z_]+/ },
]

/**
 * 这条技能的正文用到了哪些插件（按上表顺序去重）。
 * @param content - 技能正文。
 * @returns 插件名列表；一个都不用则为空数组。
 */
function pluginDepsOf(content: string): string[] {
  return PLUGIN_TOOLS.filter((entry) => entry.re.test(content)).map((entry) => entry.plugin)
}

/**
 * 正文比较：两侧都按落盘时的规范化（只差**尾部空白**不算改动）。
 *
 * 为什么需要它：落盘会 `trimEnd()` 正文，而提案 payload 可能带尾随换行 —— 直接逐字比较会把
 * 刚写好的技能误报成「文件已改动」（2026-09-26 真机：5 条里 2 条假警告）。
 */
function sameBody(left: string | undefined, right: string | undefined): boolean {
  return left !== undefined && right !== undefined && left.trimEnd() === right.trimEnd()
}

/** 已应用的技能提案：名字 → 提案（payload 形状不对的跳过）。 */
function appliedSkills(proposals: readonly ProposalRecord[]): Map<string, ProposalRecord> {
  const applied = new Map<string, ProposalRecord>()
  for (const proposal of proposals) {
    if (proposal.kind !== 'skill' || proposal.status !== 'applied') continue
    const skill = parseAppliedSkill(proposal)
    if (skill !== undefined) applied.set(skill.name, proposal)
  }
  return applied
}

/**
 * 合成技能清单（按名字排序）。
 * @param proposals - 全部提案记录。
 * @param store - 技能落盘入口（服务缺席时目录侧为空，只剩提案侧）。
 * @param registered - **本次启动注册表里的技能名**；`undefined` 表示注册表查不到（服务缺席）。
 *   传 `undefined` 时不敢乱判"没生效"，保留 `runtime-only`（页面另有"注册服务不可用"的全局提示）。
 * @returns 工作台视图。
 */
export async function skillInventory(
  proposals: readonly ProposalRecord[],
  store: SkillStore,
  registered?: readonly string[],
): Promise<SkillView[]> {
  const applied = appliedSkills(proposals)
  const views: SkillView[] = []
  const live = registered === undefined ? undefined : new Set(registered)

  for (const entry of await store.list()) {
    const onDisk = await store.read(entry.name)
    const proposal = applied.get(entry.name)
    const from = proposal === undefined ? undefined : parseAppliedSkill(proposal)
    views.push({
      name: entry.name,
      description: entry.description,
      content: onDisk?.content ?? '',
      status: proposal === undefined ? 'file-only' : sameBody(from?.content, onDisk?.content) ? 'on-disk' : 'diverged',
      file: entry.file,
      origin: proposal?.title ?? '',
      decidedAt: proposal?.decidedAt ?? '',
      disabled: entry.disabled,
      pluginDeps: pluginDepsOf(onDisk?.content ?? ''),
    })
    applied.delete(entry.name)
  }

  for (const [name, proposal] of applied) {
    const skill = parseAppliedSkill(proposal)
    if (skill === undefined) continue
    views.push({
      name,
      description: skill.description,
      content: skill.content,
      // 注册表里有它 ⇒ 真的活着（只是没落盘）；查不到 ⇒ 现在用不了（见模块头注释 E4）。
      status: live === undefined || live.has(name) ? 'runtime-only' : 'unregistered',
      file: '',
      origin: proposal.title,
      decidedAt: proposal.decidedAt,
      disabled: false,
      pluginDeps: pluginDepsOf(skill.content),
    })
  }

  return views.sort((left, right) => left.name.localeCompare(right.name))
}
