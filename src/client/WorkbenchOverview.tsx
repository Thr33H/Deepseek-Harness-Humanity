/**
 * 工作台的总览区（从 `HumanityWorkbench.tsx` 拆出，那边只剩页签与页面切换）。
 *
 * 版面上左侧是指标名（小字），右侧是取值（大一号加粗）——一眼扫过去落在值上（用户 2026-09-26）；
 * 口径说明挂在每一行的「?」里，卡片底下不再有说明段。
 *
 * **读不到就如实说读不到**：通道未就绪时显示"读不到"，绝不填推定数字 ——
 * 一个猜出来的数字会被当成系统当前状态读，那比空着更糟（M1 的原始教训）。
 * @module deepseek-harness-humanity/client/workbench-overview
 */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { useSyncExternalStore } from 'react'

import { InfoHint } from './InfoHint.js'
import { emptyDocument, type PersonaWorkbenchState } from './persona-document.js'
import type { PersonaWorkbenchController } from './persona-controller.js'
import { NS } from './locales.js'
import type { MemoryWorkbenchController } from './memory-controller.js'
import { emptyMemoryDocument, type MemoryWorkbenchState } from './memory-document.js'
import { headingWithHint, panel, panelTitle } from './styles.js'
import { metricLabelSmall, metricList, metricRow, metricValueStrong } from './metric-styles.js'

type Translate = PropsLocale<typeof NS>['t']

/** 控制器缺席时的替身订阅：**崩溃防线**——宿主只接上部分视图时，总览也要能渲染。 */
const NOOP_SUBSCRIBE = (): (() => void) => () => {}

// 缺席时的快照：`idle` ⇒ 总览如实显示"读不到"，不编数字。
// 对象只造一次（快照引用每次都变会让 React 判定状态在变，进而反复重渲染）。
const DETACHED_MEMORY_STATE: MemoryWorkbenchState = { status: 'unavailable', doc: emptyMemoryDocument() }
const DETACHED_MEMORY = { subscribe: NOOP_SUBSCRIBE, getSnapshot: () => DETACHED_MEMORY_STATE }
/** 人格控制器缺席时的快照（`idle` ⇒ 姓名显示"还没设置"，不编）。 */
const DETACHED_PERSONA_STATE: PersonaWorkbenchState = {
  status: 'idle',
  writable: false,
  stored: emptyDocument(),
  draft: emptyDocument(),
  saving: false,
  savedAt: '',
  issues: [],
  independentJudgment: true,
  independentJudgmentSaving: false,
}
const DETACHED_PERSONA = { subscribe: NOOP_SUBSCRIBE, getSnapshot: () => DETACHED_PERSONA_STATE }

/**
 * 总览指标（顺序即展示顺序）。
 *
 * `hintKey` 是这一行自己的「?」：口径与限制跟着指标走，而不是在卡片底下堆一段总说明
 * （用户 2026-09-26：解释文字收进提示气泡）。姓名不需要解释，所以没有 hintKey。
 */
const OVERVIEW_METRICS = [
  { key: 'workbench.metric.name', hintKey: undefined },
  { key: 'workbench.metric.memory', hintKey: 'workbench.metric.memoryHint' },
] as const

/** 姓名：从底色的字段里读（没设过或还没初始化时如实说"未设置"）。 */
function nameLabel(t: Translate, persona: PersonaWorkbenchState | undefined): string {
  const fields = persona?.draft.identityCard.fields ?? []
  const name = (fields.find((field) => field.key === '姓名')?.value ?? '').trim()
  return name === '' ? t('workbench.metric.nameEmpty') : name
}

/** 记忆：条数（通道没就绪时如实说读不到）。 */
function memoryLabel(t: Translate, memory: MemoryWorkbenchState): string {
  if (memory.status !== 'ready') return t('workbench.metric.unavailable')
  return t('workbench.metric.memoryValue', { count: String(memory.doc?.stats.total ?? 0) })
}

export interface OverviewPanelProps {
  t: Translate
  /** 记忆控制器；宿主只接上部分视图时可能缺席。 */
  memory?: MemoryWorkbenchController
  /** 人格控制器（姓名的数据源）；同上。 */
  persona?: PersonaWorkbenchController
}

/**
 * 总览区：两项指标（真数据或如实空态）。
 * @param props - 字典座位与两个控制器（控制器可缺席：缺席时那一侧显示"读不到"）。
 * @returns 总览面板。
 */
export function OverviewPanel(props: OverviewPanelProps) {
  const { t } = props
  const memoryController = props.memory ?? DETACHED_MEMORY
  const personaController = props.persona ?? DETACHED_PERSONA
  // 第三个参数是服务端渲染用的快照：缺了它 SSR 会直接报错（测试与服务端预渲染走同一条路径）。
  const memory = useSyncExternalStore(
    memoryController.subscribe,
    memoryController.getSnapshot,
    memoryController.getSnapshot,
  )
  const personaState = useSyncExternalStore(
    personaController.subscribe,
    personaController.getSnapshot,
    personaController.getSnapshot,
  )
  const values: Record<string, string> = {
    'workbench.metric.name': nameLabel(t, personaState),
    'workbench.metric.memory': memoryLabel(t, memory),
  }

  return (
    <section style={panel}>
      <h2 style={{ ...panelTitle, ...headingWithHint }}>
        {t('workbench.overview')}
        <InfoHint label={t('workbench.overviewHint')} />
      </h2>
      <dl style={metricList}>
        {OVERVIEW_METRICS.map((metric) => (
          <div key={metric.key} style={metricRow}>
            <dt style={{ ...metricLabelSmall, ...headingWithHint }}>
              {t(metric.key)}
              {metric.hintKey === undefined ? null : <InfoHint label={t(metric.hintKey)} />}
            </dt>
            <dd style={metricValueStrong}>{values[metric.key]}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
