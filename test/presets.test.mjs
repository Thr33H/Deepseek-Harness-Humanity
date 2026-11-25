/**
 * 她能做什么、不能做什么 —— **钉在清单上，不靠自觉**。
 *
 * 她房间跑的是「Humanity 沉浸」这套预设，能力面完全由它的插件清单决定。
 * 这份测试把这套清单**逐条写死**：以后谁想给她加一个能力，必须先改这里 ——
 * 而改的时候，下面那几条"不许有"的断言会逼你想一遍"这是不是她能碰的东西"。
 *
 * （2026-11-25 用户裁定：不挡她能看什么，只挡她不能做什么。）
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  HUMANITY_FUNCTIONAL_ID,
  HUMANITY_PRESET_ID,
  functionalPlugins,
  immersivePlugins,
  minimalPlugins,
} from '../lib/presets.js'

/**
 * 把清单摊平成 id 列表（压缩组那种 `group: true` 的把子项展开）。
 * @param {Array<{id: string, group?: true, config?: unknown}>} list - 插件清单。
 * @returns {string[]} id 列表。
 */
function idsOf(list) {
  const out = []
  for (const entry of list) {
    out.push(entry.id)
    if (entry.group === true && Array.isArray(entry.config)) {
      for (const child of entry.config) out.push(child.id)
    }
  }
  return out
}

/** 危险能力的插件名（出现任何一个，都说明她越界了）。 */
const FORBIDDEN = [
  'dsh-tool-bash',        // 跑命令
  'dsh-tool-pwsh',        // 跑命令（Windows）
  'dsh-tool-jobs',        // 后台任务
  'dsh-tool-cordis',      // 改 DSH 自己的插件
  'dsh-tool-ask-user',    // 向她弹框提问（用户 2026-11-15 裁定不要）
  'dsh-subagent',         // 子代理
  'dsh-tool-workflow',    // 多智能体编排
  'dsh-command-goal',     // 目标/计划那套项目管理语言
  'dsh-tool-goal',
  'dsh-tool-todo',
]

test('她房间的能力面 = 这一张清单（多一个插件就得先改这里）', () => {
  const ids = idsOf(immersivePlugins())
  assert.deepEqual(ids, [
    'persona',
    'tool-fs',
    'tool-fs-search',
    'tool-web',
    'time-context',
    'tool-schedule',
    'present',
    'compaction',
    'compaction-basic',
    'command-compact',
    'tool-result-pruner',
  ], '沉浸预设的插件清单变了 —— 这是她有生以来第一次多出来的能力，请确认它该有')
})

test('她能用的东西里没有任何一件危险能力', () => {
  const names = immersivePlugins().map((entry) => entry.name)
  for (const plugin of FORBIDDEN) {
    assert.ok(
      !names.some((name) => typeof name === 'string' && name.includes(plugin)),
      `沉浸预设里出现了 ${plugin} —— 她不该有这个能力`,
    )
  }
})

test('她能写文件，但写这件事由 DSH 的沙箱兜住（只在她自己的目录）', () => {
  const fs = immersivePlugins().find((entry) => entry.id === 'tool-fs')
  assert.ok(fs, '她的清单里必须有 tool-fs（读文件靠它）')
  const config = fs.config ?? {}
  // 沉浸式**允许写**（她自己目录里的东西是她的生活）；边界由会话的沙箱模式守，
  // 不是靠这里关掉写。这条断言防的是"有人顺手把写关了，她连本子都写不了"。
  assert.notEqual(config.write, false, '沉浸式应当允许写（她的本子、她的作品）')
})

test('封存前她什么也写不了（只能读、只能搜）', () => {
  const fs = minimalPlugins().find((entry) => entry.id === 'tool-fs')
  assert.ok(fs, '未封存也要能读文件（她得先认识你）')
  const config = fs.config ?? {}
  assert.equal(config.write, false)
  assert.equal(config.edit, false)
  assert.equal(config.applyPatch, false)
})

test('两套预设的 id 不许漂（房间与记忆都按这个 id 认人）', () => {
  assert.equal(HUMANITY_PRESET_ID, 'humanity')
  assert.equal(HUMANITY_FUNCTIONAL_ID, 'humanity-functional')
})

test('功能预设可以干活（含插件开发），但仍然不含子代理/工作流那套', () => {
  const names = functionalPlugins().map((entry) => entry.name)
  assert.ok(names.some((name) => typeof name === 'string' && name.includes('dsh-tool-bash')), '功能模式要能跑命令')
  // 插件开发是**功能模式**的正当能力（她带着人设去干活时会用），所以它在；
  // 不在的是"多人协作语言"那一套：子代理与工作流。
  assert.ok(names.some((name) => typeof name === 'string' && name.includes('dsh-tool-cordis')), '功能模式含插件开发')
  for (const plugin of ['dsh-subagent', 'dsh-tool-workflow']) {
    assert.ok(
      !names.some((name) => typeof name === 'string' && name.includes(plugin)),
      `功能预设里不该有 ${plugin}`,
    )
  }
})
