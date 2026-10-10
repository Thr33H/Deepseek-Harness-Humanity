/**
 * 远程通道接线的回归测试（真实 cordis，不是替身）。
 *
 * 这一条钉的是一个**真机才暴露的集成缺陷**（隔离靶机 的 C7 实测）：
 *
 * - `ctx.remote`（父服务）由 `dsh-api-gateway` 的客户端半边**同步**提供；
 * - 各命名空间服务 `remote.<ns>`（例如 `remote.settings`）是 `dsh-api-remotes` 的 `apply()` 里
 *   `await ctx.remote.$mount(contribution)` **异步逐个挂**的；
 * - 只注入 `remote` 就在回调里读 `sctx.remote.settings` ⇒ 抢跑，拿到 `undefined`
 *   ⇒ 工作台显示「命名空间未就绪」，而服务端完全正常。
 *
 * 为什么必须用**真实 cordis** 而不是假上下文：这段语义（点号服务名、traceable 代理按
 * `ctx.reflect.props['remote.settings']` 解析、依赖就位才触发 inject 回调）全部属于 cordis 本身。
 * 替身会把它们替换掉，于是测试全绿、真机照旧坏 —— 这正是缺陷漏到 C7 的原因。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'

/** 父服务：模拟 `dsh-api-gateway` 客户端半边的 `ClientRemoteService`（名字字面量 `remote`）。 */
class FakeRemote extends Service {
  constructor(ctx) {
    super(ctx, 'remote')
  }
}

/** 命名空间服务：模拟 gateway 异步 `$mount` 出来的 `RemoteNamespaceService`（名字 `remote.<ns>`）。 */
class FakeNamespace extends Service {
  constructor(ctx, name) {
    super(ctx, name)
  }

  describe() {
    return Promise.resolve({ ok: true, value: { writable: true, namespaces: [] } })
  }
}

/** 让已排队的微任务跑完。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

test('旧接线（只注入 remote）会在命名空间挂载之前抢跑 —— 这就是真机「未就绪」的成因', async () => {
  const ctx = new Context()
  const observed = []

  await ctx.plugin({
    name: 'probe-old',
    apply(c) {
      new FakeRemote(c)
      c.inject(['remote'], (sctx) => {
        // 真机里这一行拿到的是 undefined：父服务已在，命名空间还没挂上。
        observed.push(sctx.remote.settings)
        return () => {}
      })
    },
  })

  // 命名空间稍后才挂（对应 `apply()` 里的 `await $mount(...)`）。
  await ctx.plugin({
    name: 'remote.settings',
    apply: (c) => {
      new FakeNamespace(c, 'remote.settings')
    },
  })
  await settle()

  assert.equal(observed.length, 1, '只注入 remote 时，回调会在父服务出现时立刻跑')
  assert.equal(observed[0], undefined, '抢跑时命名空间还不存在（这正是真机 attach(undefined) 的来源）')

  await ctx.fiber.dispose()
})

test('新接线（注入 remote.settings）等命名空间就位才跑，且 sctx.remote.settings 可解析', async () => {
  const ctx = new Context()
  const observed = []

  await ctx.plugin({
    name: 'probe-new',
    apply(c) {
      new FakeRemote(c)
      c.inject(['remote', 'remote.settings'], (sctx) => {
        observed.push(sctx.remote.settings)
        return () => {}
      })
    },
  })
  await settle()
  assert.equal(observed.length, 0, '命名空间没挂上时回调不该跑（不抢跑）')

  await ctx.plugin({
    name: 'remote.settings',
    apply: (c) => {
      new FakeNamespace(c, 'remote.settings')
    },
  })
  await settle()

  assert.equal(observed.length, 1, '命名空间挂上后回调恰好跑一次')
  assert.equal(typeof observed[0]?.describe, 'function', 'sctx.remote.settings 必须解析成命名空间服务')

  await ctx.fiber.dispose()
})

test('命名空间服务撤下后，注入回调的清理函数会执行（掉线 → 回到未就绪，而不是继续用死通道）', async () => {
  const ctx = new Context()
  let attached = 0
  let detached = 0

  await ctx.plugin({
    name: 'probe-lifecycle',
    apply(c) {
      new FakeRemote(c)
      c.inject(['remote', 'remote.settings'], () => {
        attached += 1
        return () => {
          detached += 1
        }
      })
    },
  })

  const namespace = await ctx.plugin({
    name: 'remote.settings',
    apply: (c) => {
      new FakeNamespace(c, 'remote.settings')
    },
  })
  await settle()
  assert.equal(attached, 1)

  await namespace.dispose()
  await settle()
  assert.equal(detached, 1, '命名空间撤下必须触发清理，界面才能如实回到未就绪')

  await ctx.fiber.dispose()
})
