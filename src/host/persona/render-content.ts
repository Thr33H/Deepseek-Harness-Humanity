/**
 * 人格内容的**挑选与拆块**（纯函数）：从一份（形状可能残缺的）人格文档里挑出真正要注入的东西，
 * 再拆成"头部原子行 / 信息小节 / 尾部原子行"三块交给预算拟合。
 *
 * 为什么与 `render.ts`（最终字面文本）和 `render-fit.ts`（装不下时牺牲谁）分开：
 * 这三件事的改动理由完全不同 —— 挑内容看的是"哪些字段算数"，拆块看的是"顺序与优先级"，
 * 拟合看的是"预算怎么分"。混在一起时，改任何一件都要先读懂另外两件。
 * @module humanity/persona/render-content
 */
import { CORE_IDENTITY_KEYS } from './constants.js'
import { clip } from './clip.js'
import type { FitInput, FitSection } from './render-fit.js'
import { neutralizePromptVars } from '../text.js'
import type { PersonaDocument } from './types.js'

/** 渲染前的"可注入内容"：只留非空字段与非空小节（形状残缺的输入在这里被抹平成空）。 */
export interface RenderableContent {
  fields: Array<{ key: string; value: string }>
  sections: Array<{ title: string; items: string[] }>
  userDefined: Array<{ key: string; value: string }>
}

/**
 * 身份行里姓名部分的长度上限。
 *
 * 为什么不复用 `VALUE_SOFT_LIMIT`（120）：那个数是**一条条目**的口径，而这是**一句话里的一个名词**。
 * 120 字的"姓名"足以把整句身份陈述顶成一条啰嗦的规则，也会让 `head` 的原子行更难装进预算。
 * 24 字够容纳「本名：「示例」；别名：「例子」」这类玩法，又不可能变成一段话。
 */
const IDENTITY_NAME_LIMIT = 24

/**
 * 姓名字段在底色里的键名。
 *
 * 取自 {@link CORE_IDENTITY_KEYS} 的**第一位**，而不是再写一个 `'姓名'` 字面量：
 * `constants.ts:17-18` 明确写着"CORE_IDENTITY_KEYS 的顺序有意义（它就是展示顺序）"，
 * 所以"第一个核心字段 = 姓名"是**被文档承诺过的契约**，不是巧合。抄一个字面量则会在
 * 哪天改键名时静默失联（本文件已经吃过一次"两处各写一份规则"的亏）。
 */
const NAME_FIELD_KEY = CORE_IDENTITY_KEYS[0]

/**
 * 姓名字段里"这一串是标签不是值"的线索词。
 *
 * 有它们出现，就说明字段值是一段**带标签的描述**（例如「本名：「示例」；别名：「例子」」），
 * 而不是一个干净净的名字 —— 这时**必须**解析出真正的名字，解析不出就降级，
 * **绝不能把整串当名字**（2026-10-04 生产实测的缺陷，见 {@link identityNameOf}）。
 */
const NAME_LABEL_HINTS = ['本名', '姓名', '名字', '名称', '别名', '全名', '昵称'] as const

/**
 * 字段值超过这个长度就**不再尝试解析**。
 *
 * 为什么需要一道"太长就别猜"的闸：一个 100+ 字的字段值几乎不可能是一个名字，
 * 它要么是描述、要么是脏数据。此时正确的动作是**降级成不写名字**，
 * 而不是从里面截出 24 个字当作名字（那正是本轮要修的"把整串当名字"的另一种形态）。
 * 取 120：刚好覆盖「本名：「X」；别名：「Y」」这类玩法的合理上限（`VALUE_SOFT_LIMIT` 同量级）。
 *
 * 与本闸**成对**的是 {@link IDENTITY_NAME_LIMIT}（名字本身的上限）。两者口径一致 —— 超了都降级，
 * 谁也不截断（2026-10-05 统一，见 0.1.8 缺陷②）：本闸管"值太脏、连解析都不试"，
 * 那道闸管"解析出来的名字太长、不当名字用"。
 */
const NAME_FIELD_MAX = 120

