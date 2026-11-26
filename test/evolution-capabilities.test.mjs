/**
 * 能力清单：**从真实工具表长出来**，不是写死在提示词里。
 *
 * 这是这个插件"通用"的关键之一：换一套预设、增减一个工具插件，她被告知的
 * "能做什么"必须跟着变；不认识的工具照样列出来，不能被漏掉。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { capabilityLines, describeCapabilities, toolNamesOf, visibleToolNames } from '../lib/evolution/capabilities.js'

test('从工具定义里取名字：去重、保序、丢掉空名', () => {
  assert.deepEqual(
    toolNamesOf([{ name: 'web_search' }, { name: 'read' }, { name: 'web_search' }, { name: '' }, {}]),
    ['web_search', 'read'],
  )
  assert.deepEqual(toolNamesOf([]), [])
})

test('认识的工具翻成人话；不认识的照抄工具名（不丢）', () => {
  const hints = describeCapabilities(['web_search', 'brand_new_tool'], '小明')
  assert.deepEqual(hints, [
    { name: 'web_search', label: '查东西' },
    { name: 'brand_new_tool', label: 'brand_new_tool' },
  ])
})

test('标签里的 {who} 换成对方的称呼；没设称呼就用"对方"', () => {
  assert.deepEqual(describeCapabilities(['humanity_tell_him'], '小明'), [
    { name: 'humanity_tell_him', label: '留话给小明' },
  ])
  assert.deepEqual(describeCapabilities(['humanity_tell_him'], ''), [
    { name: 'humanity_tell_him', label: '留话给对方' },
  ])
})

test('渲染成一行一个工具；清单为空就是空', () => {
  const lines = capabilityLines(describeCapabilities(['web_search', 'brand_new_tool'], ''))
  assert.deepEqual(lines, ['- 查东西：`web_search`', '- `brand_new_tool`'])
  assert.deepEqual(capabilityLines([]), [])
})

test('取工具清单必须以"她这个 agent"为作用域，不能省略', () => {
  const agent = { id: 'agent-her' }
  // 省略作用域 = 全局视图：真机 2026-11-26 就因此把 univer_*、team_task_* 当成她的工具。
  const tools = {
    definitions: (scope) => (scope === agent ? [{ name: 'read' }, { name: 'grep' }] : [{ name: 'not_hers' }]),
  }
  assert.deepEqual(visibleToolNames(tools, agent), ['read', 'grep'])
  assert.deepEqual(visibleToolNames(tools, undefined), [], '没有 agent 宁可不给，也不能拿全局的')
  assert.deepEqual(visibleToolNames(undefined, agent), [], '工具服务不在')
  assert.deepEqual(
    visibleToolNames({ definitions: () => { throw new Error('boom') } }, agent),
    [],
    '取清单抛错也不该影响她过日子',
  )
})
