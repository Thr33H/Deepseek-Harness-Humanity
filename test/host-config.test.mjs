/**
 * 开关默认值的回归测试。
 *
 * 这里把默认值**逐字段钉死**，而不是断言 `Config({}) .enabled === true`：
 * G-004 要求「默认值一次定死，后续升级保持默认不变」，任何一次无意的默认值漂移
 * （改 schema、改组合补丁、换 schemastery 版本带来的解析差异）都必须让这个测试变红。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Config } from '../lib/index.js'
import { EXPECTED_DEFAULTS } from './helpers/expected-defaults.mjs'

// 默认值快照的说明与出处见 helpers/expected-defaults.mjs（G-004：改它 = 改产品决策）。

test('空配置解析出 P-048 的默认值', () => {
  assert.deepEqual(Config({}), EXPECTED_DEFAULTS)
})

test('缺省输入与空对象等价（组合补丁不写 config 也能拿到全部默认值）', () => {
  assert.deepEqual(Config(undefined), EXPECTED_DEFAULTS)
})

test('用户覆盖只改指定字段，其余字段保持默认', () => {
  const resolved = Config({ modules: { memory: { maxInject: 1 } } })
  assert.equal(resolved.modules.memory.maxInject, 1)
  assert.equal(resolved.modules.memory.enabled, true)
  assert.equal(resolved.enabled, true)
  assert.equal(resolved.modules.persona.enabled, true)
})

test('总开关可以单独关掉，模块开关不受影响', () => {
  const resolved = Config({ enabled: false })
  assert.equal(resolved.enabled, false)
  assert.equal(resolved.modules.persona.enabled, true)
})

test('记忆开关可以单独关掉（2026-11-20 起只有"记不记/带几条/忘不忘"三件事）', () => {
  const resolved = Config({ modules: { memory: { enabled: false, decay: false } } })
  assert.equal(resolved.modules.memory.enabled, false)
  assert.equal(resolved.modules.memory.decay, false)
  assert.equal(resolved.modules.memory.maxInject, 3, '没覆盖的项保持默认')
})
