import { createElement } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

import { HumanityWorkbench } from './HumanityWorkbench.js'
import { NS } from './locales.js'
import { PersonaBoundary } from './PersonaBoundary.js'
import type { EmotionWorkbenchController } from './emotion-controller.js'
import type { MemoryWorkbenchController } from './memory-controller.js'
import type { PersonaWorkbenchController } from './persona-controller.js'

/** 槽位座位可能拿到的属性（可能缺 `t`，也可能带别的字段——不假设）。 */
type SeatProps = Partial<PropsLocale<typeof NS>>

/**
 * 缺 `t` 时的兜底翻译：直接回键名。
 *
 * 为什么要有它：`t` 由槽位宿主注入，正常情况下一定有；但**我们不该假设**——
 * 一旦宿主在某个别的视图里用别的座位渲染我们，`t` 就是 `undefined`，
 * 而 `t('persona.title')` 会当场抛 `t is not a function`，把整个 React 根带下去。
 * 显示键名难看，但**不会把用户的会话列表弄没**。
 */
const fallbackTranslate = (key: string): string => String(key)

/** 出错时显示的中性说明（不依赖字典、不依赖控制器）。 */
function FallbackNote({ kind }: { kind: 'broken' | 'unwired' }) {
  // 两种情况的原因不同，话也必须不同：一个是渲染出错，一个是工作台没完全接上。
  const text =
    kind === 'broken'
      ? 'Humanity 面板暂时无法显示（渲染出错，已就地拦截，不影响会话与对话）。可刷新页面重试；'
        + '若持续出现，请到 **DSH 设置**里搜索 Humanity，关掉「人格」模块。'
      : 'Humanity 面板暂时无法显示（工作台未完全接上，已就地拦截，不影响会话与对话）。'
        + '这一般发生在某个模块的通道还没就绪时，刷新页面即可。'
  return (
    <div style={{ padding: 16, color: 'var(--dsw-alias-label-secondary)', fontSize: 13, lineHeight: 1.6 }}>
      {text}
    </div>
  )
}

/**
 * 造一个"座位"组件：把控制器闭包进去，再交给槽位注册。
 *
 * 为什么不把控制器塞进槽位注册的 `inject` 面：`main` 槽位的注入面由布局插件定义，我们只能
 * 照它给的形状填；而这个座位只需要"多一个 prop"，闭包就是最小、最不依赖别人契约的做法。
 * 座位本身不持有状态——状态在控制器里，`useSyncExternalStore` 负责把变化推给 React。
 *
 * 三道防线（每一项都对应一类真机会把外壳带崩的情形）：
 * 1. **属性规范化**：`t` 不是函数就用键名兜底，不抛；
 * 2. **错误边界**：子树渲染抛错只影响我们这一块，不卸载整个 React 根；
 * 3. **控制器缺失**：渲染中性说明，而不是让 `undefined.xxx` 一路炸下去。
 * @param controller - 人格工作台控制器（由 `apply()` 在插件挂载时创建）。
 * @param emotion - 情绪工作台控制器（只读观察窗）。
 * @param memory - 记忆工作台控制器。
 * @returns 可直接注册进 `main` 槽位的组件。
 */
export function createWorkbenchSeat(
  controller: PersonaWorkbenchController,
  emotion: EmotionWorkbenchController,
  memory: MemoryWorkbenchController,
) {
  return function WorkbenchSeat(props: SeatProps) {
    const t = (typeof props?.t === 'function' ? props.t : fallbackTranslate) as PropsLocale<typeof NS>['t']
    const unwired = [controller, emotion, memory].some((seat) => seat === undefined || seat === null)
    return (
      // `PersonaBoundary` 是**产品级防御**，不是排查用的脚手架：工作台里任何一次渲染抛错，
      // React 会把**整个根**卸载（真机现象：点会话 → 会话列表全没了）。边界把爆炸半径收到
      // 工作台这一块，并换上一句可读的说明。它保留在最终实现里。
      <PersonaBoundary fallback={<FallbackNote kind="broken" />}>
        {unwired ? (
          <FallbackNote kind="unwired" />
        ) : (
          <HumanityWorkbench t={t} controller={controller} emotion={emotion} memory={memory} />
        )}
      </PersonaBoundary>
    )
  }
}
