/**
 * 扫**已发布的包**（解开 tgz），这才是别人装到的东西。
 */
const fs = require('node:fs')
const path = require('node:path')
const { execSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const tgz = path.join(root, 'deepseek-harness-humanity-0.9.71.tgz')
const dir = path.join(root, '.audit-pkg')
fs.rmSync(dir, { recursive: true, force: true })
fs.mkdirSync(dir, { recursive: true })
execSync(`tar -xzf "${tgz}" -C "${dir}"`, { stdio: 'inherit' })
const pkgRoot = path.join(dir, 'package')

const patterns = [
  ['实例称谓', /上位|绒的私密|绒|火火|梅露辛|伊瑟|Yseult|大肥鱼|主人/g],
  ['本机痕迹', /\/data\/dsh|Thr33H-DSH|192\.168\.\d+\.\d+|D:\\|C:\\Users|127\.0\.0\.1:5\d{4}/g],
  ['亲密/私密描述', /束具|口球|项圈|亲了我|抱着睡|调教|好色|性欲/g],
  ['会话ID', /session-[0-9a-f]{8}-[0-9a-f]{4}/g],
  ['疑似密钥', /github_pat_|npm_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{16,}|_authToken\s*=\s*\S+/g],
]

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(d, e.name)
  return e.isDirectory() ? walk(p) : [p]
})

const files = walk(pkgRoot).filter((f) => /\.(js|md|yml|json)$/.test(f))
const rows = []
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8')
  const lines = text.split(/\r?\n/)
  for (const [name, re] of patterns) {
    lines.forEach((line, i) => {
      re.lastIndex = 0
      if (!re.exec(line)) return
      rows.push({ name, file: path.relative(pkgRoot, file).replace(/\\/g, '/'), line: i + 1, sample: line.trim().slice(0, 130) })
    })
  }
}

const out = [`# 已发布的包里有多少东西（0.9.71，共 ${files.length} 个文件）`, '']
for (const [name] of patterns) {
  const mine = rows.filter((r) => r.name === name)
  out.push(`## ${name}：${mine.length} 处`)
  const byFile = new Map()
  for (const r of mine) {
    if (!byFile.has(r.file)) byFile.set(r.file, [])
    byFile.get(r.file).push(r)
  }
  for (const [file, list] of byFile) {
    out.push(`- ${file} ×${list.length}`)
    for (const r of list.slice(0, 3)) out.push(`    ${r.line}: ${r.sample}`)
    if (list.length > 3) out.push(`    …另有 ${list.length - 3} 行`)
  }
  out.push('')
}
fs.writeFileSync(path.join(root, '..', '_已发布包核查.md'), out.join('\n'), 'utf8')
console.log(out.join('\n').slice(0, 3500))
