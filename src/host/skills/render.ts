/**
 * SKILL.md 的**渲染与解析**（纯函数，不碰文件系统）。
 *
 * 格式对着官方 `dsh-skill-filesystem`（0.1.5-rc.2）的解析器写，**不发明第二套**：
 * - 目录包 `<name>/SKILL.md`；frontmatter 里 `name` 与 `description` **缺任一即被忽略**（官方会 warn）；
 * - 其余字段（`zh_name`/`emoji`/`category`…）是官方 UI 的增强项，第一版**一个都不写**（宁少勿错）。
 *
 * 值一律用 JSON 字符串写（JSON 字符串是合法 YAML 双引号标量）：描述里出现 `: `、`#`、引号或
 * 换行时，裸写会破坏 frontmatter —— 那是"文件写坏了但看起来没错"的典型事故。
 * @module humanity/skills/render
 */

/** 一条技能的三种事实（落盘所需的最小集合）。 */
export interface SkillDocument {
  /** kebab-case 技能名。 */
  name: string
  /** 一句话说明（官方必需字段）。 */
  description: string
  /** 技能正文（模型按需载入的说明书全文）。 */
  content: string
}

/** 把任意文本渲染成 YAML 双引号标量。 */
function yamlScalar(value: string): string {
  return JSON.stringify(value)
}

/**
 * 渲染 SKILL.md 全文。
 * @param skill - 技能内容。
 * @returns 文件文本（末尾带换行）。
 */
export function renderSkillFile(skill: SkillDocument): string {
  const lines = [
    '---',
    `name: ${yamlScalar(skill.name)}`,
    `description: ${yamlScalar(skill.description)}`,
    '---',
    '',
    skill.content.trimEnd(),
    '',
  ]
  return lines.join('\n')
}

/** 读一个 frontmatter 标量：带引号的按 JSON 解析，裸值原样返回。 */
function scalarValue(raw: string): string {
  const value = raw.trim()
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value)
      if (typeof parsed === 'string') return parsed
    } catch {
      // 引号不闭合等坏值：按裸值处理，交给"缺字段即忽略"的既有语义。
    }
  }
  return value
}

/**
 * 解析 SKILL.md 文本。
 *
 * 只认 `name` 与 `description`（官方解析器的硬要求）；缺任一返回 `undefined`
 * —— 与官方"忽略并警告"同一判定，不在这里自作聪明补默认值。
 * @param text - 文件全文。
 * @returns 结构化技能；不合法时 `undefined`。
 */
export function parseSkillFile(text: string): SkillDocument | undefined {  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return undefined
  const end = normalized.indexOf('\n---', 3)
  if (end < 0) return undefined

  const fields = new Map<string, string>()
  for (const line of normalized.slice(4, end).split('\n')) {
    const at = line.indexOf(':')
    if (at <= 0) continue
    fields.set(line.slice(0, at).trim(), scalarValue(line.slice(at + 1)))
  }

  const name = fields.get('name') ?? ''
  const description = fields.get('description') ?? ''
  if (name === '' || description === '') return undefined
  const body = normalized.slice(end + 4).replace(/^\n+/, '')
  return { name, description, content: body.trimEnd() }
}

/** 取出 frontmatter 的行区间（没有合法 frontmatter 时 `undefined`）。 */
function frontmatterOf(text: string): { lines: string[]; body: string } | undefined {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return undefined
  const end = normalized.indexOf('\n---', 3)
  if (end < 0) return undefined
  return { lines: normalized.slice(4, end).split('\n'), body: normalized.slice(end + 4) }
}

/** 一行 frontmatter 的键名（不是 `键: 值` 形状时返回空串）。 */
function keyOf(line: string): string {
  const at = line.indexOf(':')
  return at <= 0 ? '' : line.slice(0, at).trim()
}

/** 停用标记的两种写法：官方 kebab-case 与它明确拒收的 legacy camelCase（读的时候都认）。 */
const DISABLED_KEYS = ['disable-model-invocation', 'disableModelInvocation']

/**
 * 改写 `disable-model-invocation`（官方字段：禁止**模型**自动调用这条技能；文件照旧被官方加载）。
 *
 * 为什么用文本级改写、而不是"解析成对象再重新渲染"：技能文件可能是用户手写的、带官方增强字段
 * （`zh_name` / `emoji` / `category` / `user-invocable`…）。重新渲染会把它们全抹掉 ——
 * 那是**改一个开关毁一份文件**。这里只动那一行，其余原样保留。
 * @param text - 原始 SKILL.md 全文。
 * @param disabled - true 写入停用标记，false 删掉该行（恢复）。
 * @returns 改写后的全文；没有合法 frontmatter 时 `undefined`（调用方按"改不了"如实回报）。
 */
export function withDisabledFlag(text: string, disabled: boolean): string | undefined {
  const parts = frontmatterOf(text)
  if (parts === undefined) return undefined
  const kept = parts.lines.filter((line) => !DISABLED_KEYS.includes(keyOf(line)))
  if (disabled) kept.push('disable-model-invocation: true')
  return `---\n${kept.join('\n')}\n---${parts.body}`
}

/**
 * 这条技能是否被标了"禁止模型调用"（官方 `isModelInvocable` 的同一判定）。
 * @param text - SKILL.md 全文。
 * @returns 停用为 true；没有标记或文件不合法为 false。
 */
export function isModelDisabled(text: string): boolean {
  const parts = frontmatterOf(text)
  if (parts === undefined) return false
  for (const line of parts.lines) {
    if (!DISABLED_KEYS.includes(keyOf(line))) continue
    const at = line.indexOf(':')
    return scalarValue(line.slice(at + 1)).toLowerCase() === 'true'
  }
  return false
}

/**
 * 用表单内容替换 `name`/`description` 两行与正文，**保住**原文的其他 frontmatter 字段。
 *
 * 与 {@link withDisabledFlag} 同一条理由：技能文件可能带用户或官方工具写的增强字段
 * （`zh_name` / `emoji` / `category` / `user-invocable`…），整份重渲染会把它们抹掉。
 * @param raw - 原始 SKILL.md 全文。
 * @param draft - 表单里的新内容。
 * @returns 改写后的全文；原文没有合法 frontmatter 时按全新文件渲染。
 */
export function replaceSkillDocument(
  raw: string,
  draft: { name: string; description: string; content: string },
): string {
  const parts = frontmatterOf(raw)
  if (parts === undefined) {
    return renderSkillFile({ name: draft.name, description: draft.description, content: draft.content })
  }
  const kept = parts.lines.filter((line) => keyOf(line) !== 'name' && keyOf(line) !== 'description')
  kept.unshift(`name: ${yamlScalar(draft.name)}`, `description: ${yamlScalar(draft.description)}`)
  return `---\n${kept.join('\n')}\n---\n\n${draft.content.trimEnd()}\n`
}
