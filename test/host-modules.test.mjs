/**
 * 模块注册表的行为测试。
 *
 * 重点不在「开关能读出来」，而在两条硬约束：
 * 1. 隔离——任何单个模块挂载/卸载抛错，都不影响其他模块（P-048「模块故障只影响自己」）；
 * 2. 开关即时生效——改配置后重新 install 得到的是新批次，旧批次的清理动作恰好跑一次。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Config } from '../lib/index.js'
import { createModuleRegistry, MODULES } from '../lib/modules.js'

/** 收集日志的假 log，用来断言「故障留下了原因」。 */
function createFakeLog() {
  const entries = []
  return {
    entries,
    info: (message, ...rest) => entries.push({ level: 'info', message, rest }),
    warn: (message, ...rest) => entries.push({ level: 'warn', message, rest }),
    error: (message, ...rest) => entries.push({ level: 'error', message, rest }),
  }
}

/** 造一个只记录 mount 次数的假模块。 */
function fakeModule(id, { enabled = true, mount, implemented = true } = {}) {
  return {
    id,
    title: id,
    implemented,
    isEnabled: () => enabled,
    ...(mount === undefined ? {} : { mount }),
  }
}

test('生产模块表：四个模块的 id 与顺序与决策日志一致（router 随 M4 裁撤删除）', () => {
  assert.deepEqual(
    MODULES.map((module) => module.id),
    ['persona', 'memory', 'evolution', 'dream'],
  )
})

test('已实现但没有 mount 的模块读作 active（宿主在注册表之外挂载）；未实现的才 skeleton', () => {
  const hostMounted = fakeModule('host-mounted')
  const unimplemented = { id: 'later', title: 'later', implemented: false, isEnabled: () => true }
  const registry = createModuleRegistry([hostMounted, unimplemented], createFakeLog())

  registry.install({}, Config({}))

  const states = Object.fromEntries(registry.snapshot().map((state) => [state.id, state.status]))
  assert.equal(states['host-mounted'], 'active', '已实现 + 宿主挂载 ⇒ active（否则启动日志谎报"未实现"）')
  assert.equal(states.later, 'skeleton', '未实现 ⇒ skeleton，不假装可用')
})

test('默认配置下：已实现的模块读作 active（不谎报）', () => {
  const registry = createModuleRegistry(MODULES, createFakeLog())

  registry.install({}, Config({}))

  // 四个模块 implemented=true 但没有 mount —— 它们由宿主在注册表之外挂载
  // （需要存储与开关事实），所以状态是 active。
  // 早先这里一律按 mount===undefined 判 skeleton，导致启动日志谎报「人格=skeleton」。
  // M4 裁撤后生产模块表里已无"未实现"模块，那条路径由上面的假模块用例覆盖。
  assert.deepEqual(
    registry.snapshot().map((state) => [state.id, state.status]),
    [
      ['persona', 'active'],
      ['memory', 'active'],
      ['evolution', 'active'],
      ['dream', 'active'],
    ],
  )
})

test('总开关关闭时所有模块都是 disabled', () => {
  const registry = createModuleRegistry(MODULES, createFakeLog())
  registry.install({}, Config({ enabled: false }))
  assert.deepEqual(
    registry.snapshot().map((state) => state.status),
    ['disabled', 'disabled', 'disabled', 'disabled'],
  )
})

test('记忆模式为 off 时记忆模块 disabled，其余模块不受影响', () => {
  const registry = createModuleRegistry(MODULES, createFakeLog())
  registry.install({}, Config({ modules: { memory: { mode: 'off' } } }))
  const states = Object.fromEntries(registry.snapshot().map((state) => [state.id, state.status]))
  assert.equal(states.memory, 'disabled')
  assert.equal(states.persona, 'active')
  assert.equal(states.dream, 'active')
})

test('梦境依赖自进化：自进化关掉时梦境不会单独工作', () => {
  const registry = createModuleRegistry(MODULES, createFakeLog())
  registry.install({}, Config({ modules: { evolution: { enabled: false } } }))
  const states = Object.fromEntries(registry.snapshot().map((state) => [state.id, state.status]))
  assert.equal(states.evolution, 'disabled')
  assert.equal(states.dream, 'disabled')
})

test('一个模块挂载抛错时只禁用它自己，其余模块照常挂载', () => {
  const log = createFakeLog()
  const mounted = []
  const modules = [
    fakeModule('persona', { mount: () => mounted.push('persona') }),
    fakeModule('memory', {
      mount: () => {
        throw new Error('后端连接失败')
      },
    }),
    fakeModule('extra', { mount: () => mounted.push('extra') }),
  ]

  const registry = createModuleRegistry(modules, log)
  registry.install({}, Config({}))

  assert.deepEqual(mounted, ['persona', 'extra'])
  const states = Object.fromEntries(registry.snapshot().map((state) => [state.id, state]))
  assert.equal(states.persona.status, 'active')
  assert.equal(states.memory.status, 'failed')
  assert.equal(states.extra.status, 'active')
  // 失败原因必须能被工作台读到，否则用户只看到「少了个功能」而不知道为什么。
  assert.match(states.memory.error, /后端连接失败/)
  // 同时也要留在日志里。
  assert.equal(log.entries.filter((entry) => entry.level === 'error').length, 1)
  assert.match(log.entries.at(-1).message, /memory.*挂载失败/)
})

test('卸载按逆序执行，且每个清理动作只跑一次', () => {
  const order = []
  const modules = [
    fakeModule('persona', { mount: () => () => order.push('persona') }),
    fakeModule('memory', { mount: () => () => order.push('memory') }),
  ]
  const registry = createModuleRegistry(modules, createFakeLog())

  const dispose = registry.install({}, Config({}))
  dispose()

  assert.deepEqual(order, ['memory', 'persona'])
})

test('一个模块的清理动作抛错不会阻断其余模块卸载', () => {
  const log = createFakeLog()
  const cleaned = []
  const modules = [
    fakeModule('persona', { mount: () => () => cleaned.push('persona') }),
    fakeModule('memory', {
      mount: () => () => {
        throw new Error('关闭领域失败')
      },
    }),
  ]
  const registry = createModuleRegistry(modules, log)

  const dispose = registry.install({}, Config({}))
  dispose()

  assert.deepEqual(cleaned, ['persona'])
  assert.equal(log.entries.filter((entry) => entry.level === 'warn').length, 1)
})

test('重新 install 得到独立批次，旧批次不会被新批次连带卸载', () => {
  const cleaned = []
  const modules = [fakeModule('persona', { mount: () => () => cleaned.push('mounted') })]
  const registry = createModuleRegistry(modules, createFakeLog())

  const first = registry.install({}, Config({}))
  const second = registry.install({}, Config({}))

  first()
  assert.deepEqual(cleaned, ['mounted'])
  second()
  assert.deepEqual(cleaned, ['mounted', 'mounted'])
})
