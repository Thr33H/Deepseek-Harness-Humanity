/**
 * 工作台在浏览器侧的标识。
 *
 * 为什么单独一个文件：这三个值跨越两个槽位契约（`sidebar.panellist` 的入口与 `main` 的面板），
 * 它们必须**成对一致**——侧栏按钮点击后调用的就是 `ctx.layout.selectPanel(id)`，而中央面板
 * 是按同一个 key 分发的。写在同一处，才不会在以后改名字时只改一半。
 */

/**
 * 入口 id 与面板 key。
 *
 * 必须避开 DSH 已占用的 key（当前是 `conversation`）：keyed 槽位里注册一个已占用的 key
 * 会**顶掉**原来的占用者，而不是并排多出一个。
 */
export const WORKBENCH_ID = 'humanity'

/** 侧栏入口排序。排在 DSH 自带全局面板之后，不抢它们的次序。 */
export const PANEL_ORDER = 60

/**
 * 侧栏入口标题。
 *
 * 直接用产品名而不是走字典：`Humanity` 是产品标识，和 DSH 自己的品牌行一样不随语言变化，
 * 因此没有必要为它维护两份完全相同的翻译。
 */
export const PANEL_LABEL = 'Humanity'
