/**
 * 对话内提案提醒（P-043）测试：真实 SystemPrompt + 假存储/待确认事实。
 *
 * 钉住四条语义：同一批只提醒一次（水位）、新提案改变批次再提醒、只对主 Agent、
 * 任何异常都收敛成"本轮不提醒"（提示词路径绝不抛——红线）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createLog } from '../lib/log.js'
import { PROPOSALS_SECTION_NAME } from '../lib/evolution/constants.js'
import { createProposal } from '../lib/evolution/model.js'
import { installProposalNotification, hashBatch } from '../lib/evolution/notify.js'
import { fakeEvolutionState } from './helpers/evolution-fake.mjs'

/** 让异步的水位落盘跑完。 */
const flush = () => new Promise((resolve) => setImmediate(resolve))

/** 起一套真实系统提示词 + 提醒注入。 */
async function boot(options = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  const { state } = fakeEvolutionState()
  let enabled = options.enabled ?? true
  let pendingActive = options.pendingActive ?? true
  const memory = { count: options.memoryPending ?? 0, ids: [] }

  const dispose = installProposalNotification(ctx, createLog(ctx, 'test'), {
    state: () => (options.noStore === true ? undefined : state),
    pending: () =>
      pendingActive
        ? {
            proposalIds: () => state.listProposals('pending').map((record) => record.id),
            memoryFingerprints: () => memory.ids,
            counts: () => {
              const counts = state.countPending()
              return { ...counts, memory: memory.count, total: counts.total + memory.count }
            },
          }
        : undefined,
    enabled: () => enabled,
  })
  const main = { id: 'session-1', session: { header: { cwd: '/ws' } } }
  const child = { id: 'session-2' }
  ctx.provide('agents', { roots: () => [main], list: () => [main, child] })

  return {
    ctx,
    state,
    main,
    child,
    memory,
    setEnabled: (next) => {
      enabled = next
    },
    setPendingActive: (next) => {
      pendingActive = next
    },
    /** 装配一次并取提醒段文本。 */
    turn: async (agent) => {
      const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent })
      return assembly.sections.find((section) => section.name === PROPOSALS_SECTION_NAME)?.text ?? ''
    },
    dispose: async () => {
      dispose()
      await ctx.fiber.dispose()
    },
  }
}

/** 落一条 pending 提案。 */
async function seedProposal(state, kind, title) {
  await state.putProposal(createProposal({ kind, title }, 65536))
}

test('有待确认批次：注入简短提醒（数量与分类都在），水位随之落盘', async () => {
  const harness = await boot()
  try {
    await seedProposal(harness.state, 'persona', '身份卡字段')
    await seedProposal(harness.state, 'skill', '新技能')

    const text = await harness.turn(harness.main)
    assert.match(text, /待确认提案/)
    assert.match(text, /2 条/)
    assert.match(text, /人格 1 条、技能 1 条/)
    assert.match(text, /只简短提醒这一次/)

    await flush()
    const expected = hashBatch(harness.state.listProposals('pending').map((record) => record.id).sort())
    assert.equal(harness.state.readState().notifiedWatermark, expected)
  } finally {
    await harness.dispose()
  }
})

test('同一批只提醒一次：第二次装配为空；新提案改变批次后再提醒（P-043）', async () => {
  const harness = await boot()
  try {
    await seedProposal(harness.state, 'route', '夜间模型')
    assert.notEqual(await harness.turn(harness.main), '')
    await flush()

    assert.equal(await harness.turn(harness.main), '', '同批第二次：不再提醒')

    await seedProposal(harness.state, 'persona', '新的提案')
    const text = await harness.turn(harness.main)
    assert.match(text, /2 条/, '新批次：再提醒一次')
  } finally {
    await harness.dispose()
  }
})

test('记忆 pending 也计入批次（P-042 分类含记忆）：数量合并、指纹参与水位', async () => {
  const harness = await boot()
  try {
    harness.memory.count = 3
    harness.memory.ids = ['fp1', 'fp2', 'fp3']
    const first = await harness.turn(harness.main)
    assert.match(first, /3 条/)
    assert.match(first, /记忆 3 条/)
    await flush()
    assert.equal(await harness.turn(harness.main), '')

    // 记忆侧多了一条 pending：批次变了，应当再提醒。
    harness.memory.count = 4
    harness.memory.ids = ['fp1', 'fp2', 'fp3', 'fp4']
    assert.match(await harness.turn(harness.main), /4 条/)
  } finally {
    await harness.dispose()
  }
})

test('没有待确认内容：一个字都不注入（不占 token、不扰动 prompt cache）', async () => {
  const harness = await boot()
  try {
    assert.equal(await harness.turn(harness.main), '')
  } finally {
    await harness.dispose()
  }
})

test('只对主 Agent 注入（子代理拿不到提醒；不声明 agents 依赖的红线由装配结构保证）', async () => {
  const harness = await boot()
  try {
    await seedProposal(harness.state, 'persona', 't')
    assert.notEqual(await harness.turn(harness.main), '')
    assert.equal(await harness.turn(harness.child), '')
  } finally {
    await harness.dispose()
  }
})

test('开关关闭 / 存储未就绪 / 事实缺席：一律空串，绝不抛（提示词路径红线）', async () => {
  const harness = await boot()
  try {
    await seedProposal(harness.state, 'persona', 't')
    harness.setEnabled(false)
    assert.equal(await harness.turn(harness.main), '')
    harness.setEnabled(true)

    harness.setPendingActive(false)
    assert.equal(await harness.turn(harness.main), '')
  } finally {
    await harness.dispose()
  }

  const noStore = await boot({ noStore: true, pendingActive: true })
  try {
    assert.equal(await noStore.turn(noStore.main), '')
  } finally {
    await noStore.dispose()
  }
})

test('水位哈希：同集合同值、顺序无关、异集合异值', () => {
  assert.equal(hashBatch(['a', 'b']), hashBatch(['a', 'b']))
  assert.equal(hashBatch(['a', 'b'].sort()), hashBatch(['b', 'a'].sort()))
  assert.notEqual(hashBatch(['a']), hashBatch(['b']))
})
