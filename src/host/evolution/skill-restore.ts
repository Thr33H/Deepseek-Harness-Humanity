/**
 * 已应用技能的**恢复**：装配时把提案里的技能重新落地（P-041 的落地机制）。
 *
 * 为什么从 `skills.ts` 拆出来：那份文件贴着 200 行行数门，而"注册一条新技能"（`apply`）与
 * "把上次应用过的技能找回磁盘"是两条独立的路径 —— 前者管**新写入**的授权与查重，
 * 后者管**启动恢复**的降级顺序（目录 → 落盘 → 运行时注册）。混在一起时，
 * "为什么落盘失败还要注册"这类问题要在注册逻辑里穿行才能回答。
 * @module humanity/evolution/skill-restore
 */
import { describeError, type Log } from '../log.js'
import type { SkillStore } from '../skills/store.js'
import type { AppliedSkill } from './skills.js'

/** 恢复结果（工作台要能看到"写了几条、为什么没写成"）。 */
export interface SkillRestoreReport {
  /** 最终可用的技能条数（在目录里 / 落盘成功 / 运行时注册成功）。 */
  restored: number
  /** 其中真正写进官方目录的条数。 */
  written: number
  /** 失败的条数。 */
  failed: number
  /** 失败原因摘要（最多两条，给技能页显示）。 */
  note: string
}

/** 恢复一条技能所需的三个外部事实。 */
export interface RestoreEnv {
  store: SkillStore | undefined
  apply(skill: AppliedSkill): Promise<void>
  log: Log
}

/** 一条技能的恢复结果。 */
export interface RestoreOutcome {
  restored: boolean
  written: boolean
  note: string
}

/**
 * 恢复一条技能：**已在目录里 ⇒ 跳过；不在 ⇒ 落盘；落盘不成 ⇒ 回退运行时注册**。
 *
 * `write` 回 `exists` 也算"没写成"（目录里读不到、写又写不进，只可能是竞态或策略拒绝），
 * 这时必须继续走注册 —— 曾经的写法在这里 `continue`，结果是技能**既没落盘也没注册**。
 * @param skill - 技能内容。
 * @param env - 落盘入口、注册入口与日志。
 * @returns 三个标记 + 失败原因（给报告用）。
 */
export async function restoreOne(skill: AppliedSkill, env: RestoreEnv): Promise<RestoreOutcome> {
  if (env.store !== undefined && (await env.store.read(skill.name)) !== undefined) {
    return { restored: true, written: false, note: '' } // 官方加载器会认它，不必再注册
  }
  if (env.store?.available() === true) {
    try {
      if ((await env.store.write(skill)) === 'written') return { restored: true, written: true, note: '' }
      env.log.warn(`技能「${skill.name}」落盘被拒（目标已存在），改走运行时注册`)
    } catch (error) {
      env.log.warn(`技能「${skill.name}」落盘失败，回退为运行时注册`, error)
      return fallbackRegister(skill, env, describeError(error))
    }
  }
  return fallbackRegister(skill, env, '')
}

/** 回退路径：运行时注册（技能至少本次可用）。 */
async function fallbackRegister(skill: AppliedSkill, env: RestoreEnv, reason: string): Promise<RestoreOutcome> {
  try {
    await env.apply(skill)
    return { restored: true, written: false, note: reason === '' ? '' : `落盘失败 ${skill.name}: ${reason}` }
  } catch (error) {
    env.log.warn(`已应用技能「${skill.name}」注册失败（可能已有同名技能）`, error)
    return { restored: false, written: false, note: `${skill.name}: 注册失败 ${describeError(error)}` }
  }
}
