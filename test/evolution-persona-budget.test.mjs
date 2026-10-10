/**
 * 0.1.10 · A：自进化接管「人格注入预算」的整理（V3/V4/V5）。
 *
 * 病根（P-056 的另一半）：注入预算是**写死**的 2400 字符，装不下就截断并标注，而自进化
 * 只会"并同义条目 + 追加新条目"—— 卡越满，能进提示词的内容越少，谁也不提"按预算取舍"。
 *
 * 本文件钉三条性质：
 * 1. **超预算时**：分析提示词必须出现预算读数与"只做整合、禁止追加新条目"的硬约束（V3）；
 * 2. **预算充足时**：那段约束**一个字都不许出现**（V4，防恒真）——而且此时新增条目照常写入
 *    （证明"不追加"是条件行为，不是把追加路径整个关掉）；
 * 3. **超预算时的行为**：同一轮里既有整合建议又有新条目 ⇒ 只并、不追加；并完之后
 *    "没进提示词的条数"必须**下降**（V5：整理真的让卡更装得下了，而不是只写了一句注记）。
 *
 * LLM 是假的（按次回放输出），人格写回是真的（`mergePersonaSections` + 真拟合账目）——
 * 这里要证的正是"提示词说了什么"与"写回真的做了什么"这两件事对得上。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { PERSONA_OVER_BUDGET_NOTICE } from '../lib/evolution/prompt.js'
import { createRunner } from '../lib/evolution/run.js'
import { createLog } from '../lib/log.js'
import { createMemoryStore } from '../lib/memory/store.js'
import { resolveMemoryPolicy } from '../lib/memory/policy.js'
import { createDefaultPersona } from '../lib/persona/model.js'
import { personaPromptReport } from '../lib/persona/render.js'
import { createFakeTable, fakeEvent, fakeEvolutionState, fakeSession, fakeSessionQuery } from './helpers/evolution-fake.mjs'

const log = createLog(new Context(), 'test')
const NOW = '2026-09-25T12:00:00.000Z'
const BASELINE = '2026-09-20T00:00:00.000Z'
const CREATED = Date.parse(BASELINE) + 60000
const INDEPENDENT_JUDGMENT = true

/** 最小合法解析输出。 */
const EMPTY_OUTPUT = { memories: [], personaSections: [], personaFixed: [], skills: [], insights: [], narrative: '' }

/**
 * 造一份人格文档。
 * @param options.perSection - 每节几条（配 `itemLength` 用来把卡顶过预算）。
 * @param options.itemLength - 每条内容的填充长度。
 * @param options.sections - 覆盖某几个小节的条目（用来放"同义重复"）。
 */
function personaDoc(options = {}) {
  const persona = createDefaultPersona()
  persona.identityCard.initializedAt = '2026-09-01T00:00:00.000Z'
  persona.identityCard.sealedAt = '2026-09-01T00:00:00.000Z'
  persona.identityCard.fields.forEach((field, index) => {
    field.value = `值${index + 1}`
  })
  const perSection = options.perSection ?? 8
  const itemLength = options.itemLength ?? 20
  persona.mutableLayer.sections.forEach((section, sectionIndex) => {
    section.items = Array.from(
      { length: perSection },
      (_, index) => `第${sectionIndex + 1}节第${index + 1}条：${'填'.repeat(itemLength)}`,
    )
  })
  for (const [title, items] of Object.entries(options.sections ?? {})) {
    const section = persona.mutableLayer.sections.find((entry) => entry.title === title)
    assert.ok(section !== undefined, `夹具里的「${title}」必须是标准小节`)
    section.items = [...items]
  }
  return persona
}

/** 某个小节的条目（副本）。 */
function itemsOf(persona, title) {
  return [...(persona.mutableLayer.sections.find((section) => section.title === title)?.items ?? [])]
}

/**
 * 造运行环境：假 LLM、真人格写回、真预算读数。
 * @param options.persona - 初始人格文档。
 * @param options.output - 模型这一轮回放的解析输出。
 */
