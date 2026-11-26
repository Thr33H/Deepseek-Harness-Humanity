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
 * 存储位置说明（工程默认，依据对方裁决 3「先走复用 settings RPC，不新建 gateway」）：
 * 两层都放在本插件自己的设置命名空间里，因为工作台只能通过设置 RPC 读写宿主状态；
 * 若把真源放进存储领域、再往设置里镜像一份，就会出现**两个对方**的同步问题——同一份数据
 * 两个写入方，谁赢取决于调用顺序，这是缺陷温床而不是设计。所以：**一份数据，一个对方**。
 * 存储领域只承担"历史/审计"（append-only，主机写入，不参与人格注入，见 P-009）。
 * @module humanity/persona/model
 */
import Schema from '@deepseek-ai/schemastery'

import { CHARACTER_AXES, CORE_IDENTITY_KEYS, STANDARD_SECTION_TITLES } from './constants.js'
import type { CharacterAxisEntry, CharacterLayer, PersonaDocument } from './types.js'

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
 * 信息 schema。
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
 * 一根性格轴的 schema。
 *
 * **这里刻意不写范围约束**（`.min(0).max(1)` 之类）：范围合法性由 `validate-character.ts`
 * 判定，那里能给出带 `path` 的结构化问题、工作台能定位到那一根轴；
 * 而 schema 层的数值约束只会让**整份文档**解析失败 —— 一根轴越界害得人格整个读不出来，
 * 与"坏一条害死整库"是同一种错误。
 */
const CharacterAxisSchema = Schema.object({
  key: Schema.union(CHARACTER_AXES).required(),
  min: Schema.number().default(0),
  max: Schema.number().default(1),
  value: Schema.number().default(0.5),
  reason: Schema.string().default(''),
})

/**
 * 性格层的 schema。
 *
 * 默认 `derivedAt: ''` + `axes: []` = **还没有性格**（未初始化）。
 * 旧文档没有这一层，读出来就是这个空壳——不需要迁移，也不需要升 `PERSONA_SCHEMA_VERSION`
 * （那管的是"含义变了"，这里只是多了一个带默认值的字段，与情绪模块加 `sensitivities` 同一处理）。
 */
const CharacterLayerSchema = Schema.object({
  derivedAt: Schema.string().default(''),
  axes: Schema.array(CharacterAxisSchema).default([]),
  /**
   * 还没落地的性格累积（情绪推动的）。
   *
   * 为什么要存进文档：它原来只是 `index.ts` 里的一个内存变量，**重启就清零**；
   * 而门槛是"攒够 0.01 且隔 24 小时"。真机一天重启十几次，于是性格**从来没有动过**
   * （2026-11-24 查出来：四根轴与早上完全一致）。
   */
  driftPending: Schema.object({
    axes: Schema.dict(Schema.number()).default({}),
    lastFlushAt: Schema.string().default(''),
  }).default({ axes: {}, lastFlushAt: '' }),
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
  character: CharacterLayerSchema,
})

/** 造一份"未初始化"的中性默认人格（P-003：未初始化时也要保证 Agent 可用）。 */
export function createDefaultPersona(): PersonaDocument {
  return PersonaSchema({})
}

/**
 * 初始化时模型给出的一根轴：**只有一个范围与理由，没有"此刻的值"**。
 *
 * 刻意不让模型给值：值应当从范围中间开始、被经历推动。让模型顺手写一个"她现在就很敏感"，
 * 等于把一次没有依据的判断烙进她的状态里。
 */
export interface CharacterAxisInput {
  key: string
  min: number
  max: number
  reason?: string
}

/** 推导性格的结论：失败时给一句能直接进工具结果的原因。 */
export type CharacterBuild = { ok: true; layer: CharacterLayer } | { ok: false; reason: string }

/** 浮点容差：与 `validate-character.ts` 用同一个口径。 */
const EPSILON = 1e-9

/** 夹到 [0, 1]。 */
const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

/** 保留两位小数（落盘的数字要能被人看懂，`0.30000000000000004` 没有意义）。 */
const round2 = (value: number): number => Math.round(value * 100) / 100

/**
 * 把模型给的四根轴整理成性格层 —— **她的笼子就是在这里定下来的**。
 *
 * 三条规则：
 * 1. 四根必须齐；少一根就整次失败（笼子缺一根，那一根就永远管不住了）；
 * 2. 范围必须在 0–1 且下限不高于上限；
 * 3. 此刻的值取**范围中点** —— 她刚出生，落在自己笼子的正中间，这是唯一一个不依赖任何经历的取值。
 * @param inputs - 模型给的轴。
 * @param now - 推导时刻（ISO 8601）。
 * @returns 结论：成功时是性格层，失败时是一句原因。
 */
export function createCharacter(inputs: readonly CharacterAxisInput[], now: string): CharacterBuild {
  const given = new Map<string, CharacterAxisInput>()
  for (const axis of inputs) {
    if (!(CHARACTER_AXES as readonly string[]).includes(axis?.key ?? '')) {
      return { ok: false, reason: `未知的轴「${axis?.key ?? ''}」：只认 ${CHARACTER_AXES.join(' / ')}` }
    }
    if (given.has(axis.key)) return { ok: false, reason: `轴「${axis.key}」给了两次` }
    given.set(axis.key, axis)
  }
  const missing = CHARACTER_AXES.filter((key) => !given.has(key))
  if (missing.length > 0) return { ok: false, reason: `缺了这几根轴：${missing.join('、')}` }

  const axes: CharacterAxisEntry[] = []
  for (const key of CHARACTER_AXES) {
    const axis = given.get(key) as CharacterAxisInput
    if (!Number.isFinite(axis.min) || !Number.isFinite(axis.max)) {
      return { ok: false, reason: `「${key}」的下限或上限不是数字` }
    }
    if (axis.min < -EPSILON || axis.max > 1 + EPSILON || axis.min > axis.max + EPSILON) {
      return {
        ok: false,
        reason: `「${key}」的范围不合法：要落在 0–1 之间，且下限不能高于上限（收到 ${axis.min}–${axis.max}）`,
      }
    }
    const min = round2(clamp01(axis.min))
    const max = round2(clamp01(axis.max))
    axes.push({ key, min, max, value: round2((min + max) / 2), reason: (axis.reason ?? '').trim() })
  }
  return { ok: true, layer: { derivedAt: now, axes } }
}
