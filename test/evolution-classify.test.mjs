/**
 * 分类写回测试：P-038 权限分层（记忆自动/敏感待确认、信息自动、底色只提案）、
 * 跨轮提案去重、模块关闭时不越权写数据。
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
    insights: [],
    narrative: '',
    ...overrides,
  }
}

/** 造一套默认依赖（记忆开、人格未初始化）。 */
function deps(overrides = {}) {
  const { state } = fakeEvolutionState()
  const memoryTable = createFakeTable()
  return {
    state,
    memoryTable,
    deps: {
      memoryStore: () => createMemoryStore(memoryTable),
      persona: () => undefined,
      state,
      log,
      ...overrides,
    },
  }
}

/** 造一份"已初始化"的人格文档（底色写过并封存）。 */
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

test('记忆：候选直接落库，不再有"待确认"这道闸（2026-11-20 重构）', async () => {
  const { deps: dependencies, memoryTable } = deps()
  const result = await applyAnalysis(dependencies, CONTEXT, output({
    memories: [
      { content: '对方偏好先给结论', scope: 'long-term', tags: ['交付'], sensitive: false },
      { content: '本项目的部署窗口是凌晨', scope: 'workspace', tags: [], sensitive: false },
      { content: '对方的银行卡尾号是敏感内容', scope: 'long-term', tags: [], sensitive: true },
    ],
  }))

  assert.equal(result.memoriesWritten, 3)
  const entries = [...memoryTable.records.values()]
  assert.equal(entries.length, 3)
  const normal = entries.find((entry) => entry.what.includes('先给结论'))
  const workspace = entries.find((entry) => entry.what.includes('部署窗口'))
  const sensitive = entries.find((entry) => entry.what.includes('银行卡'))
  // 自进化抽出来的是**模型推的**，不是她亲眼所见 —— 这一维要留着，以后引用时才不会把推断当事实。
  assert.equal(normal.certain, 'inferred')
  // 长期级候选按"关于对方"处理；工作区级候选按"关于你们之间"处理。
  assert.equal(normal.about, 'user')
  assert.equal(workspace.about, 'us')
  // 敏感性不再是"进待确认"，它只影响写入时的披露代价（说完就生效）。
  assert.equal(sensitive.cost <= 1, true)
  // 强度按"当时情绪 + 这事跟我多大关系"算出来，不是拍一个固定值。
  assert.equal(normal.strength > 0 && normal.strength <= 1, true)
})

test('记忆模块关闭：一条都不写，也不抛（P-048 模块独立）', async () => {
  const { deps: dependencies } = deps({ memoryStore: () => undefined })
  const result = await applyAnalysis(dependencies, CONTEXT, output({
    memories: [{ content: '不该被写入', scope: 'long-term', tags: [], sensitive: false }],
  }))
  assert.equal(result.memoriesWritten, 0)
})

test('写入不再有第二条闸：模块在就写，「策略关掉」这个概念已随模式一起删除', async () => {
  // 2026-11-20：旧的 `mode`（off/session/balanced/manual）与 `policy.autoWrite` 整组删除。
  // 现在只有一个开关（`modules.memory.enabled`），关掉时 `memoryStore()` 返回 undefined，
  // 与上面那条测试走的是同一条路 —— 没有"模块开着但策略说别写"的中间态。
  const { deps: dependencies } = deps({})
  const result = await applyAnalysis(dependencies, CONTEXT, output({
    memories: [{ content: '记忆模块开着就该写进去', scope: 'long-term', tags: [], sensitive: false }],
  }))
  assert.equal(result.memoriesWritten, 1)
})

test('信息：合并进完整快照、以 agent 身份写入；重复条目不再追加', async () => {
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

test('信息：人格未初始化时跳过（人格还不存在，不谈整理）', async () => {
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

test('信息写入被校验拒绝：转成 persona 提案（P-010 高风险不静默）', async () => {
  const persona = fakePersona(initializedPersona(), {
    reject: [{ code: 'mutable.conflict', path: '说话风格', severity: 'rejected', message: '与底色冲突' }],
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

test('底色字段：只生成提案，绝不直接写（P-023/P-038）', async () => {
  const persona = fakePersona(initializedPersona())
  const { deps: dependencies, state } = deps({ persona: () => persona })
  const result = await applyAnalysis(dependencies, CONTEXT, output({
    personaFixed: [{ fieldKey: '归属地', fieldValue: '示例城市', reason: '用户明确说过' }],
  }))

  assert.equal(result.proposalsCreated, 1)
  assert.equal(persona.writes.length, 0, '底色提案不许触碰写入路径')
  const proposal = state.listProposals('pending')[0]
  assert.equal(proposal.kind, 'persona')
  assert.deepEqual(JSON.parse(proposal.payload), { type: 'identity', fieldKey: '归属地', fieldValue: '示例城市' })
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
