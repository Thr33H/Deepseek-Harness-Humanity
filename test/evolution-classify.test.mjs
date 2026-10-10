/**
 * 分类写回测试：P-038 权限分层（记忆自动/敏感待确认、可变层自动、固定层只提案）、
 * P-041 技能查重四分类、跨轮提案去重、模块关闭时不越权写数据。
 *
 * 记忆写入用**真管线**（`remember()` + 真策略解析）：classify 的命题是"权限分层被遵守"，
 * 而分层的一半保证在记忆管线里（敏感→pending、去重、冲突），假货会测不到真行为。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { applyAnalysis } from '../lib/evolution/classify.js'
import { createLog } from '../lib/log.js'
import { createMemoryStore } from '../lib/memory/store.js'
import { resolveMemoryPolicy } from '../lib/memory/policy.js'
import { PersonaWriteRejected } from '../lib/persona/document.js'
import { STANDARD_SECTION_TITLES, CORE_IDENTITY_KEYS } from '../lib/persona/constants.js'
import { createFakeTable } from './helpers/evolution-fake.mjs'
import { fakeEvolutionState } from './helpers/evolution-fake.mjs'

const log = createLog(new Context(), 'test')
const CONTEXT = { runId: 'run-1', sessionId: 'session-1', cwd: '/ws', mode: 'incremental' }

/** 造一份解析输出（只填被测字段，其余走合同默认值）。 */
function output(overrides = {}) {
  return {
    memories: [],
    personaSections: [],
    personaFixed: [],
    skills: [],
    insights: [],
    narrative: '',
    ...overrides,
  }
}

/** 造一套默认依赖（记忆开、人格未初始化、无技能服务）。 */
function deps(overrides = {}) {
  const { state } = fakeEvolutionState()
  const memoryTable = createFakeTable()
  return {
    state,
    memoryTable,
    deps: {
      memoryStore: () => createMemoryStore(memoryTable),
      memoryPolicy: () => resolveMemoryPolicy('balanced'),
      persona: () => undefined,
      skills: () => undefined,
      state,
      log,
      ...overrides,
    },
  }
}

/** 造一份"已初始化"的人格文档（固定层写过并封存）。 */
function initializedPersona() {
  return {
    schemaVersion: 1,
    identityCard: {
      fields: CORE_IDENTITY_KEYS.map((key, index) => ({ key, value: index === 0 ? '测试名' : '值', custom: false })),
      initializedAt: '2026-09-01T00:00:00.000Z',
      sealedAt: '2026-09-01T00:00:00.000Z',
    },
    mutableLayer: {
      sections: STANDARD_SECTION_TITLES.map((title) => ({ title, items: [] })),
      userDefined: [],
    },
  }
}

/** 造假人格段（可设定拒绝行为；记录每次写入的完整快照）。 */
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

test('记忆：普通候选自动生效，敏感候选进待确认（P-033/P-038 由记忆管线把关）', async () => {
  const { deps: dependencies, memoryTable } = deps()
  const result = await applyAnalysis(dependencies, CONTEXT, output({
    memories: [
      { content: '用户偏好先给结论', scope: 'long-term', tags: ['交付'], sensitive: false },
      { content: '本项目的部署窗口是凌晨', scope: 'workspace', tags: [], sensitive: false },
      { content: '用户的银行卡尾号是敏感内容', scope: 'long-term', tags: [], sensitive: true },
    ],
  }))

  assert.equal(result.memoriesWritten, 3)
  const entries = [...memoryTable.records.values()]
  assert.equal(entries.length, 3)
  const normal = entries.find((entry) => entry.content.includes('先给结论'))
  const workspace = entries.find((entry) => entry.scope === 'workspace')
  const sensitive = entries.find((entry) => entry.sensitive)
  assert.equal(normal.status, 'active')
  assert.equal(normal.origin, 'agent-derived', '来源必须是 agent 推断，不能冒充用户说的')
  assert.equal(normal.ownerId, '', '长期记忆不归任何工作区')
  assert.equal(workspace.ownerId, '/ws', '工作记忆的归属来自会话 cwd')
  assert.equal(sensitive.status, 'pending')
})

