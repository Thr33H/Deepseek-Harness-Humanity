/**
 * 测试用的**客户端 bundle 加载器**：把 `lib/client.js`（DSH 真正会加载的东西）读进来并实例化。
 *
 * 客户端代码只存在于打包产物里，所以控制器与界面测试都从这里进入，而不是另建一条
 * 只在测试里成立的入口。平台外部模块按 `build-client.mjs` 的 `PLATFORM_EXTERNALS` 提供；
 * 表之外的请求一律报错 —— 那说明构建图里混进了不该出现的依赖（会让整个 Web UI 加载失败）。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const nodeRequire = createRequire(import.meta.url)

/**
 * 读出构建产物里的加载信封。
 * @returns 已实例化的模块对象（bundle 导出的符号都在它上面）。
 */
export async function loadClientBundle() {
  const source = await readFile(path.join(root, 'lib', 'client.js'), 'utf8')
  const calls = []
  const window = {
    __ModuleLoader__: {
      load: (descriptor) => calls.push(descriptor),
    },
  }
  // 用 Function 而不是 eval：信封就是给浏览器执行的普通脚本，这里只提供它用到的那个全局。
  new Function('window', source)(window)
  assert.equal(calls.length, 1, '客户端 bundle 必须且只能注册一个模块')
  return calls[0].factory(createPlatformRequire())
}

/** 平台外部模块表：只放 shell 静态提供的那些（见 bundle 头部注释）。 */
function createPlatformRequire() {
  const react = nodeRequire('react')
  return (id) => {
    if (id === 'react') return react
    if (id === 'react/jsx-runtime') return nodeRequire('react/jsx-runtime')
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return createPrimitivesStub(react)
    throw new Error(`客户端 bundle 请求了平台表之外的模块：${id}`)
  }
}

/**
 * UI 原语的替身：只用最小的 HTML 元素承载 props，够断言文案与结构。
 *
 * `Tooltip` 特意把 `label` 也渲染出来（真实实现只在悬停时才挂气泡）：提示文案在界面上唯一的
 * 静态落点就是锚点的 `aria-label`，替身把它显式画出来，测试才能断言"这句话确实挂在那个 ? 上"。
 */
function createPrimitivesStub(react) {
  const passthrough = (tag) => (props) => react.createElement(tag, props, props?.children)
  const button = (props) => react.createElement('button', props, props?.children)
  return new Proxy(
    {
      Button: button,
      Switch: (props) =>
        react.createElement('input', {
          type: 'checkbox',
          checked: props?.checked,
          onChange: props?.onChange,
        }),
      Tooltip: (props) =>
        react.createElement('span', { 'data-tooltip': props?.label }, props?.children),
      IconQuestionOutline14: () => react.createElement('span', { 'data-icon': 'question' }, '?'),
      // 下拉：默认是关的，把"当前值"和"锚点（官方 Button）"都画出来；打开时连候选项一起画，
      // 测试才断言得了"这个下拉里有哪几项、选中的是哪一项"。
      Menu: (props) =>
        react.createElement(
          'div',
          { 'data-menu': props?.open === true ? 'open' : 'closed', 'data-menu-value': props?.selectedId },
          props?.anchor,
          props?.open === true && Array.isArray(props?.items)
            ? react.createElement(
                'div',
                { 'data-menu-items': props.items.map((item) => item?.id).join(',') },
                props.items.map((item) => react.createElement('span', { key: item?.id }, item?.label)),
              )
            : null,
        ),
      IconChevronDownOutline14: () => react.createElement('span', { 'data-icon': 'chevron-down' }),
      // 可折叠行（官方 DisclosureRow）：把 aria-expanded 与标题画出来，测试才能断言展开状态。
      DisclosureRow: ({ title, open, expandable, onToggle, children }) =>
        react.createElement(
          'div',
          { 'data-disclosure-row': 'true', 'aria-expanded': String(open === true), 'data-expandable': String(expandable === true) },
          react.createElement('span', null, title),
          open === true ? children : null,
        ),
    },
    {
      get: (target, key) => {
        if (key in target) return target[key]
        if (typeof key !== 'string') return undefined
        return passthrough(key === 'Tag' ? 'span' : key === 'Input' ? 'input' : 'div')
      },
    },
  )
}
