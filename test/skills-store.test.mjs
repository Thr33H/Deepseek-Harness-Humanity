/**
 * 技能落盘的单元测试（`src/host/skills/`）。
 *
 * 这是插件里**唯一写文件系统**的地方，所以钉的重点全在"不许写坏"：
 * 技能名不能变成路径、已有文件不许覆盖、服务缺席要如实降级。
 *
 * 测试里的假 `ctx.fs` **用真实文件**（临时目录），并按官方 `dsh-fs-local` 的语义实现
 * `createIfAbsent`（命中已有文件 ⇒ 抛 `code: 'FS_NOT_OBSERVED'`）——这样测的是我们与官方
 * 的**契约**，而不是一个自己编的宽松替身。
 *
 * 格式部分对着本机安装的官方技能（`$DSH_HOME/skills/` 下的 `card-xiaohongshu` 等）同构：
 * frontmatter 只写 `name` + `description`，值一律带引号（描述里出现 `: `、`#`、引号时裸写会破坏 YAML）。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat as fsStat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { isSkillName, resolveDshHome, skillDir } from '../lib/skills/paths.js'
import { parseSkillFile, renderSkillFile } from '../lib/skills/render.js'
import { createSkillStore } from '../lib/skills/store.js'

/** TEST 生产库那 5 个技能里的一个（真机原句，含中文引号与冒号）。 */
const SKILL = {
  name: 'roleplay-memory-verify',
  description: '在角色扮演会话中回答剧情事实前先检索记忆库，并区分「落库回忆」与「临场推导」',
  content: '# 适用场景\n\n角色扮演会话里被问及剧情事实时。\n\n# 步骤\n\n1. 先调 humanity_recall；\n2. 区分"落库回忆"与"临场推导"。',
}

/** 只记日志的假门面（store 只用到 warn）。 */
const LOG = { info() {}, warn() {}, error() {}, debug() {} }

/** 造一个按官方语义实现的假 `ctx.fs`（底层是真实文件）。 */
function fakeFs() {
  return {
    // 与官方同构：resolve 是 async —— 漏 await 会被这里的 stat/readText 直接测出来
    resolve: async (target) => ({ displayPath: target }),
    stat: async ({ displayPath }) => {
      try {
        const info = await fsStat(displayPath)
        return { type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other' }
      } catch {
        return undefined
      }
    },
    readText: ({ displayPath }) => readFile(displayPath, 'utf8'),
    listDir: async ({ displayPath }) => {
      const entries = await readdir(displayPath, { withFileTypes: true })
      return entries.map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
        target: { displayPath: path.join(displayPath, entry.name) },
      }))
    },
    writeText: async ({ displayPath }, content, expected) => {
      await mkdir(path.dirname(displayPath), { recursive: true })
      if (expected?.kind === 'createIfAbsent') {
        const present = await fsStat(displayPath).then(
          () => true,
          () => false,
        )
        if (present) {
          const error = new Error(`cannot overwrite existing "${displayPath}"`)
          error.code = 'FS_NOT_OBSERVED'
          throw error
        }
      }
      await writeFile(displayPath, content, 'utf8')
      return { operation: 'create' }
    },
  }
}

