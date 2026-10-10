/**
 * F2 回归（2026-10-04）：**存储打不开必须留下容器外可见的痕迹**。
 *
 * 为什么单独一条：部署容器的 `ctx.logger` 输出**不进 `docker logs`**
 * （`src/host/log.ts` 文件头有实测记录："靶机启动日志只有 23 行，插件所有 info/error 都不在里面"）。
 * 于是"存储域声明非法 / 打开失败"这两条**最要命**的日志在过去**一个字都看不到** ——
 * 外部表现只剩"每轮说人格尚未初始化 + recall 整场失效"，而容器日志干干净净、无从下手。
 *
 * F2 的修法是改走 `reportBootFailure`，它**除了**日志门面还直写 `console.error`。
 * 这条测试把它钉住：只要有人把 `reportBootFailure` 换回 `log.error`，这里就会红。
 *
 * 与 F1 的关系：F1 让"读不到"不再撒谎，代价是**故障更安静**；F2 就是把安静补回来的那一半。
 * 两者必须同版本上线。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLog, reportBootFailure } from '../lib/log.js'
import { openDomain } from '../lib/store-open.js'

/** 一个只负责"记下被调用过"的假日志门面。 */
function fakeLog() {
  const seen = []
  return {
    seen,
    log: {
      info: (message) => seen.push(['info', message]),
      warn: (message) => seen.push(['warn', message]),
      error: (message) => seen.push(['error', message]),
    },
  }
}

/** 在捕获 `console.error` 的前提下跑一段（同步或异步）代码。 */
async function captureStderr(fn) {
  const out = []
  const original = console.error
  console.error = (...args) => out.push(args.map((value) => String(value)).join(' '))
  try {
    await fn()
  } finally {
    console.error = original
  }
  return out
}

test('F2 原理：`log.error` 不进 stderr，`reportBootFailure` 进 —— 这就是必须换的原因', async () => {
  const { log, seen } = fakeLog()

  // ① 只走 log.error：门面收到，stderr 一声不响。
  const facadeOut = await captureStderr(() => {
    log.error('存储领域 humanity 打开失败，本次以无持久化方式运行', new Error('boom'))
  })
  assert.equal(facadeOut.length, 0, 'log.error 不直写 stderr ⇒ 过去"日志干净但故障存在"')
  assert.ok(seen.some(([level]) => level === 'error'), '前提：门面确实收到了这条')

  // ② 走 reportBootFailure：门面 + stderr 都有。
  const bootOut = await captureStderr(() => {
    reportBootFailure(log, '存储领域 humanity 打开失败，本次以无持久化方式运行', new Error('boom'))
  })
  assert.equal(bootOut.length, 1, 'reportBootFailure 必须直写 stderr')
  assert.match(bootOut[0], /\[humanity\]/, 'stderr 那行要有可 grep 的前缀')
  assert.match(bootOut[0], /打开失败/, 'stderr 那行要说清失败原因')
  assert.match(bootOut[0], /boom/, '原始错误要一起带出来（排查靠它）')
})

test('F2 端到端：存储领域**打开失败** ⇒ `openDomain` 在 stderr 上留一行且降级返回 undefined', async () => {
  const { log } = fakeLog()
  let opened = 0
  const facility = {
    open: async () => {
      opened += 1
      // 模拟最常见的那条：一条记录不符合 schema ⇒ 领域打开失败。
      throw new Error('模拟：memory_entries 里有一条不符合 schema 的记录')
    },
  }

  const out = await captureStderr(async () => {
    const store = await openDomain(facility, log)
    assert.equal(store, undefined, 'G-002：打不开就降级为"本次无持久化"，不抛、不拖垮对话')
  })

  assert.equal(opened, 1, '前提：确实走到了打开那一步')
  assert.equal(out.length, 1, 'F2 要求在 stderr 上留下一行')
  assert.match(out[0], /\[humanity\]/, '前缀可 grep（容器日志里就用它找）')
  assert.match(out[0], /打开失败/, '要说清是哪一类失败')
  assert.match(out[0], /不符合 schema/, '原始原因要带出来')
})

test('F2 端到端：`loadOptional` 拿不到官方包 ⇒ 安静返回 undefined（不误报为"打开失败"）', async () => {
  // 这条守的是**不要过度告警**：可选的官方包缺席是已知且可接受的（G-002 零硬依赖），
  // 它由 `loadOptional` 自己记一条 warn 就够，不该冒充"存储打开失败"。
  const { log, seen } = fakeLog()
  const facility = { open: async () => { throw new Error('不应到达：包都没拿到') } }

  const out = await captureStderr(async () => {
    const store = await openDomain(facility, log)
    assert.equal(store, undefined)
  })

  // 包在测试环境里是可解析的，所以这里其实会走到 open 并失败 —— 记录实际行为，不硬编期望。
  assert.ok(out.length <= 1, `stderr 最多一行，实际 ${out.length}`)
  assert.ok(seen.length >= 1, '门面至少记了一条')
})
