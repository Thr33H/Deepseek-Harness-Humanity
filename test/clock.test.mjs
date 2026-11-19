/**
 * 时间基准的回归测试。
 *
 * 这一层做的是**改整个进程的时区**（`process.env.TZ`），所以它坏了不会报错，
 * 只会让"她几点睡醒""今天是几号""每日用量几点归零"全部偏几个小时。
 * 因此这里钉的是三件事：
 * 1. 只认浏览器报的那个字段（其它地方来的字符串一律不认）；
 * 2. 非法时区绝不写进进程（一处坏数据不能拖垮整个进程的 Intl）；
 * 3. 运维显式给了 `TZ` 就不抢，没给就自动学、并且存下来。
 *
 * ⚠️ 测试会真的改进程时区。两个实测细节决定了这里怎么写：
 * - `delete process.env.TZ` **不会**把时区还原（Node 会停在最后设置的那个时区），
 *   它只清掉环境变量本身 —— 而"环境里有没有显式 TZ"正是 `installClock` 的判据，
 *   所以每个用例开头要 `clearTimezoneOverride()`；
 * - 结束时必须把原始时区**显式写回**（`restoreTimeZone()`），否则会漏到本文件后面的用例。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { browserTimeZoneOf, CLOCK_DOCUMENT, installClock, isKnownTimeZone } from '../lib/clock.js'

/** 当前进程解析出的时区（用来在结束时还原）。 */
const originalZone = new Intl.DateTimeFormat('en-US').resolvedOptions().timeZone

/** 清掉环境里的 `TZ`，模拟"容器没设 TZ"的真实情况。 */
function clearTimezoneOverride() {
  delete process.env.TZ
}

/** 把原始时区写回去（`delete` 管不了时区本身）。 */
function restoreTimeZone() {
  process.env.TZ = originalZone
}

/** 假日志：把 info/warn 收起来供断言。 */
function fakeLog() {
  const infos = []
  const warns = []
  return {
    infos,
    warns,
    log: {
      info: (message) => infos.push(String(message)),
      warn: (message) => warns.push(String(message)),
      error: () => {},
      debug: () => {},
    },
  }
}

/** 假文档表：只实现时间基准用到的 `read` / `write`。 */
function fakeDocuments() {
  const records = new Map()
  return {
    records,
    store: {
      read: (ns) => records.get(ns),
      list: () => [...records.entries()].map(([ns, record]) => ({ ns, record })),
      write: async (ns, value) => {
        const record = { value, revision: (records.get(ns)?.revision ?? 0) + 1, updatedAt: new Date().toISOString() }
        records.set(ns, record)
        return record
      },
      merge: async () => {
        throw new Error('时间基准不该用 merge')
      },
    },
  }
}

/** 假 cordis 上下文：只收 `agent/pre-step` 一个事件，并提供手动触发。 */
function fakeContext() {
  const handlers = new Map()
  return {
    ctx: {
      on: (name, handler) => {
        handlers.set(name, handler)
        return () => handlers.delete(name)
      },
    },
    /** 触发一次 pre-step：`decision` 就是下游给出的消息列表。 */
    fire: async (decision) => {
      const handler = handlers.get('agent/pre-step')
      assert.ok(handler, '没有注册 agent/pre-step 监听')
      return handler({}, async () => decision)
    },
  }
}

/** 造一条网页端用户消息（带浏览器时区）。 */
const userMessage = (zone) => ({ source: { kind: 'user', rpcId: 'r1', clientTimeZone: zone }, content: [] })

/* ───────────────────────── 读消息与校验 ───────────────────────── */

test('只认网页端用户消息上的 clientTimeZone，其它形状一律不认', () => {
  assert.equal(browserTimeZoneOf(userMessage('Asia/Shanghai')), 'Asia/Shanghai')
  // 不是 user 来源（系统注入、助手消息）不认：那些没有浏览器时区这回事。
  assert.equal(browserTimeZoneOf({ source: { kind: 'time-context' } }), undefined)
  // 有 user 但没带时区（旧客户端）不认。
  assert.equal(browserTimeZoneOf({ source: { kind: 'user', rpcId: 'r1' } }), undefined)
  // 空串与非字符串不认。
  assert.equal(browserTimeZoneOf({ source: { kind: 'user', clientTimeZone: '' } }), undefined)
  assert.equal(browserTimeZoneOf({ source: { kind: 'user', clientTimeZone: 42 } }), undefined)
  // 形状不对不抛。
  assert.equal(browserTimeZoneOf(undefined), undefined)
  assert.equal(browserTimeZoneOf(null), undefined)
  assert.equal(browserTimeZoneOf('Asia/Shanghai'), undefined)
  assert.equal(browserTimeZoneOf({}), undefined)
})

