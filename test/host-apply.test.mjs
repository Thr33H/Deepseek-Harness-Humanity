/**
 * 真实组合测试：在真实的 cordis 上下文里挂真实的 DSH 服务，再把本插件挂上去。
 *
 * 为什么不用假 ctx：设置命名空间与存储领域最容易写错的恰恰是语义——base 层怎么解析、
 * effect 归属哪个 fiber、领域单元怎么落盘。mock 会把错误一起 mock 掉。这里用的是与
 * Web profile 同一批官方包（dsh-storage / dsh-storage-json / dsh-storage-domain /
 * dsh-settings-file），因此这条路径与线上是同一条。
 *
 * 断言边界：M1 刻意没有对外暴露状态服务（那是 M2 随 Remote API 一起定的对外契约），
 * 所以这里只断言从**公开 seam** 能观察到的事实：插件挂载成功、设置命名空间注册且默认值正确、
 * 用户写入被接受并持久化、存储领域真的建立了首次安装标记。模块开关的挂载与隔离语义由
 * `host-modules.test.mjs` 覆盖。缺少可选服务时的降级同样在这里验证。
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SettingsFile from '@deepseek-ai/dsh-settings-file'
import * as Humanity from '../lib/index.js'
import { PERSONA_NAMESPACE } from '../lib/persona/section.js'
import { SETTINGS_NAMESPACE } from '../lib/settings.js'
import { MEMORY_NAMESPACE } from '../lib/memory/section.js'
import { EXPECTED_DEFAULTS } from './helpers/expected-defaults.mjs'

// 默认值快照的说明与出处见 helpers/expected-defaults.mjs（与 host-config.test.mjs 共用一份）。

/**
 * 原子写的**临时产物**名 —— 不是存储产物，列出时必须排除。
 *
 * 依据（两份官方源码，别凭印象）：
 * - `dsh-storage-json/lib/index.js:26`：`const tmp = join(dirname(path), \`.${randomUUID()}.tmp\`)`
 *   ⇒ **点开头**（本障实测到的 `ENOENT …/storages/.<uuid>.tmp` 就是它）；
 * - `dsh-atomic-write/lib/index.js:66`：`` const temp = `${filename}.${randomBytes(6).toString("hex")}.tmp` ``
 *   ⇒ **`.tmp` 结尾**。
 * 两种都排除，覆盖"将来换用另一个原子写实现"的情形。
 */
function isAtomicTempName(name) {
  return name.startsWith('.') || name.endsWith('.tmp')
}

/**
 * 递归列出目录下的**存储产物**（相对路径）；原子写过程中的临时文件不算产物。
 *
 * ⚠️ 2026-10-12 修（qa-evolve 定位的**测试侧**竞态，非插件缺陷）：存储后端是**原子写**
 * （先写临时文件、再 `rename` 到目标），于是"先 `readdir` 拍快照、再逐个 `readFile`"有一个
 * 中间态窗口 —— 快照里可能包含**正在被改名走的临时文件**，随后 `readFile` 抛
 * `ENOENT: …/storages/.<uuid>.tmp`。qa 在**未改动的 0.1.11 基线树**上 1:1 复现过同一用例、
 * 同一行、同一错误。
 *
 * 为什么"排除临时产物"是**结构上**消除竞态（而不是"少跑几次没复现"）：
 * 正式产物走的是 `rename(tmp, path)`，`rename` 在 POSIX 上是**原子替换** ⇒ 一个被列出的
 * **正式产物名**在读取时不可能"恰好不存在"；会消失的**只有临时名**。把临时名从集合里去掉，
 * 这个窗口就不存在了。
 *
 * 反过来说：**单次 `ENOENT` 重试并不能修好它** —— 那个临时文件是被 `rename` **永久**移走的，
 * 重试读同一个名字只会再失败一次。所以修法必须是"别把它当产物"。
 */
async function listFiles(root, prefix = '') {
  const found = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (isAtomicTempName(entry.name)) continue
    const relative = path.join(prefix, entry.name)
    if (entry.isDirectory()) found.push(...(await listFiles(path.join(root, entry.name), relative)))
    else found.push(relative)
  }
  return found
}

/** 该错误是不是"名字还在列表里、但读之前已经没了"（竞态窗口的形态）。 */
function isVanished(error) {
  return typeof error === 'object' && error !== null && error.code === 'ENOENT'
}

