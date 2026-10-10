/**
 * 构建宿主半边：把 `src/host` 用 tsc 编成 Node ESM 包（`lib/*.js`）。
 *
 * 为什么调用 TypeScript 自带的 bin 而不是 node_modules/.bin/tsc：
 * `.bin` 里是符号链接或 .cmd 包装，在不同平台/不同包管理器下形态不同（pnpm、npm、Windows）。
 * 直接用 `node <typescript>/bin/tsc` 三个平台都一样，也不需要 shell。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')

if (!existsSync(tsc)) {
  console.error('构建失败：找不到 typescript。请先执行 `pnpm install`。')
  process.exit(1)
}

const result = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.host.json'], { cwd: root, stdio: 'inherit' })
process.exit(result.status ?? 1)