/**
 * 从一段"带标签的姓名描述"里解析出名字；解析不出返回 `undefined`。
 *
 * 规则（**宁可解析不出，也不猜**）：
 * 1. **明确锚点**：`本名` 这类标签后紧跟 `：「X」` 或 `：X` ⇒ 取 `X`；
 * 2. 无锚点、但整串**只有一个**成对引号段（`「X」` / `"X"` / `'X'`）⇒ 取 `X`；
 * 3. 无锚点、无引号段、也**不含任何标签线索词** ⇒ 视为"本来就是个干净名字"，整串收下
 *    （「小安」这种最常见、也最安全的形态）；
 * 4. 其余（有标签却解析不出、多个引号段看不出哪个是名字…）⇒ `undefined`，交由调用方降级。
 * @param text - 已取第一行、已 trim 的字段值。
 * @returns 名字；判不出来时 `undefined`。
 */
function parseNameFromField(text: string): string | undefined {
  /**
   * "这一串够格当名字吗"的**唯一闸口**（锚点捕获 / 单引号段 / 整串收下，三条路径都过它）。
   *
   * ⚠️ 2026-10-05 修（0.1.8 缺陷①）：**纯标点不是名字**。
   * `本名：；别名：` 这种"标签写了、值空着"的输入，会让下面的**裸值分支**抓到那个 `：` 本身
   * （`：` 不在裸值分支的排除集里、`\s*[:：]?\s*` 会回溯成不消费它）⇒ `identityNameOf` 返回 `"："`、
   * 身份行变成「…一台机器上的「：」」—— **比降级更糟**（降级只是不写名字，这个是写了个假名字）。
   * 判据取"必须含至少一个实义字符"（字母/数字/汉字…），标点与空白一律不算 ⇒ 当作"没写"。
   * 放在这个闸口而不是只改正则：正则那处只能堵住一种形状，这里是**所有**取名路径的总闸。
   */
  const clean = (value: string): string | undefined => {
    const trimmed = value.trim()
    if (trimmed === '') return undefined
    if (!/[\p{L}\p{N}]/u.test(trimmed)) return undefined
    return trimmed
  }

  // 1) 明确锚点：`本名：「X」` / `本名：X` / `本名 X`
  for (const label of NAME_LABEL_HINTS) {
    const anchored = new RegExp(
      `${label}\\s*[:：]?\\s*(?:[「『"']([^」』"']+)[」』"']|([^\\s;；,，。「『"']+))`,
    ).exec(text)
    const hit = clean(anchored?.[1] ?? anchored?.[2] ?? '')
    if (hit !== undefined) return hit
  }

  // 2) 没有锚点，但整串只有一个引号段 ⇒ 那就是名字。
  const quoted = [...text.matchAll(/[「『"']([^」』"']+)[」』"']/g)].map((match) => match[1] ?? '')
  if (quoted.length === 1) return clean(quoted[0] as string)

  // 3) 无锚点、无引号段、也不含任何标签线索 ⇒ 本来就是个干净名字。
  // ⚠️ 2026-10-05 修（0.1.8 附带发现的第三条，同源同害）：这里原先**漏了"无引号段"这一条**
  // （上面规则 2 与规则 4 都白纸黑字写着这条前提），于是 `「小安」和「小亮」` 这种
  // "多个引号段、分不清哪个是名字"的值会掉进本分支、**被整串收下**——
  // 身份行于是又出现 `「「小安」和「小亮」」`，正是 P0-4 那条"整串当名字"的旧病复发。
  // 现在把 `quoted.length === 0` 补上：有引号段却定不下是哪一个 ⇒ 落到规则 4 降级（不猜）。
  const hasHint = NAME_LABEL_HINTS.some((label) => text.includes(label))
  if (quoted.length === 0 && !hasHint && !/[;；,，:：]/.test(text)) return clean(text)

  // 4) 判不出来 —— 不猜。
  return undefined
}

