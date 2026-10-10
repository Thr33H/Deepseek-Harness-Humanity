/**
 * 官方导出名审计（防"改名致 undefined"这一类复发）。
 *
 * ### 为什么需要它
 *
 * 官方把一个导出**改名**时，CommonJS 下的结果是 `undefined`：导入不报错、渲染时才炸
 * React #130「Element type is invalid」。2026-09-29 真机实测：4 个图标改名（0.1.5 的
 * `…Outline14/16` → 0.1.7 的 `…Outline`）让**整个工作台四页**进了兜底页。
 * 只审"删除面"会漏掉"改名面"，所以这条测试盯着三件事：
 *
 * 1. bundle 里**直接取用**的官方导出（`别名.名字`）必须在当前这版 DSH 里存在；
 * 2. 客户端里"按候选顺序解析"的图标组（`icons.ts` 的 `ICON_CANDIDATES`），
 *    **每一组至少要有一个候选存在** —— 否则解析结果就是 `undefined`，界面又会炸；
 * 3. 候选里允许缺失的名字有且只有候选表里那些（别的名字缺失一律算红）。
 *
 * 判定用的官方包目录可被 `DSH_OFFICIAL_BASE` 覆盖；默认按容器里的布局取。
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

// ⚠️ 必须用 fileURLToPath：本仓库路径里有中文，`.pathname` 会留下 %XX 编码（实测 ENOENT）。
const BUNDLE = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const OFFICIAL_BASE = process.env.DSH_OFFICIAL_BASE ?? '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules'

/** 读一个官方包的"导出面"（把 lib/*.js 拼起来近似判断名字在不在）。 */
function officialBlob(pkg) {
  const dir = join(OFFICIAL_BASE, pkg, 'lib')
  let blob = ''
  for (const file of readdirSync(dir)) {
    if (file.endsWith('.js') && statSync(join(dir, file)).isFile()) blob += readFileSync(join(dir, file), 'utf8')
  }
  return blob
}

/** bundle 里 `var import_x = require("@deepseek-ai/…")` 的别名表 + `别名.名字` 的用法。 */
function scanBundle(source) {
  const alias = new Map()
  // esbuild 对 ESM 包会包一层 `__toESM(...)`（实测：`var primitives = __toESM(require("…"))`），
  // 所以这里必须容忍这个包装——只认裸 `= require(...)` 会一条都扫不到（本测试初版就栽在这）。
  const re = /var\s+([A-Za-z0-9_$]+)\s*=\s*(?:__toESM\()?require\("(@deepseek-ai\/[^"]+)"\)/g
  let match
  while ((match = re.exec(source)) !== null) alias.set(match[1], match[2])

  const used = new Map()
  for (const [name, pkg] of alias) {
    const usage = new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.([A-Za-z0-9_$]+)`, 'g')
    let hit
    while ((hit = usage.exec(source)) !== null) {
      if (!used.has(pkg)) used.set(pkg, new Set())
      used.get(pkg).add(hit[1])
    }
  }
  return used
}

/** 从 bundle 里抠出图标候选表：`IconQuestion: ["IconQuestionOutline14", "IconQuestionOutline"]`。 */
function scanIconCandidates(source) {
  const groups = []
  // 注意 esbuild 会在冒号与逗号后留空格（实测 `IconQuestion: ["…", "…"]`），别写成紧贴的 `:[`。
  const re = /(Icon[A-Za-z]+)\s*:\s*\[((?:"[A-Za-z0-9_$]+"\s*,?\s*)+)\]/g
  let match
  while ((match = re.exec(source)) !== null) {
    groups.push([match[1], [...match[2].matchAll(/"([A-Za-z0-9_$]+)"/g)].map((entry) => entry[1])])
  }
  return groups
}

test('客户端直接取用的官方导出，在当前这版 DSH 里都必须存在', () => {
  const source = readFileSync(BUNDLE, 'utf8')
  const used = scanBundle(source)
  assert.ok(used.size > 0, `bundle 里没扫到任何官方包引用，审计对象可能不对：${BUNDLE}`)

  const missing = []
  for (const [pkg, names] of used) {
    const blob = officialBlob(pkg)
    for (const name of names) {
      if (!new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`).test(blob)) missing.push(`${pkg}#${name}`)
    }
  }
  assert.deepEqual(missing, [], `这些官方导出在本版不存在（渲染时会炸 React #130）：${missing.join(', ')}`)
})

test('图标候选组：每一组至少有一个候选存在（否则解析为 undefined，界面必炸）', () => {
  const source = readFileSync(BUNDLE, 'utf8')
  const groups = scanIconCandidates(source)
  assert.ok(groups.length >= 4, `应至少扫到 4 个图标候选组，实际 ${String(groups.length)} 组：${groups.map(([g]) => g).join(', ')}`)

  const blob = officialBlob('@deepseek-ai/dsh-client-ui-primitives')
  const empty = groups
    .filter(([, names]) => !names.some((name) => new RegExp(`\\b${name}\\b`).test(blob)))
    .map(([group, names]) => `${group}(${names.join('/')})`)
  assert.deepEqual(empty, [], `这些图标组在本版一个候选都找不到，界面会渲染 undefined：${empty.join(', ')}`)
})

test('候选表本身不许空组（空组等于永远解析不到）', () => {
  const groups = scanIconCandidates(readFileSync(BUNDLE, 'utf8'))
  const empty = groups.filter(([, names]) => names.length === 0).map(([group]) => group)
  assert.deepEqual(empty, [])
})