test('记忆模块关闭：一条都不写，也不抛（P-048 模块独立）', async () => {
  const { deps: dependencies } = deps({ memoryStore: () => undefined, memoryPolicy: () => undefined })
  const result = await applyAnalysis(dependencies, CONTEXT, output({
    memories: [{ content: '不该被写入', scope: 'long-term', tags: [], sensitive: false }],
  }))
  assert.equal(result.memoriesWritten, 0)
})

test('策略关闭自动写入（off 模式）：管线拒绝，计数为 0', async () => {
  // 注意：manual 模式的语义是"不自动注入、只允许显式 recall"（P-030），**写入仍然允许**；
  // 真正关掉自动写入的只有 off（autoWrite=false）。
  const { deps: dependencies } = deps({ memoryPolicy: () => resolveMemoryPolicy('off') })
  const result = await applyAnalysis(dependencies, CONTEXT, output({
    memories: [{ content: 'off 模式不写', scope: 'long-term', tags: [], sensitive: false }],
  }))
  assert.equal(result.memoriesWritten, 0)
})

test('可变层：合并进完整快照、以 agent 身份写入；重复条目不再追加', async () => {
  const document = initializedPersona()
  document.mutableLayer.sections[1].items.push('简短直接') // 说话风格已有一条
  const persona = fakePersona(document)
  const { deps: dependencies } = deps({ persona: () => persona })

  const result = await applyAnalysis(dependencies, CONTEXT, output({
    personaSections: [
      { section: '说话风格', items: ['简短直接', '先结论后依据'] },
      { section: '经验教训', items: ['部署前必验 boot 清单'] },
    ],
  }))

  assert.equal(result.personaUpdated, true)
  assert.equal(persona.writes.length, 1)
  assert.equal(persona.writes[0].source, 'agent')
  const style = persona.writes[0].next.mutableLayer.sections.find((section) => section.title === '说话风格')
  assert.deepEqual(style.items, ['简短直接', '先结论后依据'], '已有条目不重复追加')
})

test('可变层：人格未初始化时跳过（人格还不存在，不谈整理）', async () => {
  const untouched = fakePersona({
    schemaVersion: 1,
    identityCard: { fields: CORE_IDENTITY_KEYS.map((key) => ({ key, value: '', custom: false })), initializedAt: '', sealedAt: '' },
    mutableLayer: { sections: [], userDefined: [] },
  })
  const { deps: dependencies } = deps({ persona: () => untouched })
  const result = await applyAnalysis(dependencies, CONTEXT, output({
    personaSections: [{ section: '说话风格', items: ['温柔'] }],
  }))
  assert.equal(result.personaUpdated, false)
  assert.equal(untouched.writes.length, 0)
})

test('可变层写入被校验拒绝：转成 persona 提案（P-010 高风险不静默）', async () => {
  const persona = fakePersona(initializedPersona(), {
    reject: [{ code: 'mutable.conflict', path: '说话风格', severity: 'rejected', message: '与固定层冲突' }],
  })
  const { deps: dependencies, state } = deps({ persona: () => persona })
  const result = await applyAnalysis(dependencies, CONTEXT, output({
    personaSections: [{ section: '说话风格', items: ['像小孩子一样天真烂漫'] }],
  }))

  assert.equal(result.personaUpdated, false)
  assert.equal(result.proposalsCreated, 1)
  const proposals = state.listProposals('pending')
  assert.equal(proposals[0].kind, 'persona')
  assert.equal(JSON.parse(proposals[0].payload).type, 'mutable')
  assert.ok(proposals[0].reason.includes('mutable.conflict'))
})

