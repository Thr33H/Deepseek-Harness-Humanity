/**
 * 人格文档的**只读判断**：不改变内容，只回答"是不是 / 有没有"。
 *
 * 单独一个文件的原因：这类判断被宿主（校验、工具）与浏览器（工作台保存前校验）同时用到，
 * 而它们既不规整数据、也不产出问题，混进 `normalize.ts` 或 `validate.ts` 都会让那个文件
 * 同时承担"改数据"和"看数据"两件事。
 *
 * ⚠️ 0.1.14 删掉了原来的 `isStandardMutableLayer`（"可变层是不是全由标准标题组成"）：
 * 用户 2026-10-09 决定"除了原生 8 项，其余都一样待遇，**没有标准这一说**"⇒ 这个派生判断
 * 连同它服务的 `mutable.section-non-standard` 提示一起失去意义。它与 `mutable.address-changed`
 * 是同一种退役方式（见 `constants.ts` 的说明）：**永远不会再被产生/消费**的东西不留着。
 * @module humanity/persona/predicates
 */
import type { IdentityCard } from './types.js'

/**
 * 固定层是否**还没有被任何人写过**。
 *
 * 三个判据缺一不可，各自挡一种真实情形：
 * - `initializedAt` / `sealedAt` 为空：P-002 要求的独立标记，正常路径靠它判断；
 * - 所有字段值都是空串：挡住"有人填过内容却没打标记"（工作台只写内容、初始化标记留给
 *   后续步骤时）——只看标记会让 Agent 覆盖掉用户已经写下的底色。
 *
 * 反过来也不能只比内容：内容恰好等于中性默认模板的已初始化文档（用户明确选择"不填"）
 * 仍然算已初始化，这正是 P-002 禁止用内容比对判断的原因。
 * @param card - 当前生效的固定层。
 * @returns 尚未被写过时为 true。
 */
export function isUntouchedIdentityCard(card: IdentityCard): boolean {
  return card.initializedAt === '' && card.sealedAt === '' && card.fields.every((field) => field.value === '')
}
