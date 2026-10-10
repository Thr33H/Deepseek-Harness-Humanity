import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { useState, useSyncExternalStore } from 'react'

import { EvolutionPage } from './EvolutionPage.js'
import { InfoHint } from './InfoHint.js'
import { MemoryPage } from './MemoryPage.js'
import { PendingCard } from './PendingCard.js'
import { OverviewPanel } from './WorkbenchOverview.js'
import { PersonaEditor } from './PersonaEditor.js'
import { SkillsPage } from './SkillsPage.js'
import { WorkbenchTabs, type WorkbenchTab } from './WorkbenchTabs.js'
import type { EvolutionWorkbenchController } from './evolution-controller.js'
import type { MemoryWorkbenchController } from './memory-controller.js'
import { NS } from './locales.js'
import type { PersonaWorkbenchController } from './persona-controller.js'
import { column, page, title, titleRow } from './styles.js'

/** 工作台属性：座位注入的本地化座位，加上闭包递进来的控制器。 */
export interface HumanityWorkbenchProps extends PropsLocale<typeof NS> {
  controller: PersonaWorkbenchController
  /** 记忆工作台控制器（M3 步骤 8b 接入）。 */
  memory: MemoryWorkbenchController
  /** 自进化工作台控制器（M5 接入：时间线 / 提案 / 待确认页共用）。 */
  evolution: EvolutionWorkbenchController
}

/**
 * Humanity 主工作台。
 *
 * 结构：标题（说明收进 ?）+ 常驻的待确认卡片 + 总览 + 四个模块卡片页签 + 当前页签的内容。
 * 数据只有一条来源：各命名空间经 `ctx.remote.settings` 读写（裁决 3），
 * 校验用的是宿主同一个规则模块（`persona/rules.ts`）。
 * @param props - 字典座位与三个工作台控制器。
 */
export function HumanityWorkbench({ t, controller, memory, evolution }: HumanityWorkbenchProps) {
  const [tab, setTab] = useState<WorkbenchTab>('persona')
  // 人格页自己出两张卡片（身份卡 / 人格卡），所以这里不再套一层面板与标题。
  const body =
    tab === 'persona' ? (
      <PersonaEditor t={t} controller={controller} />
    ) : tab === 'memory' ? (
      <MemoryPage t={t} controller={memory} />
    ) : tab === 'skills' ? (
      <SkillsPage t={t} controller={evolution} />
    ) : (
      <EvolutionPage t={t} controller={evolution} />
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

        {/* 待确认常驻顶部：有积压时一眼看到，展开就能处理 */}
        <PendingCard t={t} evolution={evolution} memory={memory} />

        <OverviewPanel t={t} memory={memory} evolution={evolution} persona={controller} />

        {/* 切换页签只影响显示哪一块，不动任何数据。 */}
        <WorkbenchTabs t={t} tab={tab} onSelect={setTab} />

        {body}
      </div>
    </div>
  )
}
