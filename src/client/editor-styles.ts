/**
 * 人格**编辑区**的样式（字段行、问题列表、底栏）。
 *
 * 与 `styles.ts` 的分工：那边是页面外壳（标题/面板/指标/页面表），这边是编辑器内部。
 * 仍然全部走内联样式 + DSH 设计令牌（P-050），不注入样式表 —— 理由见 `styles.ts` 的文件头。
 * @module deepseek-harness-humanity/client/editor-styles
 */
import type { CSSProperties } from 'react'

/* ── 人格编辑区（M2 步 6）──────────────────────────────────────────────── */

/** 编辑区分组标题（固定层 / 可变层 / 用户定义）。 */
export const groupTitle: CSSProperties = {
  margin: '20px 0 6px',
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--dsw-alias-label-primary)',
}

/**
 * 三栏的**列宽定义**（唯一真源：列表网格与添加入口的内部网格都用它，两处必然对齐）。
 *
 * | 轨 | 值 | 作用 |
 * |---|---|---|
 * | ① 名称 | `minmax(96px, 160px)` | 固定窄宽；与卡片骨架（`card-styles.cardLayout`）同一组尺寸 |
 * | ② 内容 | `minmax(240px, 1fr)` | **弹性吃满剩余**，同时给出**可用下限 240px** |
 * | ③ 动作 | `max-content` | 按按钮实际宽度收缩（两种语言都自适应） |
 *
 * **中间轨为什么带 `240px` 下限**（用户 2026-10-09 的硬要求）：三栏会让内容栏变窄，
 * 而"内容看不全"正是他报过的障。把下限写进模板 ⇒ "内容栏拿到的宽度 ≥ 240px"是**构造上成立**的，
 * 判据 V18 直接从渲染出来的 `grid-template-columns` 里读这个数（阴性对照：固定窄宽模板必须判失败）。
 * 视口窄到 96+240+按钮宽 放不下时，宁可让这一行横向溢出（3 个字也能读），也不把内容栏压回去。
 */
export const ITEM_TRACKS = 'minmax(96px, 160px) minmax(240px, 1fr) max-content'

/**
 * **列表网格**：一列容器装下所有项的三格（名称 | 内容 | 动作）。
 *
 * 为什么是"一个共享网格"而不是"每项一个小网格"：第三轨是 `max-content`（按内容收缩），
 * 若每项各自成网格，**没有按钮的锁定行**的第三轨就是 0 ⇒ 每行的中间列宽都不一样、
 * 输入框右边缘参差不齐（用户要的"整齐"就没了）。共享网格下第三轨取所有行的最大值，
 * 于是**每一行的三列严格对齐**；锁定行只需一个**空的**动作格占位（见 `ActionsCell`）。
 *
 * `alignItems: 'center'` 是三格**垂直居中**（要求 1）：多行内容框高的行里，名称与按钮居中，
 * 不再像旧版那样贴着第一行。`rowGap` 取代了旧版每项的 `marginBottom`。
 */
export const itemList: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: ITEM_TRACKS,
  alignItems: 'center',
  columnGap: 12,
  rowGap: 8,
}

/**
 * **添加入口的内部网格**：与 {@link itemList} 同一套列宽（所以输入区与上面的项严格对齐）。
 *
 * 与列表网格的区别：只有一行，所以不需要 `rowGap`。
 */
export const itemGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: ITEM_TRACKS,
  alignItems: 'center',
  columnGap: 12,
}

/**
 * **动作栏**（第三格）：「改名」「删除」左右并排（真机反馈："要并排"，不要一个占一行）。
 *
 * 它是网格的第三格（`max-content`），所以宽度天生就是两个按钮的宽度；
 * `flexWrap: 'nowrap'` 保证这两个永远在同一行。
 */
export const itemActions: CSSProperties = {
  display: 'flex',
  flexDirection: 'row',
  alignItems: 'center',
  flexWrap: 'nowrap',
  gap: 4,
}

/** 改名被拦下的原因（一行小字，横跨三栏跟在该项下面；原来在名字输入框下方）。 */
export const renameIssueText: CSSProperties = {
  fontSize: 12,
  color: 'var(--dsw-alias-state-warn-label)',
  overflowWrap: 'anywhere',
}

