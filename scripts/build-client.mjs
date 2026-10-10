/**
 * 构建客户端半边：把 `src/client` 打成**单个** CJS bundle，并套上 DSH 的模块加载信封，
 * 产出 `lib/client.js`。
 *
 * 为什么必须打成单文件：浏览器端的 `require` 由 DSH 的模块表实现，它只认三样东西——
 * shell 播种的静态模块表、启动图里的插件 row、以及已注册的 factory。相对路径
 * （`require("./styles")`）不在其中，因此客户端代码里的相对导入必须在构建期就被内联掉。
 *
 * 为什么外层信封要手写：官方插件 bundle 的格式是
 * `window.__ModuleLoader__.load({ id, factory })`，其中 `id` 必须等于**包名**——模块系统
 * 以解析出的清单包名作为浏览器模块身份，写错会让启动图指向一个不存在的 row。
 * 因此 id 直接从 package.json 读，不手抄。
 *
 * 为什么用 banner/footer 之外的字符串拼接：esbuild 会在产物里插入自己的头部与
 * `"use strict"`，位置随版本变化。拼接是确定性的，不依赖打包器的内部排布。
 */
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * shell 播种的静态模块表（`PLATFORM_MODULES`）：这些请求在运行时由外壳回答，
 * 因此必须标记为 external 而不是打进 bundle。清单与 DSH 0.1.5-rc.2 的
 * `dsh-web-frontend` 启动代码一致；多写一个不存在的键只会在该请求真的出现时才报错，
 * 少写一个则会在构建期被内联成一份私有副本（静默偏离官方实现），所以要一次列全。
 */
const PLATFORM_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const outFile = path.join(root, 'lib', 'client.js')

const result = await build({
  entryPoints: [path.join(root, 'src', 'client', 'index.ts')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: PLATFORM_EXTERNALS,
  // 中文文案保持原样：默认的 ascii 转义会把可读的字典变成一屏 \uXXXX。
  charset: 'utf8',
  legalComments: 'none',
  logLevel: 'warning',
})

const body = result.outputFiles?.[0]?.text
if (body === undefined) {
  console.error('构建失败：esbuild 没有产出内容。')
  process.exit(1)
}

const bundle = `// 由 scripts/build-client.mjs 生成，请勿手工编辑。
// 源文件在 src/client/；改动请改源码后重新构建。
window.__ModuleLoader__.load({
	id: ${JSON.stringify(packageJson.name)},
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
${body}
		return module.exports;
	}
});
`

await writeFile(outFile, bundle, 'utf8')
console.log(`已生成 lib/client.js（模块 id: ${packageJson.name}）`)
