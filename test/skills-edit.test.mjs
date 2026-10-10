/**
 * 技能**编辑动作**的测试（`src/host/skills/edit-ops.ts`）：新建 / 修改 / 停用 / 恢复。
 *
 * 这是"工作台改用户技能文件"的唯一入口，所以钉的全是**不许发生的事**：
 * 同名被覆盖、用户手写的 frontmatter 字段被抹掉、改一个不存在的技能反而把它创建出来。
 * 假 `ctx.fs` 用真实临时目录，并按官方语义实现 `createIfAbsent` / `replaceIfVersion`
 * （目标存在 ⇒ `FS_NOT_OBSERVED`；版本对不上 ⇒ `FS_STALE_VERSION`）。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat as fsStat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { createSkill, setSkillDisabled, updateSkill, validateDraft } from '../lib/skills/edit-ops.js'
import { createSkillStore } from '../lib/skills/store.js'

const LOG = { info() {}, warn() {}, error() {}, debug() {} }

/** 官方错误码形状。 */
function fsError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

/** 按官方语义实现的假 `ctx.fs`（底层是真实文件；version 用内容长度代替）。 */
function fakeFs() {
  const versionOf = async (file) => (await readFile(file, 'utf8')).length
  return {
    resolve: async (target) => ({ displayPath: target }),
    stat: async ({ displayPath }) => {
      try {
        const info = await fsStat(displayPath)
        if (info.isDirectory()) return { type: 'directory' }
        return { type: 'file', version: await versionOf(displayPath) }
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
      }))
    },
    writeText: async ({ displayPath }, content, expected) => {
      await mkdir(path.dirname(displayPath), { recursive: true })
      const present = await fsStat(displayPath).then(
        () => true,
        () => false,
      )
      if (expected?.kind === 'createIfAbsent' && present) throw fsError('FS_NOT_OBSERVED')
      if (expected?.kind === 'replaceIfVersion') {
        if (!present) throw fsError('FS_STALE_VERSION')
        if (expected.version !== (await versionOf(displayPath))) throw fsError('FS_STALE_VERSION')
      }
      await writeFile(displayPath, content, 'utf8')
      return { operation: present ? 'update' : 'create' }
    },
  }
}

/** 造一个临时 DSH_HOME 与 store，用完删掉。 */
async function withStore(run) {
  const home = await mkdtemp(path.join(tmpdir(), 'humanity-skills-edit-'))
  try {
    await run(createSkillStore(() => fakeFs(), () => home, LOG), home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

/** 用户手写的一份技能（带官方增强字段 —— 编辑时**一个都不许丢**）。 */
const HANDWRITTEN = [
  '---',
  'name: "hand-made"',
  'description: "手写的技能"',
  'zh_name: "手写的"',
  'emoji: "🧪"',
  'user-invocable: true',
  '---',
  '',
  '原始正文',
  '',
].join('\n')

test('表单校验：名字必须是 kebab-case、说明与正文都不能空', () => {
  assert.equal(validateDraft({ name: 'ok-name', description: '说明', content: '正文' }), undefined)
  assert.match(validateDraft({ name: 'Bad Name', description: '说明', content: '正文' }), /kebab-case/)
  assert.match(validateDraft({ name: '../etc', description: '说明', content: '正文' }), /kebab-case/)
  assert.match(validateDraft({ name: 'ok', description: '  ', content: '正文' }), /说明不能为空/)
  assert.match(validateDraft({ name: 'ok', description: '说明', content: '\n' }), /正文不能为空/)
})

test('新建：写进官方目录；同名已存在时如实拒绝（绝不覆盖）', async () => {
  await withStore(async (store, home) => {
    const first = await createSkill(store, { name: 'my-skill', description: '我的技能', content: '# 步骤' })
    assert.match(first, /已新建技能/)

    const file = path.join(home, 'skills', 'my-skill', 'SKILL.md')
    assert.match(await readFile(file, 'utf8'), /name: "my-skill"/)

    const second = await createSkill(store, { name: 'my-skill', description: '改了说明', content: '# 别的' })
    assert.match(second, /已经存在/)
    assert.match(await readFile(file, 'utf8'), /我的技能/, '原文件必须一字未动')
  })
})

test('修改：改说明与正文，同时保住用户手写的其他 frontmatter 字段', async () => {
  await withStore(async (store, home) => {
    const file = path.join(home, 'skills', 'hand-made', 'SKILL.md')
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, HANDWRITTEN, 'utf8')

    const notice = await updateSkill(store, { name: 'hand-made', description: '新说明', content: '新正文' })
    assert.match(notice, /已更新/)

    const text = await readFile(file, 'utf8')
    assert.match(text, /description: "新说明"/)
    assert.match(text, /新正文/)
    assert.match(text, /zh_name: "手写的"/, '用户手写的增强字段不许丢')
    assert.match(text, /emoji: "🧪"/)
    assert.match(text, /user-invocable: true/)
    assert.equal(text.includes('原始正文'), false, '正文被替换')
  })
})

test('修改：技能不存在时不"顺手创建"（编辑不该变成复活）', async () => {
  await withStore(async (store) => {
    const notice = await updateSkill(store, { name: 'never-existed', description: '说明', content: '正文' })
    assert.match(notice, /找不到技能/)
    assert.equal(await store.readRaw('never-existed'), undefined)
  })
})

test('停用 / 恢复：写官方标记，且保住其他字段；恢复后标记消失', async () => {
  await withStore(async (store, home) => {
    const file = path.join(home, 'skills', 'hand-made', 'SKILL.md')
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, HANDWRITTEN, 'utf8')

    assert.match(await setSkillDisabled(store, 'hand-made', true), /已停用/)
    let text = await readFile(file, 'utf8')
    assert.match(text, /disable-model-invocation: true/)
    assert.match(text, /emoji: "🧪"/, '停用只该动那一行')
    assert.equal((await store.list())[0].disabled, true, '列表要能读到停用状态')

    assert.match(await setSkillDisabled(store, 'hand-made', false), /已恢复/)
    text = await readFile(file, 'utf8')
    assert.equal(text.includes('disable-model-invocation'), false)
    assert.equal((await store.list())[0].disabled, false)
  })
})

test('停用：技能不存在时如实说找不到（不新建、不抛）', async () => {
  await withStore(async (store) => {
    assert.match(await setSkillDisabled(store, 'ghost', true), /找不到技能/)
    assert.match(await setSkillDisabled(store, '../etc', true), /不合法/)
  })
})
