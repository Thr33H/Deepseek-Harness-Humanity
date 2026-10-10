/**
 * 人格工具的**返回值**：结果形状、输出 schema、构造与渲染。
 *
 * 为什么单独一个文件：两个工具（init / update）共用同一套结果契约与同一段渲染，
 * 而这段契约的读者是**模型**（P-003 要求"用对话消息展示实际写入内容"）。
 * 放在工具定义里会让"契约"和"参数说明"两份长文本挤在一个文件里，改一处要读三处。
 * @module humanity/persona/tool-result
 */
import type { PersonaDocument, PersonaIssue } from './types.js'
import { validatePersona } from './validate.js'

/** 工具结果里的问题条目（P-011：结构化，措辞由 Agent 组织）。 */
export interface ResultIssue {
  code: string
  path: string
  severity: string
  message: string
}

/** 工具返回的规范值。字段与下面的 `RESULT_SCHEMA` 一一对应。 */
export interface PersonaToolValue {
  ok: boolean
  action: 'init' | 'update'
  message: string
  identityCard: Array<{ key: string; value: string }>
  mutableLayer: Array<{ title: string; items: string[] }>
  userDefined: Array<{ key: string; value: string }>
  issues: ResultIssue[]
}

/**
 * 工具输出契约。
 *
 * 输出 schema 不是模型可见的参数（只有 `parameters` 进 prompt），所以这里刻意用**宽类型**
 * （成败由 `ok` 表达、`action` 用字符串）：契约的作用是让结果可被机器读取与回放，
 * 不是替模型做约束。少一个枚举就少一处"改了枚举值导致旧日志读不出"的风险。
 */
export const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true, description: '是否真的写入成功' },
    action: { type: 'string', required: true, description: 'init | update' },
    message: { type: 'string', required: true, description: '面向 Agent/用户的一句话结论；失败时说明为什么没写入' },
    identityCard: {
      type: 'array',
      required: true,
      description: '写入后生效的固定层字段',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { key: { type: 'string', required: true }, value: { type: 'string', required: true } },
      },
    },
    mutableLayer: {
      type: 'array',
      required: true,
      description: '写入后生效的可变层（标准小标题；兜底层见 userDefined）',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', required: true },
          items: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
    },
    userDefined: {
      type: 'array',
      required: true,
      description: '写入后生效的「用户定义」兜底层',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { key: { type: 'string', required: true }, value: { type: 'string', required: true } },
      },
    },
    issues: {
      type: 'array',
      required: true,
      description: '结构化问题清单；`ok:false` 时至少一条 rejected',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          code: { type: 'string', required: true },
          path: { type: 'string', required: true },
          severity: { type: 'string', required: true },
          message: { type: 'string', required: true },
        },
      },
    },
  },
} as const

/** 把校验问题转成结果里的条目。 */
export function toResultIssues(issues: readonly PersonaIssue[]): ResultIssue[] {
  return issues.map((issue) => ({
    code: issue.code,
    path: issue.path,
    severity: issue.severity,
    message: issue.message,
  }))
}

/** 当前文档的叶子字段快照（只含可 JSON 化的内容，不含活对象）。 */
function snapshot(doc: PersonaDocument): Omit<PersonaToolValue, 'ok' | 'action' | 'message' | 'issues'> {
  return {
    identityCard: doc.identityCard.fields.map((field) => ({ key: field.key, value: field.value })),
    mutableLayer: doc.mutableLayer.sections.map((section) => ({ title: section.title, items: [...section.items] })),
    userDefined: doc.mutableLayer.userDefined.map((entry) => ({ key: entry.key, value: entry.value })),
  }
}

/** 一次成功的写入结果。 */
export function success(
  action: 'init' | 'update',
  doc: PersonaDocument,
  message: string,
  warnings: readonly PersonaIssue[] = [],
): PersonaToolValue {
  return { ok: true, action, message, ...snapshot(doc), issues: toResultIssues(warnings) }
}

/**
 * 一次被拒绝的写入结果。
 *
 * 失败**不抛异常**而是返回结构化结果：这条路径的读者是模型，"为什么没写入"必须和成功结果
 * 走同一条渲染通道；否则模型只会看到一句无上下文的工具错误，然后照旧向用户宣布写好了。
 */
export function refusal(
  action: 'init' | 'update',
  doc: PersonaDocument,
  message: string,
  issues: readonly PersonaIssue[] = [],
): PersonaToolValue {
  return { ok: false, action, message, ...snapshot(doc), issues: toResultIssues(issues) }
}

/**
 * 写入成功后重新算一遍 warnings。
 *
 * 为什么不在写之前算：`write()` 只对外抛 rejected 级问题，warning 级（超长、非标准小标题）
 * 会被吞掉，而它们恰恰是 Agent 该知道的信息（P-015/P-016）。这里用**同一份校验逻辑**补算
 * （`prev` 传 undefined ⇒ 跳过全部依赖历史的判定），保证"报给 Agent 的警告"与"校验器认定的警告"
 * 出自同一个判据，而不是第二套规则。
 * @param doc - 已生效的文档。
 * @returns warning 级问题。
 */
export function warningsOf(doc: PersonaDocument): PersonaIssue[] {
  return validatePersona(doc, undefined, 'agent').issues.filter((issue) => issue.severity === 'warning')
}

/** 工具结果 → 给模型看的文本。成功时展示实际写入内容（P-003 要求"用对话消息展示"）。 */
export function renderValue(value: PersonaToolValue): string {
  const lines = [value.ok ? '已写入生效人格。' : `没有写入（${value.action}）：${value.message}`]

  if (value.ok) {
    lines.push('', '固定层：')
    for (const field of value.identityCard) lines.push(`- ${field.key}：${field.value}`)

    const filled = value.mutableLayer.filter((section) => section.items.length > 0)
    if (filled.length > 0) {
      lines.push('', '可变层：')
      for (const section of filled) lines.push(`- ${section.title}：${section.items.join('；')}`)
    }
    if (value.userDefined.length > 0) {
      lines.push('', '用户定义：')
      for (const entry of value.userDefined) lines.push(`- ${entry.key}：${entry.value}`)
    }

    // P-003 要求消息结尾必须说清"已对 Agent 封存"，且给出改的入口。
    lines.push(
      '',
      value.action === 'init'
        ? '已对 Agent 封存：Agent 无法再次修改固定层。如需修改，请前往 Humanity 工作台。'
        : '固定层保持不变（已封存）；被取代的旧内容已进入历史，不再参与人格注入。',
    )
  }

  for (const issue of value.issues) {
    lines.push(`- [${issue.severity}] ${issue.code} @ ${issue.path}：${issue.message}`)
  }
  return lines.join('\n')
}

/** 纯文本内容块。 */
export function text(content: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: content }]
}