test('时区校验：认识真实 IANA 名，拒绝空串与瞎编的名字', () => {
  assert.equal(isKnownTimeZone('Asia/Shanghai'), true)
  assert.equal(isKnownTimeZone('UTC'), true)
  assert.equal(isKnownTimeZone('America/New_York'), true)
  assert.equal(isKnownTimeZone(''), false)
  assert.equal(isKnownTimeZone('   '), false)
  assert.equal(isKnownTimeZone('Mars/Olympus'), false)
  assert.equal(isKnownTimeZone('上海'), false)
})

/* ───────────────────────── 学习与记忆 ───────────────────────── */

test('没学到之前是 default；收到浏览器时区就切过去、并落盘', async () => {
  clearTimezoneOverride()
  const { log, infos } = fakeLog()
  const { store, records } = fakeDocuments()
  const { ctx, fire } = fakeContext()
  const clock = installClock(ctx, log, { documents: () => store, log, preference: () => ({ auto: true, zone: '' }) })

  // 初始：还没学到（来源不是 auto）。
  assert.notEqual(clock.report().source, 'auto')
  assert.ok(infos.some((line) => line.includes('还没学到')), '启动时就该在日志里交代当前用的哪个钟')

  await fire({ kind: 'enter', messages: [userMessage('America/New_York')] })

  assert.equal(clock.report().effective, 'America/New_York')
  assert.equal(clock.report().source, 'auto')
  assert.notEqual(clock.report().learnedAt, '')
  const stored = records.get(CLOCK_DOCUMENT)?.value
  assert.equal(stored.timeZone, 'America/New_York')
  clock.dispose()
  restoreTimeZone()
})

test('同一次请求里多条消息：以最后一条为准（代表用户此刻的设备）', async () => {
  clearTimezoneOverride()
  const { log } = fakeLog()
  const { store } = fakeDocuments()
  const { ctx, fire } = fakeContext()
  const clock = installClock(ctx, log, { documents: () => store, log, preference: () => ({ auto: true, zone: '' }) })

  await fire({ kind: 'enter', messages: [userMessage('Europe/London'), userMessage('Asia/Tokyo')] })
  assert.equal(clock.report().effective, 'Asia/Tokyo')
  clock.dispose()
  restoreTimeZone()
})

test('非法时区不写进进程（宁可用旧的，也不能让 Intl 在别的模块里炸）', async () => {
  clearTimezoneOverride()
  const before = new Intl.DateTimeFormat('en-US').resolvedOptions().timeZone
  const { log, warns } = fakeLog()
  const { store } = fakeDocuments()
  const { ctx, fire } = fakeContext()
  const clock = installClock(ctx, log, { documents: () => store, log, preference: () => ({ auto: true, zone: '' }) })

  await fire({ kind: 'enter', messages: [userMessage('Mars/Olympus')] })
  assert.equal(new Intl.DateTimeFormat('en-US').resolvedOptions().timeZone, before)
  assert.notEqual(clock.report().source, 'auto')
  assert.ok(warns.some((line) => line.includes('无法识别')))
  clock.dispose()
  restoreTimeZone()
})

test('消息里没有时区：这一轮什么都不做（旧客户端也不会把钟拨乱）', async () => {
  clearTimezoneOverride()
  const { log } = fakeLog()
  const { store } = fakeDocuments()
  const { ctx, fire } = fakeContext()
  const clock = installClock(ctx, log, { documents: () => store, log, preference: () => ({ auto: true, zone: '' }) })

  await fire({ kind: 'enter', messages: [{ source: { kind: 'user' } }] })
  assert.notEqual(clock.report().source, 'auto')
  assert.equal(clock.report().learnedAt, '')
  clock.dispose()
  restoreTimeZone()
})

test('存下来的时区：存储一就绪就应用，不必等第一条消息', () => {
  clearTimezoneOverride()
  // 上一次运行留下的是 Asia/Shanghai。
  const { store, records } = fakeDocuments()
  records.set(CLOCK_DOCUMENT, {
    value: { timeZone: 'Asia/Shanghai', learnedAt: '2026-11-19T02:00:00.000Z' },
    revision: 1,
    updatedAt: '2026-11-19T02:00:00.000Z',
  })
  const { log } = fakeLog()
  const { ctx } = fakeContext()
  const clock = installClock(ctx, log, { documents: () => store, log, preference: () => ({ auto: true, zone: '' }) })

  clock.restore()
  assert.equal(clock.report().effective, 'Asia/Shanghai')
  assert.equal(clock.report().source, 'auto')
  assert.equal(clock.report().learnedAt, '2026-11-19T02:00:00.000Z')
  clock.dispose()
  restoreTimeZone()
})

test('存的是坏值（认不出的时区）：当作没存过，不回落到坏时区上', () => {
  clearTimezoneOverride()
  const { store, records } = fakeDocuments()
  records.set(CLOCK_DOCUMENT, { value: { timeZone: 'Mars/Olympus' }, revision: 1, updatedAt: '' })
  const { log, warns } = fakeLog()
  const { ctx } = fakeContext()
  const clock = installClock(ctx, log, { documents: () => store, log, preference: () => ({ auto: true, zone: '' }) })

  clock.restore()
  assert.notEqual(clock.report().source, 'auto')
  assert.equal(warns.length, 0, '读坏值不该报警（那是上一版写坏的数据，安静跳过即可）')
  clock.dispose()
  restoreTimeZone()
})

