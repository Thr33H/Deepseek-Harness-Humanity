/**
 * 校验入口：把固定层与可变层的判定汇总成一份结论。
 *
 * 只做**确定性**判定（结构、封存、"是否删掉了原有内容"）。任何需要理解语义的判定都不在这里：
 * 那属于 Agent 的整理职责（P-017），这一层只提供它必须遵守的机械约束。
 * @module humanity/persona/validate
 */
import { CONFIRMABLE_ISSUES } from './constants.js'
import type { PersonaDocument, PersonaIssue, PersonaValidation, ValidateOptions, WriteSource } from './types.js'
import { checkIdentity } from './validate-identity.js'
import { checkMutable } from './validate-mutable.js'

/**
 * 校验一次写入。
 *
 * 只做**确定性**判定：结构、封存、以及"是否删掉了原有内容"。任何需要理解语义的判定
 * 都不在这里（见文件头说明）。
 * @param next - 规范化之后的候选文档。
 * @param prev - 当前生效文档；首次初始化时传 `undefined`。
 * @param source - 写入来源。
 * @param options - 额外上下文（目前只有"用户已确认"的白名单）。
 * @returns 校验结论；`ok === false` 时必须拒绝写入。
 */
export function validatePersona(
  next: PersonaDocument,
  prev: PersonaDocument | undefined,
  source: WriteSource,
  options: ValidateOptions = {},
): PersonaValidation {
  const issues: PersonaIssue[] = []

  checkIdentity(next, prev, source, issues)
  checkMutable(next, prev, source, issues)

  // 白名单在这里**再拦一次**，不只在工具层拦：`confirmed` 是"用户点头了"的凭证，
  // 而 `validatePersona` 是所有人（工具、设置钩子、客户端直写）都会经过的那道门。
  // 类型只能约束 TypeScript 调用方，拦不住运行时传进来的字符串——所以把白名单做成
  // 运行时事实，而不是注释里的承诺。
  const confirmable = new Set<string>(CONFIRMABLE_ISSUES)
  const confirmed = new Set<string>((options.confirmed ?? []).filter((code) => confirmable.has(code)))
  const effective = issues.map((issue) =>
    issue.severity === 'rejected' && confirmed.has(issue.code) ? { ...issue, severity: 'warning' as const } : issue,
  )

  return { ok: !effective.some((issue) => issue.severity === 'rejected'), issues: effective }
}

