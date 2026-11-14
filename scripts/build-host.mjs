/**
 * 构建宿主半边：先清掉 `lib/`，再用 tsc 把 `src/host` 编成 Node ESM 包（`lib/*.js`）。
 *
 * 为什么必须先清：tsc **只写不删**。删掉一个源文件后，它编译出的旧 `.js` 会一直留在
 * `lib/` 里，而 `package.json` 的 `files` 收的是 `lib` 下全部 `.js` —— 于是"已经删掉的功能"
 * 继续被打包、继续可能被 require 到（2026-11-14 实测：删了 `gate.ts`，`lib/gate.js` 还在包里）。
 * 清空再编，产物就是源码的忠实映射。
 *
 * 为什么调用 TypeScript 自带的 bin 而不是 node_modules/.bin/tsc：
 * `.bin` 里是符号链接或 .cmd 包装，在不同平台/不同包管理器下形态不同（pnpm、npm、Windows）。
 * 直接用 `node <typescript>/bin/tsc` 三个平台都一样，也不需要 shell。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')

if (!existsSync(tsc)) {
  console.error('构建失败：找不到 typescript。请先执行 `pnpm install`。')
  process.exit(1)
}

// 清 `lib/` 而不是逐个删：tsc 的输出清单我们拿不到，按清单删就只能删"还记得的"。
// client.js 由下一步 `build-client.mjs` 重新生成，这里一起清掉也安全。
rmSync(path.join(root, 'lib'), { recursive: true, force: true })

const result = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.host.json'], { cwd: root, stdio: 'inherit' })
process.exit(result.status ?? 1)
