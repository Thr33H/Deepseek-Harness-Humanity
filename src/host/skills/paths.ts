/**
 * 技能落盘的**路径解析与安全校验**（本模块是唯一把技能名变成文件路径的地方）。
 *
 * 为什么单点收口：技能名来自模型产出的提案 payload，是**不可信输入**。一旦拼进路径，
 * `../../etc/x` 这种名字就能写到任意位置。这里强制官方 kebab-case 文法，不合法直接抛 ——
 * 路径安全不靠调用方自觉。
 *
 * 两条"不引依赖"的自觉：
 * - `DSH_HOME` 通过 `globalThis.process` 结构化读取（host 侧编译环境**没有** `@types/node`，
 *   也不该为读一个环境变量去引它）；
 * - 路径拼接自己实现（同一原因），分隔符统一 `/` —— Node 的 `fs` 在 Windows 上同样接受它。
 * @module humanity/skills/paths
 */

/** 技能名文法（抄自官方 `dsh-skill` 编译产物；升级时按 DEV-PLAN-M5 §3 重核）。 */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * 技能名是否合法。
 * @param name - 候选名字。
 * @returns 合法为 true。
 */
export function isSkillName(name: string): boolean {
  return SKILL_NAME_RE.test(name)
}

/**
 * 拼接路径片段（首段保留原样，其余去掉首尾分隔符后接上）。
 * @param base - 基准路径（通常是绝对路径）。
 * @param parts - 追加片段。
 * @returns 拼接结果。
 */
export function joinPath(base: string, ...parts: string[]): string {
  const cleaned = parts.map((part) => part.replace(/^[/\\]+/, '').replace(/[/\\]+$/, ''))
  return [base.replace(/[/\\]+$/, ''), ...cleaned].join('/')
}

/**
 * 解析 DSH_HOME。
 * @param explicit - 显式传入的路径（测试用）；缺省读进程环境变量。
 * @returns 绝对路径；未设置或为空时 `undefined`（**不猜路径**：猜错就是把技能写到别处）。
 */
export function resolveDshHome(explicit?: string): string | undefined {
  const fromEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[
    'DSH_HOME'
  ]
  const home = (explicit ?? fromEnv)?.trim()
  return home === undefined || home === '' ? undefined : home
}

/**
 * 用户级技能根目录（官方约定 `<DSH_HOME>/skills`，见 DEV-PLAN-M7 §1）。
 * @param dshHome - DSH_HOME 绝对路径。
 * @returns 技能根目录。
 */
export function skillsRoot(dshHome: string): string {
  return joinPath(dshHome, 'skills')
}

/**
 * 一个技能的目录。
 * @param dshHome - DSH_HOME 绝对路径。
 * @param name - 技能名（必须是 kebab-case）。
 * @returns 技能目录绝对路径。
 */
export function skillDir(dshHome: string, name: string): string {
  if (!isSkillName(name)) throw new Error(`技能名「${name}」不符合 kebab-case 文法，拒绝落盘`)
  return joinPath(skillsRoot(dshHome), name)
}

/**
 * SKILL.md 的完整路径。
 * @param dshHome - DSH_HOME 绝对路径。
 * @param name - 技能名（必须是 kebab-case）。
 * @returns `SKILL.md` 绝对路径。
 */
export function skillFile(dshHome: string, name: string): string {
  return joinPath(skillDir(dshHome, name), 'SKILL.md')
}
