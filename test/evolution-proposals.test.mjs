/**
 * 提案审核测试：approve/reject/delete 状态机、封存语义（source='user'）、
 * 失败保持 pending、拒绝留档与幂等。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createProposalActions } from '../lib/evolution/proposals.js'
import { createLog } from '../lib/log.js'
import { PersonaWriteRejected } from '../lib/persona/document.js'
import { CORE_IDENTITY_KEYS, STANDARD_SECTION_TITLES } from '../lib/persona/constants.js'
import { createProposal } from '../lib/evolution/model.js'
import { fakeEvolutionState } from './helpers/evolution-fake.mjs'

const log = createLog(new Context(), 'test')

/** 造一份"已初始化"的人格文档。 */
function initializedPersona() {
  return {
    schemaVersion: 1,
    identityCard: {
      fields: CORE_IDENTITY_KEYS.map((key, index) => ({ key, value: index === 0 ? '旧名' : '值', custom: false })),
      initializedAt: '2026-09-01T00:00:00.000Z',
      sealedAt: '2026-09-01T00:00:00.000Z',
    },
    mutableLayer: {
      sections: STANDARD_SECTION_TITLES.map((title) => ({ title, items: [] })),
      userDefined: [],
    },
  }
}

/** 造假人格段（可设定拒绝；记录写入）。 */
function fakePersona(document, options = {}) {
  const writes = []
  return {
    writes,
    read: () => document,
    write: async (next, source) => {
      if (options.reject !== undefined) throw new PersonaWriteRejected(options.reject)
      writes.push({ next, source })
      document = next
    },
    attached: true,
    onDocumentChanged: () => () => {},
  }
}

/** 造审核环境。 */
function harness(options = {}) {
  const { state } = fakeEvolutionState()
  const persona = options.persona === null ? undefined : fakePersona(options.document ?? initializedPersona(), options)
  const actions = createProposalActions({ state, persona: () => persona, log })
  return { state, persona, actions }
}

/** 落一条提案进表并返回记录。 */
async function seed(state, kind, payload, overrides = {}) {
  const record = createProposal({ kind, title: overrides.title ?? `${kind} 提案`, reason: '测试', payload }, 65536)
  await state.putProposal({ ...record, ...overrides })
  return record
}

test('approve 固定层提案：以 user 身份写入（字段更新 + 新字段追加 custom），状态转 applied', async () => {
  const { state, persona, actions } = harness()
  const proposal = await seed(state, 'persona', { type: 'identity', fieldKey: '姓名', fieldValue: '新名' })
  const other = await seed(state, 'persona', { type: 'identity', fieldKey: '归属地', fieldValue: '示例城市' }, { title: '归属地提案' })

  const notice1 = await actions.approve(proposal.id)
  assert.ok(notice1.includes('以你的名义'))
  const nameField = persona.writes[0].next.identityCard.fields.find((field) => field.key === '姓名')
  assert.equal(nameField.value, '新名')
  assert.equal(persona.writes[0].source, 'user', '批准是用户动作：写入来源必须是 user')
  assert.equal(state.getProposal(proposal.id).status, 'applied')
  assert.ok(state.getProposal(proposal.id).decidedAt !== '')

  await actions.approve(other.id)
  const added = persona.writes[1].next.identityCard.fields.find((field) => field.key === '归属地')
  assert.deepEqual(added, { key: '归属地', value: '示例城市', custom: true })
})

test('approve 时人格模块不可用：如实说明，提案保持 pending', async () => {
  const { state, actions } = harness({ persona: null })
  const proposal = await seed(state, 'persona', { type: 'identity', fieldKey: '姓名', fieldValue: 'x' })
  const notice = await actions.approve(proposal.id)
  assert.ok(notice.includes('人格模块当前不可用'))
  assert.equal(state.getProposal(proposal.id).status, 'pending')
})

