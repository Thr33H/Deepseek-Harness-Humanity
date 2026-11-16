/**
 * 人格文档的**一次性写回式升级**（启动时跑一次，幂等，永不抛）。
 *
 * 与 `migrations.ts` 的区别（两个文件都叫"迁移"，但性质完全不同）：
 * - `migrations.ts`：**读取时**的形状适配（纯函数、每次规范化都跑、不改存储）；
 * - 本文件：**写回**存储的一次性数据搬家（async、需要命名空间就绪、只跑一次）。
 * 放在一起会让人以为"反正都是迁移"，结果写回被塞进读取路径 —— 那是灾难。
 *
 * 目前两步，都在 2026-11-16 由用户拍板：
 *
 * ### ① 「关系」从底色搬进信息
 * 关系是**慢变**的（会修好、会变冷、会重新亲近），而底色是**封存**的（agent 改不了，只有对方
 * 能在工作台改）。放在底色里，关系就永远停在初始化那一刻 —— 结构错位。搬到信息后它成为原生小节，
 * 机制与其它信息一致：慢变、常驻注入、agent 可写。
 *
 * 只搬**键名里带「关系」**的底色自定义字段；「身份」之类一个字都不动。
 *
 * ### ② 退役「交付格式」
 * 用户原话："直接删了吧，别保留，要不然又影响判断了"。理由成立：只要槽位还在，模型每次整理
 * 都会往里填一条汇报体规则（"先给结论再给依据"），等于持续把语气拉回助理腔 —— 与"有温度"相反。
 *
 * 处置：**槽位删除，条目并进「说话风格」**。写的字是对方的东西，不该因为删槽位就丢掉；
 * 而"怎么说话"本来就是说话风格那一节的事，并进去语义也成立。
 *
 * ### 为什么搬走就删，不留两份
 * 留两处会在注入里出现两遍；以后改了信息里那份，底色那条还是旧的 —— 正是要消掉的病。
 * 删除不可怕：`persona.write` 会把改写前的快照记进人格历史，工作台可回滚。
 *
 * @module humanity/persona/upgrade
 */
import type { Log } from '../log.js'
import { describeError, reportBootFailure } from '../log.js'
import type { PersonaDocument } from './types.js'
import type { PersonaSection } from './section.js'

/** 信息里承载关系的小节标题（与 `STANDARD_SECTION_TITLES` 里的那一项一致）。 */
export const RELATIONSHIP_SECTION_TITLE = '关系'

/** 被退役的「交付格式」条目并入这里。 */
const SPEECH_STYLE_TITLE = '说话风格'

/** 已退役的原生小节：内容迁走，槽位消失。 */
const RETIRED_DELIVERY_TITLE = '交付格式'

/** 底色字段名是否在说"关系"。 */
const looksLikeRelationship = (key: string): boolean => key.includes('关系')

/** 取（或建）一个小节，返回它的条目数组。 */
function sectionItemsOf(doc: PersonaDocument, title: string): string[] {
  const found = doc.mutableLayer.sections.find((item) => item.title === title)
  if (found !== undefined) return found.items
  const created = { title, items: [] as string[] }
  doc.mutableLayer.sections.push(created)
  return created.items
}

/**
 * ① 把底色里的关系字段搬进「关系」节。
 * @returns 是否改动了文档。
 */
function applyRelationshipMove(doc: PersonaDocument, notes: string[]): boolean {
  const moved = doc.identityCard.fields.filter((field) => looksLikeRelationship(field.key))
  const hasSection = doc.mutableLayer.sections.some((item) => item.title === RELATIONSHIP_SECTION_TITLE)

  if (moved.length === 0 && hasSection) return false
  // 未初始化的空文档不迁移：那会把"新装"误判成"有旧数据"，还会凭空写出一个空小节。
  if (doc.identityCard.initializedAt === '' && moved.length === 0) return false

  doc.identityCard.fields = doc.identityCard.fields.filter((field) => !looksLikeRelationship(field.key))
  const items = sectionItemsOf(doc, RELATIONSHIP_SECTION_TITLE)
  for (const field of moved) {
    const value = field.value.trim()
    if (value !== '' && !items.includes(value)) items.push(value)
  }
  if (moved.length > 0) {
    notes.push(`关系从底色搬入信息：${moved.map((field) => `${field.key}=${field.value}`).join('；')}`)
  } else {
    notes.push('信息里补上了「关系」小节')
  }
  return true
}

/**
 * ② 退役「交付格式」：条目并进「说话风格」，槽位删除。
 * @returns 是否改动了文档。
 */
function applyDeliveryRetire(doc: PersonaDocument, notes: string[]): boolean {
  const index = doc.mutableLayer.sections.findIndex((item) => item.title === RETIRED_DELIVERY_TITLE)
  if (index < 0) return false

  const retired = doc.mutableLayer.sections[index]
  const items = retired?.items ?? []
  doc.mutableLayer.sections.splice(index, 1)

  if (items.length > 0) {
    const target = sectionItemsOf(doc, SPEECH_STYLE_TITLE)
    for (const item of items) {
      const value = item.trim()
      if (value !== '' && !target.includes(value)) target.push(value)
    }
    notes.push(`「交付格式」退役：${items.length} 条并入「说话风格」（${items.join('；')}）`)
  } else {
    notes.push('「交付格式」退役（原本是空的）')
  }
  return true
}

/**
 * 跑全部一次性升级。幂等：跑过一次之后没有可升级的东西，第二次直接返回 false。
 *
 * **永不抛**：失败只记日志，绝不拦住插件启动；下一个就绪点会再试一次。
 *
 * @param section - 人格读写入口。
 * @param log - 日志门面（搬了什么/并了什么必须留痕）。
 * @returns 这次是否真的改了文档。
 */
export async function upgradePersonaDocument(section: PersonaSection, log: Log): Promise<boolean> {
  if (!section.attached) return false

  const next = structuredClone(section.read())
  const notes: string[] = []
  const changedRelationship = applyRelationshipMove(next, notes)
  const changedDelivery = applyDeliveryRetire(next, notes)
  if (!changedRelationship && !changedDelivery) return false

  try {
    // 来源记为 `user`：这是宿主代对方执行的数据搬家，不是 agent 的自动整理 ——
    // 用 `agent` 会被封存/高风险规则挡住（底色封存后 agent 不得改）。
    await section.write(next, 'user')
    log.info(`人格数据升级：${notes.join('；')}（改写前的快照已进人格历史，可回滚）`)
    return true
  } catch (error) {
    // ⚠️ 走 stderr，不走 logger：`ctx.logger` 的输出不进 `docker logs`，而"对方的旧数据没搬到
    // 新结构"这种事必须从外面看得见（2026-11-16 真机：迁移失败静默，界面只是少了那节）。
    reportBootFailure(log, `人格数据升级失败（下次就绪时重试）：${describeError(error)}`, error)
    return false
  }
}
