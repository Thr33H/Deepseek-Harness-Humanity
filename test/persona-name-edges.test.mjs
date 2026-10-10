/**
 * 0.1.8 两条精确性小修的**边界钉子**（`identityNameOf` / 身份行）。
 *
 * 背景：两条缺陷都只在**异常数据**上触发，所以常规用例（真实形态、常见形态）全绿也证明不了它们被修好。
 * 本文件专门钉"异常侧"：
 *
 * - **缺陷①（空锚点）**：`本名：；别名：` 这类"标签写了、值空着"的输入，0.1.7 返回 **`"："`**
 *   ⇒ 身份行变成「…一台机器上的「：」」。**比降级更糟**（降级只是不写名字，这个是写了个假名字）。
 * - **缺陷②（超长截断）**：25–120 字的值（含从标签里解析出的超长名字）在 0.1.7 会被切成
 *   `前 24 字…` 塞进身份行，而同一文件的注释与既有测试的**意图**都是"超长 ⇒ 降级、不猜"。
 *
 * ⚠️ 判据只看**身份行那一行**：整份 prompt 里固定层本来就会渲染 `- 姓名：<值>`（超 120 字由 `clip()`
 * 截断并留 `…`，那是设计行为）。拿整份 prompt 做 `includes` 断言会误伤（见 `name-fix.md` §5 的教训）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CORE_IDENTITY_KEYS } from '../lib/persona/constants.js'
import { createDefaultPersona } from '../lib/persona/model.js'
import { identityNameOf, identityStatementOf } from '../lib/persona/render-content.js'
import { renderPersonaPrompt } from '../lib/persona/render.js'

const NAME_KEY = CORE_IDENTITY_KEYS[0]

/** 单元级：喂一个姓名值，取 `identityNameOf` 的结果。 */
const nameOf = (value) => identityNameOf({ fields: [{ key: NAME_KEY, value }], sections: [], userDefined: [] })

/** 端到端：渲染真人格段，取**身份行那一行**。 */
function identityLineOf(value) {
  const persona = createDefaultPersona()
  persona.identityCard.fields[0].value = value
  persona.identityCard.initializedAt = '2026-09-23T00:00:00.000Z'
  persona.identityCard.sealedAt = '2026-09-23T00:00:00.000Z'
  const text = renderPersonaPrompt(persona, { enabled: true })
  return text.split('\n').find((line) => line.startsWith('我是运行在'))
}

/** 降级形态（不写名字）那一句。 */
const DEGRADED = /我是运行在 DeepSeek Harness 里的一台机器上的一个 AI。/

// ───────────────────────────── 缺陷①：空锚点 / 纯标点 ─────────────────────────────

test('0.1.8 缺陷①：空锚点（标签写了、值空着）⇒ 降级，**绝不返回标点当名字**', () => {
  // 0.1.7 实测：这些都是 `"："` —— 裸值分支抓到了锚点后面那个冒号本身。
  const cases = [
    ['本名：；别名：', '生产实测的那一条（§12.3）'],
    ['本名：；', '只有本名、且空'],
    ['本名：', '只有标签与冒号'],
    ['姓名：；别名：', '换个标签词同样形态'],
    ['本名： ： ', '冒号后只有空白'],
    ['别名：；本名：', '两个标签都空'],
  ]
  for (const [value, why] of cases) {
    assert.equal(nameOf(value), undefined, `${why}：${JSON.stringify(value)} ⇒ 必须降级（0.1.7 会返回 "："）`)
  }
})

test('0.1.8 缺陷①：纯标点/纯空白的值 ⇒ 降级（"够格当名字"的判据 = 至少一个实义字符）', () => {
  const cases = [['：'], ['。。'], ['。。。'], ['；'], ['、'], ['「」'], ['「：」'], ['　'], ['  '], ['—'], ['…']]
  for (const [value] of cases) {
    assert.equal(nameOf(value), undefined, `纯标点/空白不得当名字：${JSON.stringify(value)}`)
  }
})

test('0.1.8 缺陷①（端到端）：空锚点时身份行**只有降级形态**，不出现「：」这种假名字', () => {
  const line = identityLineOf('本名：；别名：')
  assert.ok(line !== undefined, '身份行必须在')
  assert.match(line, DEGRADED, '空锚点 ⇒ 降级成不写名字')
  assert.doesNotMatch(line, /「：」/, '不得出现「：」')
  assert.doesNotMatch(line, /「/, '降级形态里不应有任何名字引号')
  assert.doesNotMatch(line, /本名|别名/, '标签不得混进身份行')
})

// ───────────────────────────── 缺陷②：超长 ⇒ 降级，不截断 ─────────────────────────────

test('0.1.8 缺陷②：25–120 字的裸值 ⇒ 降级（**不再截成 `前 24 字…`**）', () => {
  // 0.1.7 实测：25 / 50 / 119 / 120 字都会返回 `前 24 字 + …`。这是本轮修掉的那条。
  for (const length of [25, 30, 50, 119, 120]) {
    const value = '阿'.repeat(length)
    assert.equal(nameOf(value), undefined, `${length} 字的裸值不得被截断当名字（0.1.7 会返回 24 字 + …）`)
  }
})

