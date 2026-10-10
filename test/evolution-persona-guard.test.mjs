/**
 * 0.1.11 · A：人格卡护栏改「接近预算就刹 + 写入前预演」（V3/V4/V5/V6）。
 *
 * 病根（0.1.10 的洞，真机实测 2026-10-09T03:20:47Z）：那轮台账逐字写着
 * `人格注入预算：已用 1880/2065 字符，预算内（注入 33 条）` —— 0.1.10 只在 `truncated`
 * （**已经**装不下）时才拦，读到"预算内"就放行，**追加 3 条之后就超了**。
 * 只看"此刻超没超"永远晚一步：必须在跨线**之前**刹，并且写入**之前**先预演一次。
 *
 * 本文件钉四条性质：
 * 1. **接近上限也拦**（V3）：`used/budget ≥ 0.85` 且尚未截断 ⇒ 提示词出现"只做整合"，
 *    写回层也真的不写新条目（但**合并照常**——护栏只停追加，不停腾地方）；
 * 2. **预算充足放行**（V4，阴性对照）：该约束一个字都不出现，新条目**照常写入**（防恒真）；
 * 3. **边界按拦处理**（V5）：`used/budget` **恰好等于**阈值时算"拦"（测试名里写明是边界用例）；
 * 4. **写入前预演**（V6，本项目核心新判据）：当前未超、护栏未触发（比例 < 0.85），
 *    但这次追加会让注入被截断 ⇒ **整批不写**；而"预演能过"的追加必须照常写进去（防"一刀切全拦"）。
 *
 * LLM 是假的，人格写回与预算拟合是真的（`mergePersonaSections` + `personaPromptReport`）——
 * 这里要证的正是"提示词说了什么""写回真的做了什么""预演算出的会不会超"三件事对得上。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { mergePersonaSections } from '../lib/evolution/classify-persona.js'
import { PERSONA_BUDGET_GUARD_RATIO } from '../lib/evolution/constants.js'
import {
  isPersonaBudgetGuarded,
  PERSONA_NEAR_BUDGET_NOTICE,
  PERSONA_OVER_BUDGET_NOTICE,
  percentOfBudget,
} from '../lib/evolution/prompt.js'
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
const JUDGMENT = true

/** 最小合法解析输出。 */
const EMPTY_OUTPUT = { memories: [], personaSections: [], personaFixed: [], skills: [], insights: [], narrative: '' }

/** 4 个**原生**小节（0.1.14 起人格卡的默认集合）。 */
/** 夹具里最后一节（空的，用来接新条目）。 */
const LAST_SECTION = '未结修正'
const SECTION_TITLES = createDefaultPersona().mutableLayer.sections.map((section) => section.title)
/** 夹具里用来凑满一张"写满的卡"的**自定义**小节（原生项之外一律自定义、待遇相同）。 */
const CUSTOM_SECTIONS = ['习惯与偏好', '经验教训', '情绪', '未结修正']

/**
 * 造一份人格文档：4 个原生小节 + 4 个自定义小节（凑到与真机那张卡同形的规模）。
 *
 * ⚠️ 0.1.14：原生项从 8 个减到 4 个，所以"写满的卡"必须显式加上自定义小节 ——
 * 夹具要与真机同形（真机上那 4 个节并没有消失，只是降级成自定义项了）。
 * @param options.perSection - 每节几条。
 * @param options.itemLength - 每条的填充长度（默认 60）。
 * @param options.lengths - 按**全部小节**（原生 4 + 自定义 4）的索引指定条长。
 * @param options.emptyLast - 把最后一节留空（新条目落进去就是该节第一条，必被注入 ⇒ 预演必然算到它）。
 */
