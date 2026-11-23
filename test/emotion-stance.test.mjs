/**
 * 「立场快照」的回归测试。
 *
 * 这一层要钉的是**评估器到底拿到了什么**：人格里会改变"这件事意味着什么"的那几样
 * （性格 / 偏好 / 底线 / 关系 / 称呼 / 自定义设定）必须被读出来、压成一小段、并且**每次现读**。
 *
 * 现场（2026-11-20）：人格写着「好色、性欲强，尤其对主人本人」，评估器却把主人的露骨要求
 * 判成「对TA厌烦（因为又发来露骨的性要求）」—— 因为它拿到的只有"一句话 + 她当前的情绪"。
 * 现场（2026-11-21）：人格里的「特殊癖好」是**自定义底色字段**，第一版快照没取，于是拍屁股
 * 那类事它只能按"第一次见面"猜。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { PERSONA_NAMESPACE as PERSONA_NS_FROM_PERSONA } from '../lib/persona/document.js'
import { PERSONA_NAMESPACE, readStance, renderStance, stanceReader } from '../lib/emotion/stance.js'

/** 一份形状与线上一致的人格文档（含性格层、原生小节、自定义字段）。 */
const persona = () => ({
  identityCard: {
    fields: [
      { key: '姓名', value: '沈迟' },
      { key: '性别', value: '女' },
      { key: '人格偏好', value: '慢热，想清楚才开口；不绕弯子，讨厌敷衍，喜欢真的东西。' },
      { key: '主语言', value: '中文' },
      { key: '特殊癖好', value: '被打屁股' },
    ],
  },
  character: {
    derivedAt: '2026-11-21T05:01:03.041Z',
    axes: [
      { key: 'stability', min: 0.35, max: 0.75, value: 0.55 },
      { key: 'extraversion', min: 0.55, max: 0.92, value: 0.74 },
    ],
  },
  mutableLayer: {
    sections: [
      { title: '对TA的称呼', items: ['火火'] },
      { title: '说话风格', items: ['句子短，语气松。'] },
      { title: '行为边界', items: [] },
      { title: '关系', items: ['第一次见面，还在互相摸脾气'] },
      { title: '雷区', items: ['别拿家人开玩笑'] },
    ],
    userDefined: [{ key: '咖啡', value: '不加糖' }],
  },
})

test('命名空间抄得对：情绪这边写的必须等于人格那边的常量（抄错就永远读不到）', () => {
  assert.equal(PERSONA_NAMESPACE, PERSONA_NS_FROM_PERSONA)
})

test('读得出那几样：性格、人格偏好、自定义字段、底线、关系、称呼、自定义小节', () => {
  const stance = readStance(persona())
  assert.ok(stance !== undefined)
  assert.match(stance.character, /此刻的你/, '性格层被渲染成了一句话')
  // 人格偏好与"特殊癖好"都要在 —— 后者是自定义底色字段，第一版漏过它。
  assert.deepEqual(stance.traits, [
    { key: '人格偏好', value: '慢热，想清楚才开口；不绕弯子，讨厌敷衍，喜欢真的东西。' },
    { key: '特殊癖好', value: '被打屁股' },
  ])
  // 姓名/性别/主语言不参与"意义判断"，不进立场。
  assert.equal(stance.traits.some((entry) => entry.key === '姓名'), false)
  assert.deepEqual(stance.boundaries, [], '空的行为边界就是"没写明"，不要编')
  assert.deepEqual(stance.relation, ['第一次见面，还在互相摸脾气'])
  assert.deepEqual(stance.address, ['火火'])
  // 非原生小节进"其他设定"（说话风格是"怎么表达"，不是"什么有意思"，不进）。
  assert.deepEqual(stance.sections, [{ title: '雷区', items: ['别拿家人开玩笑'] }])
  assert.deepEqual(stance.custom, [{ key: '咖啡', value: '不加糖' }])
})

test('形状残缺也不炸：形状不对/没人格/全空都读成 undefined', () => {
  assert.equal(readStance(undefined), undefined)
  assert.equal(readStance(null), undefined)
  assert.equal(readStance('不是对象'), undefined)
  assert.equal(readStance({}), undefined, '什么都没有 = 没有人格')
  assert.equal(
    readStance({ identityCard: { fields: [{ key: '姓名', value: '沈迟' }] }, mutableLayer: { sections: [] } }),
    undefined,
    '只有姓名不算立场（它不改变"这件事意味着什么"）',
  )
})

test('渲染：第二人称、开头点明"以你的立场为准"，底线为空时明说别替自己补', () => {
  const text = renderStance(readStance(persona()))
  assert.match(text, /【你的立场】/, '开头要有这个小标题')
  assert.match(text, /以这个为准/)
  assert.match(text, /- 你是谁：/, '性格那行去掉原前缀后放进"你是谁"')
  assert.equal(text.includes('此刻的你'), false, '渲染时吃掉 characterLine 的前缀，读起来才不像提示词碎片')
  assert.match(text, /- 你的人格偏好：慢热/)
  assert.match(text, /- 你的特殊癖好：被打屁股/, '自定义底色字段要进立场')
  assert.match(text, /- 你的底线：没有特别写明/)
  assert.match(text, /- 你和对方的关系：第一次见面/)
  assert.match(text, /- 你叫对方：火火/)
  assert.match(text, /- 你的雷区：别拿家人开玩笑/, '非原生小节也要进')
  assert.match(text, /- 你的咖啡：不加糖/)
  assert.equal(text.includes('说话风格'), false, '说话风格不参与"意义判断"')
  assert.equal(renderStance(undefined), '', '没有立场就不加这一段')
})

test('底线写了就照写（不替她补、也不替她删）', () => {
  const doc = persona()
  doc.mutableLayer.sections[2] = { title: '行为边界', items: ['不接别的称呼', '不聊工作上的事'] }
  const text = renderStance(readStance(doc))
  assert.match(text, /你的底线：不接别的称呼；不聊工作上的事/)
  assert.equal(text.includes('没有特别写明'), false)
})

test('现读：人格改过之后，下一次读到的是新的（不缓存）', () => {
  let doc = persona()
  const read = stanceReader(() => doc)
  assert.match(read()?.traits[0]?.value ?? '', /慢热/)

  doc = { ...persona(), identityCard: { fields: [{ key: '人格偏好', value: '冷淡，不喜亲近。' }] } }
  assert.match(read()?.traits[0]?.value ?? '', /冷淡/, '第二次读到的是改过之后的')
})

test('读人格抛错时退回"没有立场"，绝不让情绪评估跟着失败', () => {
  const read = stanceReader(() => {
    throw new Error('设置服务还没接上')
  })
  assert.equal(read(), undefined)
})