test('0.1.8 缺陷②：名字上限是**准入**判据，不是截断点（24 收下、25 降级）', () => {
  assert.equal(nameOf('阿'.repeat(24)), '阿'.repeat(24), '恰好 24 字仍在准入内')
  assert.equal(nameOf('阿'.repeat(25)), undefined, '25 字 ⇒ 降级（0.1.7 是截断）')
})

test('0.1.8 缺陷②：从标签里解析出的超长名字 ⇒ 也降级（两道闸口径统一）', () => {
  const cases = ['本名：' + '阿'.repeat(30), '本名：「' + '阿'.repeat(30) + '」', '别名：' + '阿'.repeat(40)]
  for (const value of cases) {
    assert.equal(nameOf(value), undefined, `解析出的名字超 24 字 ⇒ 降级：${JSON.stringify(value.slice(0, 12))}…`)
  }
})

test('0.1.8 缺陷②（端到端）：超长值进不了身份行，且身份行里**永不出现截断标记 `…`**', () => {
  for (const value of ['阿'.repeat(30), '很长的名字'.repeat(12), '本名：' + '阿'.repeat(40)]) {
    const line = identityLineOf(value)
    assert.ok(line !== undefined, '身份行必须在')
    assert.doesNotMatch(line, /…/, '身份行不得出现截断标记')
    assert.match(line, DEGRADED, '超长 ⇒ 降级形态')
  }
})

test('0.1.8 缺陷②：>120 字仍降级（这条 0.1.7 已正确，钉住不许回退）', () => {
  for (const length of [121, 130, 400]) {
    assert.equal(nameOf('阿'.repeat(length)), undefined, `${length} 字 ⇒ 降级`)
  }
})

// ───────────────────────────── 原有正确行为：这一版不许碰坏 ─────────────────────────────

test('0.1.8 回归：常见形态逐一对齐（简单 / 引号 / 无引号 / 标签顺序颠倒 / 半角冒号）', () => {
  const cases = [
    ['本名：「示例」；别名：「例子」', '示例', '用户卡形态'],
    ['小安', '小安', '干净名字整串收下'],
    ['「小安」', '小安', '只有一对引号'],
    ['本名：小安；别名：小亮', '小安', '无引号'],
    ['别名：「例子」；本名：「示例」', '示例', '标签顺序颠倒'],
    ['本名: 示例', '示例', '半角冒号'],
    ['别名：「例子」', '例子', '只有别名时它就是唯一线索'],
  ]
  for (const [value, expected, why] of cases) {
    assert.equal(nameOf(value), expected, `${why}：${JSON.stringify(value)} ⇒ ${JSON.stringify(expected)}`)
  }
})

test('0.1.8 回归：能当名字的结果里**绝不含**标签 / 分隔符 / 省略号', () => {
  const inputs = [
    '本名：「示例」；别名：「例子」',
    '本名：「示例」；别名：「例子」；昵称：「小例」',
    '小安',
    '「示例」',
    '姓名：示例',
    '本名：示例；别名：例子',
    '名称：示例；全名：示例示例',
    '本名：示例\n',
    ' 小安 ',
  ]
  for (const value of inputs) {
    const name = nameOf(value)
    assert.ok(name !== undefined, `这一组都该解析出名字：${JSON.stringify(value)}`)
    assert.doesNotMatch(name, /本名|别名|姓名|名字|名称|全名|昵称/, `标签漏进名字：${JSON.stringify(name)}`)
    assert.doesNotMatch(name, /[;；,，:：]/, `分隔符漏进名字：${JSON.stringify(name)}`)
    assert.doesNotMatch(name, /…/, `名字里不得有截断标记：${JSON.stringify(name)}`)
    assert.ok(name.length <= 24, `名字超过准入上限：${name.length}`)
  }
})

test('0.1.8 回归：保守降级三类不变（多行 / 多引号段无标签 / 空值）', () => {
  const cases = [
    ['本名：小安\n别名：小亮', '多行：不猜哪一行是名字'],
    ['小安\n小亮', '多行（无标签）'],
    ['「小安」和「小亮」', '多个引号段，看不出哪个是名字'],
    ['', '空值'],
    ['   ', '全空白'],
  ]
  for (const [value, why] of cases) {
    assert.equal(nameOf(value), undefined, `${why}：${JSON.stringify(value)}`)
  }
})

test('0.1.8 回归：真实形态的**身份行逐字**仍正确（用户卡那一条）', () => {
  const line = identityLineOf('本名：「示例」；别名：「例子」')
  assert.match(line, /^我是运行在 DeepSeek Harness 里的一台机器上的「示例」。/)
  const name = /「(.+?)」/.exec(line)?.[1] ?? ''
  assert.equal(name, '示例', `名字应恰好是「示例」，实际 ${JSON.stringify(name)}`)
  assert.match(line, /下面写的不是我在扮演的角色，是我自己/)
})

test('0.1.8 回归：身份陈述句的**降级形态**未被改动', () => {
  const statement = identityStatementOf({ fields: [{ key: NAME_KEY, value: '本名：；别名：' }], sections: [], userDefined: [] })
  assert.equal(
    statement,
    '我是运行在 DeepSeek Harness 里的一台机器上的一个 AI。' +
      '下面写的不是我在扮演的角色，是我自己；运行在服务器上、要靠工具才能碰到东西，这些是事实，不改变我是谁。',
    '降级形态应逐字不变（只是"少掉名字那一小块"）',
  )
})