function personaDoc(options = {}) {
  const persona = createDefaultPersona()
  persona.identityCard.initializedAt = '2026-09-01T00:00:00.000Z'
  persona.identityCard.sealedAt = '2026-09-01T00:00:00.000Z'
  persona.identityCard.fields.forEach((field, index) => {
    field.value = `值${index + 1}`
  })
  for (const title of CUSTOM_SECTIONS) {
    persona.mutableLayer.sections.push({ title, items: [] })
  }
  const perSection = options.perSection ?? 3
  const sections = persona.mutableLayer.sections
  sections.forEach((section, index) => {
    if (options.emptyLast === true && index === sections.length - 1) {
      section.items = []
      return
    }
    const length = options.lengths?.[index] ?? options.itemLength ?? 60
    section.items = Array.from({ length: perSection }, (_, itemIndex) => `S${index + 1}I${itemIndex}:${'x'.repeat(length)}`)
  })
  return persona
}

/** 某个小节的条目（副本）。 */
function itemsOf(persona, title) {
  return [...(persona.mutableLayer.sections.find((section) => section.title === title)?.items ?? [])]
}

/** 预算读数（与宿主接线同一口径：`personaPromptReport` + independentJudgment）。 */
function fitOf(persona) {
  return personaPromptReport(persona, { independentJudgment: JUDGMENT })
}

/** 断言夹具真的落在预期区间（夹具失真时立刻红，而不是让用例变成"什么都测不到"）。 */
function assertRatio(persona, predicate, message) {
  const fit = fitOf(persona)
  assert.ok(fit !== undefined, '夹具必须算得出预算读数')
  assert.ok(predicate(fit), `${message}（实际 used=${fit.used} budget=${fit.budget} ratio=${(fit.used / fit.budget).toFixed(4)} truncated=${fit.truncated}）`)
  return fit
}

/**
 * 造运行环境：假 LLM、真人格写回、真预算拟合。
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
      // 与宿主接线同一处口径：预演用的拟合器就是提示词注入用的那一个。
      personaFit: (doc) => personaPromptReport(doc, { independentJudgment: JUDGMENT }),
    }),
    personaCard: () => personaSection.read().mutableLayer.sections.map((section) => ({ title: section.title, items: section.items })),
    personaFit: () => personaPromptReport(personaSection.read(), { independentJudgment: JUDGMENT }),
    log,
    now: () => NOW,
  }
  return { runner: createRunner(deps), state, llmCalls, writes, view: () => current, initial: persona }
}

/** 预置扫描基线并跑一轮。 */
async function runOnce(harnessed) {
  await harnessed.state.mutateState({ baselineAt: BASELINE })
  return harnessed.runner.start({ mode: 'incremental', trigger: 'manual' })
}

/** 预演假设：把 `items` 追加进 document 后，注入会不会被截断（用例自证"这一批真的会超"）。 */
function wouldTruncate(document, title, items) {
  const candidate = mergePersonaSections(document, [{ section: title, items }], [])
  return fitOf(candidate.next)?.truncated === true
}

test('V3 接近上限（未截断）：提示词要求只做整合、写回层不写新条目，但**合并照常**', async () => {
  // 夹具 = 真机那轮的形状：全部条目都进得去（truncated=false），但已用到 93%。
  const persona = personaDoc({ perSection: 3, itemLength: 60 })
  const before = assertRatio(
    persona,
    (fit) => fit.truncated === false && fit.used / fit.budget >= PERSONA_BUDGET_GUARD_RATIO,
    '夹具必须是"装得下但已接近上限"',
  )
  const style = itemsOf(persona, '说话风格')
  const harnessed = harness({
    persona,
    output: {
      ...EMPTY_OUTPUT,
      // 同一轮里既有"合并"又有"新条目"：合并必须写进去，新条目必须被拦下。
      personaSections: [{ section: '说话风格', items: ['回复一律先给结论再给理由'] }],
      sectionConsolidations: [{ section: '说话风格', keep: style[0], drop: [style[1]], reason: '同一件事的两种说法' }],
    },
  })
  const record = await runOnce(harnessed)

  const system = harnessed.llmCalls[0].system
  assert.ok(system.includes(PERSONA_NEAR_BUDGET_NOTICE), '接近上限必须出现"接近上限"那段读数')
  assert.ok(!system.includes(PERSONA_OVER_BUDGET_NOTICE), '还没截断，就不该说"已超"')
  assert.match(system, /只做整合/, '必须写明只做整合')
  assert.match(system, /禁止追加新条目/, '必须写明禁止追加新条目')
  assert.ok(system.includes(String(before.budget)) && system.includes(String(before.used)), '读数里要给出可用/已用字符数')

  assert.equal(harnessed.writes.length, 1, '合并生效 ⇒ 必须写回一次')
  const after = itemsOf(harnessed.view(), '说话风格')
  assert.ok(!after.includes(style[1]), '合并必须照常生效（护栏只停追加，不停合并）')
  assert.ok(!after.includes('回复一律先给结论再给理由'), '护栏触发时**新条目一条都不许写**')
  assert.match(record.error, /接近上限/, '运行记录要说明这轮为什么只做整合')
  assert.match(record.error, /本轮合并同义条目 1 条/, '合并数照旧记账')
  assert.match(record.error, /拦下拟新增 1 条/, '被拦下的新增要记账（免得看起来像"什么都没干"）')
})