test('固定层字段：只生成提案，绝不直接写（P-023/P-038）', async () => {
  const persona = fakePersona(initializedPersona())
  const { deps: dependencies, state } = deps({ persona: () => persona })
  const result = await applyAnalysis(dependencies, CONTEXT, output({
    personaFixed: [{ fieldKey: '归属地', fieldValue: '示例城市', reason: '用户明确说过' }],
  }))

  assert.equal(result.proposalsCreated, 1)
  assert.equal(persona.writes.length, 0, '固定层提案不许触碰写入路径')
  const proposal = state.listProposals('pending')[0]
  assert.equal(proposal.kind, 'persona')
  assert.deepEqual(JSON.parse(proposal.payload), { type: 'identity', fieldKey: '归属地', fieldValue: '示例城市' })
})

test('技能查重四分类（P-041）：重复不生成、同名异内容=更新、新名字=全新', async () => {
  const catalog = [
    { name: 'weekly-report', description: '生成周报' },
    { name: 'deploy-check', description: '部署检查' },
  ]
  const skills = {
    list: async () => catalog,
    get: async (name) => (name === 'weekly-report' ? { content: '旧内容' } : undefined),
    register: () => () => {},
  }
  const { deps: dependencies, state } = deps({ skills: () => skills })

  const result = await applyAnalysis(dependencies, CONTEXT, output({
    skills: [
      { name: 'weekly-report', description: '生成周报', content: '旧内容', reason: '重复出现' },
      { name: 'weekly-report', description: '生成周报', content: '新内容更完整', reason: '流程升级' },
      { name: 'meeting-notes', description: '整理会议纪要', content: '# 技能', reason: '重复出现' },
    ],
  }))

  assert.equal(result.proposalsCreated, 2, '完全重复的那条不生成')
  assert.equal(result.proposalsSkipped, 1)
  const titles = state.listProposals('pending').map((record) => record.title)
  assert.ok(titles.some((title) => title.startsWith('更新技能：weekly-report')))
  assert.ok(titles.some((title) => title.startsWith('新技能：meeting-notes')))
})

test('路由建议已裁撤：解析结果里即便带着 routes 也一律不产提案（用户 2026-09-26 裁撤 M4）', async () => {
  const { deps: dependencies, state } = deps()
  const result = await applyAnalysis(dependencies, CONTEXT, output({
    routes: [{ title: '夜间批处理用便宜模型', reason: '对话里反复出现成本抱怨', scenario: '后台任务', provider: '', model: '' }],
  }))

  assert.equal(result.proposalsCreated, 0)
  assert.deepEqual(state.listProposals('pending'), [], '不再产出永不生效的路由提案')
})

test('跨轮去重：同类同名提案仍 pending 时不再生成（防刷屏）', async () => {
  const { deps: dependencies, state } = deps()
  const fixed = [{ fieldKey: '归属地', fieldValue: '示例城市', reason: '用户明确说过' }]
  const first = await applyAnalysis(dependencies, CONTEXT, output({ personaFixed: fixed }))
  const second = await applyAnalysis(dependencies, { ...CONTEXT, runId: 'run-2' }, output({ personaFixed: fixed }))

  assert.equal(first.proposalsCreated, 1)
  assert.equal(second.proposalsCreated, 0)
  assert.equal(second.proposalsSkipped, 1)
  assert.equal(state.listProposals('pending').length, 1)
})

test('梦境洞察不进记忆库：只计数不落条目（联想产物证据强度低，留给用户在时间线决定）', async () => {
  const { deps: dependencies, memoryTable } = deps()
  const result = await applyAnalysis(dependencies, { ...CONTEXT, mode: 'dream' }, output({
    insights: ['用户最近在赶工', '部署焦虑反复出现'],
    narrative: '今晚梦见 boot 清单一直在闪烁。',
  }))

  assert.equal(result.memoriesWritten, 0)
  assert.equal(memoryTable.records.size, 0)
})
