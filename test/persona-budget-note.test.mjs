/**
 * 0.1.12 · B1：运行注记的百分比**必须与护栏判据同口径**（V5）。
 *
 * 报障（用户 2026-10-09）：`1755/2065` 那一档，判据是 `0.84988 < 0.85` ⇒ **不拦**，
 * 而注记显示「占 85%（预算充足）」—— **显示与判据互相矛盾**。根因是显示层用了 `Math.round`。
 *
 * 修法：显示改用 **`Math.floor`**，于是
 * `floor(used/budget × 100) ≥ 85 ⟺ used/budget ≥ 0.85`（判据的那条精确比较）——
 * "显示的百分数 ≥ 85"与"护栏触发"**恒等价**，相邻档位（1755 → 84% / 1756 → 85%）必然分档。
 *
 * 本文件同时钉住"注记文案里不许出现自相矛盾的组合"这个**可机械复核**的性质。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PERSONA_BUDGET_GUARD_RATIO } from '../lib/evolution/constants.js'
import { isPersonaBudgetGuarded, percentOfBudget, personaBudgetNote } from '../lib/evolution/prompt.js'

/** 真机那一档的预算总数（`prompt/render` 实测值）。 */
const BUDGET = 2065

/** 造一条预算读数（默认无截断）。 */
function fitOf(used, extra = {}) {
  return { budget: BUDGET, used, injected: 30, dropped: 0, truncated: false, ...extra }
}

test('V5 边界：1755/2065（84.988%）**不**触发护栏，且注记说「占 84%（预算充足）」—— 与判据一致', () => {
  const fit = fitOf(1755)
  assert.ok(fit.used / fit.budget < PERSONA_BUDGET_GUARD_RATIO, '前提：这一档确实没到护栏线')
  assert.equal(isPersonaBudgetGuarded(fit), false)

  assert.equal(percentOfBudget(fit), 84, '显示必须是 84（floor），不能再四舍五入成 85')
  const note = personaBudgetNote(fit, false, 0, 0)
  assert.match(note, /占 84%（预算充足）/, `注记：${note}`)
  assert.doesNotMatch(note, /占 85%/, '绝不许出现「占 85%」——那正是报障里与判据矛盾的那半句')
  assert.doesNotMatch(note, /接近上限/, '没触发护栏就不许说接近上限')
  assert.doesNotMatch(note, /本轮只做整合/, '没触发护栏就不许说"只做整合"')
})

test('V5 相邻档位：1756/2065（85.036%）触发护栏，注记说「占 85%（接近上限）」—— 两档可区分', () => {
  const fit = fitOf(1756)
  assert.ok(fit.used / fit.budget >= PERSONA_BUDGET_GUARD_RATIO)
  assert.equal(isPersonaBudgetGuarded(fit), true)

  assert.equal(percentOfBudget(fit), 85, '显示 85')
  const note = personaBudgetNote(fit, true, 0, 0)
  assert.match(note, /占 85%（接近上限）/, `注记：${note}`)
  assert.match(note, /本轮只做整合/, '触发护栏就要说清这一轮只做整合')
  assert.doesNotMatch(note, /预算充足/, '触发护栏时不许说"预算充足"')

  // 两档必须**互相区分**：一条说 84%/充足，一条说 85%/接近上限。
  const lower = personaBudgetNote(fitOf(1755), false, 0, 0)
  assert.notEqual(lower, note, '相邻取值（1755 / 1756）的注记必须不同')
})

test('V5 等价性（防回归）：在阈值两侧整段取值上，「显示 ≥ 85%」与「护栏触发」恒等价', () => {
  for (let used = 1600; used <= 2000; used += 1) {
    const fit = fitOf(used)
    const guarded = isPersonaBudgetGuarded(fit)
    const shown = percentOfBudget(fit) >= PERSONA_BUDGET_GUARD_RATIO * 100
    assert.equal(shown, guarded, `used=${used} 时显示（${percentOfBudget(fit)}%）与判据（${guarded}）必须一致`)
  }
})

test('注记**永不**同时出现「占 ≥85%」与「预算充足/未触发」这类互相矛盾的组合', () => {
  for (let used = 1600; used <= 2000; used += 1) {
    const fit = fitOf(used)
    const guarded = isPersonaBudgetGuarded(fit)
    const note = personaBudgetNote(fit, guarded, 0, 0)
    const claimsAmple = /预算充足/.test(note)
    const claimsNear = /接近上限/.test(note)
    assert.equal(claimsAmple, !guarded, `used=${used}：只有未触发护栏才允许说"预算充足"`)
    assert.equal(claimsNear, guarded, `used=${used}：只有触发护栏才允许说"接近上限"`)
    if (claimsAmple) assert.match(note, /占 (?:[0-8]?\d)%/, `说"预算充足"时百分数必须 < 85%：${note}`)
    if (claimsNear) assert.match(note, /占 (?:8[5-9]|9\d|100)%/, `说"接近上限"时百分数必须 ≥ 85%：${note}`)
  }
})

test('注记保留 0.1.10 就有的那句措辞（时间线对着它读），并如实带上并/拦计数', () => {
  const note = personaBudgetNote(fitOf(1900), true, 3, 2)
  assert.match(note, /人格注入预算：已用 1900\/2065 字符/)
  assert.match(note, /本轮合并同义条目 3 条/, '0.1.10 的字面必须保留（自进化页按它读）')
  assert.match(note, /护栏\/预演拦下拟新增 2 条/, '拦下的新增要记账')
})

test('已截断时注记说"超预算 + 丢了几条"，且不许同时说"预算充足"', () => {
  const fit = fitOf(1900, { truncated: true, dropped: 7 })
  const note = personaBudgetNote(fit, true, 0, 0)
  assert.match(note, /超预算，7 条没能进提示词/)
  assert.doesNotMatch(note, /预算充足/)
})
