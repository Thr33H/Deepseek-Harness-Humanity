/**
 * 0.1.12 · A：技能落盘工具 `humanity_skill_persist`（V3 代码路径 + **V4 阴性对照**）。
 *
 * ### 这里要证的命题
 * 1. **按调用会话的权限落盘**：工具从 `exec.agent.session` 解析 per-call 沙箱策略，
 *    并把 `exec.signal` + 策略**一起**交给官方 `ctx.fs.writeText`（第 4/5 个参数）——
 *    这正是 0.1.12 之前缺的那两个参数（缺了就只能回落部署默认模式 ⇒ 技能目录被拒）；
 * 2. **不越权**（V4，防"修一个洞开一个洞"）：
 *    - 工具**只收名字、不收路径**（参数表里没有 path/内容字段）；
 *    - 非 kebab-case 的名字（`..`、`/`、绝对路径、大写）**一次文件系统调用都不发**；
 *    - 合法名字必然落在 `<DSH_HOME>/skills/<name>/SKILL.md`（由 `paths.ts` 唯一构造）；
 *    - 正文只从"已批准提案"取，调用方**不能**自带内容；
 *    - 围栏仍在：会话策略是 `workspace-write` 时被官方后端拒绝，工具如实回报而不是绕路。
 *
 * 用**真实** `dsh-tools` 管线 + 真实 `createSkillStore`，只把 `ctx.fs` 换成记账替身 ——
 * 要断言的是"传给官方后端的参数"与"注册进模型可见集合"，替身 fs 正是这两件事的观察点。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createLog } from '../lib/log.js'
import { SKILL_PERSIST_TOOL } from '../lib/evolution/tools-skill-persist.js'
import { installSkillPersistTool } from '../lib/evolution/tools-skill-persist.js'
import { createSkillStore } from '../lib/skills/store.js'

const HOME = '/fake/dsh-home'
const log = createLog(new Context(), 'test')

/** 一次"已批准待落盘"的技能（提案 payload 的窄化形状）。 */
const APPLIED = [
  { name: 'demo-skill', description: '演示用技能', content: '# 演示\n\n做一件事。' },
  { name: 'other-skill', description: '另一条', content: '正文' },
  { name: 'a', description: '单段名', content: '正文' },
  { name: 'a1-b2-c3', description: '多段名', content: '正文' },
]

/** 调用工具时携带的 agent 替身（会话身份与 cwd 都从这里读——与 memory-tool.test.mjs 同款）。 */
const AGENT = { id: 'session-42', session: { id: 'session-42', header: { cwd: '/work/shop' } } }

/**
 * 记账替身 fs：**记录每次调用的完整实参**（含第 4/5 个），并可按需抛沙箱拒绝。
 * `resolve` 只做纯字符串拼接（真实后端会 realpath，但那不影响本用例要证的参数传递）。
 */
function fakeFs(options = {}) {
  const calls = { resolve: [], stat: [], readText: [], listDir: [], writeText: [] }
  return {
    calls,
    async resolve(path) {
      calls.resolve.push(path)
      return { displayPath: path, targetKey: path }
    },
    async stat() {
      return undefined
    },
    async readText() {
      return ''
    },
    async listDir() {
      return []
    },
    async writeText(target, content, expected, signal, sandboxPolicy) {
      calls.writeText.push({ target, content, expected, signal, sandboxPolicy })
      if (options.deny === true) {
        const error = new Error(`cannot write "${target.displayPath}": file access denied under workspace-write mode`)
        error.code = 'FS_SANDBOX_DENIED'
        throw error
      }
      return { version: 'v1' }
    },
  }
}

/**
 * 起一套真实宿主：工具管线 + 技能落盘工具 + 记账 fs。
 * @param options.deny - fs 替身是否抛沙箱拒绝。
 * @param options.policy - 会话策略解析结果（undefined = 沙箱服务缺席）。
 * @param options.sandboxMode - 后端的围栏事实。
 * @param options.pending - 待落盘清单（默认 {@link APPLIED}）。
 * @param options.noFs - 模拟 `ctx.fs` 缺席。
 */