test('approve 可变层提案：合并进当前文档（不整份覆盖）', async () => {
  const document = initializedPersona()
  document.mutableLayer.sections[1].items = ['已有的风格'] // 说话风格
  const { state, persona, actions } = harness({ document })
  const proposal = await seed(state, 'persona', {
    type: 'mutable',
    sections: [{ section: '说话风格', items: ['先结论后依据'] }],
  })

  await actions.approve(proposal.id)
  const style = persona.writes[0].next.mutableLayer.sections.find((section) => section.title === '说话风格')
  assert.deepEqual(style.items, ['已有的风格', '先结论后依据'])
  assert.equal(state.getProposal(proposal.id).status, 'applied')
})

test('approve 只带整合建议的可变层提案：人格卡真的变了（不是标个 applied 就完事）', async () => {
  // 2026-09-26 审计：这类提案没有 `sections` 可加，只有 `consolidations`（把几条同义条目并成一条）。
  // 旧实现只读 sections ⇒ 用户点了「批准」、提案被标成 applied，人格卡却一个字没变。
  const document = initializedPersona()
  document.mutableLayer.sections[1].items = ['台词不加括号，直接写', '台词不加括号、直接写'] // 说话风格
  const { state, persona, actions } = harness({ document })
  const proposal = await seed(state, 'persona', {
    type: 'mutable',
    sections: [],
    consolidations: [{ section: '说话风格', keep: '台词不加括号，直接写', drop: ['台词不加括号、直接写'] }],
  })

  const notice = await actions.approve(proposal.id)
  const style = persona.writes[0]?.next.mutableLayer.sections.find((section) => section.title === '说话风格')
  assert.deepEqual(style?.items, ['台词不加括号，直接写'], '两条重复条目被并成一条')
  assert.equal(state.getProposal(proposal.id).status, 'applied')
  assert.match(notice, /已应用/)
})

test('approve 被人格校验拒绝：保持 pending，拒绝原因给用户看（P-011 不静默）', async () => {
  const { state, actions } = harness({
    reject: [{ code: 'identity.conflict', path: '姓名', severity: 'rejected', message: '与现有字段冲突' }],
  })
  const proposal = await seed(state, 'persona', { type: 'identity', fieldKey: '姓名', fieldValue: 'x' })
  const notice = await actions.approve(proposal.id)
  assert.ok(notice.includes('与现有字段冲突'))
  assert.equal(state.getProposal(proposal.id).status, 'pending')
})

test('approve 路由提案：applied + 如实说明已裁撤（不假装生效；历史类别仍可处理）', async () => {
  const { state, actions } = harness()
  const proposal = await seed(state, 'route', { title: '夜间便宜模型', reason: '成本', scenario: '', provider: '', model: '' })
  const notice = await actions.approve(proposal.id)
  assert.ok(notice.includes('已裁撤'), '必须说清自动路由已裁撤，不能暗示以后会生效')
  assert.ok(!notice.includes('尚未交付'), '不再有"等 M4 交付"的说法')
  assert.equal(state.getProposal(proposal.id).status, 'applied')
})

test('reject 与 delete：拒绝留档、删除移除；不存在的 id 给中性文案', async () => {
  const { state, actions } = harness()
  const proposal = await seed(state, 'route', { title: 't', reason: '' })
  const notice = await actions.reject(proposal.id)
  assert.ok(notice.includes('已拒绝'))
  assert.equal(state.getProposal(proposal.id).status, 'rejected')

  assert.ok((await actions.delete(proposal.id)).includes('已删除'))
  assert.equal(state.getProposal(proposal.id), undefined)
  assert.ok((await actions.delete('nope')).includes('不存在'))
  assert.ok((await actions.approve('nope')).includes('不存在'))
})

test('重复 approve：第二次不再应用（幂等，不双写人格）', async () => {
  const { state, persona, actions } = harness()
  const proposal = await seed(state, 'persona', { type: 'identity', fieldKey: '姓名', fieldValue: '新名' })
  await actions.approve(proposal.id)
  const notice = await actions.approve(proposal.id)
  assert.ok(notice.includes('已被处理过'))
  assert.equal(persona.writes.length, 1)
})
