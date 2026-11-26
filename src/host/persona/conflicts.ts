/**
 * 人格内部的**语义冲突**检测（同一小节内的"做 / 不做"对立）。
 *
 * ### 为什么需要
 * `validate` 一直只查结构（重复键、锁定节、冒牌字段名）。于是「叫对方」和「不准叫对方」
 * 可以同时躺在一节里，注入时两句都进提示词 —— 模型的行为就变成随机的，而对方在工作台上
 * 看不出"这两条在打架"。2026-11-16 设计评审把它列为待修项 P6，这里落地。
 *
 * ### 判据（保守：宁可漏报，不误伤）
 * 只有同时满足三条才算冲突：
 * 1. **同一小节**（跨小节的语境差异太大，不做跨节判定）；
 * 2. **极性相反**：一条含否定词、另一条不含；
 * 3. **去掉否定词之后高度相似**（字符二元组 Jaccard ≥ 阈值，或短句是长句的子串且占比够大）。
 *
 * 反例（应当**不**判为冲突，测试里钉住）：
 * - 「不喜欢吵」vs「不讨厌安静」—— 去掉否定词后毫不相似；
 * - 「话少但句句有落点」vs「不要话少」—— 相似度不够（后者只是前者的一个片段）；
 * - 分处两节的同类句子 —— 结构是对方分的，不做跨节推断。\n *\n * ### 已知漏报（有意接受）\n * 否定词把动词一起吃掉时抓不到，例如「用敬语」vs「不用敬语」（去掉「不用」后只剩「敬语」）。\n * 这种形态要么靠提高相似度阈值去抓，要么靠词性分析 —— 两者都会带来误报，而误报会拦住对方\n * 正常的保存。宁可漏报：漏了只是没帮上忙，误报是替他做了决定。
 *
 * ### 只拒绝，不删除
 * 冲突时的动作是**拒绝写入并告诉模型"留哪条"**，而不是替对方选一条删掉 —— 判定有误报空间，
 * 删错了是不可逆的（虽然进历史），而让人/模型来选是零风险。
 * @module humanity/persona/conflicts
 */

/** 否定词表（长词在前：先匹配「不要」再轮到「不」，避免把「不要」拆成两个标记）。 */
const NEGATIONS = ['不要', '不准', '不许', '不能', '不必', '无需', '不用', '禁止', '别把', '别', '勿', '甭', '不'] as const

/** 判定用的相似度阈值（字符二元组 Jaccard）。0.6 = "两句几乎是同一件事的两种说法"。 */
const SIMILARITY_THRESHOLD = 0.6

/** 子串包含判定的长度占比门槛（短句至少占长句的六成，才算"同一句话"）。 */
const CONTAINMENT_RATIO = 0.6

/** 归一化后短于这个长度就不判定：两三个字的短语相似度没有意义。 */
const MIN_NORMALIZED_LENGTH = 2

/** 一条文本是否含否定。 */
export function hasNegation(text: string): boolean {
  return NEGATIONS.some((word) => text.includes(word))
}

/**
 * 归一化：去掉空白与标点、去掉否定词、统一小写。
 *
 * 去掉否定词是关键：这样「叫对方」与「不准叫对方」在**内容层面**是同一句话，
 * 差异只剩下"极性"，而那正是我们要判的东西。
 * @param text - 原始条目。
 * @returns 归一化文本。
 */
export function normalizeForConflict(text: string): string {
  let result = text
  for (const word of NEGATIONS) result = result.split(word).join('')
  // 空白与常见中英标点一律去掉：条目里的逗号、引号不该影响"是不是同一件事"。
  return result.replace(/[\s，。、；：！？…—·「」『』（）()【】[\]"'“”‘’《》<>~!?,.:;]+/g, '').toLowerCase()
}

/** 字符二元组集合。 */
function bigrams(text: string): Set<string> {
  const grams = new Set<string>()
  for (let index = 0; index + 1 < text.length; index += 1) grams.add(text.slice(index, index + 2))
  return grams
}

/** 两句归一化文本的相似度（Jaccard）。 */
function similarity(left: string, right: string): number {
  const a = bigrams(left)
  const b = bigrams(right)
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const gram of a) if (b.has(gram)) shared += 1
  return shared / (a.size + b.size - shared)
}

/**
 * 两条条目是否互相矛盾。
 * @param left - 条目 A。
 * @param right - 条目 B。
 * @returns 是否冲突（极性相反且内容高度相似）。
 */
export function conflicts(left: string, right: string): boolean {
  // 极性必须相反：两条都否定（"别这样""不要那样"）不算打架。
  if (hasNegation(left) === hasNegation(right)) return false

  const a = normalizeForConflict(left)
  const b = normalizeForConflict(right)
  if (a.length < MIN_NORMALIZED_LENGTH || b.length < MIN_NORMALIZED_LENGTH) return false
  if (a === b) return true

  // 子串包含：短的那句几乎就是长的那句的骨架（"用敬语" ⊂ "跟长辈说话要用敬语"）。
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a]
  if (longer.includes(shorter) && shorter.length / longer.length >= CONTAINMENT_RATIO) return true

  return similarity(a, b) >= SIMILARITY_THRESHOLD
}

/** 一对冲突（下标指向传入的 items）。 */
export interface ConflictPair {
  left: number
  right: number
}

/**
 * 在一节的条目里找出所有冲突对。
 * @param items - 该节的条目（顺序即文档顺序）。
 * @returns 冲突对（左下标 < 右下标）。
 */
export function findConflicts(items: readonly string[]): ConflictPair[] {
  const pairs: ConflictPair[] = []
  for (let left = 0; left < items.length; left += 1) {
    for (let right = left + 1; right < items.length; right += 1) {
      if (conflicts(items[left] ?? '', items[right] ?? '')) pairs.push({ left, right })
    }
  }
  return pairs
}
