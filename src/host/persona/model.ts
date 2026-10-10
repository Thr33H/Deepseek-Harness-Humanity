/**
 * 人格的 schema 与默认值（宿主侧；浏览器不 import 本文件）。
 *
 * 数据模型、常量与校验规则在 `rules.ts`——那是宿主与工作台共用的唯一真源。
 * 这里只剩下**只有宿主需要**的东西：schemastery schema、解析默认值、以及由此派生的
 * `createDefaultPersona()`。本文件把它们 re-export 出来，老的导入路径（`model.js`）保持不变。
 *
 * 为什么 schema 与模型分家：`rules.ts` 必须能进浏览器 bundle，而 schemastery 不该跟着进去
 * （它会把一份 schema 库内联到客户端，并让两侧规则有机会各写一份）。
 *
 * 存储位置说明（工程默认，依据用户裁决 3「先走复用 settings RPC，不新建 gateway」）：
 * 两层都放在本插件自己的设置命名空间里，因为工作台只能通过设置 RPC 读写宿主状态；
 * 若把真源放进存储领域、再往设置里镜像一份，就会出现**两个主人**的同步问题——同一份数据
 * 两个写入方，谁赢取决于调用顺序，这是缺陷温床而不是设计。所以：**一份数据，一个主人**。
 * 存储领域只承担"历史/审计"（append-only，主机写入，不参与人格注入，见 P-009）。
 * @module humanity/persona/model
 */
import Schema from '@deepseek-ai/schemastery'

import { CORE_IDENTITY_KEYS, STANDARD_SECTION_TITLES } from './constants.js'
import type { PersonaDocument } from './types.js'

/**
 * 人格文档结构版本。
 *
 * 为什么单独放一个字段而不是只靠 schemastery 默认值：G-004 要求数据结构版本化。
 * schema 默认值能处理"新增字段"，但处理不了"含义变了"；有了显式版本，将来才能在
 * 写入路径上做一次性迁移，而不是猜这份文档是哪一代的。
 */
export const PERSONA_SCHEMA_VERSION = 1

const IdentityFieldSchema = Schema.object({
  key: Schema.string().required(),
  value: Schema.string().default(''),
  custom: Schema.boolean().default(false),
})

const MutableSectionSchema = Schema.object({
  title: Schema.string().required(),
  items: Schema.array(Schema.string()).default([]),
})

const UserDefinedEntrySchema = Schema.object({
  key: Schema.string().required(),
  value: Schema.string().default(''),
})

/**
 * 可变层 schema。
 *
 * `sections` 的默认值是**由标准小标题生成**的，而不是把 8 项硬抄一遍——
 * 抄一遍意味着改 `STANDARD_SECTION_TITLES` 时忘改默认值，两处就会分叉。
 */
const MutableLayerSchema = Schema.object({
  sections: Schema.array(MutableSectionSchema).default(
    STANDARD_SECTION_TITLES.map((title) => ({ title, items: [] })),
  ),
  userDefined: Schema.array(UserDefinedEntrySchema).default([]),
})

const IdentityCardSchema = Schema.object({
  fields: Schema.array(IdentityFieldSchema).default(
    CORE_IDENTITY_KEYS.map((key) => ({ key, value: '', custom: false })),
  ),
  initializedAt: Schema.string().default(''),
  sealedAt: Schema.string().default(''),
})

/**
 * 人格文档 schema。默认值的唯一真源；组合补丁与代码都不得再抄一份。
 *
 * 这里刻意**不写 `: Schema<PersonaDocument>` 标注**：那会把输入类型钉成完整的
 * `PersonaDocument`，于是 `PersonaSchema({})`（只给默认值）在编译期就不合法。
 * 让 schemastery 自己推导，输入类型会自动带上"有默认值的字段可省略"。
 */
export const PersonaSchema = Schema.object({
  schemaVersion: Schema.number().default(PERSONA_SCHEMA_VERSION),
  identityCard: IdentityCardSchema,
  mutableLayer: MutableLayerSchema,
})

/** 造一份"未初始化"的中性默认人格（P-003：未初始化时也要保证 Agent 可用）。 */
export function createDefaultPersona(): PersonaDocument {
  return PersonaSchema({})
}
