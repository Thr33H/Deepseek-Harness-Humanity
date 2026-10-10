/**
 * 记忆数据模型的默认值、指纹与策略解析回归测试。
 *
 * 与 `persona-model.test.mjs` 同一思路：把默认值**逐字段钉死**（G-004 默认值不漂移）。
 * 记忆的默认值漂了比开关漂了更隐蔽 —— 它不会报错，只会让"待确认"变成"直接注入"，
 * 或者让自动注入悄悄超出 P-028 的 0–3 条上限。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CONTENT_CHAR_LIMIT,
  DEFAULT_IMPORTANCE,
  MAX_INJECT_LIMIT,
  MEMORY_ENTRY_VERSION,
  MEMORY_TABLE,
} from '../lib/memory/constants.js'
import { buildDedupeKey, createMemoryEntry, MemoryEntrySchema } from '../lib/memory/model.js'
import { canRemember, isDegenerateAdvanced, overridesOf, resolveMemoryPolicy } from '../lib/memory/policy.js'

/** 一份最小合法输入（省略全部可默认字段）。 */
const minimal = {
  scope: 'long-term',
  content: '  用户偏好简短回复  ',
  origin: 'agent-derived',
  sourceSessionId: 'session-1',
}

test('表的命名符合存储领域的名字校验（写错会在声明期抛，症状像"环境有问题"）', () => {
  assert.match(MEMORY_TABLE, /^[a-z][a-z0-9_]*$/)
})

test('新建条目补齐默认值：待确认、自动写入的低置信度、未使用过', () => {
  const entry = createMemoryEntry(minimal)

  assert.equal(entry.status, 'pending', '自动写入默认必须落在待确认（P-025）')
  assert.equal(entry.origin, 'agent-derived')
  assert.equal(entry.importance, DEFAULT_IMPORTANCE)
  assert.ok(entry.confidence > 0 && entry.confidence < 1, '自动写入的置信度必须小于 1')
  assert.equal(entry.sensitive, false, '敏感默认不写（P-033）')
  assert.equal(entry.pinned, false)
  assert.equal(entry.useCount, 0)
  assert.equal(entry.lastUsedAt, '')
  assert.equal(entry.archivedAt, '')
  assert.equal(entry.entryVersion, MEMORY_ENTRY_VERSION)
  assert.deepEqual(entry.tags, [])
  assert.equal(entry.createdAt, entry.updatedAt)
  assert.ok(entry.id.length > 0)
})

test('正文两侧空白被去掉，id 逐条唯一', () => {
  const first = createMemoryEntry(minimal)
  const second = createMemoryEntry(minimal)

  assert.equal(first.content, '用户偏好简短回复')
  assert.notEqual(first.id, second.id)
})

test('去重指纹忽略大小写、空白与标点，但作用域不同则不同条', () => {
  assert.equal(
    buildDedupeKey('long-term', ' 用户 偏好：简短 回复！'),
    buildDedupeKey('long-term', '用户偏好简短回复'),
  )
  assert.notEqual(buildDedupeKey('long-term', '用户偏好简短回复'), buildDedupeKey('session', '用户偏好简短回复'))
})

test('schema 是存储契约：越界与未知取值一律拒绝，而不是悄悄截断', () => {
  assert.throws(() => MemoryEntrySchema.parse({ ...createMemoryEntry(minimal), importance: 9 }))
  assert.throws(() => MemoryEntrySchema.parse({ ...createMemoryEntry(minimal), scope: 'global' }))
  assert.throws(() => MemoryEntrySchema.parse({ ...createMemoryEntry(minimal), status: 'draft' }))
  assert.throws(() => MemoryEntrySchema.parse({ ...createMemoryEntry(minimal), content: 'x'.repeat(CONTENT_CHAR_LIMIT + 1) }))
  // 来源缺失不能被默认值兜住：没有来源的记忆是传闻，没法判断该不该提升（P-033）。
  assert.throws(() => MemoryEntrySchema.parse({ ...createMemoryEntry(minimal), origin: undefined }))
})

test('解析已落库的旧数据时，缺 status 的条目视为生效中而不是待确认', () => {
  const stored = { ...createMemoryEntry(minimal), status: undefined }
  assert.equal(MemoryEntrySchema.parse(stored).status, 'active')
})

