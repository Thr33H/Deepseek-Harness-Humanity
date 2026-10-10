/**
 * 工作台的总览区（从 `HumanityWorkbench.tsx` 拆出，那边只剩页签与页面切换）。
 *
 * 总览四项（DEVELOPMENT §4.5.3 的默认首页）读的是**真实投影**：策略摘要来自记忆与自进化的
 * 生效配置，最近活动与预算来自自进化运行记录。通道未就绪时如实显示"读不到"，
 * **绝不填推定数字**——一个猜出来的数字会被当成系统当前状态读，那比空着更糟（M1 的原始教训）。
 *
 * 版面上左侧是指标名（小字），右侧是取值（大一号加粗）——一眼扫过去落在值上（用户 2026-09-26）；
 * 口径说明挂在每一行的「?」里，卡片底下不再有说明段。
 *
 * 唯一不来自投影的是「高风险改动确认」：它在 M2 就已落地，只是落在**对话里**（DSH 审批 seam），
 * 所以说明里如实标注去向——真机反馈里 Agent 曾把用户指到本页找一个不存在的入口 ⇒ 死结。
 * @module deepseek-harness-humanity/client/workbench-overview
 */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { useSyncExternalStore } from 'react'

import type { EvolutionWorkbenchController } from './evolution-controller.js'
import { InfoHint } from './InfoHint.js'
import { emptyDocument, type PersonaWorkbenchState } from './persona-document.js'
import type { PersonaWorkbenchController } from './persona-controller.js'
import { emptyEvolutionState, type EvolutionWorkbenchState } from './evolution-document.js'
import { NS } from './locales.js'
import type { MemoryWorkbenchController } from './memory-controller.js'
import { emptyMemoryState, type MemoryWorkbenchState } from './memory-document.js'
import { headingWithHint, panel, panelTitle } from './styles.js'
import { metricLabelSmall, metricList, metricRow, metricValueStrong } from './metric-styles.js'

type Translate = PropsLocale<typeof NS>['t']

/** 控制器缺席时的替身订阅：**崩溃防线**——宿主只接上部分视图时，总览也要能渲染。 */
const NOOP_SUBSCRIBE = (): (() => void) => () => {}

// 缺席时的快照：`idle` ⇒ 总览如实显示"读不到"，不编数字。
// 对象只造一次（快照引用每次都变会让 React 判定状态在变，进而反复重渲染）。
const DETACHED_MEMORY_STATE = emptyMemoryState()
const DETACHED_EVOLUTION_STATE = emptyEvolutionState()
const DETACHED_MEMORY = { subscribe: NOOP_SUBSCRIBE, getSnapshot: () => DETACHED_MEMORY_STATE }
const DETACHED_EVOLUTION = { subscribe: NOOP_SUBSCRIBE, getSnapshot: () => DETACHED_EVOLUTION_STATE }
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
 * 总览四项（DEVELOPMENT §4.5.3 的默认首页，顺序即展示顺序）。
 *
 * `hintKey` 是这一行自己的「?」：口径与限制跟着指标走，而不是在卡片底下堆一段总说明
 * （用户 2026-09-26：解释文字收进提示气泡）。姓名不需要解释，所以没有 hintKey。
 */
const OVERVIEW_METRICS = [
  { key: 'workbench.metric.name', hintKey: undefined },
  { key: 'workbench.metric.policy', hintKey: 'workbench.metric.policyHint' },
  { key: 'workbench.metric.activity', hintKey: 'workbench.metric.activityHint' },
  { key: 'workbench.metric.usage', hintKey: 'workbench.metric.usageHint' },
] as const

/** 通道没就绪时不编数字：如实说读不到。 */
function unavailable(memory: MemoryWorkbenchState, evolution: EvolutionWorkbenchState): boolean {
  return memory.status !== 'ready' || evolution.status !== 'ready'
}

/** 策略摘要：记忆模式 + 自进化触发方式（都取自生效配置）。 */
function policyLabel(t: Translate, memory: MemoryWorkbenchState, evolution: EvolutionWorkbenchState): string {
  if (unavailable(memory, evolution)) return t('workbench.metric.unavailable')
  return t('workbench.metric.policyValue', {
    memory: t(`memory.mode.${memory.policy.mode}` as never),
    evolution: t(`evolution.schedule.${evolution.config.schedule.mode}` as never),
  })
}

