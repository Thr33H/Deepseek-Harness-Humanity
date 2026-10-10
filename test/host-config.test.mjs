/**
 * 开关默认值的回归测试。
 *
 * 这里把默认值**逐字段钉死**，而不是断言 `Config({}) .enabled === true`：
 * G-004 要求「默认值一次定死，后续升级保持默认不变」，任何一次无意的默认值漂移
 * （改 schema、改组合补丁、换 schemastery 版本带来的解析差异）都必须让这个测试变红。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Config, MEMORY_MODES } from '../lib/index.js'
import { EXPECTED_DEFAULTS } from './helpers/expected-defaults.mjs'

// 默认值快照的说明与出处见 helpers/expected-defaults.mjs（G-004：改它 = 改产品决策）。

test('空配置解析出 P-048 的默认值', () => {
  assert.deepEqual(Config({}), EXPECTED_DEFAULTS)
})

test('缺省输入与空对象等价（组合补丁不写 config 也能拿到全部默认值）', () => {
  assert.deepEqual(Config(undefined), EXPECTED_DEFAULTS)
})

test('用户覆盖只改指定字段，其余字段保持默认', () => {
  const resolved = Config({ modules: { memory: { mode: 'manual' } } })
  assert.equal(resolved.modules.memory.mode, 'manual')
  assert.equal(resolved.enabled, true)
  assert.equal(resolved.modules.persona.enabled, true)
})

test('总开关可以单独关掉，模块开关不受影响', () => {
  const resolved = Config({ enabled: false })
  assert.equal(resolved.enabled, false)
  assert.equal(resolved.modules.persona.enabled, true)
})

test('记忆模式只接受约定的四种取值', () => {
  for (const mode of MEMORY_MODES) {
    assert.equal(Config({ modules: { memory: { mode } } }).modules.memory.mode, mode)
  }
  assert.throws(() => Config({ modules: { memory: { mode: 'turbo' } } }))
})