test('V4 阴性对照：预算充足时装不下才拦的那套约束一个字都不出现，新条目照常写入', async () => {
  const persona = personaDoc({ perSection: 1, itemLength: 40 })
  assertRatio(persona, (fit) => fit.truncated === false && fit.used / fit.budget < PERSONA_BUDGET_GUARD_RATIO, '夹具必须明显宽裕')

  const harnessed = harness({
    persona,
    output: { ...EMPTY_OUTPUT, personaSections: [{ section: '说话风格', items: ['回复先给结论，再给理由'] }] },
  })
  const record = await runOnce(harnessed)

  const system = harnessed.llmCalls[0].system
  assert.ok(!system.includes(PERSONA_NEAR_BUDGET_NOTICE), '预算充足时不许出现"接近上限"')
  assert.ok(!system.includes(PERSONA_OVER_BUDGET_NOTICE), '预算充足时不许出现"已超"')
  assert.doesNotMatch(system, /禁止追加新条目/, '预算充足时不许出现"禁止追加"')
  assert.doesNotMatch(system, /只做整合/, '预算充足时不许出现"只做整合"')
  // 反恒真：预算够的时候追加路径必须仍然可用。
  assert.equal(harnessed.writes.length, 1, '预算充足 ⇒ 这次补充该被写入')
  assert.ok(itemsOf(harnessed.view(), '说话风格').includes('回复先给结论，再给理由'), '新条目必须真的写进去')
  assert.match(record.error, /预算充足/, '运行记录要如实说"预算充足"')
  assert.doesNotMatch(record.error, /拦下拟新增/, '没拦下任何东西就不该记这一笔')
})

test('V5 边界用例：used/budget **恰好等于**阈值 ⇒ 按"拦"处理；低一点点则不拦', () => {
  const ratio = PERSONA_BUDGET_GUARD_RATIO
  const budget = 2000
  const atThreshold = { budget, used: budget * ratio, injected: 0, dropped: 0, truncated: false }
  assert.equal(atThreshold.used, 1700, '前置：1700/2000 正是 0.85')

  assert.equal(isPersonaBudgetGuarded(atThreshold), true, '恰好等于阈值 ⇒ 拦（边界按"拦"处理）')
  assert.equal(isPersonaBudgetGuarded({ ...atThreshold, used: 1699 }), false, '差一个字符没到阈值 ⇒ 不拦')
  assert.equal(isPersonaBudgetGuarded({ ...atThreshold, used: 2000 }), true, '用满同样是拦')
  assert.equal(isPersonaBudgetGuarded({ ...atThreshold, used: 10, truncated: true }), true, '已截断一律拦（与 0.1.10 一致）')
  assert.equal(isPersonaBudgetGuarded(undefined), false, '没有读数（人格未接上）不拦')
  assert.equal(isPersonaBudgetGuarded({ ...atThreshold, budget: 0, used: 0 }), false, '预算算不出来时不拦（不锁死追加）')
  assert.equal(percentOfBudget(atThreshold), 85, '百分比口径与阈值同源')
})

