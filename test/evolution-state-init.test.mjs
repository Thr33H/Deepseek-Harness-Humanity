/**
 * 0.1.9 缺陷①的边界钉子：**状态表为空时的第一次写入**。
 *
 * 背景（生产实测）：`evolution_state` 表**从来没有被创建过**（全库只有 `update`、没有 `put`），
 * 12 条 `evolution_runs` 全部 26–101 ms 失败，错误同一句
 * `domain 'humanity' table 'evolution_state' has no record 'main' to update`。
 *
 * 这个缺陷在生产上连坏 12 轮、单测却全绿，原因是**测试替身的 `update` 会在缺失时补建**。
 * 本文件的用例正是钉在"替身与真后端同语义"之后才会红的那一格 —— 它同时是
 * **修复的自证工具**：修 `lib/evolution/state.js` 的 `mutateState` 之前它必红，之后必绿。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { STATE_KEY } from '../lib/evolution/constants.js'
import { STATE_INITIAL } from '../lib/evolution/model.js'
import { createFakeTable, fakeEvolutionState } from './helpers/evolution-fake.mjs'

test('0.1.9 缺陷①：状态表为空时，**第一次** mutateState 必须成功（并建出 main 记录）', async () => {
  const { tables, state } = fakeEvolutionState()
  // 起点必须与生产一致：表里**没有** main 记录（这正是 12 轮失败的那一格）。
  assert.equal(tables.state.get(STATE_KEY), undefined, '起点：表里没有 main 记录（生产就是这样）')

  await state.mutateState({ baselineAt: '2026-10-05T00:00:00.000Z' })

  const record = tables.state.get(STATE_KEY)
  assert.ok(record !== undefined, '第一次写之后 main 记录必须存在')
  assert.equal(record.baselineAt, '2026-10-05T00:00:00.000Z', '本次 patch 必须落上（不是只建了个空记录）')
  assert.equal(tables.state.records.size, 1, '单值状态表里只该有一条记录')
})

test('0.1.9（反向钉子）：替身与真后端同语义 —— 没有 ensure 时，缺记录就抛', async () => {
  // 这条钉住"替身不许再替被测代码把记录建好"。它红了，说明这一层不再骗人。
  const table = createFakeTable()
  await assert.rejects(
    () => table.update('main', () => ({})),
    /has no record 'main' to update/,
    '假表的 update 必须在记录缺失时抛出（与官方 missing-key 同语义）',
  )
})

test('0.1.9 缺陷①：函数式 patch 只应用一次（防"先 put 再 update 同一 patch"的双计）', async () => {
  const { state } = fakeEvolutionState()
  await state.mutateState((current) => ({ ...current, dailyCalls: current.dailyCalls + 1 }))
  await state.mutateState((current) => ({ ...current, dailyCalls: current.dailyCalls + 1 }))
  assert.equal(state.readState().dailyCalls, 2, '两次 +1 应当正好是 2（若实现把 patch 算两次会变 3/4）')
})

test('0.1.9：读侧兜底**未被改动** —— 空表 readState 仍返回出厂值且不抛', () => {
  const { state } = fakeEvolutionState()
  assert.deepEqual(state.readState(), STATE_INITIAL, '读侧行为必须与 0.1.8 完全一致')
})

test('0.1.9 追加③：配额账本可写可读（修①后"20 次/日"不再恒 0）', async () => {
  // 0.1.8 之前：写入永远失败 ⇒ readState 恒返回 STATE_INITIAL ⇒ 工作台恒显示 0/20、额度永不生效。
  const { state } = fakeEvolutionState()
  await state.mutateState({ dailyDate: '2026-10-05', dailyCalls: 0, dailyInputTokens: 0, dailyOutputTokens: 0 })
  await state.mutateState((current) => ({
    ...current,
    dailyCalls: current.dailyCalls + 3,
    dailyInputTokens: current.dailyInputTokens + 1200,
    dailyOutputTokens: current.dailyOutputTokens + 300,
  }))
  const record = state.readState()
  assert.equal(record.dailyDate, '2026-10-05', '跨日日键要能落盘')
  assert.equal(record.dailyCalls, 3, '调用次数要能累加（配额护栏读的就是它）')
  assert.equal(record.dailyInputTokens, 1200)
  assert.equal(record.dailyOutputTokens, 300)
})

test('0.1.9：ensure 只建一次 —— 并发调用不重复建档、也不丢更新', async () => {
  const { tables, state } = fakeEvolutionState()
  await Promise.all([
    state.mutateState((current) => ({ ...current, dailyCalls: current.dailyCalls + 1 })),
    state.mutateState((current) => ({ ...current, dailyOutputTokens: current.dailyOutputTokens + 5 })),
    state.mutateState({ baselineAt: 'concurrent' }),
  ])
  assert.equal(tables.state.records.size, 1, '并发下仍只该有一条记录')
  const record = state.readState()
  assert.equal(record.dailyCalls, 1, '并发写入不得互相顶掉')
  assert.equal(record.dailyOutputTokens, 5)
  assert.equal(record.baselineAt, 'concurrent')
})

test('0.1.9：ensure 失败**不缓存** —— 一次瞬时故障不该把状态写入永久卡死', async () => {
  const { tables, state } = fakeEvolutionState()
  // 让第一次 put 失败，之后恢复。
  const originalPut = tables.state.put
  let fail = true
  tables.state.put = async (key, value) => {
    if (fail) throw new Error('瞬时存储故障')
    return originalPut(key, value)
  }
  await assert.rejects(() => state.mutateState({ baselineAt: 'first' }), /瞬时存储故障/)
  fail = false
  await state.mutateState({ baselineAt: 'second' })
  assert.equal(state.readState().baselineAt, 'second', '第二次必须能成功（说明 ensure 没有被缓存在失败态）')
})