/* ───────────────────────── 运维显式指定 ───────────────────────── */

test('容器显式给了 TZ：不抢，也不自动学', async () => {
  clearTimezoneOverride()
  process.env.TZ = 'Europe/London'
  const { log, infos } = fakeLog()
  const { store, records } = fakeDocuments()
  const { ctx, fire } = fakeContext()
  const clock = installClock(ctx, log, { documents: () => store, log, preference: () => ({ auto: true, zone: '' }) })

  assert.equal(clock.report().source, 'env')
  assert.ok(infos.some((line) => line.includes('不再自动学习')))

  await fire({ kind: 'enter', messages: [userMessage('Asia/Shanghai')] })
  assert.equal(clock.report().effective, 'Europe/London', '运维的决定优先于浏览器')
  assert.equal(records.size, 0, '不该把浏览器时区写进存储')
  clock.dispose()
  restoreTimeZone()
})

test('存着旧值但运维改了 TZ：以环境为准，不覆盖', () => {
  clearTimezoneOverride()
  process.env.TZ = 'Europe/London'
  const { store, records } = fakeDocuments()
  records.set(CLOCK_DOCUMENT, {
    value: { timeZone: 'Asia/Shanghai', learnedAt: '2026-11-19T02:00:00.000Z' },
    revision: 1,
    updatedAt: '',
  })
  const { log, infos } = fakeLog()
  const { ctx } = fakeContext()
  const clock = installClock(ctx, log, { documents: () => store, log, preference: () => ({ auto: true, zone: '' }) })

  clock.restore()
  assert.equal(clock.report().effective, 'Europe/London')
  assert.equal(clock.report().source, 'env')
  assert.ok(infos.some((line) => line.includes('以环境为准')))
  clock.dispose()
  restoreTimeZone()
})

/* ───────────────────────── 手动模式（用户固定一个时区） ───────────────────────── */

/** 可变偏好：模拟用户在设置里切换。 */
function preferenceSwitch(initial) {
  let pref = initial
  return {
    pref: () => pref,
    set: (next) => {
      pref = next
    },
  }
}

test('手动固定：立刻用它，而且不再跟浏览器变', async () => {
  clearTimezoneOverride()
  const { log } = fakeLog()
  const { store, records } = fakeDocuments()
  const { ctx, fire } = fakeContext()
  const pref = preferenceSwitch({ auto: false, zone: 'Asia/Tokyo' })
  const clock = installClock(ctx, log, { documents: () => store, log, preference: pref.pref })

  // 装好就是手动那个时区（不用等任何消息）。
  assert.equal(clock.report().effective, 'Asia/Tokyo')
  assert.equal(clock.report().source, 'manual')

  // 浏览器说别的时区：手动模式下不学、不改、不落盘。
  await fire({ kind: 'enter', messages: [userMessage('America/New_York')] })
  assert.equal(clock.report().effective, 'Asia/Tokyo')
  assert.equal(clock.report().source, 'manual')
  assert.equal(records.size, 0)
  clock.dispose()
  restoreTimeZone()
})

test('手动模式下填了非法时区：退回自动（不会让进程停在坏值上）', async () => {
  clearTimezoneOverride()
  const { log } = fakeLog()
  const { store } = fakeDocuments()
  const { ctx } = fakeContext()
  const clock = installClock(ctx, log, {
    documents: () => store,
    log,
    preference: () => ({ auto: false, zone: 'Mars/Olympus' }),
  })
  clock.reconfigure()
  assert.notEqual(clock.report().source, 'manual')
  clock.dispose()
  restoreTimeZone()
})

test('设置里来回切：手动→自动回到学到的时区，自动→手动立刻切过去', async () => {
  clearTimezoneOverride()
  const { log } = fakeLog()
  const { store } = fakeDocuments()
  const { ctx, fire } = fakeContext()
  const pref = preferenceSwitch({ auto: true, zone: '' })
  const clock = installClock(ctx, log, { documents: () => store, log, preference: pref.pref })

  // 先自动学到 Asia/Shanghai。
  await fire({ kind: 'enter', messages: [userMessage('Asia/Shanghai')] })
  assert.equal(clock.report().effective, 'Asia/Shanghai')

  // 用户切成手动 + 纽约 ⇒ 立刻生效。
  pref.set({ auto: false, zone: 'America/New_York' })
  clock.reconfigure()
  assert.equal(clock.report().effective, 'America/New_York')
  assert.equal(clock.report().source, 'manual')

  // 再切回自动 ⇒ 回到学到的那一个，而不是停在纽约。
  pref.set({ auto: true, zone: 'America/New_York' })
  clock.reconfigure()
  assert.equal(clock.report().effective, 'Asia/Shanghai')
  assert.equal(clock.report().source, 'auto')
  clock.dispose()
  restoreTimeZone()
})
