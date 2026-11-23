/**
 * 打包契约测试：`package.json` 的 `dsh` 声明、组合补丁、以及 loader 需要的导出符号，
 * 三者必须自洽。
 *
 * 这些是"改一处忘了改另一处"最容易出问题的地方：包名写错会让浏览器启动图指向一个不存在的
 * row；补丁里的 name 写错会让宿主根本挂不上；把默认值抄进补丁则会制造第二份真源（G-004）。
 * 与其等用户装上以后才发现，不如在这里钉死。
 */
import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import * as Humanity from '../lib/index.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const patch = yaml.load(await readFile(path.join(root, 'cordis.patch.yml'), 'utf8'))

/** 断言仓库里确实存在某个相对路径。 */
async function assertFileExists(relative) {
  await access(path.join(root, relative))
}

test('bundle 与 client 两份清单都指向真实存在的产物', async () => {
  assert.equal(packageJson.dsh.bundle.patch, './cordis.patch.yml')
  // `main` 是裸相对路径，exports 里带 `./` 前缀，指的是同一个文件。
  assert.equal(
    path.normalize(packageJson.exports['.'].default),
    path.normalize(packageJson.main),
  )
  assert.equal(packageJson.dsh.client.platform, 'web')

  for (const relative of [
    packageJson.dsh.bundle.patch,
    packageJson.main,
    packageJson.exports['.'].default,
    packageJson.exports['./client'].default,
  ]) {
    await assertFileExists(relative)
  }
})

test('客户端声明只列出真实存在的同组合包（写错会让组合阶段直接失败）', () => {
  const injected = packageJson.dsh.client.inject
  assert.ok(Array.isArray(injected) && injected.length > 0)
  // 这两行声明了本插件要写入的两个槽位（sidebar.panellist 与 main）。
  assert.deepEqual(injected, ['@deepseek-ai/dsh-client-ui-layout', '@deepseek-ai/dsh-client-ui-sidebar'])
  // 没有额外的 external：本插件只请求 shell 已经播种的静态模块表。
  assert.equal(packageJson.dsh.client.external, undefined)
})

test('组合补丁：插入插件行 + 停三段噪音 + 默认预设 + 替换 system-prompt 身份行', () => {
  assert.ok(Array.isArray(patch) && patch.length === 6)
  const [layer, fileRefRow, devContextRow, deliverableRow, registryRow, identityLayer] = patch
  assert.ok(Array.isArray(layer.insert) && layer.insert.length === 1)

  const [row] = layer.insert
  assert.equal(row.name, packageJson.name)
  assert.equal(typeof row.id, 'string')
  assert.equal(row.disabled, undefined)

  // 身份层替换行：关掉第一方身份声明，persona 前缀置空；suffix（工作目录事实）保留。
  assert.equal(identityLayer.id, 'system-prompt')
  assert.equal(identityLayer.config.includeHarnessIdentity, false, '第一方身份声明必须在配置层关掉（信息是唯一自我认知）')
  assert.equal(identityLayer.config.personaPrefix, '', '全局 persona 前缀置空（各 preset 的前缀由宿主身份层在 waterfall 摘除）')
  assert.match(identityLayer.config.personaSuffix, /cwd/, '工作目录是事实不是身份，必须保留')

  // 两段宿主平面噪音（2026-11-14）：它们不在任何 preset 里，只能在补丁层整行停掉。
  assert.equal(fileRefRow.id, 'file-reference-local', '@ 路径说明来自这一行')
  assert.equal(fileRefRow.disabled, true)
  assert.equal(devContextRow.id, 'harness-dev-context', 'checkout / Web GUI 说明来自这一行')
  assert.equal(devContextRow.disabled, true)
  assert.equal(deliverableRow.id, 'deliverable-file-references', '文件链接 / present 那段英文来自这一行')
  assert.equal(deliverableRow.disabled, true)

  // 默认预设（2026-11-14）：指向 humanity 自己注册的那一个，否则新会话会落到 standard。
  assert.equal(registryRow.id, 'agent-preset-registry')
  assert.equal(registryRow.config.default, 'humanity')
})

test('组合补丁不重复声明默认值（默认值只能有一个真源）', () => {
  const [row] = patch[0].insert
  assert.equal(
    row.config,
    undefined,
    '默认值必须只写在 src/host/config.ts 的 schema 里；补丁里再抄一份会在升级时分叉',
  )
})

test('宿主半边导出 loader 需要的全部符号', () => {
  assert.equal(Humanity.name, 'humanity')
  assert.equal(typeof Humanity.apply, 'function')
  // 零硬依赖：缺任何可选 seam 都只关子功能，而不让插件进入 waiting。
  assert.deepEqual(Humanity.inject, [])
  assert.equal(typeof Humanity.Config, 'function')
  assert.deepEqual(Humanity.MODULE_IDS, ['persona', 'emotion', 'memory', 'evolution'])
})
