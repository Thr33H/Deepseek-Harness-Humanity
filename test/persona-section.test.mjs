/**
 * 人格命名空间接线的测试（真实设置服务）。
 *
 * 为什么必须用真实的 `dsh-settings-file`：这条接线的关键行为全在设置服务的语义里——
 * `installSection` 的 base 层、`validate` 钩子在**浏览器直接写入**时是否真的拦得住、
 * `replace` 是不是整体替换。假设置服务会把这些全部替换掉，测不到任何东西。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SettingsFile from '@deepseek-ai/dsh-settings-file'
import { createLog } from '../lib/log.js'
import { createDefaultPersona } from '../lib/persona/model.js'
import { validatePersona } from '../lib/persona/validate.js'
import { installPersonaSection, PERSONA_NAMESPACE, PersonaWriteRejected } from '../lib/persona/section.js'

/** 起一个真实设置服务，并挂上人格命名空间。 */
async function boot() {
  const dir = await mkdtemp(path.join(tmpdir(), 'humanity-persona-'))
  const ctx = new Context()
  await ctx.plugin(SettingsFile, { path: path.join(dir, 'settings.yml') })

  /** 历史接收方替身：只记录收到的条目，避开存储依赖。 */
  const history = []
  const persona = installPersonaSection(ctx, createLog(ctx, 'test'), () => (entry) => history.push(entry))

  return {
    ctx,
    persona,
    history,
    dispose: async () => {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

/** 填一份"用户已经写过"的文档。 */
function filled() {
  const doc = createDefaultPersona()
  doc.identityCard.fields[0].value = '小安'
  doc.identityCard.fields[1].value = '女'
  doc.identityCard.fields[2].value = '温和、直接'
  doc.identityCard.initializedAt = '2026-09-23T00:00:00.000Z'
  doc.identityCard.sealedAt = '2026-09-23T00:00:00.000Z'
  doc.mutableLayer.sections[0].items = ['主人']
  doc.mutableLayer.sections[1].items = ['先给结论，再给依据']
  return doc
}

const descriptorOf = (ctx) =>
  ctx.get('settings').describe({ redactSecrets: true }).find((entry) => entry.ns === PERSONA_NAMESPACE)

test('命名空间被注册，未写入时按默认（未初始化）人格解析', async () => {
  const harness = await boot()
  try {
    const descriptor = descriptorOf(harness.ctx)
    assert.ok(descriptor, 'humanity-persona 命名空间没有注册')
    assert.equal(descriptor.value.identityCard.initializedAt, '')
    assert.equal(descriptor.value.mutableLayer.sections.length, 4, '0.1.14：新装只预置 4 个原生小节')
    assert.equal(harness.persona.attached, true)
  } finally {
    await harness.dispose()
  }
})

test('写入完整快照后能读回（replace 语义，不是深合并）', async () => {
  const harness = await boot()
  try {
    await harness.persona.write(filled(), 'user')

    const read = harness.persona.read()
    assert.equal(read.identityCard.fields[0].value, '小安')
    assert.deepEqual(read.mutableLayer.sections[1].items, ['先给结论，再给依据'])
  } finally {
    await harness.dispose()
  }
})

test('⭐ 旧数据缺核心字段（如新增的「主语言」）不会让命名空间注册失败 —— 规范化自动补齐', async () => {
  // 2026-09-23 真机事故回归：往 CORE_IDENTITY_KEYS 里加字段后，已有数据在 schema 下"缺核心字段"，
  // 而设置命名空间的 validate 钩子在**注册时**就会跑一次 ⇒ identity.core-missing 一抛，
  // **整个命名空间注册失败**，客户端永远连不上（用户什么都没做，插件看起来"把人格面板弄坏了"）。
  const dir = await mkdtemp(path.join(tmpdir(), 'humanity-legacy-'))
  const ctx = new Context()
  try {
    // 造一份与真机同形的旧数据：三字段身份卡 + 旧小节名「当前状态」，**直接写进设置文件** ——
    // 这样它就是在"注册那一刻"被校验的那一份（复现真实事故的时序）。
    const legacy = filled()
    legacy.identityCard.fields = legacy.identityCard.fields.filter((field) => field.key !== '主语言')
    // 0.1.14：默认文档里已经没有「情绪」这一节了 ⇒ 旧数据就是**文档里直接有一节叫「当前状态」**，
    // 规范化那一步照样要把它改名成「情绪」并把内容带过来（迁移规则与"它是不是原生项"无关）。
    legacy.mutableLayer.sections.push({ title: '当前状态', items: ['待命中'] })
    const settingsPath = path.join(dir, 'settings.yml')
    // JSON 是 YAML 的子集：直接写 JSON 就能被设置文件读成一份合法文档（顶层键 = 命名空间）。
    await writeFile(settingsPath, JSON.stringify({ [PERSONA_NAMESPACE]: legacy }))

    await ctx.plugin(SettingsFile, { path: settingsPath })
    const persona = installPersonaSection(ctx, createLog(ctx, 'test'), () => undefined)
    // `ctx.inject` 的回调在依赖就位后的微任务里跑：等一拍再断言接上了。
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.equal(persona.attached, true, '命名空间必须注册成功（事故里抛出的就是这一步）')
    const read = persona.read()
    assert.deepEqual(
      read.identityCard.fields.map((field) => field.key),
      ['姓名', '性别', '人格偏好', '主语言'],
      '缺的核心字段被补成空值，顺序仍是核心字段优先',
    )
    assert.equal(read.identityCard.fields[3].value, '')
    assert.equal(read.identityCard.fields[3].custom, false)
    // 旧标题同一次规范化里被迁移，老数据不需要用户做任何事。
    assert.equal(read.mutableLayer.sections.some((section) => section.title === '情绪'), true)
    // 补齐之后照常可写（不再有任何"注册失败"的连锁反应）。
    await persona.write(filled(), 'user')
    assert.equal(persona.read().identityCard.fields[0].value, '小安')
  } finally {
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('核心字段缺失规则本身仍在：不经规范化的调用方仍会被 core-missing 拒绝', () => {
  // 分层是有意的：`normalizePersona` 负责把"旧数据 / 手工改坏的文档"补成合法形状，
  // `validatePersona` 负责判定"这份文档能不能落盘"。补字段是**迁移**，不是校验放水。
  const broken = filled()
  broken.identityCard.fields = broken.identityCard.fields.filter((field) => field.key !== '性别')

  const validation = validatePersona(broken, filled(), 'user')
  assert.equal(validation.ok, false)
  assert.deepEqual(
    validation.issues.filter((issue) => issue.severity === 'rejected').map((issue) => issue.code),
    ['identity.core-missing'],
  )
})

test('Agent 改固定层被拒，且拒绝是结构化的（P-011）', async () => {
  const harness = await boot()
  try {
    await harness.persona.write(filled(), 'user')

    const changed = filled()
    changed.identityCard.fields[2].value = 'Agent 自己想改的'

    await assert.rejects(harness.persona.write(changed, 'agent'), (error) => {
      assert.ok(error instanceof PersonaWriteRejected)
      assert.equal(error.issues[0].code, 'identity.sealed')
      assert.equal(error.issues[0].severity, 'rejected')
      return true
    })

    // 被拒之后生效文档不能被动过。
    assert.equal(harness.persona.read().identityCard.fields[2].value, '温和、直接')
  } finally {
    await harness.dispose()
  }
})

test('被取代的旧内容会进历史，且历史里没有"当前仍然有效"的值', async () => {
  const harness = await boot()
  try {
    await harness.persona.write(filled(), 'user')
    harness.history.length = 0

    const next = filled()
    next.identityCard.fields[0].value = '清'
    next.mutableLayer.sections[1].items = ['先结论']

    await harness.persona.write(next, 'user')

    assert.deepEqual(
      harness.history.map((entry) => [entry.path, entry.previous, entry.source]).sort(),
      [
        ['identityCard.fields.姓名', '小安', 'user'],
        ['mutableLayer.sections.说话风格', '先给结论，再给依据', 'user'],
      ],
    )
    // 没变的东西不该被记成历史。
    assert.equal(harness.history.some((entry) => entry.previous === '主人'), false)
  } finally {
    await harness.dispose()
  }
})

test('规范化在写入前生效：空白被去掉、空项被丢弃', async () => {
  const harness = await boot()
  try {
    const doc = filled()
    doc.mutableLayer.sections[2].items = ['   ', '  交付要短  ']

    await harness.persona.write(doc, 'user')

    assert.deepEqual(harness.persona.read().mutableLayer.sections[2].items, ['交付要短'])
  } finally {
    await harness.dispose()
  }
})
