/**
 * 把提示词从**编译后的代码**里原样抽出来，写成一份 Markdown。
 *
 * 两种视角：
 * - 三种"投给她的"提示词（醒来词 / 收账 / 主动找你）是**模板**：运行时填进去的地方标成 {{变量}}；
 * - 其余是**固定文字**（后台模型的 system），没有运行时插值。
 *
 * 为什么不手抄：手抄一定会跟代码走散（docs/PROMPTS.md 昨晚就抄错了 —— 日记那节还写着"插件代写"）。
 */
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')
const lib = path.join(root, 'lib')

/** 载入一个 lib 模块，并把它内部的常量也取出来。 */
async function loadWith(relative, names) {
  const source = path.join(lib, relative + '.js')
  const text = fs.readFileSync(source, 'utf8')
  const beside = path.join(path.dirname(source), '__dump_' + path.basename(source))
  const missing = names.filter((name) => !new RegExp(`export\\s+(?:const|let|var|function|class)\\s+${name}\\b`).test(text))
  fs.writeFileSync(beside, text + (missing.length === 0 ? '' : `\nexport { ${missing.join(', ')} };\n`), 'utf8')
  try {
    return await import(pathToFileURL(beside).href + '?v=' + Date.now())
  } finally {
    fs.unlinkSync(beside)
  }
}

/** 把哨兵值换成 {{变量名}}。 */
function templatize(text, pairs) {
  let out = text
  for (const [sentinel, name] of pairs) out = out.split(sentinel).join(`{{${name}}}`)
  // "现在是 2026年11月27日星期五 22:43。" 这句是算出来的，整句换掉。
  out = out.replace(/^现在是 .*$/m, '现在是 {{现在几点（她的时区，人话）}}。')
  return out
}