function harness(options = {}) {
  const { state } = fakeEvolutionState()
  const memoryTable = createFakeTable()
  const persona = options.persona ?? personaDoc()
  let current = persona
  const writes = []
  const llmCalls = []
  const personaSection = {
    read: () => current,
    write: async (next) => {
      writes.push(next)
      current = next
    },
    attached: true,
    onDocumentChanged: () => () => {},
  }
  const sessions = [fakeSession('s1', CREATED, { cwd: '/ws' })]
  const events = { s1: [fakeEvent('s1', 1, 'user/message', '我喜欢简短回复')] }
  const config = {
    evolution: {
      enabled: true,
      schedule: { mode: 'idle', idleMinutes: 30, timeOfDay: '03:00', weekday: 1, monthDay: 1, timezone: '' },
      scan: { includeSubSessions: false },
      budget: {
        maxSessionsPerRun: 5,
        maxEventsPerSession: 200,
        maxInputBytesPerCall: 32768,
        maxOutputTokensPerCall: 2000,
        dailyCallCap: 20,
      },
    },
    dream: { enabled: true },
  }
  const output = options.output ?? EMPTY_OUTPUT
  const deps = {
    state,
    config: () => config,
    enabled: () => true,
    sessionQuery: () => fakeSessionQuery(sessions, events),
    llm: {
      route: () => ({ provider: 'deepseek', model: 'test' }),
      streamText: async (input) => {
        llmCalls.push(input)
        return { text: JSON.stringify(output), inputTokens: 100, outputTokens: 40, finishReason: 'stop' }
      },
    },
    classify: () => ({
      memoryStore: () => createMemoryStore(memoryTable),
      memoryPolicy: () => resolveMemoryPolicy('balanced'),
      persona: () => personaSection,
      skills: () => undefined,
      state,
      log,
    }),
    personaCard: () => personaSection.read().mutableLayer.sections.map((section) => ({ title: section.title, items: section.items })),
    // 与宿主接线同一处口径：预算读数只从 `personaPromptReport` 来。
    personaFit: () => personaPromptReport(personaSection.read(), { independentJudgment: INDEPENDENT_JUDGMENT }),
    log,
    now: () => NOW,
  }
  return {
    runner: createRunner(deps),
    state,
    llmCalls,
    writes,
    view: () => current,
    /** 初始文档（写回会整体替换，所以原对象保持为"改动前"）。 */
    initial: persona,
  }
}

/** 预置扫描基线，避免"首轮建基线不扫"的语义干扰。 */
async function seedBaseline(state) {
  await state.mutateState({ baselineAt: BASELINE })
}

/** 正常跑一轮并返回运行记录。 */
async function runOnce(harnessed) {
  await seedBaseline(harnessed.state)
  return harnessed.runner.start({ mode: 'incremental', trigger: 'manual' })
}

test('V3 超预算：提示词出现预算读数 + 「只做整合、禁止追加新条目」的硬约束', async () => {
  const persona = personaDoc({ perSection: 20, itemLength: 60 })
  const before = personaPromptReport(persona, { independentJudgment: INDEPENDENT_JUDGMENT })
  assert.ok(before !== undefined && before.truncated, '夹具必须真的超预算（否则这条用例什么都没测到）')

  const harnessed = harness({
    persona,
    output: { ...EMPTY_OUTPUT, sectionConsolidations: [{ section: '说话风格', keep: itemsOf(persona, '说话风格')[0], drop: [itemsOf(persona, '说话风格')[1]], reason: '同义' }] },
  })
  const record = await runOnce(harnessed)

  assert.equal(harnessed.llmCalls.length, 1, '这一轮该有一次模型调用')
  const system = harnessed.llmCalls[0].system
  assert.ok(system.includes(PERSONA_OVER_BUDGET_NOTICE), '超预算必须有那段读数的开头')
  assert.match(system, /只做整合/, '必须写明"只做整合"')
  assert.match(system, /禁止追加新条目/, '必须写明"禁止追加新条目"')
  assert.ok(system.includes(String(before.budget)), '读数里要给出可用字符数（预算）')
  assert.ok(system.includes(String(before.dropped)), '读数里要给出"多少条没进提示词"')
  assert.match(record.error, /人格注入预算/, 'A4：预算账目要进运行记录（用户能在时间线上看见）')
})

