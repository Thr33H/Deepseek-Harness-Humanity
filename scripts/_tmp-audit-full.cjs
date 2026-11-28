/**
 * 全量复查：比第一轮宽得多的口径。
 *
 * 覆盖面：
 *  1. 仓库里**所有**文本文件（不只 .ts/.md，含无扩展名、.txt-.mjs-.json-.yml…）；
 *  2. 更宽的模式（地址/端口/坐标/长串/邮箱/QQ/微信/引号里的长句）；
 *  3. **git 历史**（旧提交仍然公开，HEAD 干净不等于仓库干净）；
 *  4. 非文本文件清单（图片/二进制扫不了，至少要看见它们存在）。
 */
const fs = require('node:fs')
const path = require('node:path')
const { execSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const tracked = execSync('git ls-files', { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)

/** 文本判定：能按 UTF-8 读出来且没有 NUL。 */
const isText = (file) => {
  try {
    const buf = fs.readFileSync(path.join(root, file))
    if (buf.length === 0) return false
    if (buf.includes(0)) return false
    buf.toString('utf8')
    return true
  } catch {
    return false
  }
}

const patterns = [
  ['称呼/私事', /上位|绒的私密|火火|梅露辛|伊瑟|Yseult|大肥鱼|主人|主人本人|爸爸|宝贝儿?|亲爱的/g],
  ['地址/端口', /\b\d{1,3}(\.\d{1,3}){3}\b|:\d{4,5}\b|\/opt\/|\/data\/|C:\\\\|D:\\\\|\/home\/[a-z]/g],
  ['长串(疑似密钥)', /\b[A-Za-z0-9_-]{32,}\b/g],
  ['邮箱/账号', /[\w.+-]+@[\w-]+\.[\w.]+|\b[1-9]\d{4,11}\b(?=\s*(QQ|qq|微信|wechat))/g],
  ['身份证/手机', /\b1[3-9]\d{9}\b|\b\d{17}[\dXx]\b/g],
  ['引号长句(可能抄了对话)', /["“「][^"”」\n]{12,}["”」]/g],
  ['亲密描述', /束具|口球|项圈|亲了我|抱着睡|调教|好色|性欲|露骨|裸/g],
]

const report = []
const textFiles = tracked.filter(isText)
const binary = tracked.filter((f) => !isText(f))

report.push('# 全量复查（第二轮）')
report.push('')
report.push(`git 跟踪 ${tracked.length} 个文件：文本 ${textFiles.length}、非文本 ${binary.length}。`)
report.push(`非文本（扫不了，只能列出来看）：${binary.join(', ') || '无'}`)
report.push('')

for (const [name, re] of patterns) {
  const hits = []
  for (const file of textFiles) {
    const lines = fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/)
    lines.forEach((line, i) => {
      re.lastIndex = 0
      if (!re.exec(line)) return
      hits.push({ file, line: i + 1, sample: line.trim().slice(0, 110) })
    })
  }
  report.push(`## ${name}：${hits.length} 处`)
  const byFile = new Map()
  for (const h of hits) {
    if (!byFile.has(h.file)) byFile.set(h.file, [])
    byFile.get(h.file).push(h)
  }
  for (const [file, list] of byFile) {
    report.push(`- ${file} ×${list.length}`)
    for (const h of list.slice(0, 3)) report.push(`    ${h.line}: ${h.sample}`)
    if (list.length > 3) report.push(`    …另有 ${list.length - 3} 行`)
  }
  report.push('')
}

// ── git 历史 ──
report.push('## git 历史（旧提交仍然公开）')
for (const [name, re] of patterns.slice(0, 2)) {
  const needle = name === '称呼/私事' ? '上位' : '/data/dsh'
  let count = 0
  try {
    count = execSync(`git log --all -S"${needle}" --oneline`, { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean).length
  } catch { count = -1 }
  report.push(`- 含「${needle}」的提交：${count} 个`)
}

fs.writeFileSync(path.join(root, '..', '_全量复查.md'), report.join('\n'), 'utf8')
console.log(report.join('\n').slice(0, 5000))
