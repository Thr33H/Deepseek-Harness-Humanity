import type { CSSProperties } from 'react'
import { useSyncExternalStore } from 'react'

import { IconPersonalization } from './icons.js'

/**
 * 侧栏入口字形收到的两个事实，与 `sidebar.panellist` 的 owner props 一致。
 *
 * 两个字段都写成**可选**：宿主在别的视图里可能不传（或传 `undefined`），
 * 而这里一旦假设"一定有"，代价可能是整个侧栏崩掉。
 */
export interface HumanityPanelIconProps {
  /** 请求的方形边长（px）：栏折叠时比展开时略大。 */
  size?: number
  /** 该面板当前是否在主区显示。 */
  active?: boolean
}

/**
 * 兜底字形：自带的极简 svg。
 *
 * 为什么需要它：`IconPersonalizationOutline16` 是**外部模块的导出**，一旦那一版外壳没有
 * 这个符号，取值就是 `undefined`，而 React 遇到 `undefined` 作为元素类型会抛
 * "Element type is invalid" —— 错误冒到根上就是"整个 UI 消失"。
 * 自带一个不依赖任何导出的 svg，把这类风险降成"图标长得普通一点"。
 * @param props - 边长（缺省 16）。
 */
function FallbackGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="5.5" r="2.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M3 13c0-2.5 2.2-4 5-4s5 1.5 5 4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

/**
 * Humanity 侧栏入口的字形。
 *
 * 这里**只画图标，不包 button**：`sidebar.panellist` 的占用者只提供字形，按钮本身、
 * 无障碍名称、选中态样式和点击后的面板切换都由侧栏外壳负责。再包一层按钮会得到嵌套按钮
 * 和双重选中样式。
 *
 * 因此 `active` 只作为契约的一部分接收而不使用——选中态由外壳渲染，占用者重复表达会
 * 与外壳打架。
 * @param props - 侧栏入口 owner props。
 */
export function HumanityPanelIcon({ size }: HumanityPanelIconProps) {
  // 图标跨版本解析（见 icons.ts）：0.1.5 叫 `…Outline16`、0.1.7 叫 `…Outline`；
  // 两版都没有时用自带字形，而不是把 `undefined` 交给 React（React #130）。
  const Icon = IconPersonalization ?? FallbackGlyph
  return <Icon size={typeof size === 'number' && Number.isFinite(size) ? size : 16} />
}

/**
 * 待确认红点（P-042）。
 *
 * `sidebar.panellist` 的槽位契约**没有徽标字段**（entry 只有 id/order/label，owner props 只有
 * size/active——编译 `dsh-client-ui-sidebar/lib/client.js:346-352` 实证），所以红点画在
 * **我们自己注册的图标组件内部**：包一层相对定位的 span，右上角一个纯色圆点。
 * 不扩槽位契约、不碰外壳 DOM。
 */
const badgeWrap: CSSProperties = { position: 'relative', display: 'inline-flex' }
const badgeDot: CSSProperties = {
  position: 'absolute',
  top: -2,
  right: -3,
  width: 7,
  height: 7,
  borderRadius: '50%',
  background: 'var(--dsw-alias-status-error, #e5484d)',
}

/** 红点版图标的属性：字形属性 + 一个"待确认数量"的外部存储订阅面。 */
export interface HumanityPanelBadgeProps extends HumanityPanelIconProps {
  /** 订阅计数变化（控制器 `subscribe`）。 */
  subscribe(listener: () => void): () => void
  /** 读当前待确认总数（必须是稳定原始值：`useSyncExternalStore` 的快照契约）。 */
  getCount(): number
}

/** 内层：真正用 hook 的字形（订阅面已确认是函数才会被渲染，hook 顺序稳定）。 */
function BadgeGlyph({ size, subscribe, getCount }: HumanityPanelBadgeProps) {
  const count = useSyncExternalStore(subscribe, getCount, getCount)
  return (
    <span style={badgeWrap}>
      <HumanityPanelIcon size={size} />
      {count > 0 ? <span style={badgeDot} /> : null}
    </span>
  )
}

/**
 * 带待确认红点的侧栏字形。
 *
 * 订阅面缺失/坏形状时退化成普通图标（不画点、不抛）：这是**外壳级**组件，
 * 它崩掉的代价是整个侧栏，比少个红点严重得多。
 * @param props - 字形属性 + 计数订阅面。
 */
export function HumanityPanelIconWithBadge(props: HumanityPanelBadgeProps) {
  if (typeof props?.subscribe !== 'function' || typeof props?.getCount !== 'function') {
    return <HumanityPanelIcon size={props?.size} />
  }
  return <BadgeGlyph {...props} />
}