async function boot(options = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  const fs = fakeFs({ deny: options.deny === true })
  const seenSessions = []
  const store = createSkillStore(
    () => (options.noFs === true ? undefined : fs),
    () => HOME,
    log,
  )
  const handle = installSkillPersistTool(ctx, log, {
    store: () => store,
    pending: () => options.pending ?? APPLIED,
    sandbox: () => ({
      mode: options.sandboxMode ?? 'workspace-write',
      policyFor: (session) => {
        seenSessions.push(session)
        return 'policy' in options ? options.policy : { mode: 'danger-full-access', workspaceRoot: '/', sessionId: 'session-42' }
      },
    }),
  })
  await settle(ctx)
  return {
    ctx,
    fs,
    seenSessions,
    handle,
    call: (args, withAgent = true) =>
      ctx.tools.execute({
        callId: 'call-persist',
        name: SKILL_PERSIST_TOOL,
        arguments: args,
        signal: new AbortController().signal,
        ...(withAgent ? { agent: AGENT } : {}),
      }),
    textOf: (result) => result.content.map((block) => block.text ?? '').join('\n'),
    dispose: () => ctx.fiber.dispose(),
  }
}

/** 等工具真的注册进模型可见集合（defineTool 走动态 import，注册是异步落地的）。 */
async function settle(ctx) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (ctx.tools.schemas().some((schema) => schema.name === SKILL_PERSIST_TOOL)) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('技能落盘工具没有在预期时间内注册')
}

test('V3 代码路径：用**调用会话**解析出的策略写盘，写入参数（含 signal 与策略）逐项可核', async () => {
  const harness = await boot()
  try {
    const result = await harness.call({ name: 'demo-skill' })
    const text = harness.textOf(result)

    assert.equal(result.isError ?? false, false, '成功路径不该是错误结果')
    assert.match(text, /已落盘/)
    assert.equal(harness.fs.calls.writeText.length, 1, '只该发生一次写入')

    const call = harness.fs.calls.writeText[0]
    assert.equal(call.target.displayPath, `${HOME}/skills/demo-skill/SKILL.md`, '目标只能是技能根目录下的 SKILL.md')
    // `renderSkillFile` 会把标量加双引号（YAML 安全写法），逐字对齐它的真实输出。
    assert.match(call.content, /^---\nname: "demo-skill"\ndescription: "演示用技能"\n---/, '写的是官方目录包格式（renderSkillFile）')
    assert.match(call.content, /做一件事。/, '正文来自已批准提案，逐字带上')
    assert.deepEqual(call.expected, { kind: 'createIfAbsent' }, '仍是排他新建（绝不覆盖已有技能）')
    assert.ok(call.signal instanceof AbortSignal, '第 4 个参数必须是调用方的取消信号')
    assert.deepEqual(
      call.sandboxPolicy,
      { mode: 'danger-full-access', workspaceRoot: '/', sessionId: 'session-42' },
      '第 5 个参数必须是**按调用会话**解析出的 per-call 策略（0.1.12 之前这里是 undefined ⇒ 被拒）',
    )
    // 会话对象本身（不是只拿 id）被交给策略解析器：官方写的就是 `exec.agent.session`。
    assert.equal(harness.seenSessions.length, 1)
    assert.equal(harness.seenSessions[0], AGENT.session, '交给策略解析器的必须是 exec.agent.session 本体')
  } finally {
    await harness.dispose()
  }
})

