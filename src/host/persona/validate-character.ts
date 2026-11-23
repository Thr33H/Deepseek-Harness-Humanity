/**
 * 性格轴的判定（2026-11-20 新增）。
 *
 * 只判**机械约束**：四根轴齐不齐、数值合不合法、封存之后 Agent 还能不能动。
 * 任何"这根轴该是多少"的判断都不在这里 —— 那是初始化时她自己的推导（`init.ts`），
 * 以及之后由经历推动的漂移（`drift.ts`，2026-11-23 起：封存只锁**范围**，位置可以在范围内被动挪）。
 *
 * ### 封存的分界
 *
 * 笼子（`min` / `max` / `reason`）与底色同一条纪律：**推导一次就封存，Agent 之后不能改**，
 * 只有对方能在工作台改。理由是它就是"天生"这件事本身 —— 能给模型随口改的"天生"，等于没有。
 *
 * 此刻的值（`value`）**不在这里变**：它由经历推动，将来走一条独立于人格编辑的内部路径。
 * 这一版还没有那条路，所以 `value` 在这一层和笼子一样是静止的（初始化时一次定下）。
 * @module humanity/persona/validate-character
 */
import { CHARACTER_AXES } from './constants.js'
import type { CharacterAxisEntry, PersonaDocument, PersonaIssue, WriteSource } from './types.js'

/** 浮点比较的容差：0–1 的轴用两位小数足够，但不要让 0.30000000000000004 判成越界。 */
const EPSILON = 1e-9

/** 造一条问题。 */
function problem(
  code: PersonaIssue['code'],
  path: string,
  severity: 'rejected' | 'warning',
  message: string,
): PersonaIssue {
  return { code, path, severity, message }
}

/** 值是否落在 [0, 1]（含端点）。 */
const inUnitRange = (value: number): boolean => Number.isFinite(value) && value >= -EPSILON && value <= 1 + EPSILON

/**
 * 单项轴的机械检查。
 * @param axis - 候选轴。
 * @param index - 它在数组里的位置（拼 `path` 用）。
 * @param issues - 收集问题的容器。
 */
function checkAxis(axis: CharacterAxisEntry, index: number, issues: PersonaIssue[]): void {
  const base = `character.axes[${index}]`
  const name = axis.key
  for (const [field, value] of [
    ['min', axis.min],
    ['max', axis.max],
    ['value', axis.value],
  ] as const) {
    if (!inUnitRange(value)) {
      issues.push(
        problem('character.range-invalid', `${base}.${field}`, 'rejected', `${name} 的 ${field} 必须是 0–1 之间的数`),
      )
    }
  }
  if (axis.min > axis.max + EPSILON) {
    issues.push(
      problem('character.range-invalid', `${base}.min`, 'rejected', `${name} 的下限不能高于上限（${axis.min} > ${axis.max}）`),
    )
  }
  // 范围已经变形时不再判"值是否在范围内"：那只会多一条由同一起因派生的噪声。
  if (axis.min <= axis.max + EPSILON && (axis.value < axis.min - EPSILON || axis.value > axis.max + EPSILON)) {
    issues.push(
      problem(
        'character.value-out-of-range',
        `${base}.value`,
        'rejected',
        `${name} 此刻的值 ${axis.value} 掉出了它的范围 ${axis.min}–${axis.max}`,
      ),
    )
  }
  if ((axis.reason ?? '').trim() === '') {
    // 只警告不拒绝：理由是"这个范围为什么成立"的来路，缺了不影响功能，
    // 但会让以后所有的解释都断线 —— 所以提示，而不是卡住初始化。
    issues.push(problem('character.reason-missing', `${base}.reason`, 'warning', `${name} 没有写下理由`))
  }
}

/**
 * 已推导的性格是否与上一版一致（只比笼子和理由，**不比 `value`**）。
 *
 * 为什么排除 `value`：它是"此刻"的量，将来会被经历推动。如果它也进这条比对，
 * 那么任何一次内部演化都会被当成"Agent 改了封存的笼子"而被拒 —— 把两类完全不同的事
 * 混成了同一道闸。
 */
function shapeOf(entries: readonly CharacterAxisEntry[]): string {
  return JSON.stringify(
    [...entries]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((axis) => [axis.key, axis.min, axis.max, (axis.reason ?? '').trim()]),
  )
}

/**
 * 判定性格部分。
 * @param next - 候选文档。
 * @param prev - 当前生效文档；首次初始化时为 `undefined`。
 * @param source - 写入来源。
 * @param issues - 收集问题的容器。
 */
export function checkCharacter(
  next: PersonaDocument,
  prev: PersonaDocument | undefined,
  source: WriteSource,
  issues: PersonaIssue[],
): void {
  const candidate = next?.character
  // 形状可能残缺：手工构造的文档、以及这一层出现之前写入的文档根本没有 character。
  // "少了整块"与 `derivedAt` 为空是同一个语义（还没有性格）—— 校验不该因为旧数据而崩。
  if (candidate === undefined || candidate === null || candidate.derivedAt === '') return
  const axes: readonly CharacterAxisEntry[] = Array.isArray(candidate.axes) ? candidate.axes : []

  const seen = new Set<string>()
  for (const axis of axes) seen.add(axis.key)
  const missing = CHARACTER_AXES.filter((key) => !seen.has(key))
  if (missing.length > 0) {
    issues.push(problem('character.axis-missing', 'character.axes', 'rejected', `性格缺了这几根：${missing.join('、')}`))
  }
  axes.forEach((axis, index) => checkAxis(axis, index, issues))

  // 封存：已经有笼子之后再改，只允许用户改。
  const sealedBefore = prev?.character?.derivedAt ?? ''
  const before = Array.isArray(prev?.character?.axes) ? prev.character.axes : []
  if (sealedBefore !== '' && source === 'agent' && shapeOf(axes) !== shapeOf(before)) {
    issues.push(
      problem(
        'character.sealed',
        'character.axes',
        'rejected',
        '性格的范围已经封存：Agent 不能改，改了请对方在工作台里动',
      ),
    )
  }
}
