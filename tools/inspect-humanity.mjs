/**
 * 她这段时间的**一次看清**（放在容器里，随时跑）。
 *
 * 用法：`docker exec <容器名> node $DSH_HOME/inspect-humanity.mjs`（也可直接 `node tools/inspect-humanity.mjs`）
 *
 * 只读：状态、任务、日记、她目录里的文件、以及她最近一轮说过什么/调了哪些工具。
 * 为什么要有这个脚本：以前每次都现拼一大段 `node -e`，容易漏字段、也容易把只读检查写成写操作。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const HOME = process.env.DSH_HOME
if (HOME === undefined) {
  console.error('请先设 $DSH_HOME（就是 DSH 的数据目录）')
  process.exit(2)
}

/** 读一个 JSON 存储，坏了就当空。 */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** 一个存储里所有表的记录值。 */
function rowsOf(store) {
  const tables = store?.tables ?? {}
  const rows = []
  for (const table of Object.values(tables)) {
    for (const row of Object.values(table ?? {})) {
      if (row === null || typeof row !== 'object') continue
      // 行上有 status（任务在用）与 record（载荷），两个都要带出来。
      const payload = 'record' in row ? row.record : 'value' in row ? row.value : undefined
      rows.push({ status: row.status, ...(payload ?? {}) })
    }
  }
  return rows
}

/** 她的时区里现在几点。 */
function nowText() {
  return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
}

const humanity = readJson(path.join(HOME, 'storages', 'humanity.json')) ?? { tables: {} }
const documents = humanity.tables.documents ?? {}
const state = documents['humanity-evolution-state']?.value
const view = documents['humanity-evolution']?.value
const diary = documents['humanity-diary']?.value
const archive = documents['humanity-diary-archive']?.value

console.log('现在      ', nowText())
if (state === undefined) {
  console.log('状态      ', '（还没有状态文档）')
} else {
  console.log('状态      ', JSON.stringify({
    精力: Number(state.energy?.toFixed?.(2) ?? 0),
    今天第几次: state.dayCount,
    上一次醒: state.lastWakeAt,
    下一次: state.nextAt,
    在睡: state.sleepingSince !== '',
    今日token: Math.round(state.tokensToday ?? 0),
    排程错误: state.lastError || '',
    收账错误: state.lastSettleError || '',
  }))
}

const schedule = readJson(path.join(HOME, 'storages', 'schedule.json'))
const tasks = rowsOf(schedule).filter((task) => task !== null && typeof task === 'object' && 'scheduledAt' in task)
for (const task of tasks) {
  console.log('任务      ', task.status ?? '?', task.scheduledAt ?? '?', String(task.title ?? ''))
}

console.log('日记      ', diary === undefined ? '（还没写过）' : `主档 ${diary.entries?.length ?? 0} 篇；归档 ${archive?.entries?.length ?? 0} 篇`)
if (Array.isArray(diary?.entries)) {
  for (const entry of diary.entries.slice(-3)) {
    console.log('    ', entry.date, entry.openedAt === '' ? '合着' : `已翻开@${entry.openedAt}`, entry.noticedAt === '' ? '' : `她知道@${entry.noticedAt}`)
    console.log('      ', String(entry.text ?? '').slice(0, 100).replace(/\s+/g, ' '))
  }
}

console.log('页面投影  ', JSON.stringify({
  攒着的事: view?.threads ?? [],
  她的作品: (view?.works ?? []).map((work) => `${work.name}(${work.kind})`),
  压着: view?.status?.busy ?? false,
}))

// 她的房间目录。
const roomDir = path.join(HOME, 'humanity', 'room')
try {
  const files = fs.readdirSync(roomDir)
  console.log('她的目录  ', files.length === 0 ? '（空的）' : files.join(', '))
} catch {
  console.log('她的目录  ', '（还没建）')
}

// 她最近一轮说过什么、调了哪些工具。
const sessionsRoot = path.join(HOME, 'sessions')
let sessionFile
try {
  for (const bucket of fs.readdirSync(sessionsRoot)) {
    const dir = path.join(sessionsRoot, bucket)
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith('session-cea8b30f')) continue
      const candidate = path.join(dir, name, 'session.v4.jsonl.zstd')
      if (fs.existsSync(candidate)) sessionFile = candidate
    }
  }
} catch {
  sessionFile = undefined
}
if (sessionFile === undefined) {
  console.log('她的会话  ', '（找不到）')
} else {
  const text = zlib.zstdDecompressSync(fs.readFileSync(sessionFile)).toString('utf8')
  const events = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // 坏行跳过
    }
  }
  console.log('会话事件  ', `${events.length} 条；文件 ${(fs.statSync(sessionFile).size / 1024).toFixed(0)} KB`)
  const toolsOf = (message) => (message?.content ?? []).filter((part) => part.type === 'tool_use').map((part) => part.name)
  const textOf = (message) => (message?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join(' ')
  let printed = 0
  for (const event of events.slice(-40)) {
    if (event.type === 'assistant/message') {
      const tools = toolsOf(event.data?.message)
      const words = textOf(event.data?.message)
      console.log('  她说', tools.length > 0 ? `【调用 ${tools.join(',')}】` : '', String(words).slice(0, 160).replace(/\s+/g, ' '))
      printed += 1
    }
    if (event.type === 'tool/result' && printed <= 6) {
      console.log('  工具返回', JSON.stringify(event.data).slice(0, 160))
    }
  }
}