/**
 * 从信息底色字段里取**姓名**，并洗成"可以安全放进一句话里的一个名词"。
 *
 * 为什么需要它（2026-10-04，修 task-21 的 P0-4 残项）：初版身份行把名字**写死**成「小安」。
 * 信息是可换名的，写死会让同一段提示词里出现两个名字 —— 实测中模型
 * 选了卡里的值（"我是小安，全名「小安」"），但**那是侥幸，不是保证**。
 *
 * 清洗规则（都只针对"放进句子"这一件事）：
 * 1. **值必须是单行** —— 字段值允许换行（对方会写「本名：X；别名：Y」甚至多行），
 *    而身份行是 `head` 里的**原子行**，里面出现换行会把一句话劈成两行、打乱段落结构；
 *    ⚠️ 2026-10-05 订正措辞（0.1.8）：旧文档写的是"只取第一行"，而实现从 0.1.7 起就是
 *    **多行一律降级**（不猜哪一行是名字，见下方 `lines.length > 1` 那处）。文档对齐实现；
 * 2. **名字超过 {@link IDENTITY_NAME_LIMIT} 就不再当名字**（降级 `undefined`，**不截断**）；
 *    ⚠️ 2026-10-05 改（0.1.8 缺陷②）：旧口径是"超长只截断不报错"，于是 25–120 字的值会被切成
 *    `前 24 字…` 塞进身份行 —— 与 `NAME_FIELD_MAX` 注释里"不该从里面截出 24 个字当作名字"
 *    自相矛盾。现在两道闸（`NAME_FIELD_MAX` 与 {@link IDENTITY_NAME_LIMIT}）**都只降级、不截断**。
 * 3. 控制字符与 ANSI 已由 `collectPersonaContent` 的 `stripControlChars` 预先剥掉，
 *    `{{` 也已被 `neutralizePromptVars` 中和（`{{` ⇒ `{ {`），所以这里不重复做。
 * @param content - 已挑好并净化过的内容。
 * @returns 可嵌入句子的姓名；**取不到时返回 `undefined`**（由调用方决定降级）。
 */
