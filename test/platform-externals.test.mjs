/**
 * 客户端 `PLATFORM_EXTERNALS` 与 DSH 外壳播种表的**一致性检查**（审计 S6-1 / P12）。
 *
 * 为什么需要它：`scripts/build-client.mjs` 把 shell 的静态模块表**硬编码**在仓库里。
 * 少写一个键 ⇒ esbuild 会把该包**内联成一份私有副本**，运行时与官方实现静默分叉；
 * 多写/写错 ⇒ 只在那个请求真的出现时才炸。两者都不会在 `verify` 里自己冒出来。
 *
 * 检查方式：读已安装的 DSH `dsh-web-frontend` 产物，从播种函数里抽出模块名集合，与仓库里
 * 的清单逐项比对。**找不到 DSH 产物时跳过而不是失败** —— 本仓库要求可移植（G-006），
 * 在没有安装 DSH 的机器上跑测试不该因为这条挂掉。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

/** 从 `scripts/build-client.mjs` 里抽出 `PLATFORM_EXTERNALS` 的字面量。 */
function declaredExternals() {
  const source = readFileSync('scripts/build-client.mjs', 'utf8')
  const match = /const PLATFORM_EXTERNALS = \[([\s\S]*?)\]/.exec(source)
  assert.ok(match, 'build-client.mjs 里找不到 PLATFORM_EXTERNALS')
  return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1])
}

/** 找到已安装的 DSH web 前端 bundle；找不到返回 undefined。 */
function frontendBundle() {
  const override = process.env.DSH_FRONTEND_BUNDLE
  const directories = [
    ...(override === undefined ? [] : [path.dirname(override)]),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets',
  ]
  for (const directory of directories) {
    if (!existsSync(directory)) continue
    const index = readdirSync(directory).find((name) => /^index-.*\.js$/.test(name))
    if (index !== undefined) return path.join(directory, index)
  }
  return undefined
}

/**
 * 从播种函数里抽出模块名集合。
 *
 * 产物是压缩过的，但播种对象的形状固定：`{react:<id>,"react/jsx-runtime":<id>,…,
 * "@deepseek-ai/dsh-client-ui-dockkit":<id>}`。取这一段再按 `键:` 抽名字，
 * 形状对不上时返回 undefined（视为"没探测到"而不是"清单错了"）。
 */
function seededModules(bundle) {
  const start = bundle.indexOf('{react:')
  const end = bundle.indexOf('"@deepseek-ai/dsh-client-ui-dockkit"', start)
  if (start < 0 || end < 0) return undefined
  const slice = bundle.slice(start, bundle.indexOf('}', end) + 1)
  const names = [...slice.matchAll(/(?:^|[,{])\s*(?:"([^"]+)"|([A-Za-z_$][\w$]*))\s*:/g)]
    .map((entry) => entry[1] ?? entry[2])
  return names.length > 0 ? new Set(names) : undefined
}

test('客户端的外部模块清单与 DSH 外壳播种表一致（少写会静默内联，多写会在运行时炸）', () => {
  const declared = declaredExternals()
  assert.ok(declared.length > 0, '清单不该为空')

  const bundlePath = frontendBundle()
  if (bundlePath === undefined) {
    // 没装 DSH 的机器：这条无从比对，跳过（不是失败）。
    return
  }

  const seeded = seededModules(readFileSync(bundlePath, 'utf8'))
  if (seeded === undefined) {
    // 产物形状变了（压缩器换了写法）：同样视为"探测不到"，不误报。
    return
  }

  const missing = declared.filter((name) => !seeded.has(name))
  const extra = [...seeded].filter((name) => !declared.includes(name))
  assert.deepEqual(
    { missing, extra },
    { missing: [], extra: [] },
    'PLATFORM_EXTERNALS 与 DSH 播种表分叉了：missing = 我们漏写的，extra = 我们多写的',
  )
})