async function main() {
  const appraise = await loadWith('emotion/appraise', ['APPRAISE_SYSTEM', 'OWN_SUFFIX'])
  const memoryWrite = await loadWith('memory/write', ['INTEGRATE_SYSTEM'])
  const memoryConsolidate = await loadWith('memory/consolidate', ['PERIOD_SYSTEM', 'CHAPTER_SYSTEM'])
  const personaGrow = await loadWith('persona/grow', ['GROW_SYSTEM'])
  const memoryTools = await loadWith('memory/tools', ['REMEMBER_DESCRIPTION', 'RECALL_DESCRIPTION'])
  const promptTexts = await loadWith('persona/prompt-texts', ['INDEPENDENT_JUDGMENT_PROMPT', 'MUTABLE_OPS_GUIDE'])
  const memoryRender = await loadWith('memory/render', ['MEMORY_GUIDANCE', 'FIRST_RECALL_TITLE'])
  const wake = await loadWith('evolution/wake', [])
  const diary = await loadWith('evolution/diary', [])
  const tell = await loadWith('evolution/tell', [])
  const toolTell = await loadWith('evolution/tool-tell', ['TELL_DESCRIPTION'])

  // ── 三种投递词：用哨兵值跑一遍真代码，再把哨兵换成变量名 ──
  const wakeText = templatize(
    wake.buildWakePrompt(
      '2026-11-27T14:43:31.000Z',
      'Asia/Shanghai',
      '《S_上次》',
      ['《S_待办》'],
      ['《S_日期》'],
      '《S_称呼》',
      [{ name: '《S_工具名》', label: '《S_人话》' }],
    ),
    [
      ['《S_称呼》', '称呼'],
      ['《S_上次》', '上一次她自己的话'],
      ['《S_待办》', '她手上的待办（有几行就几行）'],
      ['《S_日期》', '被翻过的日记日期'],
      ['《S_工具名》', '工具名'],
      ['《S_人话》', '工具的人话标签'],
    ],
  )
  const collectText = templatize(
    diary.buildCollectPrompt('《S_日期》', '《S_材料》', '《S_日记》', '《S_称呼》', '《S_当天记录》'),
    [
      ['《S_称呼》', '称呼'],
      ['《S_日期》', '收账的那一天'],
      ['《S_材料》', '材料文件名'],
      ['《S_日记》', '日记文件名'],
      ['《S_当天记录》', '当天全量记录的文件名'],
    ],
  )
  const tellText = templatize(
    tell.buildTellPrompt('《S_话》', '《S_文件》', '《S_路径》', '《S_称呼》'),
    [
      ['《S_称呼》', '称呼'],
      ['《S_话》', '她留的那句话'],
      ['《S_文件》', '她想给他看的文件名'],
      ['《S_路径》', '那个文件的绝对路径'],
    ],
  )

  const sections = []
  const push = (title, body, note) => {
    sections.push(`### ${title}` + (note ? `\n\n> ${note}` : '') + `\n\n\`\`\`text\n${body}\n\`\`\``)
  }

  push('1. 她自己的时间（醒来词）', wakeText, '**模板**：`{{…}}` 是运行时填的。工具清单是**一行一个**（这里只画一行）；装了几个工具就有几行。')
  push('2. 她该写日记了（收账）', collectText, '**模板**。')
  push('3. 她主动找你', tellText, '**模板**。')
  push('4. 情绪：这句话让她怎么了', appraise.APPRAISE_SYSTEM, '**固定文字**。调用时会在它前面拼【你的立场】、可能拼【前文】。')
  push('5. 她自己看到东西时的情绪补充', appraise.OWN_SUFFIX, '**固定文字**，接在第 4 段后面。')
  push('6. 记忆：从对话里挑', memoryWrite.INTEGRATE_SYSTEM, '**固定文字**；调用时把那段对话接在后面。')
  push('7. 记忆：按类归拢', memoryConsolidate.PERIOD_SYSTEM, '**固定文字**；调用时把待整理的经历逐行接在后面。')
  push('8. 记忆：按阶段归拢', memoryConsolidate.CHAPTER_SYSTEM, '**固定文字**；同上。')
  push('9. 人格：自己整理信息层', personaGrow.GROW_SYSTEM, '**固定文字**；调用时接材料与"已有的小节名"。')
  push('10. 每轮注入：独立判断', promptTexts.INDEPENDENT_JUDGMENT_PROMPT, '**固定文字**，开关打开时每轮都在最前面。')
  push('11. 每轮注入：记忆说明', String(memoryRender.MEMORY_GUIDANCE), '**固定文字**。')
  push('12. 每轮注入：记忆标题', String(memoryRender.FIRST_RECALL_TITLE), '**固定文字**。')
  push('13. 人格改动指南', promptTexts.MUTABLE_OPS_GUIDE, '**固定文字**。')
  push('14. 工具说明：humanity_tell_him', toolTell.TELL_DESCRIPTION, `**固定文字**（其中"${'${TELL_MAX_CHARS}'}"这个上限是常量）。`)
  push('15. 工具说明：humanity_remember', memoryTools.REMEMBER_DESCRIPTION, '**固定文字**。')
  push('16. 工具说明：humanity_recall', memoryTools.RECALL_DESCRIPTION, '**固定文字**。')

  const doc = [
    '# 她读到的每一段提示词（2026-11-27，模板视角）',
    '',
    '这份是**从编译后的代码里原样抽出来**的，不是手抄。',
    '',
    '- 第 1–3 段是**投给她的话**：`{{…}}` 是运行时填进去的变量，其余每个字都是写死的；',
    '- 第 4–16 段是**固定文字**（后台模型的 system / 每轮注入 / 工具说明）：没有运行时插值，调用时把材料拼在它后面。',
    '',
    '## 变量从哪来',
    '',
    '| 变量 | 从哪来 | 空的时候 |',
    '|---|---|---|',
    '| 称呼 | 人格里「对TA的称呼」第一条 | 写"对方"（醒来词/收账）或"他"（主动找你，泛指） |',
    '| 现在几点 | 运行时算：她的时区，`2026年11月27日星期五 14:43` | —— |',
    '| 工具名 / 人话标签 | 她那台机器**此刻真正可见的工具**（不是写死的清单） | 清单为空时，那一段整个不出现 |',
    '| 她手上的待办 | 她自己目录里的 `todo.md`，最多 8 行 | 换成"你现在没有攒着没做完的事"那句 |',
    '| 被翻过的日记日期 | 日记本里"被人打开过"的那几天 | 那一段整个不出现 |',
    '| 上一次她自己的话 | 她上一轮在房间里的最后一句话（截断到 300 字） | 那一段整个不出现 |',
    '| 收账的那一天 | "现在"按她的时区算出的日期 | —— |',
    '| 材料 / 日记文件名 | `日记材料-<日期>.md` / `diary-<日期>.md` | —— |',
    '| 她留的那句话 | 她用 `humanity_tell_him` 留的原文 | 只带东西、不说话时，这一行不出现 |',
    '| 文件名 / 绝对路径 | 她想给他看的文件（她自己目录里的顶层文件名） | 不带东西时，整段不出现 |',
    '',
    ...sections,
    '',
  ].join('\n')

  fs.writeFileSync(path.join(root, 'docs', '提示词全文.md'), doc, 'utf8')
  console.log('已生成 docs/提示词全文.md（模板视角），共', sections.length, '段')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
