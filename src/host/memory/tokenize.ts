/**
 * 分词：把一句用户消息与一条记忆正文切成**可比较的记号**（中英文都要能用）。
 *
 * 为什么不用分词库：P-029 要求"不调用模型做查询改写"，同理也不该为一次检索引入词典依赖 ——
 * 记忆检索要的是"这两句在说同一件事吗"，不是语法分析。做法是**汉字二元组（bigram）+ 英文单词**：
 *
 * - 「我喜欢喝咖啡」⇒ 我喜 / 喜欢 / 欢喝 / 喝咖 / 咖啡。标签「咖啡」也切成 咖啡 ⇒ **能对上**；
 * - 不需要词典就能让"没空格的中文"有可匹配的单元，且不会把「咖啡」切碎成「咖」「啡」而误伤。
 *
 * 代价说清楚：bigram 会产生「我喜」这种无意义单元。它们同时出现在两边才计分，
 * 所以只是噪音，不会凭空制造命中；而真正的内容词一定出现在某个 bigram 里。
 * @module humanity/memory/tokenize
 */

/** 英文停用词（只收最没有信息量的一批；收了 `not` 是为了检索，冲突检测另有一套否定词表）。 */
const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'am',
  'to',
  'of',
  'and',
  'or',
  'for',
  'in',
  'on',
  'at',
  'by',
  'with',
  'it',
  'its',
  'this',
  'that',
  'these',
  'those',
  'i',
  'me',
  'my',
  'you',
  'your',
  'we',
  'our',
  'do',
  'does',
  'did',
  'not',
  'no',
  'yes',
  'so',
  'if',
  'then',
  'than',
  'as',
  'but',
  'please',
])

/** 汉字片段（含扩展 A 区与兼容区）。 */
const HAN_RUN = /\p{Script=Han}+/u

/** 非字母数字（Unicode 意义）都当分隔符 —— 标点、空白、emoji 都不参与匹配。 */
const SEPARATOR = /[^\p{L}\p{N}]+/u

/** 把一个词按"汉字段 / 非汉字段"切开（处理 `咖啡coffee` 这类混排）。 */
function segmentsOf(word: string): string[] {
  return word.match(new RegExp(`${HAN_RUN.source}|[^\\p{Script=Han}]+`, 'gu')) ?? []
}

/** 汉字段切成二元组；单字段就取它自己（不产生空集）。 */
function bigramsOf(run: string): string[] {
  if (run.length < 2) return [run]
  const grams: string[] = []
  for (let index = 0; index + 1 < run.length; index += 1) grams.push(run.slice(index, index + 2))
  return grams
}

/**
 * 切分文本。
 *
 * 规则：NFKC 归一 → 小写 → 按非字母数字切词 → 每段再按脚本切（汉字段出二元组、其余段长度 ≥2 且非停用词）。
 * @param text - 原始文本（消息、正文或标签）。
 * @returns 记号集合（去重；空文本得到空集）。
 */
export function tokenize(text: string): Set<string> {
  const tokens = new Set<string>()
  const normalized = text.normalize('NFKC').toLowerCase()

  for (const word of normalized.split(SEPARATOR)) {
    if (word === '') continue
    for (const segment of segmentsOf(word)) {
      if (HAN_RUN.test(segment)) {
        for (const gram of bigramsOf(segment)) tokens.add(gram)
        continue
      }
      if (segment.length >= 2 && !STOP_WORDS.has(segment)) tokens.add(segment)
    }
  }
  return tokens
}

/**
 * 两个记号集合的交集大小（关键词命中数）。
 * @param left - 集合 A。
 * @param right - 集合 B。
 * @returns 公共记号数。
 */
export function overlapCount(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let hits = 0
  for (const token of left) if (right.has(token)) hits += 1
  return hits
}
