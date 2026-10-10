/**
 * 模块页签：人格 / 记忆 / 技能 / 自进化四张**卡片**（用户 2026-09-26：「换成卡片式」）。
 *
 * 为什么单独一个文件：`TABS` 是"这一页有哪些模块"的唯一真源 —— 加模块只改一行；
 * 而"卡片长什么样"与"工作台主体怎么装配"是两件事，改动理由不同。
 * **「待确认」不在页签里**：它是"等你处理的事"，占了顶部一张常驻卡片（`PendingCard`）。
 *
 * 卡片本体用**官方 `Button`**（不是自己画的 `<button>` + 令牌）：hover、按下、焦点环、
 * 禁用态与深浅主题全由 DSH 的组件保证，我们只负责"四张等宽"这一层布局（用户 2026-09-26：
 * 「能用原生就用原生，这样连主题都不用适配了」）。
 * @module deepseek-harness-humanity/client/workbench-tabs
 */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

import { NS } from './locales.js'
import { tabBar } from './tab-styles.js'

/** 页签只放"内容页"；后续新增的页面也加在 `TABS` 里。 */
export type WorkbenchTab = 'persona' | 'memory' | 'skills' | 'evolution'

/** 四张模块卡（顺序即展示顺序）。 */
const TABS = [
  ['persona', 'memory.tab.persona'],
  ['memory', 'memory.tab.memory'],
  ['skills', 'skills.tab'],
  ['evolution', 'evolution.tab'],
] as const

/** 属性：字典座位 + 当前页签 + 切换回调。 */
export interface WorkbenchTabsProps extends PropsLocale<typeof NS> {
  tab: WorkbenchTab
  onSelect(tab: WorkbenchTab): void
}

/**
 * 渲染四张模块卡。
 * @param props - 字典座位、当前页签与切换回调。
 * @returns 卡片式页签栏（当前页用主按钮样式 + `aria-current="page"` 标出）。
 */
export function WorkbenchTabs({ t, tab, onSelect }: WorkbenchTabsProps) {
  return (
    <nav style={tabBar}>
      {TABS.map(([id, labelKey]) => (
        <Button
          key={id}
          size="sm"
          variant={tab === id ? 'primary' : 'outline'}
          style={{ width: '100%' }}
          aria-current={tab === id ? 'page' : undefined}
          onClick={() => onSelect(id)}
        >
          {t(labelKey)}
        </Button>
      ))}
    </nav>
  )
}