/**
 * 内容控件的包装层（`Content`）：**撑满内容列，并且把里面的控件也撑满**。
 *
 * ⚠️ **真机缺陷的根因就在这一行**（2026-10-09 用户截图："身份卡的输入框内容被截断得厉害、
 * 人格卡的多行框正常"）：原语 `Input` 的真实结构是
 * `<span class="wrap" style="display:inline-flex">` + 内层 `<input style="flex:1">`
 * （见 `@deepseek-ai/dsh-client-ui-primitives/lib/Input.module.css`）——
 * 外层是 **inline-flex（收缩到内容宽）**。0.1.12 时 `Input` 是**grid 的直接子项**，
 * grid 的 `justify-self: stretch` 会把它拉满那一列，所以看不出问题；0.1.13 给它加了一层
 * `data-persona-content` 包装（为了可机械复核），包装层是 `display:block` ——
 * **block 不会拉伸子元素**，于是 `.wrap` 退回收缩宽（≈ 输入框默认 20 字符 ≈ 135px），
 * 长值就被"框"截住了。`<textarea>` 没事，是因为它自带 `width: 100%`（见 {@link textarea}）。
 *
 * 修法：包装层改成**纵向 flex**（`align-items: stretch` 默认就会把子项在横向上拉满）——
 * 一处修好所有走这个包装的控件（身份卡值 / 用户定义值 / 改名输入框 / 底部添加表单的两个输入框）。
 * `width: 100%` 只是把意图写明；**真正起作用的是 flex 列拉伸**（只加 `width:100%` 而不改 flex
 * 仍然是坏的 —— 判据 V15 的阴性对照就钉这一点）。
 */
export const editorCell: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  width: '100%',
  minWidth: 0,
}

/** 删除的二次确认带：横跨整项、警示边框、确认与取消并排。 */
export const deleteBand: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 8,
  marginTop: 6,
  padding: '8px 10px',
  border: '0.5px solid var(--dsw-alias-border-l4)',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-1)',
  fontSize: 13,
  color: 'var(--dsw-alias-label-secondary)',
}

/**
 * 底部**添加入口展开后的外框**：横跨三栏的一行，只在上方加一条虚线把它和上面的项分开。
 *
 * 为什么不用旧版的"带边框的面板"（`addForm`）：面板的内边距会把里面的输入框整体右移
 * ≈10px，与上面那些项的三栏**对不齐**（用户要的"整齐"就毁在这 10px 上）。
 * 现在只加 `paddingTop` + 虚线：纵向有分隔，横向**零偏移**，内部网格与列表网格严格对上。
 */
export const addBand: CSSProperties = {
  gridColumn: '1 / -1',
  marginTop: 4,
  paddingTop: 10,
  borderTop: '0.5px dashed var(--dsw-alias-border-l4)',
}

/** 左列的标签（字段名 / 小节名）。 */
export const fieldLabel: CSSProperties = {
  fontSize: 13,
  color: 'var(--dsw-alias-label-secondary)',
  overflowWrap: 'anywhere',
}

/** 多行输入：原语里没有 Textarea，用主题令牌自绘一个，视觉与 `Input` 对齐。 */
export const textarea: CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  minHeight: 64,
  padding: '7px 10px',
  // 令牌与官方 `Input` 对齐（用户 2026-09-26：控件尽量走原生，别让表单里出现两种底色）——
  // 官方没有多行原语，所以这里是唯一一处自己画边框的输入控件，样式按原语抄。
  border: '0.5px solid var(--dsw-alias-border-l4)',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  fontSize: 14,
  lineHeight: 1.5,
  resize: 'vertical',
}

/** 底部动作条：右侧对齐的按钮组与左侧状态文字。 */
export const footer: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  marginTop: 20,
  paddingTop: 12,
  borderTop: '1px solid var(--dsw-alias-border-l2)',
}

/** 底部操作区：右对齐的按钮组。 */
export const actions: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
}

/** 状态与错误文案的排版。 */
export const statusText: CSSProperties = {
  margin: 0,
  fontSize: 13,
  color: 'var(--dsw-alias-label-secondary)',
}

/** 问题清单：拒绝项用告警色，警告项用次要色。 */
export const issueList: CSSProperties = {
  margin: '8px 0 0',
  paddingInlineStart: 20,
  fontSize: 13,
}

/** 阻断级问题（红色，必须处理后才能保存）。 */
export const issueRejected: CSSProperties = {
  color: 'var(--dsw-alias-label-error, var(--dsw-alias-label-primary))',
}

/** 警告级问题（不阻断保存）。 */
export const issueWarning: CSSProperties = {
  color: 'var(--dsw-alias-label-secondary)',
}

/** 问题条目的定位后缀（`path`），等宽以便对齐阅读。 */
export const issuePath: CSSProperties = {
  fontFamily: 'var(--dsw-font-family-mono, monospace)',
  fontSize: 12,
  color: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))',
}

/**
 * 卡片内部的横向分隔线（身份卡里"开关 / 字段"之间那条）。
 *
 * 用 `hr` + 主题边框色，而不是给某一块加 `border-bottom`：分隔线属于"两块内容之间"，
 * 不属于任何一块；这样两块各自怎么改都不会把线弄丢或重复。
 */
export const divider: CSSProperties = {
  margin: '14px 0',
  border: 'none',
  borderTop: '1px solid var(--dsw-alias-border-l2)',
}

/**
 * 人格卡的**注入预算警告**（超出预算、有条目进不了提示词）。
 *
 * 用警示色而不是错误色：这不是故障 —— 卡片写多了而已，合并重复条目就能装回去。
 * 与记忆页的降级条同一个口径：**如实说、但不吓人**。
 */
export const budgetWarning: CSSProperties = {
  margin: '0 0 10px',
  color: 'var(--dsw-alias-state-warn-label)',
  fontSize: 13,
}
