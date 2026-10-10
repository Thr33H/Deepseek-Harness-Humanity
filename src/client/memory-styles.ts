/**
 * 记忆工作台的样式 token。
 *
 * 复用 `styles.ts` 里已有的面板/标题/提示样式，只把**记忆特有**的东西放这里：
 * 作用域标签配色、条目行、元信息行、操作区。放在同一个文件里是为了"看一眼就知道记忆页长什么样"。
 * @module deepseek-harness-humanity/client/memory-styles
 */
import type { CSSProperties } from 'react'

/** 三个作用域各一种色（长期/工作/会话），让用户一眼分辨这条记忆的适用范围。 */
export const SCOPE_COLORS: Readonly<Record<string, string>> = {
  'long-term': 'var(--dsw-alias-brand-primary)',
  workspace: 'var(--dsw-alias-state-success-primary)',
  session: 'var(--dsw-alias-label-secondary)',
}

/** 搜索行（输入框 + 重新加载）。 */
export const searchRow: CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }

/** 卡片标题行（标题 + 计数 + 折叠控件）。 */
export const cardTitleRow: CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'center',
  justifyContent: 'space-between',
}

/** 上一次操作的结论。 */
export const notice: CSSProperties = {
  marginTop: 8,
  fontSize: 12,
  color: 'var(--dsw-alias-label-secondary)',
}

/** 极简模式警告条：警示色背景 + 左边框，放在页面最上方。 */
export const degradedBanner: CSSProperties = {
  marginBottom: 12,
  padding: '10px 14px',
  borderLeft: '3px solid var(--dsw-alias-state-warning-primary, #d97706)',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-warning, rgba(217, 119, 6, 0.12))',
  fontSize: 13,
  lineHeight: 1.6,
}

/** 警告条正文。 */
export const degradedText: CSSProperties = { margin: '6px 0 0' }

/** 警告条里的技术原因（小字、次要色）。 */
export const degradedTech: CSSProperties = {
  margin: '4px 0 0',
  fontSize: 12,
  color: 'var(--dsw-alias-label-secondary)',
}


/**
 * 页头里的**失败原因**（读取失败、写入被拒、并发冲突…）。
 *
 * 用警示色而不是错误色：绝大多数是"这次没写成"，数据没坏；但**必须看得见** ——
 * 控制器一直在写 `state.error`，界面不显示就等于"悄悄失败"（G-002）。
 */
export const failure: CSSProperties = {
  margin: '4px 0 0',
  color: 'var(--dsw-alias-state-warn-label)',
  fontSize: 13,
}