/** 最近活动：时间线里最后一条运行（时间口径与时间线一致，都是记录里的 ISO 时刻）。 */
function activityLabel(t: Translate, evolution: EvolutionWorkbenchState): string {
  if (evolution.status !== 'ready') return t('workbench.metric.unavailable')
  if (evolution.runs.length === 0) return t('workbench.metric.noActivity')
  const last = [...evolution.runs].sort((left, right) => left.startedAt.localeCompare(right.startedAt)).at(-1)
  if (last === undefined) return t('workbench.metric.noActivity')
  return t('workbench.metric.activityValue', {
    time: last.startedAt.slice(5, 16).replace('T', ' '),
    status: t(`evolution.run.status.${last.status}` as never),
  })
}

/** token 数显示：上千折成 `12.3k`（一屏里不该出现六位数字）。 */
function formatTokens(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count)
}

/**
 * 消耗：今日调用次数 + token。
 *
 * **余额查不到**（不是没做）：预付套餐的剩余额度只在阿里云百炼控制台的「模型用量」里，
 * API 层不暴露实时余额；要查得走阿里云 OpenAPI（需要 AccessKey，手上只有模型 key）。
 * 所以这里只报**我们真记账的数字**，余额由说明行指向控制台 —— 不编一个数字糊弄人。
 */
function usageLabel(t: Translate, evolution: EvolutionWorkbenchState): string {
  if (evolution.status !== 'ready') return t('workbench.metric.unavailable')
  return t('workbench.metric.usageValue', {
    calls: String(evolution.dailyCalls),
    cap: String(evolution.dailyCallCap),
    tokens: formatTokens(evolution.dailyInputTokens + evolution.dailyOutputTokens),
  })
}

/** 姓名：从人格卡的身份卡读（没设过或还没初始化时如实说"未设置"）。 */
function nameLabel(t: Translate, persona: PersonaWorkbenchState | undefined): string {
  const fields = persona?.draft.identityCard.fields ?? []
  const name = (fields.find((field) => field.key === '姓名')?.value ?? '').trim()
  return name === '' ? t('workbench.metric.nameEmpty') : name
}

export interface OverviewPanelProps {
  t: Translate
  /** 记忆控制器（策略摘要的数据源）；宿主只接上部分视图时可能缺席。 */
  memory?: MemoryWorkbenchController
  /** 自进化控制器（策略 / 最近活动 / 消耗的数据源）；同上。 */
  evolution?: EvolutionWorkbenchController
  /** 人格控制器（姓名的数据源）；同上。 */
  persona?: PersonaWorkbenchController
}

/**
 * 总览区：四项指标（真数据或如实空态）。
 * @param props - 字典座位与两个控制器（控制器可缺席：缺席时那一侧显示"读不到"）。
 * @returns 总览面板。
 */
export function OverviewPanel(props: OverviewPanelProps) {
  const { t } = props
  const memoryController = props.memory ?? DETACHED_MEMORY
  const evolutionController = props.evolution ?? DETACHED_EVOLUTION
  const personaController = props.persona ?? DETACHED_PERSONA
  // 第三个参数是服务端渲染用的快照：缺了它 SSR 会直接报错（测试与服务端预渲染走同一条路径）。
  const memory = useSyncExternalStore(
    memoryController.subscribe,
    memoryController.getSnapshot,
    memoryController.getSnapshot,
  )
  const evolution = useSyncExternalStore(
    evolutionController.subscribe,
    evolutionController.getSnapshot,
    evolutionController.getSnapshot,
  )
  const personaState = useSyncExternalStore(
    personaController.subscribe,
    personaController.getSnapshot,
    personaController.getSnapshot,
  )
  const values: Record<string, string> = {
    'workbench.metric.name': nameLabel(t, personaState),
    'workbench.metric.policy': policyLabel(t, memory, evolution),
    'workbench.metric.activity': activityLabel(t, evolution),
    'workbench.metric.usage': usageLabel(t, evolution),
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
