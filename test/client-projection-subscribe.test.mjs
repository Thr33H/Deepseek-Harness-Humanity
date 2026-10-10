/**
 * 客户端「宿主投影落盘后重读」接线的回归测试（真机缺陷 P2）。
 *
 * 记忆工作台的写是**两段式**：客户端只把命令放进命令槽，宿主消费完、投影落盘后才更新
 * `entries`。客户端 `update()` 返回时宿主多半还没消费完，此刻立刻 `load()` 读到的是中间态
 * （真机症状：点按钮有反应、列表不变）。宿主投影会发 `settings/document-updated`，
 * 订阅它是"第二段写完了"的确定信号（第一方 `dsh-client-ui-settings` 用的同一个事件）。
 *
 * 用真实构建产物（`lib/client.js`）而不是重写一份逻辑：接线写错的代价恰恰在打包后的那份里。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadClientBundle } from './helpers/client-bundle.mjs'

const { subscribeToProjection } = await loadClientBundle()

/** 假的客户端 remote：记录监听器并允许测试手动触发。 */
function fakeRemote() {
  const listeners = new Map()
  const offs = []
  return {
    remote: {
      $on(event, listener) {
        listeners.set(event, listener)
        const off = () => listeners.delete(event)
        offs.push(off)
        return off
      },
    },
    emit(ns) {
      return listeners.get('settings/document-updated')?.(ns)
    },
    subscribedEvents: () => [...listeners.keys()],
    offs,
  }
}

test('订阅正确的事件名，且只在指定命名空间变化时重读', () => {
  const { remote, emit, subscribedEvents } = fakeRemote()
  let reloads = 0
  const off = subscribeToProjection(remote, ['humanity-memory'], () => {
    reloads += 1
  })

  assert.deepEqual(subscribedEvents(), ['settings/document-updated'], '订阅的必须是宿主投影事件')
  emit('humanity-persona')
  assert.equal(reloads, 0, '无关命名空间的写入不该触发重读（否则是刷新风暴）')
  emit('humanity-memory')
  assert.equal(reloads, 1, '自己的命名空间变化必须重读')
  emit('humanity-memory')
  assert.equal(reloads, 2)

  off()
  emit('humanity-memory')
  assert.equal(reloads, 2, '取消订阅后不再重读')
})

test('拿不到 $on 或它抛错时都退化为「不自动刷新」，绝不抛（客户端组合不能被拖垮）', () => {
  // 1）服务形状不对：没有 $on。
  assert.doesNotThrow(() => subscribeToProjection({}, ['humanity-memory'], () => assert.fail('不该重读'))())
  assert.doesNotThrow(() => subscribeToProjection(undefined, ['humanity-memory'], () => assert.fail('不该重读'))())

  // 2）$on 自己抛（连接已断等）：必须被吞掉，返回可调用的空操作。
  const off = subscribeToProjection(
    {
      $on() {
        throw new Error('连接已断开')
      },
    },
    ['humanity-memory'],
    () => assert.fail('不该重读'),
  )
  assert.equal(typeof off, 'function')
  assert.doesNotThrow(() => off())
})