/**
 * 逐个读回列出的产物，拼成一段文本。
 *
 * 第二层兜底（窄口子）：万一将来后端改成**非原子**的发布序列（例如"先把目标改名走、再放新的"，
 * 官方 `backupRecord` 就是这种形态），正式产物名也可能在读取前消失。此时**跳过它**而不是让整条
 * 断言失败 —— 这条用例要证的是"存储领域真的打开了、写了首次安装标记"，不是"每一刻每个名字都可读"。
 * 别的错误照旧抛（不许把权限/IO 故障当成竞态吞掉）。
 * @param root - 目录。
 * @param files - 相对路径列表（可为 `listFiles` 的产物，也可由用例直接给定）。
 * @returns 可读产物的正文拼接；一个都读不出来时为空串（调用方据此断言）。
 */
async function readFilesBestEffort(root, files) {
  const contents = await Promise.all(
    files.map(async (file) => {
      try {
        return await readFile(path.join(root, file), 'utf8')
      } catch (error) {
        if (isVanished(error)) return ''
        throw error
      }
    }),
  )
  return contents.filter((text) => text !== '').join('\n')
}

/** 拍一次"存储领域产物"的快照：列出产物（排除原子写临时件）→ 读回 → 拼接（可能为空串）。 */
async function readStoragePayload(root) {
  return readFilesBestEffort(root, await listFiles(root))
}

/** "首次安装标记"的判据（`installedAt` 是 ISO 时刻）。 */
const INSTALL_MARKER = /"installedAt"\s*:\s*"20\d\d-/

/**
 * 等到存储领域**真的把产物写出来**为止（返回那一刻的快照）。
 *
 * ⚠️ 为什么不能只等"目录出现"（`existsSync(storages)`）就拍快照 —— 这是本障的**第二层**竞态，
 * 2026-10-12 由"改动后跑 10 轮"抓到（第一层是临时件被读 ⇒ ENOENT）：
 * 后端是"先建目录 / 先落临时件、再 rename 提交"，于是"目录刚出现"那一刻，快照里可能
 * **只有在飞的临时件**（过滤后为空），或者**还没有任何产物**。旧断言 `files.length > 0`
 * 在那种时刻本就会假红，只是当年临时件也算"一个文件"而侥幸躲过。
 * ⇒ 正确的等法是等**内容**（产物已提交、正文里有安装标记），而不是等目录或等文件名。
 * @param root - storages 目录。
 * @param timeoutMs - 上限；超时抛错并带上最后一次快照，便于定位。
 */