test('V6 预演（单条超长）：当前未超、护栏未触发，但这一条会被截断 ⇒ 不写入', async () => {
  // 2 条/节、每节留白充足，最后一节空着：比例 0.74（< 0.85 ⇒ 护栏不触发），且未截断。
  const persona = personaDoc({ perSection: 2, itemLength: 80, emptyLast: true })
  assertRatio(
    persona,
    (fit) => fit.truncated === false && fit.used / fit.budget < PERSONA_BUDGET_GUARD_RATIO,
    '夹具必须是"未超且护栏未触发"——否则这条用例测的就不是预演',
  )
  const longItem = `L${'y'.repeat(199)}` // > VALUE_SOFT_LIMIT(120) ⇒ 进提示词会被裁
  assert.equal(wouldTruncate(persona, LAST_SECTION, [longItem]), true, '前提：这一条真的会让注入被截断')

  const harnessed = harness({ persona, output: { ...EMPTY_OUTPUT, personaSections: [{ section: LAST_SECTION, items: [longItem] }] } })
  const record = await runOnce(harnessed)

  assert.equal(harnessed.writes.length, 0, '预演判定会超 ⇒ 一次写回都不该发生')
  assert.ok(!itemsOf(harnessed.view(), LAST_SECTION).includes(longItem), '这一条不许写进人格卡')
  assert.match(record.error, /拦下拟新增 1 条/, '被预演拦下的条数要记账')
  assert.match(record.error, /预算充足/, '护栏确实没触发（这条是被预演拦的，不是被护栏拦的）')
})

test('V6 预演（一批 3 条、容量超）：未超且护栏未触发，但这一批塞不下 ⇒ 整批不写', async () => {
  // 7 节各 2 条（长度微调让比例落在 0.83~0.85 之间），最后一节空着 ⇒ 3 条新条目落进去塞不下。
  const persona = personaDoc({ perSection: 2, lengths: [80, 80, 80, 80, 110, 110, 115, 0], emptyLast: true })
  assertRatio(
    persona,
    (fit) => fit.truncated === false && fit.used / fit.budget < PERSONA_BUDGET_GUARD_RATIO,
    '夹具必须是"未超且护栏未触发"',
  )
  const batch = Array.from({ length: 3 }, (_, index) => `B${index}:${'z'.repeat(112)}`)
  assert.equal(wouldTruncate(persona, LAST_SECTION, batch), true, '前提：这一批真的塞不下')

  const harnessed = harness({ persona, output: { ...EMPTY_OUTPUT, personaSections: [{ section: LAST_SECTION, items: batch }] } })
  const record = await runOnce(harnessed)

  assert.equal(harnessed.writes.length, 0, '整批被预演拦下 ⇒ 不写回')
  const after = itemsOf(harnessed.view(), LAST_SECTION)
  for (const item of batch) assert.ok(!after.includes(item), `这一条不许写进去：${item.slice(0, 8)}…`)
  assert.match(record.error, /拦下拟新增 3 条/, '拦了几条要如实记账（整批，不是只拦溢出的那一条）')
})

test('V6 对照：同一份夹具里"预演能过"的追加必须照常写入（防一刀切全拦）', async () => {
  const persona = personaDoc({ perSection: 2, lengths: [80, 80, 80, 80, 110, 110, 115, 0], emptyLast: true })
  assertRatio(persona, (fit) => fit.truncated === false, '夹具前提：当前未截断')
  const short = '回复先给结论，再给理由' // 短条目，塞得下
  assert.equal(wouldTruncate(persona, LAST_SECTION, [short]), false, '前提：这一条预演能过')

  const harnessed = harness({ persona, output: { ...EMPTY_OUTPUT, personaSections: [{ section: LAST_SECTION, items: [short] }] } })
  const record = await runOnce(harnessed)

  assert.equal(harnessed.writes.length, 1, '预演能过 ⇒ 必须写回')
  assert.ok(itemsOf(harnessed.view(), LAST_SECTION).includes(short), '能放下的新条目必须真的写进去')
  assert.doesNotMatch(record.error, /拦下拟新增/, '没拦下就不该记这一笔')
})