/** 造一个临时 DSH_HOME 与 store，用完删掉。 */
async function withStore(run) {
  const home = await mkdtemp(path.join(tmpdir(), 'humanity-skills-'))
  try {
    await run(createSkillStore(() => fakeFs(), () => home, LOG), home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

test('技能名文法：kebab-case 之外一律拒（路径穿越在这里被拦住）', () => {
  assert.equal(isSkillName('roleplay-memory-verify'), true)
  assert.equal(isSkillName('a1-b2'), true)
  for (const bad of ['A-b', 'a_b', 'a--b', '../etc', 'a/b', '', '-a', 'a ']) {
    assert.equal(isSkillName(bad), false, `「${bad}」不该通过`)
  }
  assert.throws(() => skillDir('/tmp/x', '../../etc'), /kebab-case/)
})

test('DSH_HOME：显式值优先，环境变量次之，空值一律当"没有"（不猜路径）', () => {
  assert.equal(resolveDshHome('/home/user/dsh-home'), '/home/user/dsh-home')
  assert.equal(resolveDshHome('   '), undefined)

  const before = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = '/from-env'
    assert.equal(resolveDshHome(), '/from-env', '运行时确实从环境变量取路径')
    process.env.DSH_HOME = '  '
    assert.equal(resolveDshHome(), undefined)
  } finally {
    if (before === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = before
  }
})

test('渲染与解析往返：描述里的冒号、井号、引号都不破坏 frontmatter', () => {
  const tricky = { ...SKILL, description: '处理 a: b 与 #tag，还有"引号"和\n换行' }
  assert.deepEqual(parseSkillFile(renderSkillFile(tricky)), tricky)
})

test('解析：官方形状（双引号值 + 额外字段）能读；缺 name 或 description 一律判不合法', () => {
  const official = '---\nname: "card-xiaohongshu"\ndescription: "样式卡片"\nemoji: "📱"\n---\n\n正文\n'
  assert.deepEqual(parseSkillFile(official), { name: 'card-xiaohongshu', description: '样式卡片', content: '正文' })
  assert.equal(parseSkillFile('---\nname: "x"\n---\n正文'), undefined, '缺 description ⇒ 与官方一样忽略')
  assert.equal(parseSkillFile('# 没有 frontmatter'), undefined)
})

test('落盘：写成官方目录包格式（目录自动创建），内容可被解析回来', async () => {
  await withStore(async (store, home) => {
    assert.equal(await store.write(SKILL), 'written')

    const file = path.join(home, 'skills', SKILL.name, 'SKILL.md')
    assert.deepEqual(parseSkillFile(await readFile(file, 'utf8')), SKILL)
    assert.deepEqual(await store.read(SKILL.name), SKILL)
    assert.deepEqual(await readdir(path.join(home, 'skills', SKILL.name)), ['SKILL.md'], '不留临时文件')
  })
})

test('绝不覆盖：同名技能已存在时原样不动（官方 createIfAbsent 语义）', async () => {
  await withStore(async (store) => {
    await store.write(SKILL)
    assert.equal(await store.write({ ...SKILL, content: '后来者想改写' }), 'exists')
    assert.equal((await store.read(SKILL.name)).content, SKILL.content, '原文件必须一字未动')
  })
})

test('列表：认目录包与扁平 md，跳过隐藏项与坏格式文件', async () => {
  await withStore(async (store, home) => {
    await store.write(SKILL)
    const root = path.join(home, 'skills')
    await writeFile(path.join(root, 'flat-skill.md'), '---\nname: "flat-skill"\ndescription: "扁平技能"\n---\n正文\n')
    await writeFile(path.join(root, 'broken.md'), '没有 frontmatter 的文件\n')
    await mkdir(path.join(root, 'no-skill-file'))
    await mkdir(path.join(root, '.hidden'))
    await writeFile(path.join(root, '.hidden', 'SKILL.md'), '---\nname: "hidden"\ndescription: "藏起来的"\n---\n')

    assert.deepEqual(
      (await store.list()).map((entry) => entry.name),
      ['flat-skill', SKILL.name],
    )
  })
})

test('列表与读取：目录不存在时是空清单，非法名读取返回 undefined（不抛）', async () => {
  await withStore(async (store) => {
    assert.deepEqual(await store.list(), [], '还没落过盘 ⇒ 空清单，不是错误')
    assert.equal(await store.read('never-written'), undefined)
    assert.equal(await store.read('../../etc/passwd'), undefined, '非法名不许拼进路径')
  })
})

test('服务缺席时如实降级：不算可用、列表空、读取 undefined、落盘明确报不可用', async () => {
  const noFs = createSkillStore(() => undefined, () => '/home/user/dsh-home', LOG)
  assert.equal(noFs.available(), false)
  assert.deepEqual(await noFs.list(), [])
  assert.equal(await noFs.read(SKILL.name), undefined)
  await assert.rejects(() => noFs.write(SKILL), /不可用/)

  const noHome = createSkillStore(() => fakeFs(), () => undefined, LOG)
  assert.equal(noHome.available(), false)
  await assert.rejects(() => noHome.write(SKILL), /不可用/)
})

test('清单状态：提案正文只是尾部空白不同，不该误报「文件已改动」', async () => {
  const { skillInventory } = await import('../lib/skills/inventory.js')
  await withStore(async (store, home) => {
    // 提案 payload 的正文带尾随换行（模型产出常见），落盘会被 trimEnd
    const skill = { name: 'tail-blank', description: '尾部空白', content: '正文\n\n' }
    await store.write(skill)
    const proposal = {
      id: 'p1',
      kind: 'skill',
      status: 'applied',
      title: '新技能：tail-blank',
      reason: '',
      payload: JSON.stringify(skill),
      diff: '',
      createdAt: '',
      decidedAt: '2026-09-26T00:00:00.000Z',
      sourceRunId: '',
      sourceSessionIds: [],
    }
    const [view] = await skillInventory([proposal], store)
    assert.equal(view.status, 'on-disk', '只差尾部空白 ⇒ 仍算已落盘（2026-09-26 真机假警告）')
    assert.deepEqual(view.pluginDeps, [], '没用到插件能力 ⇒ 不报警告')
  })
})

test('只在提案里的技能：注册表里查得到才算「还没存成文件」，查不到就是「现在没生效」', async () => {
  // 2026-09-26 审计 E4：旧实现只凭"有提案、文件不在"就写下 `runtime-only`，
  // 于是**注册失败**的技能也会显示成"还没存成文件：现在只靠插件每次启动时重新注册"——
  // 读起来像"它是活的，只是没落盘"。真相要拿注册表的实际清单核对。
  const { skillInventory } = await import('../lib/skills/inventory.js')
  await withStore(async (store) => {
    const proposal = {
      id: 'p1',
      kind: 'skill',
      status: 'applied',
      title: '新技能：ghost',
      reason: '',
      payload: JSON.stringify({ name: 'ghost', description: '还没落盘', content: '正文' }),
      diff: '',
      createdAt: '',
      decidedAt: '',
      sourceRunId: '',
      sourceSessionIds: [],
    }

    const [unverified] = await skillInventory([proposal], store)
    assert.equal(unverified.status, 'runtime-only', '注册表读不到（服务缺席/列举失败）⇒ 不敢乱判"没生效"')

    const [registered] = await skillInventory([proposal], store, ['ghost'])
    assert.equal(registered.status, 'runtime-only', '注册表里确实有它 ⇒ 只是没落盘')

    const [missing] = await skillInventory([proposal], store, ['别的技能'])
    assert.equal(missing.status, 'unregistered', '既不在磁盘、也不在注册表 ⇒ 这条技能现在用不了')
    assert.equal(missing.file, '', '没有文件路径可显示')
  })
})

test('技能依赖检测：正文用了哪个插件的能力就警告哪个（宁少勿错，没核实过的不列）', async () => {
  const { skillInventory } = await import('../lib/skills/inventory.js')
  await withStore(async (store) => {
    const make = (name, content) => ({
      id: name,
      kind: 'skill',
      status: 'applied',
      title: `新技能：${name}`,
      reason: '',
      payload: JSON.stringify({ name, description: '说明', content }),
      diff: '',
      createdAt: '',
      decidedAt: '',
      sourceRunId: '',
      sourceSessionIds: [],
    })
    const proposals = [
      make('uses-humanity', '先调用 humanity_recall 查一下记忆。'),
      make('uses-im', '用 dsh_im_reply_to 回消息。'),
      make('uses-both', '先 humanity_recall，再用 dsh_im_source 标注来源。'),
      make('plain', '纯文件操作，不依赖任何插件。'),
    ]
    for (const proposal of proposals) await store.write(JSON.parse(proposal.payload))

    const views = await skillInventory(proposals, store)
    const byName = Object.fromEntries(views.map((view) => [view.name, view.pluginDeps]))
    assert.deepEqual(byName['uses-humanity'], ['Humanity'])
    assert.deepEqual(byName['uses-im'], ['dsh-im'])
    assert.deepEqual(byName['uses-both'], ['Humanity', 'dsh-im'], '多个依赖要都列出来（卸载任一都会失效）')
    assert.deepEqual(byName['plain'], [], '没用到插件能力 ⇒ 不报警告')
  })
})