async function waitForStoragePayload(root, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const payload = await readStoragePayload(root).catch(() => '')
    if (INSTALL_MARKER.test(payload)) return payload
    if (Date.now() > deadline) {
      throw new Error(`等待超时：存储领域未写出首次安装标记（最后一次快照：${payload === '' ? '空' : JSON.stringify(payload.slice(0, 200))}）`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/**
 * 等一个异步副作用出现。
 *
 * 为什么需要它：存储领域是通过 `ctx.inject` 的 attach 回调**异步**打开的（`facility.open` 是 Promise），
 * 所以 `ctx.plugin()` 返回时领域可能还没落盘。测试必须等真实时序，而不是假设它已经完成——
 * 用固定 sleep 是不稳的，这里带超时地轮询，超时即失败并说明原因。
 */
async function waitFor(check, description, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) throw new Error(`等待超时：${description}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** 起一套真实服务并把 Humanity 挂上去。 */
async function boot(config) {
  const dir = await mkdtemp(path.join(tmpdir(), 'humanity-test-'))
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: path.join(dir, 'storages') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(SettingsFile, { path: path.join(dir, 'settings.yml') })
  await ctx.plugin(Humanity, config)
  return {
    ctx,
    dir,
    dispose: async () => {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

/** 取本插件的设置描述符。 */
function descriptorOf(ctx) {
  const settings = ctx.get('settings')
  const descriptor = settings.describe({ redactSecrets: true }).find((entry) => entry.ns === SETTINGS_NAMESPACE)
  assert.ok(descriptor, `设置服务里没有 ${SETTINGS_NAMESPACE} 命名空间`)
  return descriptor
}

test('真实服务下挂载成功，命名空间按 P-048 默认值解析', async () => {
  const { ctx, dispose } = await boot(Humanity.Config({}))
  try {
    assert.deepEqual(descriptorOf(ctx).value, EXPECTED_DEFAULTS)
  } finally {
    await dispose()
  }
})

test('整插件路径下，两个设置命名空间都注册进 describe()（开关 + 人格）', async () => {
  // 这条钉的是 C7 实测暴露的那类集成缺陷：单元测试里单独调 `installPersonaSection` 是绿的，
  // 但"经真实 apply() 走一遍"才是线上路径。两个命名空间缺任何一个，工作台就是不可用。
  const { ctx, dispose } = await boot(Humanity.Config({}))
  try {
    const namespaces = ctx
      .get('settings')
      .describe({ redactSecrets: true })
      .map((entry) => entry.ns)
    assert.ok(namespaces.includes(SETTINGS_NAMESPACE), `缺少 ${SETTINGS_NAMESPACE}：${namespaces.join(', ')}`)
    assert.ok(namespaces.includes(PERSONA_NAMESPACE), `缺少 ${PERSONA_NAMESPACE}：${namespaces.join(', ')}`)
  } finally {
    await dispose()
  }
})

test('组合配置作为 base 层：用户只覆盖自己写过的字段', async () => {
  const { ctx, dispose } = await boot(Humanity.Config({ enabled: true }))
  try {
    const settings = ctx.get('settings')
    await settings.update(SETTINGS_NAMESPACE, { modules: { memory: { mode: 'manual' } } })

    const descriptor = descriptorOf(ctx)
    assert.equal(descriptor.value.modules.memory.mode, 'manual')
    // 没被用户写过的字段仍然继承默认值 —— 这是"升级零迁移"的关键：老配置不需要补齐新字段。
    assert.equal(descriptor.value.modules.persona.enabled, true)
    assert.deepEqual(descriptor.user, { modules: { memory: { mode: 'manual' } } })

    // 写入必须穿过真实的文件提供方落到磁盘，而不只是改了内存。
    const document = await readFile(path.join(ctx.get('settings').documentPath), 'utf8')
    assert.match(document, /manual/)
  } finally {
    await dispose()
  }
})

test('总开关关闭后写入依然合法，不会把插件写成异常状态', async () => {
  const { ctx, dispose } = await boot(Humanity.Config({}))
  try {
    await ctx.get('settings').update(SETTINGS_NAMESPACE, { enabled: false })
    assert.equal(descriptorOf(ctx).value.enabled, false)
  } finally {
    await dispose()
  }
})

test('存储领域被真正打开并写下首次安装标记', async () => {
  const { ctx, dir, dispose } = await boot(Humanity.Config({}))
  try {
    assert.notEqual(ctx.get('storageDomain'), undefined)
    // 等**内容**而不是等目录：见 `waitForStoragePayload` 的说明（目录先于产物出现是常态）。
    const payload = await waitForStoragePayload(path.join(dir, 'storages'))
    assert.match(payload, INSTALL_MARKER)
  } finally {
    await dispose()
  }
})

test('回归钉（第一层）：原子写的临时产物不进存储快照 —— qa 定位的那条 ENOENT 竞态', async () => {
  // 确定性复现"readdir 拍到了临时文件"那一刻：手工造出两种官方临时名（此刻它们真的存在），
  // 断言快照既不会读到它们的内容、也不会因为它们而失败。
  const { dir, dispose } = await boot(Humanity.Config({}))
  try {
    const root = path.join(dir, 'storages')
    await waitForStoragePayload(root) // 先等真实产物落出来
    // `dsh-storage-json` 的形态（本障实测到的那个）与 `dsh-atomic-write` 的形态。
    await writeFile(path.join(root, '.00000000-0000-4000-8000-000000000000.tmp'), 'HALF-WRITTEN-A', 'utf8')
    await writeFile(path.join(root, 'humanity.json.deadbeef.tmp'), 'HALF-WRITTEN-B', 'utf8')

    const payload = await readStoragePayload(root)

    assert.doesNotMatch(payload, /HALF-WRITTEN/, '半截的临时文件内容绝不许进快照')
    assert.match(payload, INSTALL_MARKER, '真实产物照常读到（临时件不该让快照变空）')
  } finally {
    await dispose()
  }
})

test('回归钉（第二层）：列表里的名字在读取前已消失 ⇒ 跳过它，其余照读、不整条失败', async () => {
  // 直接喂一份"包含一个已经不存在的名字"的列表 = 竞态窗口的最终形态（ENOENT）。
  // 不依赖时序，因此这条用例是**确定**的。
  const root = await mkdtemp(path.join(tmpdir(), 'humanity-vanish-'))
  try {
    await writeFile(path.join(root, 'keep.json'), '{"installedAt":"2026-10-09T00:00:00.000Z"}', 'utf8')
    const payload = await readFilesBestEffort(root, ['keep.json', 'gone-before-read.json'])
    assert.match(payload, /"installedAt"/, '还在的那个产物必须照常读到')
    assert.doesNotMatch(payload, /gone-before-read/, '消失的名字不该出现在正文里')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('缺少设置与存储服务时仍然挂载成功，只降级不抛错（G-002）', async () => {
  const ctx = new Context()
  assert.equal(ctx.get('settings'), undefined)
  assert.equal(ctx.get('storageDomain'), undefined)

  // 关键断言：不抛。DSH 升级后某个 seam 消失时，插件必须自己关掉子功能，
  // 而不是把整个 DSH 带崩。
  await ctx.plugin(Humanity, Humanity.Config({}))

  assert.equal(ctx.get('settings'), undefined)
  await ctx.fiber.dispose()
})

test('设置服务在插件之后才挂载时，命名空间仍会被补注册（attach 生命周期）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'humanity-late-'))
  const ctx = new Context()
  try {
    // 先挂插件：此刻设置服务还不存在。旧实现（ctx.get 一次性探测）会在这里永远放弃注册。
    await ctx.plugin(Humanity, Humanity.Config({}))
    assert.equal(ctx.get('settings'), undefined)

    await ctx.plugin(SettingsFile, { path: path.join(dir, 'settings.yml') })

    // 服务出现后，ctx.inject 的回调应当补上命名空间注册。
    assert.deepEqual(descriptorOf(ctx).value, EXPECTED_DEFAULTS)
  } finally {
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('设置服务在插件之后挂载时，用户写入同样即时生效（不只在加载期接上的才算数）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'humanity-late-write-'))
  const ctx = new Context()
  try {
    await ctx.plugin(Humanity, Humanity.Config({}))
    await ctx.plugin(SettingsFile, { path: path.join(dir, 'settings.yml') })

    const settings = ctx.get('settings')
    await settings.update(SETTINGS_NAMESPACE, { modules: { dream: { enabled: false } } })

    const descriptor = descriptorOf(ctx)
    assert.equal(descriptor.value.modules.dream.enabled, false)
    assert.deepEqual(descriptor.user, { modules: { dream: { enabled: false } } })
  } finally {
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('DSH 0.1.7 的 settings（没有 installSection）⇒ 降级不抛，DSH 主体照常（G-002 / P7）', async () => {
  // 0.1.7 重构了 settings 服务：`installSection` 已被删除。旧代码直接调用会抛 TypeError，
  // 而抛在 `ctx.inject` 回调里会连带打挂插件组合 —— 那正是 G-002 禁止的"把 DSH 带崩"。
  const ctx = new Context()
  // 结构上像设置服务，但没有动态命名空间 API。
  ctx.provide('settings', {
    writable: true,
    documentPath: '/tmp/does-not-matter.yml',
    describe: () => [],
  })
  try {
    await ctx.plugin(Humanity, Humanity.Config({}))
    // 关键断言：挂载完成、没有抛；服务仍在（插件没被摘掉）。
    assert.notEqual(ctx.get('settings'), undefined)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('配置变更后策略视图自动重投影：切模式不必等命令消费或手动重载（round 48c 视频取证）', async () => {
  const { ctx, dispose } = await boot(Humanity.Config({}))
  try {
    const settings = ctx.get('settings')
    const policyOf = () => settings.get(MEMORY_NAMESPACE)?.policy
    await waitFor(async () => policyOf()?.mode === 'balanced', '记忆命名空间首次投影')

    await settings.update(SETTINGS_NAMESPACE, { modules: { memory: { mode: 'manual' } } })
    await waitFor(async () => policyOf()?.mode === 'manual', '配置变更后策略视图自动重投影')
  } finally {
    await dispose()
  }
})