test('预设模式解析出的策略逐项钉死', () => {
  assert.deepEqual(resolveMemoryPolicy('off'), {
    mode: 'off',
    scopes: { 'long-term': false, workspace: false, session: false },
    autoWrite: false,
    autoInject: false,
    injectLimit: 0,
    injectTokenBudget: 0,
    decay: false,
    vector: false,
    relevanceThreshold: 0.35,
    decayUnusedDays: 90,
    decayHalfLifeDays: 30,
    pinFrequent: false,
    autoWriteSensitive: false,
  })
  assert.deepEqual(resolveMemoryPolicy('session').scopes, {
    'long-term': false,
    workspace: false,
    session: true,
  })

  const balanced = resolveMemoryPolicy('balanced')
  assert.deepEqual(balanced.scopes, { 'long-term': true, workspace: true, session: true })
  assert.equal(balanced.autoInject, true)
  assert.equal(balanced.injectLimit, MAX_INJECT_LIMIT)
  assert.equal(balanced.decay, true)
  assert.equal(balanced.vector, false, '向量检索默认关闭')
  assert.equal(balanced.pinFrequent, false, '高频常驻 MVP 固定关闭（P-031）')
  assert.equal(balanced.autoWriteSensitive, false, '敏感内容不可由开关打开（P-033）')

  const manual = resolveMemoryPolicy('manual')
  assert.equal(manual.autoInject, false, '手动模式只走 recall 工具')
  assert.equal(manual.injectLimit, 0)
  assert.deepEqual(manual.scopes, { 'long-term': true, workspace: true, session: true })
})

test('高级开关只覆盖动过的项，注入条数被夹在硬上限内', () => {
  const policy = resolveMemoryPolicy('balanced', {
    scopes: { 'long-term': false },
    injectLimit: 99,
    vector: true,
  })

  assert.equal(policy.scopes['long-term'], false)
  assert.equal(policy.scopes.workspace, true, '没动过的作用域跟随预设')
  assert.equal(policy.injectLimit, MAX_INJECT_LIMIT, '开关只能把注入条数调小，调不大（P-028）')
  assert.equal(policy.vector, true)
  assert.equal(policy.injectTokenBudget, resolveMemoryPolicy('balanced').injectTokenBudget)
  assert.equal(resolveMemoryPolicy('balanced', { injectLimit: -3 }).injectLimit, 0)
})

test('高级开关：customized 为假时完全跟随预设（切模式不会被残留值拖住）', () => {
  // 用户上一次调过高级开关（值留在配置里），但 customized=false ⇒ 模式说了算。
  const stale = { customized: false, longTerm: false, work: false, session: false, maxInject: 0, decay: false, vector: true }
  assert.equal(overridesOf(stale), undefined)
  const session = resolveMemoryPolicy('session', overridesOf(stale) ?? {})
  assert.deepEqual(session.scopes, { 'long-term': false, workspace: false, session: true }, '只有会话层开')
  assert.equal(session.injectLimit, 3)

  const balanced = resolveMemoryPolicy('balanced', overridesOf(stale) ?? {})
  assert.equal(balanced.autoInject, true)
  assert.equal(balanced.decay, true)
})

test('高级开关：customized 为真时按用户的值覆盖，且向量检索恒关闭（P-027）', () => {
  const custom = { customized: true, longTerm: false, work: true, session: false, maxInject: 9, decay: false, vector: true }
  const policy = resolveMemoryPolicy('balanced', overridesOf(custom))

  assert.deepEqual(policy.scopes, { 'long-term': false, workspace: true, session: false })
  assert.equal(policy.injectLimit, 3, '注入条数仍被硬上限夹住（P-028）')
  assert.equal(policy.decay, false)
  assert.equal(policy.vector, false, '向量开关打开也不生效，但不报错')
})

test('缺陷 1 回归：模式不是 off 却把三层全关 ⇒ 回退到预设（不让记忆静默失效）', () => {
  // 真实触发路径：用户先在高级里改过开关（customized=true），再把三层逐个关掉。
  const broken = { customized: true, longTerm: false, work: false, session: false, maxInject: 3, decay: true, vector: false }

  assert.equal(isDegenerateAdvanced(broken, 'balanced'), true)
  assert.equal(overridesOf(broken, 'balanced'), undefined, '矛盾组合不产生覆盖')
  const policy = resolveMemoryPolicy('balanced', overridesOf(broken, 'balanced') ?? {})
  assert.deepEqual(policy.scopes, { 'long-term': true, workspace: true, session: true }, '回退到 balanced 预设')
  assert.equal(canRemember(policy), true, '工具因此照常注册（原缺陷就是这里静默失效）')

  // off 模式下三层全关是**正常**的：不由这条规则接管。
  assert.equal(isDegenerateAdvanced(broken, 'off'), false)
  const off = resolveMemoryPolicy('off', overridesOf(broken, 'off') ?? {})
  assert.equal(off.autoWrite, false)

  // 只关部分层是合法的高级用法，照旧生效。
  const partial = { ...broken, session: true }
  assert.equal(isDegenerateAdvanced(partial, 'balanced'), false)
  assert.deepEqual(resolveMemoryPolicy('balanced', overridesOf(partial, 'balanced')).scopes, {
    'long-term': false,
    workspace: false,
    session: true,
  })
})