test('V4-1 非 kebab-case 名一律拒：一次文件系统调用都不发（路径穿越在名字闸就被拦下）', async () => {
  const harness = await boot()
  try {
    const illegal = ['../evil', 'a/b', '/abs/path', 'A-B', '..', 'x/../../y', '带空格 名', 'trailing-']
    for (const name of illegal) {
      const result = await harness.call({ name })
      assert.match(harness.textOf(result), /不是合法 kebab-case/, `「${name}」必须被名字闸拒绝`)
    }
    assert.equal(harness.fs.calls.resolve.length, 0, '非法名不该触发任何路径解析')
    assert.equal(harness.fs.calls.stat.length, 0, '非法名不该读盘')
    assert.equal(harness.fs.calls.writeText.length, 0, '非法名一次写盘都不许发生')
  } finally {
    await harness.dispose()
  }
})

test('V4-2 工具的参数表里**没有路径/内容字段**：只有 name（结构上无法指定写到哪、写什么）', async () => {
  const harness = await boot()
  try {
    const schema = harness.ctx.tools.schemas().find((entry) => entry.name === SKILL_PERSIST_TOOL)
    assert.ok(schema !== undefined, '工具必须注册进模型可见集合')
    const properties = Object.keys(schema.parameters?.properties ?? {})
    assert.deepEqual(properties, ['name'], '只允许一个参数：技能名')
    assert.equal(schema.parameters.required?.includes('name') ?? false, true, 'name 必填')
  } finally {
    await harness.dispose()
  }
})

test('V4-3 合法名字必然落在技能根目录下（目标路径由 skillFile 唯一构造）', async () => {
  const harness = await boot()
  try {
    for (const name of ['demo-skill', 'a', 'a1-b2-c3']) {
      await harness.call({ name })
    }
    const paths = harness.fs.calls.writeText.map((call) => call.target.displayPath)
    assert.equal(paths.length, 3, '三次合法调用各写一次')
    for (const path of paths) {
      assert.ok(path.startsWith(`${HOME}/skills/`), `路径必须在技能根目录下：${path}`)
      assert.ok(path.endsWith('/SKILL.md'), `必须是目录包格式：${path}`)
    }
  } finally {
    await harness.dispose()
  }
})

test('内容闸：正文只从"已批准提案"取 —— 没批准过的名字不许写（模型不能借本工具写任意内容）', async () => {
  const harness = await boot()
  try {
    const result = await harness.call({ name: 'not-applied-skill' })
    assert.match(harness.textOf(result), /没有找到已批准/, '未批准的名字必须被拒')
    assert.equal(harness.fs.calls.writeText.length, 0, '未批准 ⇒ 不写盘')
  } finally {
    await harness.dispose()
  }
})

test('围栏仍在（V4）：会话策略解析不出来时拒绝写盘（与官方工具同一条判断），不做任何降级绕过', async () => {
  // 官方先例：`dsh-tool-str-replace-editor` 在 `sandboxMode !== undefined && policy === undefined` 时直接抛。
  const harness = await boot({ sandboxMode: 'workspace-write', policy: undefined })
  try {
    const result = await harness.call({ name: 'demo-skill' })
    assert.match(harness.textOf(result), /读不到沙箱策略服务/, '要如实说明为什么没写')
    assert.equal(harness.fs.calls.writeText.length, 0, '缺策略 ⇒ 不写盘（不回落成"无策略的裸写"）')
  } finally {
    await harness.dispose()
  }
})

test('后端真拒绝时如实回报（不抛、不重试、不绕路）', async () => {
  const harness = await boot({ deny: true })
  try {
    const result = await harness.call({ name: 'demo-skill' })
    const text = harness.textOf(result)
    assert.match(text, /被沙箱拒绝/)
    assert.match(text, /不要重试或绕路/, '要把"这是权限问题、不是缺陷"说清楚')
    assert.equal(result.isError ?? false, false, '沙箱拒绝是结构化结果，不是工具崩溃')
  } finally {
    await harness.dispose()
  }
})

test('ctx.fs 缺席：如实说不可用，不猜路径、不抛', async () => {
  const harness = await boot({ noFs: true })
  try {
    const result = await harness.call({ name: 'demo-skill' })
    assert.match(harness.textOf(result), /不可用/)
    assert.equal(harness.fs.calls.writeText.length, 0)
  } finally {
    await harness.dispose()
  }
})