export function identityNameOf(content: RenderableContent): string | undefined {
  const field = content.fields.find((entry) => entry.key === NAME_FIELD_KEY)
  const lines = (field?.value ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  if (lines.length === 0) return undefined
  // ⚠️ 单行是**硬要求**：身份行是 `head` 里的原子行，换行会把一句话劈成两半。
  // 但"只取第一行"有个隐患 —— 值若写成「姓名」+ 换行 + 「小安」，第一行是标签、名字在第二行，
  // 照第一行解析就会判不出而静默降级（对方明明写了名字）。两难之下取**保守**的一边：
  // 多行 ⇒ 直接判为"判不出来"（降级成不写名字），**不猜**哪一行是名字。
  if (lines.length > 1) return undefined

  const firstLine = lines[0] as string

  // 太长 ⇒ 不猜：100+ 字的字段值不可能是名字，降级比"截出 24 个字当名字"安全。
  if (firstLine.length > NAME_FIELD_MAX) return undefined

  // 解析真正的名字；判不出来就 undefined（调用方降级成"一台机器上的一个 AI"）。
  // ⚠️ 不在这之前截断输入：截断会把 `本名：「很长的名字…」` 的收尾引号切掉，
  // 于是正则匹配不上、白白降级（第一版就这样，实测拿回一个 `：`）。
  // 正确做法是**先把名字解析出来，再判它够不够格当名字**（见下）。
  const name = parseNameFromField(firstLine)
  if (name === undefined) return undefined

  // 兜底：解析结果里若仍残留标签线索词，说明判错了 ⇒ 也当判不出来（不猜）。
  if (NAME_LABEL_HINTS.some((label) => name.includes(label))) return undefined

  // 限长：**超过就降级，不截断**（2026-10-05 改，0.1.8 缺陷②）。
  // 旧写法是 `name.slice(0, 24) + '…'` —— 而名字是"一句话里的一个名词"，
  // 塞一句被切掉的残句进去只会让模型把残句当名字念（「…机器上的「某某某某某某…」」）。
  // 这与 `NAME_FIELD_MAX` 注释的立场（宁可降级，也不截出 24 个字当名字）本来就是同一件事，
  // 只是旧实现只在那道闸上执行、在这道闸上放行 ⇒ 现在两道闸口径统一：**只降级，不截断**。
  return name.length <= IDENTITY_NAME_LIMIT ? name : undefined
}

/**
 * 挑出真正要注入的内容。
 *
 * 逐层 `?.`/`??`：提示词路径上的输入来自设置文档，我们没有权力假设它一定完整。
 *
 * **`{{` 在这里就中和掉**（2026-09-26 审计 P7）：中和会把 `{{` 变成 `{ {`（每个多一个字符），
 * 放在拟合**之后**做，预算就是按"没中和的文本"算的，最终注入长度可能超出上限；放在这里做，
 * 拟合看到的字符串与真正进提示词的完全一致。人格段外层仍保留一次中和（幂等，当兜底）。
 * @param doc - 当前生效的人格文档（可能是形状不对的值）。
 * @returns 非空的底色字段、信息小节与兜底条目。
 */
export function collectPersonaContent(doc: PersonaDocument): RenderableContent {
  const safe = neutralizePromptVars
  return {
    fields: (doc?.identityCard?.fields ?? [])
      .filter((field) => (field?.value ?? '').trim() !== '')
      .map((field) => ({ key: safe(field?.key ?? ''), value: safe(field?.value ?? '') })),
    sections: (doc?.mutableLayer?.sections ?? [])
      .map((section) => ({
        title: safe(section?.title ?? ''),
        items: (section?.items ?? [])
          .filter((item) => (item ?? '').trim() !== '')
          .map((item) => safe(item ?? '')),
      }))
      .filter((section) => section.title !== '' && section.items.length > 0),
    userDefined: (doc?.mutableLayer?.userDefined ?? [])
      .filter((entry) => (entry?.value ?? '').trim() !== '')
      .map((entry) => ({ key: safe(entry?.key ?? ''), value: safe(entry?.value ?? '') })),
  }
}

/**
 * 把内容拆成"拟合用的块"：头部原子行（身份声明 + 底色）、信息小节、尾部原子行（自定义）。
 *
 * 与旧实现的区别：小节**不再先拼成一整行**。旧写法让"一个小节"在预算面前是不可分割的，
 * 放不下就整节消失（真机上 7 节丢了 3 节）；现在交给 `fitPersonaContent` 逐条装。
 * @param content - 已挑好的非空内容。
 * @returns 拟合输入。
 */
export function blocksOf(content: RenderableContent): FitInput {
  // 版式（2026-11-15 用户定稿）：
  //   ## 你是{姓名}
  //   - 姓名：…
  //   - 性别：…
  //   ## 你的信息
  //   - 对TA的称呼：…
  //
  // 以前这里先铺三行"身份腔"的元说明（「你是谁（人格底色）…」「我是运行在 DeepSeek Harness
  // 里的一台机器上的一个 AI…」「不说我在扮演」）。用户 2026-11-15 的裁定：那三行**没有说明
  // 身份，反而在反复强调"我是一个 AI"**，等于把客服/帮手的自我认知按回模型身上。已整段删除，
  // 身份只由标题 + 卡片内容正面陈述。
  const name = identityNameOf(content)
  const head: string[] = [name === undefined ? '## 你是谁' : `## 你是${name}`]
  for (const field of content.fields) {
    const core = (CORE_IDENTITY_KEYS as readonly string[]).includes(field.key) ? '' : '（自定义）'
    head.push(`- ${field.key}${core}：${clip(field.value)}`)
  }
  if (content.sections.length > 0) head.push('', '## 你的信息')

  const sections: FitSection[] = content.sections.map((section) => ({ title: section.title, items: section.items }))

  const tail: string[] = []
  if (content.userDefined.length > 0) {
    tail.push('## 自定义')
    for (const entry of content.userDefined) tail.push(`- ${entry.key}：${clip(entry.value)}`)
  }

  return { head, sections, tail }
}
