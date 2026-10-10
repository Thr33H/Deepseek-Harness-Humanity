/**
 * Humanity 套件 · 客户端半边。
 *
 * 职责：把工作台接入 DSH 的 Web 界面——一个侧栏入口，一个中央面板（DEVELOPMENT 4.1/4.5）。
 * 人格数据经 `ctx.remote.settings` 读写宿主（用户裁决 3：复用设置 RPC，不新建 gateway）。
 *
 * 下面几行 `import type {} from ...` 不是空操作：它们把 DSH 的槽位、服务与 Remote 面声明拉进
 * 类型程序。`ctx.slots` / `ctx.locale` / `ctx.remote` 以及 `sidebar.panellist`、`main` 两个槽位
 * 契约都由这些包通过 `declare module` 声明；不引入就既没有类型，也发现不了契约变更。
 * `import type` 在打包时会被完全擦除，不会产生任何运行时依赖。
 *
 * ⚠️ 值导入的红线：只有 `build-client.mjs` 的 `PLATFORM_EXTERNALS`（shell 静态模块表）里列出的
 * 包才能出现在这份图里，其余 `@deepseek-ai/*` 一律只能 `import type`。
 * 违反这条不是"这个插件少个功能"，而是**整个 Web UI 的插件加载失败**。
 * @module deepseek-harness-humanity/client
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { createElement } from 'react'

import { EvolutionWorkbenchController } from './evolution-controller.js'
import { HumanityPanelIconWithBadge } from './HumanityPanelIcon.js'
import { PANEL_LABEL, PANEL_ORDER, WORKBENCH_ID } from './ids.js'
import { en, NS, zh } from './locales.js'
import { EVOLUTION_NAMESPACE } from './evolution-channel.js'
import { MEMORY_NAMESPACE } from './memory-channel.js'
import { PERSONA_NAMESPACE, PersonaWorkbenchController } from './persona-controller.js'
import { MemoryWorkbenchController } from './memory-controller.js'
import { attachRemoteController } from './remote-attach.js'
import { createWorkbenchSeat } from './WorkbenchSeat.js'

/** Cordis 插件名，浏览器侧诊断用。 */
export const name = 'humanity-client'

/**
 * 需要的服务。这两个是真正的前置条件：没有 slots 就无处注册，没有 locale 面板文案无法解析。
 * 它们都由 Web 组合固定提供，因此声明成硬依赖不会带来加载风险。
 *
 * `remote` **故意不在这里**：它是可选 seam（G-002）。没有它时工作台照常打开，只是人格页显示
 * "通道未就绪"，而不是让整个入口消失。attach/detach 交给 `remote-attach.ts` 的一次 `ctx.inject`。
 */
export const inject = ['slots', 'locale']

/** 字典注册的动作：注册失败（如同名命名空间被占用）**不许抛**，否则整块 UI 消失。 */
function registerLocale(ctx: Context): void {
  ctx.effect(() => {
    try {
      return ctx.locale.register(NS, { zh, en })
    } catch (error) {
      console.error('[humanity] 文案字典注册失败，将使用键名兜底', error)
      return () => {}
    }
  }, 'humanity: 文案字典')
}

/**
 * 注册一个槽位：**任何失败都只记日志**。
 *
 * `ctx.slots.register` 会因为各种契约原因抛（重复 key、槽位未声明、选项不合法…）。
 * 让它冒泡出去 = 客户端组合失败 = 整块 UI 消失；而少一个入口最多是"功能暂时看不到"。
 * @param what - 日志里用的名字。
 * @param register - 真正的注册动作。
 */
function safeRegister(what: string, register: () => unknown): void {
  try {
    register()
  } catch (error) {
    console.error(`[humanity] ${what} 注册失败，已跳过（不影响外壳与其它的槽位）`, error)
  }
}

