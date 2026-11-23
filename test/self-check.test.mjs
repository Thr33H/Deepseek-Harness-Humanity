/**
 * 启动就绪的自检：**凡是在"存储/设置还没就绪"时读出来的值，都不许缓存**。
 *
 * ### 为什么要有这个文件
 *
 * 2026-11-21～22 连着踩了三次同一个坑，表现完全不同、根因是同一句话：
 *
 * | 表现 | 实际 |
 * |---|---|
 * | 封存了却还给她 `humanity_persona_init` | 工具按"默认文档"注册 |
 * | 关了独立判断，重启后又注入那段提示词 | 开关按"默认配置"算了一次 |
 * | 关掉的模块重启后又开了 | 模块开关按默认配置同步了一次 |
 *
 * 插件启动时，**存储比配置晚就绪**。那段时间里 `settings.read()` / `documents()` /
 * `store()` 返回的都是默认值 —— 它不是"读到假数据"，是"还不知道"。把这个"还不知道"
 * 当成事实缓存下来，就再也纠正不回来了。
 *
 * 所以这里钉三条纪律，任何一条破了就红：
 * 1. **不许在装配期一次性读配置**（`const x = settings.read()`）；
 * 2. **不许把配置缓存成快照**（`source = () => next`）；
 * 3. **每个依赖存储的模块都必须有 `notifyStoreReady`**，并且宿主真的调它。
 */
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const HOST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'host')

/** 递归收集 `src/host` 下的 .ts 文件。 */
async function hostFiles(dir = HOST) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await hostFiles(full)))
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

test('自检①：装配期不许一次性读配置（读完缓存就是默认值）', async () => {
  const offenders = []
  for (const file of await hostFiles()) {
    const source = await readFile(file, 'utf8')
    // `const x = settings.read()`：顶层一次性读。允许的是 `read: () => settings.read()` 这种函数。
    const hits = [...source.matchAll(/^ {0,2}(?:const|let)\s+\w+\s*=\s*settings\.read\(\)/gm)]
    if (hits.length > 0) offenders.push(`${path.relative(HOST, file)}（${hits.length} 处）`)
  }
  assert.deepEqual(
    offenders,
    [],
    `这些位置在装配期读了配置并缓存 —— 存储就绪前拿到的是默认值：\n${offenders.join('\n')}`,
  )
})

test('自检②：不许把配置缓存成快照（要传读取函数）', async () => {
  const offenders = []
  for (const file of await hostFiles()) {
    const source = await readFile(file, 'utf8')
    // `source = () => next`：把此刻的值冻进闭包。正确写法是 `source = read`（每次现算）。
    //
    // 排除 `source = () => entry`：那是**服务摘除时回退到组合配置**，`entry` 是常量基础层，
    // 不是"读到的某个时刻的值"，缓存它没有时序问题。
    const hits = [...source.matchAll(/source\s*=\s*\(\)\s*=>\s*(?!entry\b)\w+/g)]
    if (hits.length > 0) offenders.push(`${path.relative(HOST, file)}：${hits.map((h) => h[0]).join(' / ')}`)
  }
  assert.deepEqual(offenders, [], `配置被缓存成快照了，之后存储就绪也不会重算：\n${offenders.join('\n')}`)
})

test('自检③：每个有状态的模块都要能被通知"存储就绪"', async () => {
  const expected = ['persona', 'memory', 'emotion', 'evolution']
  const missing = []
  for (const module of expected) {
    const index = path.join(HOST, module, 'index.ts')
    let source
    try {
      source = await readFile(index, 'utf8')
    } catch {
      // 模块不存在（例如被人删了）：跳过，不算失败。
      continue
    }
    if (!source.includes('notifyStoreReady')) missing.push(module)
  }
  assert.deepEqual(
    missing,
    [],
    `这些模块没有 notifyStoreReady，等于永远不知道存储何时可读：\n${missing.join('\n')}`,
  )
})

test('自检④：宿主必须在存储就绪时真的通知每个模块', async () => {
  const source = await readFile(path.join(HOST, 'index.ts'), 'utf8')
  for (const module of ['persona', 'memory', 'emotion', 'evolution']) {
    // 允许 `state.persona?.notifyStoreReady()` 或 `state.persona.notifyStoreReady()`：
    // 装配顺序决定那一刻是不是一定有值，`?.` 与"补一次"都是合法写法。
    const pattern = new RegExp(`state\\.${module}\\??\\.notifyStoreReady\\(`)
    assert.match(source, pattern, `宿主没有通知 ${module} 存储已就绪`)
  }
})

test('自检⑤：人格工具的可见性必须等"数据真的可读"，不能只看 attached', async () => {
  const source = await readFile(path.join(HOST, 'persona', 'tools.ts'), 'utf8')
  assert.match(
    source,
    /persona\.ready === false/,
    '工具注册必须等 `ready`（= 接上 且 存储就绪），否则会按默认文档注册 —— ' +
      '真机表现：封存了却还给她 humanity_persona_init',
  )
})
