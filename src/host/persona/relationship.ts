/**
 * 一次性数据迁移：把「关系」从**底色**搬到**信息**（2026-11-16 用户拍板 A 方案）。
 *
 * ### 为什么搬
 * 关系是**慢变**的：会修好、会变冷、会重新亲近。而底色是**封存**的（agent 改不了，只有对方
 * 能在工作台改）。把关系放在底色里，等于让它永远停在初始化那一刻 —— 结构错位（见设计讨论
 * "P1"）。搬到信息后它成为第 5 个原生小节，机制与其它信息一致：慢变、常驻注入、agent 可写。
 *
 * ### 为什么是"复制后删除"，不是"保留一份"
 * 用户选的 A：只留一份。留两处会在注入里出现两遍，而且以后改了信息里的那份、底色里那条还是旧的。
 * 删除不可怕 —— `persona.write` 会把改写前的快照记进人格历史（工作台可回滚）。
 *
 * ### 判据
 * 只搬**键名里带「关系」**的底色自定义字段（例如「与火火的关系」）。其它自定义字段
 * （「身份」「归属地」之类）一个字都不动 —— 迁移不是"清理底色"。
 *
 * @module humanity/persona/relationship
 */
import type { Log } from '../log.js'
import { warnSafely } from '../log.js'
import type { PersonaSection } from './section.js'

/** 信息里承载关系的小节标题（与 `STANDARD_SECTION_TITLES` 里的那一项一致）。 */
export const RELATIONSHIP_SECTION_TITLE = '关系'

/** 底色字段名是否在说"关系"。 */
const looksLikeRelationship = (key: string): boolean => key.includes('关系')

/**
 * 执行迁移。幂等：跑过一次之后底色里不再有匹配字段，第二次调用直接返回 false。
 *
 * @param section - 人格读写入口。
 * @param log - 日志门面（搬了什么必须留痕，不然对方只会看到底色少了一行）。
 * @returns 这次是否真的改了文档。
 */
export async function migrateRelationshipFromIdentity(section: PersonaSection, log: Log): Promise<boolean> {
  if (!section.attached) return false

  const current = section.read()
  const fields = current.identityCard.fields ?? []
  const moved = fields.filter((field) => looksLikeRelationship(field.key))
  const hasSection = (current.mutableLayer.sections ?? []).some(
    (item) => item.title === RELATIONSHIP_SECTION_TITLE,
  )

  // 没有要搬的、小节也已存在 ⇒ 什么都不做（已迁移过的常见形态）。
  if (moved.length === 0 && hasSection) return false

  // ⚠️ 未初始化的空文档不迁移：那会把"新装"误判成"有旧数据"，还会凭空写出一个空小节。
  if (current.identityCard.initializedAt === '' && moved.length === 0) return false

  const next = structuredClone(current)
  next.identityCard.fields = next.identityCard.fields.filter((field) => !looksLikeRelationship(field.key))

  const target = next.mutableLayer.sections.find((item) => item.title === RELATIONSHIP_SECTION_TITLE)
  const items = moved.map((field) => field.value.trim()).filter((value) => value !== '')
  if (target === undefined) {
    next.mutableLayer.sections.push({ title: RELATIONSHIP_SECTION_TITLE, items })
  } else {
    target.items = [...target.items, ...items.filter((value) => !target.items.includes(value))]
  }

  try {
    // 来源记为 `user`：这是宿主代对方执行的数据搬家，不是 agent 的自动整理 ——
    // 用 `agent` 会被封存/高风险规则挡住（底色封存后 agent 不得改）。
    await section.write(next, 'user')
    if (moved.length > 0) {
      log.info(
        `关系已从底色搬到信息：${moved.map((field) => `${field.key}=${field.value}`).join('；')}` +
          `（底色该字段已删除，改写前的快照已进人格历史）`,
      )
    } else {
      log.info('信息里补上了「关系」小节（此前没有）')
    }
    return true
  } catch (error) {
    // 迁移失败不该拦住插件启动：下一次就绪检查会再试一次。
    warnSafely(log, '关系迁移失败（下次就绪时重试）：人格文档保持原样', error)
    return false
  }
}
