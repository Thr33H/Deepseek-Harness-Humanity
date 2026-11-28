/**
 * 从人格里那行"对TA的称呼"里取一个名字。
 *
 * 为什么值得钉：那一行是给人看的短句（`日常：「小明」「老板」`），
 * 直接塞进醒来词就成了"「小明」「老板」不在你身边"——像在念清单。
 * 真机 2026-11-25 第一次上机就是这样。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { pickUserName } from '../lib/text.js'

test('取引号里的第一个名字', () => {
  assert.equal(pickUserName('日常：「小明」「老板」'), '小明')
  assert.equal(pickUserName('「阿澈」'), '阿澈')
  assert.equal(pickUserName('"小明"'), '小明')
})

test('没有引号时去掉"日常："这类前缀，再清掉引号与分隔符', () => {
  assert.equal(pickUserName('日常：小明'), '小明')
  assert.equal(pickUserName('小明、老板'), '小明 老板')
  assert.equal(pickUserName('  小明  '), '小明')
})

test('空的取不出来就返回空串（调用方退回"他"）', () => {
  assert.equal(pickUserName(''), '')
  assert.equal(pickUserName('   '), '')
})
