/**
 * 把整合结果**写回**（`consolidate.ts` 只算不写，这里负责落地）。
 *
 * 三条纪律：
 * 1. **走正规写入路径**（`section.write(next, 'agent')`）—— 校验、历史、封存判定一个都不绕过；
 * 2. **被拒不硬闯**：校验层说不行就放弃（下一轮再说），绝不为了"整理干净"去改校验；
 * 3. **绝不抛**：它挂在自进化运行的开头，抛一次会让整轮整理失败，而这只该是一次免费清理。
 * @module humanity/persona/consolidate-apply
 */
import type { Log } from '../log.js'
import { warnSafely } from '../log.js'
import { consolidatePersona, type PersonaMerge } from './consolidate.js'
import type { PersonaSection } from './section.js'
import { isUntouchedIdentityCard } from './predicates.js'

/** 一次整合的结果：并掉几条 + 每一对"留下哪条、去掉哪条"。 */
export interface ConsolidationResult {
  /** 并掉的条数。 */
  count: number
  /** 每一对「留下了哪条、去掉了哪条」（供对话里的那句话）。 */
  merges: PersonaMerge[]
}

const EMPTY: ConsolidationResult = { count: 0, merges: [] }

/**
 * 合并信息里的近重复条目并写回。
 * @param section - 人格读写入口。
 * @param log - 日志门面。
 * @returns 实际合并掉的条目数（0 = 没有可合并项，或没写成）。
 */
export async function applyConsolidation(section: PersonaSection, log: Log): Promise<ConsolidationResult> {
  try {
    const current = section.read()
    // 未初始化：人格还不存在，谈不上整理（与 `writePersonaSections` 同一道闸）。
    if (isUntouchedIdentityCard(current.identityCard)) return EMPTY
    const { document, merged } = consolidatePersona(current)
    if (merged.length === 0) return EMPTY
    await section.write(document, 'agent')
    log.info(`信息整合：合并了 ${merged.length} 条重复条目（${merged.map((item) => item.title).join('、')}）`)
    return { count: merged.length, merges: merged }
  } catch (error) {
    // 校验拒绝 / 存储未就绪都走这里：整理只是"顺手做的好事"，失败不该影响这一轮整理。
    warnSafely(log, '信息整合失败（本轮跳过，不影响整理）', error)
    return EMPTY
  }
}
