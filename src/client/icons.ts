/**
 * 官方图标的**跨版本解析**：0.1.5 与 0.1.7 换了图标命名规矩，硬写一个名字必然炸一边。
 *
 * ### 为什么要这一层
 *
 * 0.1.5 的原语包里只有带尺寸后缀的名字（`IconQuestionOutline14`）；
 * 0.1.7 把尺寸后缀去掉、改成带变体后缀（`IconQuestionOutline` / `…Artwork` / `…Medium` / `…Regular`），
 * **旧名直接不存在**。CommonJS 下不存在的导出就是 `undefined`：导入不报错，
 * 渲染时才炸 React #130「Element type is invalid」——2026-09-29 真机实测，
 * 一个 `undefined` 图标把**整个工作台**（四页）拖进兜底页。
 *
 * 所以这里做两件事：
 * 1. **按候选顺序解析**（旧名优先，新名兜底），拿到能渲染的那个；
 * 2. **渲染处一律有兜底**：一个图标拿不到就渲 `null`，绝不让 `undefined` 进 JSX。
 *
 * ### 与审计测试的关系
 *
 * `test/official-names.test.mjs` 会扫客户端 bundle 里引用的官方导出，逐个核对"当前这版 DSH 里在不在"。
 * 候选名里**必然**有一个在某一版里不存在（这正是"跨版本"的含义），所以该测试的判据是：
 * 「缺失的名字必须出现在 {@link ICON_CANDIDATES} 的某个候选组里，**且同组至少有一个名字存在**」
 * —— 既允许旧名缺失，又不允许"整组都查不到"（那种情况就是真坏了）。
 * @module deepseek-harness-humanity/client/icons
 */
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { ComponentType, SVGProps } from 'react'

/** 官方图标组件的形状（我们只用到 `size`）。 */
export type IconComponent = ComponentType<{ size?: number } & SVGProps<SVGSVGElement>>

/**
 * 候选表：组名 → 按优先级排列的官方导出名（旧版名在前）。
 *
 * 顺序不能反：旧名优先保证 0.1.5 一点不变；新名兜底让 0.1.7 能跑。
 */
export const ICON_CANDIDATES: Readonly<Record<string, readonly string[]>> = {
  IconQuestion: ['IconQuestionOutline14', 'IconQuestionOutline'],
  IconChevronDown: ['IconChevronDownOutline14', 'IconChevronDownOutline'],
  IconChevronRight: ['IconChevronRightOutline14', 'IconChevronRightOutline'],
  IconPersonalization: ['IconPersonalizationOutline16', 'IconPersonalizationOutline'],
}

/** 能渲染的东西：函数组件或 `memo`/`forwardRef` 之类的对象。 */
function isRenderable(value: unknown): value is IconComponent {
  return typeof value === 'function' || (typeof value === 'object' && value !== null)
}

/**
 * 按顺序取第一个能渲染的候选。
 * @param group - 候选组名（见 {@link ICON_CANDIDATES}），只用于诊断。
 * @returns 组件；一个都拿不到时 `undefined`（调用方必须兜底，不要直接渲染）。
 */
export function resolveIcon(group: keyof typeof ICON_CANDIDATES | string): IconComponent | undefined {
  const names = ICON_CANDIDATES[group] ?? []
  const bag = primitives as unknown as Record<string, unknown>
  for (const name of names) {
    if (isRenderable(bag[name])) return bag[name] as IconComponent
  }
  return undefined
}

/** 问号图标（卡片上的「?」说明入口）。 */
export const IconQuestion = resolveIcon('IconQuestion')
/** 展开/收起：向下箭头。 */
export const IconChevronDown = resolveIcon('IconChevronDown')
/** 展开/收起：向右箭头。 */
export const IconChevronRight = resolveIcon('IconChevronRight')
/** 侧栏面板图标（个性化）。 */
export const IconPersonalization = resolveIcon('IconPersonalization')

/** 候选里允许"本版不存在"的全部名字（审计测试据此放行，别在别处再抄一份）。 */
export const CANDIDATE_NAMES: readonly string[] = Object.values(ICON_CANDIDATES).flat()
