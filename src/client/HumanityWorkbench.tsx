import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { useState } from 'react'

import { EmotionPage } from './EmotionPage.js'
import { InfoHint } from './InfoHint.js'
import { MemoryPage } from './MemoryPage.js'
import { OverviewPanel } from './WorkbenchOverview.js'
import { PersonaEditor } from './PersonaEditor.js'
import { WorkbenchTabs, type WorkbenchTab } from './WorkbenchTabs.js'
import type { EmotionWorkbenchController } from './emotion-controller.js'
import type { MemoryWorkbenchController } from './memory-controller.js'
import { NS } from './locales.js'
import type { PersonaWorkbenchController } from './persona-controller.js'
import { column, page, title, titleRow } from './styles.js'

/** 工作台属性：座位注入的本地化座位，加上闭包递进来的控制器。 */
export interface HumanityWorkbenchProps extends PropsLocale<typeof NS> {
  controller: PersonaWorkbenchController
  /** 情绪工作台控制器（只读观察窗）。 */
  emotion: EmotionWorkbenchController
  /** 记忆工作台控制器。 */
  memory: MemoryWorkbenchController
}

/**
 * Humanity 主工作台。
 *
 * 结构：标题（说明收进 ?）+ 总览 + 三张模块卡片页签 + 当前页签的内容。
 * 数据只有一条来源：各控制器经 `connection`（自有数据面）读写。
 * @param props - 字典座位与三个工作台控制器。
 */
export function HumanityWorkbench({ t, controller, emotion, memory }: HumanityWorkbenchProps) {
  const [tab, setTab] = useState<WorkbenchTab>('persona')
  // 人格页自己出两张卡片（底色 / 信息），所以这里不再套一层面板与标题。
  const body =
    tab === 'persona' ? (
      <PersonaEditor t={t} controller={controller} />
    ) : tab === 'emotion' ? (
      <EmotionPage t={t} controller={emotion} />
    ) : (
      <MemoryPage t={t} controller={memory} />
    )

  return (
    <div style={page}>
      <div style={column}>
        <header>
          <div style={titleRow}>
            <h1 style={title}>Humanity</h1>
            {/* 一页的说明（这是什么、开关在哪）只在问号里，不占版面（用户 2026-09-26）。 */}
            <InfoHint label={t('workbench.titleHint')} side="bottom" />
          </div>
        </header>

        <OverviewPanel t={t} memory={memory} persona={controller} />

        {/* 切换页签只影响显示哪一块，不动任何数据。 */}
        <WorkbenchTabs t={t} tab={tab} onSelect={setTab} />

        {body}
      </div>
    </div>
  )
}