test('V4 阴性对照：预算充足时那段约束一个字都不许出现，且新条目照常写入（防恒真）', async () => {
  const persona = personaDoc({ perSection: 3, itemLength: 8 })
  const before = personaPromptReport(persona, { independentJudgment: INDEPENDENT_JUDGMENT })
  assert.ok(before !== undefined && before.truncated === false, '夹具必须在预算内（这是本用例的前提）')

  const harnessed = harness({
    persona,
    output: { ...EMPTY_OUTPUT, personaSections: [{ section: '说话风格', items: ['回复先给结论，再给理由'] }] },
  })
  await runOnce(harnessed)

  const system = harnessed.llmCalls[0].system
  assert.ok(!system.includes(PERSONA_OVER_BUDGET_NOTICE), '预算充足时不许出现超预算段')
  assert.doesNotMatch(system, /禁止追加新条目/, '预算充足时不许出现"禁止追加"约束')
  assert.doesNotMatch(system, /只做整合/, '预算充足时不许出现"只做整合"约束')
  // 关键的反恒真断言：预算够的时候，追加路径必须**仍然可用**。
  assert.equal(harnessed.writes.length, 1, '预算内该写入这次补充')
  assert.ok(itemsOf(harnessed.view(), '说话风格').includes('回复先给结论，再给理由'), '预算内新增条目必须真的写进去')
})

test('V5 超预算行为：只并、不追加；并完「没进提示词的条数」下降', async () => {
  const keep = '台词不加括号，直接写'
  const drop = '台词不加括号、直接写'
  // ⚠️ 夹具把"被并掉的那条"放在该节**末尾**（注入窗口之外）：账目上它是"没进提示词的条数"的一部分，
  // 并掉它 ⇒ 未注入数**严格下降 1**。若把它放在窗口内，删掉一条短句反而会让更长的条目滑进窗口，
  // 总账可能不动甚至变差 —— 那是拟合算法的正常行为，不该被这条用例误判成"整理没用"。
  const persona = personaDoc({
    perSection: 20,
    itemLength: 60,
    sections: {
      说话风格: [
        keep,
        ...Array.from({ length: 20 }, (_, index) => `说话风格第${index + 2}条：${'填'.repeat(60)}`),
        drop,
      ],
    },
  })
  const before = personaPromptReport(persona, { independentJudgment: INDEPENDENT_JUDGMENT })
  assert.ok(before !== undefined && before.truncated, '夹具必须真的超预算')
  const beforeSection = before.sections.find((section) => section.title === '说话风格')
  assert.ok(beforeSection !== undefined && beforeSection.dropped > 0, '被并的那条必须真的在"未注入"里')

  const harnessed = harness({
    persona,
    output: {
      ...EMPTY_OUTPUT,
      // 同一轮里既有"合并"又有"新条目"：新条目必须被拦下（否则就是"越整理越长"）。
      personaSections: [{ section: '说话风格', items: ['不要替用户做决定'] }],
      sectionConsolidations: [{ section: '说话风格', keep, drop: [drop], reason: '同一件事的两种说法' }],
    },
  })
  const record = await runOnce(harnessed)

  assert.equal(harnessed.writes.length, 1, '整合生效 ⇒ 必须写回一次')
  const after = itemsOf(harnessed.view(), '说话风格')
  assert.ok(!after.includes(drop), '同义条目必须被并掉')
  assert.ok(after.includes(keep), '保留项必须在场')
  assert.ok(!after.includes('不要替用户做决定'), '超预算时**禁止追加新条目**（哪怕模型提了）')

  const stats = personaPromptReport(harnessed.view(), { independentJudgment: INDEPENDENT_JUDGMENT })
  assert.ok(stats !== undefined)
  assert.equal(stats.dropped, before.dropped - 1, `并掉一条未注入的同义条目 ⇒ 未注入数严格降 1（${before.dropped} → ${stats.dropped}）`)
  assert.ok(stats.injected >= before.injected, '并完之后能进提示词的条数不许变少')
  assert.match(record.error, /本轮合并同义条目 1 条/, 'A4：并了几条要进运行记录（可核对）')
})
