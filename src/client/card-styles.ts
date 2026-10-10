/**
 * **全工作台统一的一条卡片的排布**（2026-09-26 设计定稿；用户给了个手绘框架，这里把它做成能装下
 * "任意多个元信息、任意多个按钮"的东西）。
 *
 * ```text
 * ┌──────────────┬────────────────────────────────┬──────────────┐
 * │ 状态 类别 …  │  内容（这条到底是什么）         │  动作 …      │
 * │ 归属/时间/…  │  说明 / 理由 / 统计             │  （1..N 个） │
 * │ （1..N 行）  │  （1..N 行）                    │              │
 * ├──────────────┴────────────────────────────────┴──────────────┤
 * │ 跨整卡的一行：警告 / 注记 / 差异 / 叙事                        │
 * └──────────────────────────────────────────────────────────────┘
 * ```
 *
 * **三段各司其职，每个条目都一样**：
 * - **左 · 元信息**：这条东西"是什么状态、属于谁、什么时候的"。标签放第一行，细节跟在下面。
 *   格数不固定 —— 标签自动换行、小字行可以有多行；**可编辑的元信息（例如记忆归属下拉）也在这里**，
 *   不必去别处找。
 * - **中 · 实际内容**：主体。第一行是这条的"名字"（记忆正文 / 技能名 / 提案标题 / 运行时刻），
 *   后面跟说明、理由、统计。
 * - **右 · 操作**：这条能做的事，**永远在最右**。1 个到 5 个都行，放不下自动换行。
 * - **跨卡行**：关于**整条**的提醒（警告、差异、梦境叙事）横跨三列 —— 塞进中列会看起来像内容的一部分。
 *
 * **为什么是这个形状**（用户原话：「包括人格、记忆、技能……总之有很多条目，风格统一」）：
 * 改之前四个页面四种读法 —— 记忆是"内容 + 下面一行元信息 + 右边按钮"，技能是"标题行 + 说明 +
 * 元信息 + 左下按钮"，提案与运行记录又各是另外两种。同一件事（一条东西 + 它的状态 + 它能做的操作）
 * 每次都要重新找一遍。
 *
 * **列宽与对齐**：左列与人格页的项名列**用同一组尺寸**（`minmax(96px, 160px)`，见 `editor-styles.itemGrid`）
 * —— 于是"标签 → 内容 → 操作"这条基线在整个工作台是同一条。左列**定宽**而不是按内容收缩：
 * 一条长路径会把它撑开、把内容挤扁，而定宽之后所有卡片的正文都从同一个 x 开始，列表更好扫。
 * （0.1.13 起人格页把"操作"列并进了项名下方 —— 那边的删除按钮属于项名那一列，卡片骨架仍是三列。）
 *
 * 容器本身没有官方原语（0.1.5-rc.2 的 primitives 里没有 Card/ListItem，见 P-054 那份清单），
 * 所以外壳由我们用 **DSH 设计令牌**画；里面的标签、按钮、下拉、开关**一律是官方原语**。
 * @module deepseek-harness-humanity/client/card-styles
 */
import type { CSSProperties } from 'react'

/** 卡片外壳：细边框 + 一层底色 + 10px 圆角（所有列表共用同一种壳）。 */
export const card: CSSProperties = {
  padding: '10px 12px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 10,
  background: 'var(--dsw-alias-bg-layer-2)',
}

/**
 * 卡片骨架：左元信息 / 中内容 / 右操作。
 *
 * `alignItems: 'start'` 而不是 `center`：内容有长有短，**操作按钮要对齐第一行** ——
 * 位置可预测比"垂直居中好看"重要（一条理由写三行时，居中的按钮会飘到段落中间）。
 */
export const cardLayout: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(96px, 160px) minmax(0, 1fr) max-content',
  alignItems: 'start',
  gap: 12,
}

/** 左列：标签一行（可 1..N 个，自动换行）+ 若干行小字。 */
export const cardMeta: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 4,
  minWidth: 0,
}

/** 左列第一行：状态 / 类别 / 归属标签，放不下就换行。 */
export const cardTags: CSSProperties = { display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }

/** 左列的细节行（时刻、路径、重要度…）。长路径在列宽内断行，完整值放 `title`。 */
export const cardNote: CSSProperties = {
  maxWidth: '100%',
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-secondary)',
  overflowWrap: 'anywhere',
}

/** 中列：实际内容。 */
export const cardBody: CSSProperties = { minWidth: 0 }

/** 中列第一行 —— 这条东西的"名字"（记忆正文 / 技能名 / 提案标题 / 运行时刻）。 */
export const cardTitle: CSSProperties = {
  display: 'block',
  fontSize: 14,
  fontWeight: 600,
  lineHeight: 1.6,
  color: 'var(--dsw-alias-label-primary)',
  overflowWrap: 'anywhere',
}

/** 中列的后续行（说明、理由、统计、来源）。 */
export const cardLine: CSSProperties = {
  margin: '4px 0 0',
  fontSize: 13,
  lineHeight: 1.6,
  color: 'var(--dsw-alias-label-secondary)',
  overflowWrap: 'anywhere',
}

/** 右列：操作按钮，靠右排（1..N 个，放不下换行）。 */
export const cardActions: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: 6,
  flexWrap: 'wrap',
}

/** 横跨整张卡的一行（警告 / 注记 / 差异）。 */
export const cardSpan: CSSProperties = { gridColumn: '1 / -1', marginTop: 8 }

/** 跨列的小字（注记、警告）。 */
export const cardSpanLine: CSSProperties = {
  margin: 0,
  fontSize: 13,
  lineHeight: 1.6,
  color: 'var(--dsw-alias-label-secondary)',
  overflowWrap: 'anywhere',
}

/** 跨列的细内容块（差异）：官方代码字体 + 上限高度 + 可滚动。 */
export const cardPre: CSSProperties = {
  margin: 0,
  padding: '8px 10px',
  maxHeight: 200,
  overflow: 'auto',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-3)',
  color: 'var(--dsw-alias-label-secondary)',
  // 代码字体用官方 token：DSH 自己的 DiffBlock / TerminalBlock 就是这个。
  font: 'var(--dsw-font-markdown-code-block)',
  lineHeight: 1.5,
  whiteSpace: 'pre-wrap',
}

/** 长正文（梦境叙事）跨列展开时的正文块。 */
export const cardProse: CSSProperties = {
  margin: 0,
  fontSize: 13,
  lineHeight: 1.7,
  color: 'var(--dsw-alias-label-secondary)',
  overflowWrap: 'anywhere',
}

/** 列表容器：卡片之间留 8px（原来是行与行贴在一起）。 */
export const cardList: CSSProperties = {
  listStyle: 'none',
  padding: 0,
  margin: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
}