/** 侧栏入口。list 槽位：新增一个 id 是"并排多一个"，而不是顶掉别人。 */
function registerSidebarEntry(ctx: Context, evolution: EvolutionWorkbenchController): void {
  // 红点计数订阅面（P-042）：图标组件闭包持有控制器的订阅与快照读取。
  // index.ts 是 .ts 不是 .tsx：用 createElement 包一层，槽位契约本身不动。
  const icon = (props: { size?: number; active?: boolean }): ReturnType<typeof createElement> =>
    createElement(HumanityPanelIconWithBadge, {
      ...props,
      subscribe: evolution.subscribe,
      getCount: () => evolution.getSnapshot().pendingCounts.total,
    })
  safeRegister('侧栏入口', () =>
    ctx.slots.inject('sidebar.panellist', () =>
      ctx.slots.register({ name: 'sidebar.panellist', id: WORKBENCH_ID, order: PANEL_ORDER, label: PANEL_LABEL }, icon),
    ),
  )
}

/** 主工作台。keyed 槽位，key 与侧栏入口 id 相同 —— 侧栏点击后正是按这个 key 分发。 */
function registerWorkbench(ctx: Context, seat: ReturnType<typeof createWorkbenchSeat>): void {
  // 挂 `main` 而不是 `root`：`root` 是整帧唯一占用者，注册它等于顶掉整个应用外壳。
  safeRegister('主面板', () =>
    ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: WORKBENCH_ID, locale: NS }, seat)),
  )
}

/**
 * 挂载工作台。
 * @param ctx - DSH 浏览器侧根上下文。
 */
export function apply(ctx: Context): void {
  registerLocale(ctx)

  // 三个状态机都不含 React，只持有"草稿/投影 + 远程通道"。
  const controller = new PersonaWorkbenchController()
  const memory = new MemoryWorkbenchController()
  const evolution = new EvolutionWorkbenchController()
  attachRemoteController(ctx, controller, PERSONA_NAMESPACE, '人格')
  attachRemoteController(ctx, memory, MEMORY_NAMESPACE, '记忆')
  attachRemoteController(ctx, evolution, EVOLUTION_NAMESPACE, '自进化')

  registerSidebarEntry(ctx, evolution)
  registerWorkbench(ctx, createWorkbenchSeat(controller, memory, evolution))
}

// 这几个符号导出是**给测试用的**（与第一方客户端插件导出自己的控制器同一做法）：
// 崩溃防线（属性兜底 / 错误边界）必须能被独立渲染验证，否则只能靠真机去撞。
export { PERSONA_NAMESPACE, PersonaWorkbenchController } from './persona-controller.js'
export { HUMANITY_NAMESPACE } from './persona-channel.js'
export { MEMORY_NAMESPACE, MEMORY_OPS } from './memory-channel.js'
export { EVOLUTION_NAMESPACE, EVOLUTION_OPS } from './evolution-channel.js'
export { asMemoryDocument } from './memory-document.js'
export { asEvolutionConfig, defaultEvolutionConfig } from './evolution-config-doc.js'
export { asEvolutionDocument, emptyEvolutionState } from './evolution-document.js'
export { EvolutionWorkbenchController } from './evolution-controller.js'
export { filterEntries, formatAge } from './memory-view.js'
export { MemoryWorkbenchController } from './memory-controller.js'
export { MemoryPage } from './MemoryPage.js'
export { PendingDetails } from './PendingPage.js'
export { PendingCard } from './PendingCard.js'
export { EvolutionPage } from './EvolutionPage.js'
export { HumanityPanelIcon, HumanityPanelIconWithBadge } from './HumanityPanelIcon.js'
export { PersonaBoundary } from './PersonaBoundary.js'
export { SkillsPage } from './SkillsPage.js'
export { OverviewPanel } from './WorkbenchOverview.js'
export { createWorkbenchSeat } from './WorkbenchSeat.js'
export { subscribeToProjection } from './remote-attach.js'
