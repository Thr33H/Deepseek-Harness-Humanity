/**
 * 客户端 bundle 的加载与注册测试。
 *
 * 这里刻意**不**重新实现一遍注册逻辑，而是把构建产物 `lib/client.js` 当成 DSH 会看到的东西
 * 来用：先按模块加载信封取出 factory，再用平台模块表喂 `require`，最后断言它真的往
 * `sidebar.panellist` 与 `main` 注册了东西、并且能渲染出内容。这样任何一处契约漂移
 * （槽位名、注册选项、包名 id、平台外部依赖）都会在这里变红，而不是等用户点开侧栏才发现。
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { PERSONA_ISSUE_CODES } from '../lib/persona/constants.js'
import { PERSONA_NAMESPACE } from '../lib/persona/section.js'
import { SETTINGS_NAMESPACE } from '../lib/settings.js'
import { CARD_SKELETON, countHints, visibleText } from './helpers/markup.mjs'
import { createFakeChannel, emptyPersona, withSection } from './helpers/persona-fake.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const nodeRequire = createRequire(import.meta.url)

/** 读出构建产物里的加载信封，并诚实断言它只声明了一个 factory。 */
async function loadBundle() {
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
  return calls[0]
}

/** 造一个记录动作的假上下文，形状与浏览器侧 cordis 上下文一致。 */
function createFakeContext(channel = createFakeChannel(emptyPersona()).channel) {
  const effects = []
  const localeNamespaces = []
  const registrations = []
  const injected = []

  const ctx = {
    effect: (callback) => {
      const dispose = callback()
      effects.push(dispose)
      return dispose
    },
    inject: (deps, callback) => {
      injected.push(deps)
      // 模拟"服务已经在位"：0.1.7 起工作台走**自有数据面**（客户端 `connection.rpc.call`），
      // 所以替身要提供的是 `connection`，而不是旧的 `remote.settings`。
      // 端点名与参数形状必须与 `src/client/plane-channel.ts` 一致（否则这条测试就失去意义）。
      const connection = {
        rpc: {
          call: (channel_, endpoint, payload) => {
            const args = payload?.args ?? {}
            if (endpoint === 'humanity/describe') return channel.describe()
            if (endpoint === 'humanity/replace') return channel.replace(args.ns, args.section, args.expectedRevision)
            if (endpoint === 'humanity/update') return channel.update(args.ns, args.patch, args.expectedRevision)
            return Promise.resolve({ ok: false, error: { message: `未知端点 ${channel_}/${endpoint}` } })
          },
        },
      }
      const dispose = callback({ connection })
      effects.push(dispose)
      return dispose
    },
    locale: {
      register: (ns, dicts) => {
        localeNamespaces.push({ ns, dicts })
        return () => {}
      },
    },
    slots: {
      inject: (key, callback) => {
        callback()
        return () => {}
      },
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }

  return { ctx, effects, localeNamespaces, registrations, injected }
}

/**
 * UI 原语的测试替身。
 *
 * 为什么不直接 `require` 真实的 `@deepseek-ai/dsh-client-ui-primitives`：它的构建产物在运行时
 * 会 `import` 一批只声明为 devDependency 的包（clsx、shiki、katex…）。这些依赖在浏览器里由
 * shell 的静态模块表回答，在 Node 里则解析不到，硬加载会拉起一整棵无关的重依赖树。
 *
 * 原语的**接口**正确性由 `pnpm typecheck` 对着官方 .d.ts 保证（JSX 属性会逐个检查）；
 * 这个测试要证的是另一件事：bundle 能装、能注册、能渲染出内容。
 */
function createPrimitivesStub(react) {
  /** 把原语按语义映射成同名 HTML 元素，保留 children 与其余属性。 */
  const passthrough = (tag) =>
    ({ children, ...props }) =>
      react.createElement(tag, props, children)

  return {
    Tag: ({ children }) => react.createElement('span', { 'data-testid': 'tag' }, children),
    // Switch 在替身里映射成一个纯受控 checkbox：测试要证的只是"控件存在且状态正确"。
    Switch: ({ checked, label, disabled }) =>
      react.createElement('input', {
        type: 'checkbox',
        checked,
        disabled,
        readOnly: true,
        'aria-label': label,
      }),
    Pill: passthrough('span'),
    Button: passthrough('button'),
    Input: passthrough('input'),
    // ⚠️ 替身**只提供当前版（0.1.7）的名字**：0.1.5 的 `…14/16` 后缀名这里故意不给。
    // 这样一旦有人在组件里直接 `import { IconQuestionOutline14 }`，替身里就是 `undefined`，
    // 渲染立刻炸（React #130）—— 2026-09-29 真机就是这么挂的，用替身把它钉住。
    // 跨版本由 `src/client/icons.ts` 的候选解析负责（该模块自己有专门的审计测试）。
    IconPersonalizationOutline: ({ size }) => react.createElement('svg', { width: size, height: size }),
    // 「带圆圈的 ?」：真实现只在悬停时挂气泡，提示文案在界面上唯一的静态落点就是锚点的
    // aria-label；替身把它画成 data-tooltip，测试才断言得了"这句话确实挂在那个 ? 上"。
    Tooltip: ({ label, children }) => react.createElement('span', { 'data-tooltip': label }, children),
    IconQuestionOutline: () => react.createElement('span', { 'data-icon': 'question' }, '?'),
    IconChevronDownOutline: () => react.createElement('span', { 'data-icon': 'chevron-down' }, 'v'),
    IconChevronRightOutline: () => react.createElement('span', { 'data-icon': 'chevron-right' }, '>'),
    // 下拉：默认关闭，只画锚点与当前值；打开时才画候选项（测试据此断言选项表）。
    Menu: ({ open, selectedId, anchor, items }) =>
      react.createElement(
        'div',
        { 'data-menu': open === true ? 'open' : 'closed', 'data-menu-value': selectedId },
        anchor,
        open === true && Array.isArray(items)
          ? react.createElement(
              'div',
              { 'data-menu-items': items.map((item) => item.id).join(',') },
              items.map((item) => react.createElement('span', { key: item.id }, item.label)),
            )
          : null,
      ),
    IconChevronDownOutline14: () => react.createElement('span', { 'data-icon': 'chevron-down' }),
  }
}

/** 平台模块表：真实 React，加上上面那份原语替身。 */
function createPlatformRequire() {
  const react = nodeRequire('react')
  const primitives = createPrimitivesStub(react)
  return (id) => {
    if (id === 'react') return react
    if (id === 'react/jsx-runtime') return nodeRequire('react/jsx-runtime')
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    // 类型专用导入在构建期被擦除，运行期绝不应该出现这些请求。
    throw new Error(`客户端 bundle 请求了平台表之外的模块：${id}`)
  }
}

/** 用 react-dom/server 静态渲染（不需要 DOM）。 */
function render(element) {
  return nodeRequire('react-dom/server').renderToStaticMarkup(element)
}

/** 让 apply() 里那次异步读取跑完，再渲染。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/** 造一个字典翻译函数：缺键直接断言失败（字典与代码必须同步）。 */
function translator(localeNamespaces, code = 'zh') {
  const dictionary = localeNamespaces[0].dicts[code]
  return (key, params) => {
    const value = dictionary[key]
    assert.ok(value !== undefined, `字典缺少键：${key}`)
    if (params === undefined) return value
    return Object.entries(params).reduce((text, [name, replacement]) => text.replace(`{${name}}`, replacement), value)
  }
}

/** 造一个只提供快照的控制器（总览只订阅状态，不发命令）。 */
function fakeSnapshotController(snapshot) {
  return { subscribe: () => () => {}, getSnapshot: () => snapshot }
}

/** 取出 main 槽位注册的组件。 */
function mainComponent(registrations) {
  const main = registrations.find((entry) => entry.options.name === 'main')
  assert.ok(main, '缺少 main 面板')
  return main.component
}

test('bundle 的模块 id 必须等于包名', async () => {
  const descriptor = await loadBundle()
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  assert.equal(descriptor.id, packageJson.name)
})

test('bundle 只请求平台模块表里的东西，且没有把宿主那套依赖打进来', async () => {
  const source = await readFile(path.join(root, 'lib', 'client.js'), 'utf8')

  // 平台表之外的 `require` 会让整个 Web UI 的插件加载失败（不是只少个功能），所以这里断言请求集合。
  const requested = [...source.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1])
  assert.deepEqual(
    [...new Set(requested)].sort(),
    ['@deepseek-ai/dsh-client-ui-primitives', 'react', 'react/jsx-runtime'],
  )

  // 宿主侧的 schema 库不该出现在客户端 bundle 里：规则被抽到无依赖的 `persona/rules.ts`，
  // 就是为了让工作台用同一套校验又不把 schemastery 内联进来。
  assert.equal(source.includes('schemastery'), false, '客户端 bundle 里出现了 schemastery')
})

test('remote 走可选注入，且注入的是命名空间服务 remote.settings（不是父服务 remote）', async () => {
  const descriptor = await loadBundle()
  const plugin = descriptor.factory(createPlatformRequire())

  assert.equal(plugin.name, 'humanity-client')
  assert.deepEqual(plugin.inject, ['slots', 'locale'])

  const { ctx, injected, registrations, localeNamespaces } = createFakeContext()
  plugin.apply(ctx)

  // ⚠️ 这条断言历史上教训很深，改到 0.1.7 之后**依然**要盯住"注入的是不是真正提供调用的那个服务"：
  // 旧写法只注入父服务 `remote` 会抢跑（命名空间 `remote.settings` 由 api-remotes 异步挂载）；
  // 0.1.7 起工作台改走自有数据面，调用面是客户端 `connection` 服务（`rpc.call('/api', …)`），
  // 所以这里必须逐个钉住 `['connection']` —— 写成别的（或写回旧值）就是通道又挂错了侧。
  assert.deepEqual(injected, [['connection'], ['connection'], ['connection']])

  assert.deepEqual(
    localeNamespaces.map((entry) => entry.ns),
    ['humanity'],
  )
  assert.deepEqual(Object.keys(localeNamespaces[0].dicts).sort(), ['en', 'zh'])
  // 中英字典的键集合必须完全一致，否则切换语言会露出原始 key。
  assert.deepEqual(
    Object.keys(localeNamespaces[0].dicts.zh).sort(),
    Object.keys(localeNamespaces[0].dicts.en).sort(),
  )

  const panel = registrations.find((entry) => entry.options.name === 'sidebar.panellist')
  assert.ok(panel, '缺少 sidebar.panellist 入口')
  assert.equal(panel.options.id, 'humanity')
  assert.equal(panel.options.label, 'Humanity')
  assert.equal(typeof panel.options.order, 'number')

  // 这两条是"点击侧栏能切到工作台"的全部前提：入口 id 与面板 key 必须相同，
  // 且 key 不能占用 DSH 自带的 conversation。
  const main = registrations.find((entry) => entry.options.name === 'main')
  assert.equal(main.options.key, panel.options.id)
  assert.notEqual(main.options.key, 'conversation')
  assert.equal(main.options.locale, 'humanity')
})

test('每个校验代码都有中英文案（工作台按代码渲染，不靠宿主中文原句）', async () => {
  const descriptor = await loadBundle()
  const plugin = descriptor.factory(createPlatformRequire())
  const { ctx, localeNamespaces } = createFakeContext()
  plugin.apply(ctx)

  const { zh, en } = localeNamespaces[0].dicts
  for (const code of PERSONA_ISSUE_CODES) {
    const key = `persona.issue.${code}`
    assert.ok(zh[key] !== undefined, `中文字典缺少 ${key}`)
    assert.ok(en[key] !== undefined, `英文字典缺少 ${key}`)
  }
})

test('人格命名空间在宿主与浏览器两侧必须一致（写错了就是读不到数据）', async () => {
  const client = await loadBundle().then((descriptor) => descriptor.factory(createPlatformRequire()))
  assert.equal(client.PERSONA_NAMESPACE, PERSONA_NAMESPACE)
})

test('侧栏字形只画图标，不包按钮（按钮由侧栏外壳负责）', async () => {
  const descriptor = await loadBundle()
  const plugin = descriptor.factory(createPlatformRequire())
  const { ctx, registrations } = createFakeContext()
  plugin.apply(ctx)

  const panel = registrations.find((entry) => entry.options.name === 'sidebar.panellist')
  const markup = render(nodeRequire('react').createElement(panel.component, { size: 16, active: false }))

  // 要守的三件事：① 图标在最外层 span 里（M5 起外面多一层相对定位容器，用来放 P-042 的
  // 待确认红点——槽位契约没有徽标字段，红点只能画在我们自己注册的组件内部）；
  // ② 图标本体仍是 svg，不夹带任何调试标记；③ 没有自己包一层 button。
  assert.match(markup, /^<span/)
  assert.match(markup, /<svg/)
  assert.doesNotMatch(markup, /DEBUG/, '调试标记必须已经清理干净')
  assert.doesNotMatch(markup, /<button/)
})

test('工作台能渲染：总览四项（无通道时如实说读不到）+ 页面清单', async () => {
  const descriptor = await loadBundle()
  const plugin = descriptor.factory(createPlatformRequire())
  const { ctx, registrations, localeNamespaces } = createFakeContext()
  plugin.apply(ctx)

  const translate = translator(localeNamespaces)

  await settle()
  const markup = render(nodeRequire('react').createElement(mainComponent(registrations), { t: translate }))

  assert.match(markup, /Humanity/)
  // 界面是给用户看的：里程碑编号、占位、裁撤这类**开发进度黑话**不该出现（用户 2026-09-26 定）。
  for (const jargon of ['M6', 'M5', '占位', '已裁撤', '未接入']) {
    assert.ok(!markup.includes(jargon), `界面里不该出现开发黑话「${jargon}」`)
  }
  assert.match(markup, /待确认/, '待确认卡片常驻顶部（用户 2026-09-26 定的信息架构）')
  assert.match(markup, /没有积压/, '没积压时也要明确说一句，让人一眼知道不用管')

  // 总览四项（用户 2026-09-26 定的口径）：姓名 / 当前策略 / 最近行为 / 消耗。
  assert.match(markup, /总览/)
  for (const label of ['姓名', '当前策略摘要', '最近行为', '消耗']) {
    assert.ok(markup.includes(label), `总览区缺少指标：${label}`)
  }
  // 姓名来自人格卡：测试里没设过 ⇒ 如实说"还没设置"，不编一个名字。
  assert.match(markup, /还没设置/, '没设姓名时不许编')
  // 其余三项来自宿主投影（控制器未接通道 ⇒ 如实说读不到）。
  assert.equal(markup.split('暂时读不到').length - 1, 3, '三项指标无通道时如实说读不到')
  assert.ok(!markup.includes('后续版本提供'), '不再有"后续版本提供"这种空头承诺')

  // 页面清单整段已按用户的决定**删除**（不可交互的重复列表只是噪音）；页签与总览仍在。
  for (const label of ['总览', '记忆', '自进化', '技能', '待确认']) {
    assert.ok(markup.includes(label), `工作台缺少页面/页签：${label}`)
  }
  assert.ok(!markup.includes('计划中的页面') && !markup.includes('数据 / 设置'), '不该再有页面清单与占位项')

  // 说明收进「?」（用户 2026-09-26）：界面上只留一个圈问号，解释文字不再铺成灰字段落。
  // 判据是"去掉气泡与 aria-label 之后还看得见吗"——同一句话留在 ? 里可以，铺在正文里不行。
  const visible = visibleText(markup)
  for (const gone of ['各模块的开关在 DSH 设置里', '这几项读的是当前真实状态', '她会记住你说过的事']) {
    assert.ok(!visible.includes(gone), `说明文字不该再直接铺在界面上：${gone}`)
  }
  assert.ok(countHints(markup) >= 5, '卡片与条目旁边都要有「?」入口')
  assert.match(markup, /data-tooltip="[^"]*DSH 设置/, '「?」里必须如实指路：开关在 DSH 设置里调')

  // 页签换成卡片式：四张等宽卡片，当前页只有一张亮着。
  assert.match(markup, /grid-template-columns:repeat\(4, minmax\(0, 1fr\)\)/, '页签是四张等宽卡片')
  assert.equal(markup.split('aria-current="page"').length - 1, 1, '当前页只能有一张卡片亮着')
})

test('总览四项：接上投影后显示真实策略 / 最近活动 / 预算（真数据优先于空态）', async () => {
  const client = (await loadBundle()).factory(createPlatformRequire())
  const { ctx, localeNamespaces } = createFakeContext()
  client.apply(ctx)
  const translate = translator(localeNamespaces)

  const memory = fakeSnapshotController({ status: 'ready', policy: { mode: 'balanced' } })
  const evolution = fakeSnapshotController({
    status: 'ready',
    config: { schedule: { mode: 'idle' } },
    runs: [
      { startedAt: '2026-09-25T17:21:00.001Z', status: 'completed' },
      { startedAt: '2026-09-26T02:54:59.966Z', status: 'failed' },
    ],
    dailyCalls: 5,
    dailyCallCap: 20,
  })
  const markup = render(nodeRequire('react').createElement(client.OverviewPanel, { t: translate, memory, evolution }))

  assert.match(markup, /记忆 平衡（默认） · 自进化 空闲自动/, '策略摘要读生效配置')
  assert.match(markup, /09-26 02:54 · 失败/, '最近活动取时间线里最后一条（不是第一条）')
  assert.match(markup, /今日 5 \/ 20 次调用/, '预算读宿主账本')
  assert.ok(!markup.includes('暂时读不到'), '有数据时不该再说读不到')
  // 字体口径（用户 2026-09-26）：左侧指标名小一号，右侧取值大一号并加粗。
  assert.match(markup, /font-size:13px/, '指标名要小一号')
  assert.match(markup, /font-size:17px;font-weight:600/, '取值要大一号且加粗')
  assert.match(markup, /data-tooltip="[^"]*余额查不到/, '消耗行的「?」要交代余额为什么查不到')
})

test('人格页在通道就绪时渲染出可编辑的身份卡与可变层（M2 步 6）', async () => {
  const document = emptyPersona()
  document.identityCard.fields[0].value = '小安'
  document.identityCard.initializedAt = '2026-09-23T00:00:00.000Z'
  document.identityCard.sealedAt = '2026-09-23T00:00:00.000Z'
  document.mutableLayer.sections[1].items = ['先给结论，再给依据']

  const descriptor = await loadBundle()
  const plugin = descriptor.factory(createPlatformRequire())
  const { ctx, registrations, localeNamespaces } = createFakeContext(createFakeChannel(document).channel)
  plugin.apply(ctx)

  const dictionary = localeNamespaces[0].dicts.zh
  const translate = (key) => {
    const value = dictionary[key]
    assert.ok(value !== undefined, `字典缺少键：${key}`)
    return value
  }

  await settle()
  const markup = render(nodeRequire('react').createElement(mainComponent(registrations), { t: translate }))

  // 固定层与可变层是**两张独立卡片**（用户 2026-09-23 最终布局），各自有标题。
  assert.match(markup, /身份卡/)
  assert.match(markup, /人格卡/)
  assert.match(markup, /已封存/)
  // 身份卡的值来自宿主文档（只读渲染也算证明"读到了"）。0.1.13：内容是**一直可编辑的输入框**，
  // 名称才是纯文字 —— 值出现在 `value="…"` 里。
  assert.match(markup, /value="小安"/, '默认态就把内容放在输入框里')
  // 可变层按小标题铺开，内容在**默认可编辑**的多行框里。
  assert.match(markup, /先给结论，再给依据/)
  assert.match(markup, /保存/)
  // 没有改动时保存按钮必须是禁用的：不给出"点了却什么都不发生"的按钮。
  assert.match(markup, /<button[^>]*disabled[^>]*>保存<\/button>/)

  // 独立判断开关（顶层 humanity 配置，不是人格文档字段）：控件在、默认选中、状态文字在。
  assert.match(markup, /🧠 独立判断模式/, '开关的标签文案必须渲染出来')
  assert.match(markup, /type="checkbox"[^>]*checked/, '默认开启时控件处于选中态')
  assert.match(markup, /以事实与证据为准，不迎合、不编造/, '说明文字必须渲染出来')
  assert.match(markup, /已开启/, '必须有显式状态文字')

  // 位置：开关在**身份卡卡片内部、字段之前**，并用一条横线与字段分隔（用户 2026-09-23 最终决定）。
  const switchAt = markup.indexOf('🧠 独立判断模式')
  assert.ok(markup.indexOf('身份卡') < switchAt, '开关属于身份卡卡片')
  // 从开关的位置往后找"姓名"：总览区也有一项叫"姓名"，不能撞它。
  assert.ok(switchAt < markup.indexOf('姓名', switchAt), '开关排在字段之前')
  assert.ok(switchAt < markup.indexOf('人格卡'), '开关不在人格卡（可变层）那张卡片里')
  // 同样只在这个座位之后找（总览区的「姓名」在它前面，会把锚点带偏）。
  const fieldAt = markup.indexOf('姓名', switchAt)
  const ruleAt = markup.indexOf('<hr', switchAt)
  assert.ok(ruleAt > switchAt && ruleAt < fieldAt, '开关与字段之间必须有横线分隔')
  assert.equal(markup.includes('固定层 · 身份卡'), false, '旧的内层小标题已删（标题即卡片标题）')
})

test('崩溃防线：属性兜底、控制器缺失、文档缺数组 —— 三种情形都不抛', async () => {
  // 2026-09-23 真机事故：我们子树里任何一次渲染抛错，React 18 会卸载**整个根**，
  // 用户看到「点一下会话，侧栏所有会话都不见」。下面逐条钉住"不许抛"的三个入口。
  const descriptor = await loadBundle()
  const plugin = descriptor.factory(createPlatformRequire())

  // ① 完全不传 props（宿主在别的视图里可能这么渲染）：`t` 不是函数时用键名兜底。
  const bare = render(nodeRequire('react').createElement(plugin.createWorkbenchSeat(new plugin.PersonaWorkbenchController()), {}))
  assert.ok(bare.length > 0, '没有 t 也要渲染出东西，而不是白屏')

  // ② 控制器缺失：渲染中性说明，而不是让 `undefined.xxx` 一路炸。
  const missing = render(nodeRequire('react').createElement(plugin.createWorkbenchSeat(undefined), { t: (key) => key }))
  assert.match(missing, /暂时无法显示/)

  // ②b 只缺记忆/自进化控制器（人格那一个在场）：旧写法只查人格，于是工作台带着 `undefined`
  //     继续渲染到 `controller.subscribe` 上抛错，被错误边界接住后显示"渲染出错"——
  //     原因说错了，用户照那句话去关人格模块只会更糟（2026-09-26 审计 C1）。
  const partial = render(
    nodeRequire('react').createElement(
      plugin.createWorkbenchSeat(new plugin.PersonaWorkbenchController(), undefined, undefined),
      { t: (key) => key },
    ),
  )
  assert.match(partial, /未完全接上/, '缺记忆/自进化控制器要说"没接上"，不能说"渲染出错"')

  // ③ 错误边界的语义（SSR 渲染器不走错误边界，所以直接验它的两个约定）：
  //    抛错 → 翻标志位；翻了之后渲染 fallback。componentDidCatch 自己也不许抛。
  assert.deepEqual(plugin.PersonaBoundary.getDerivedStateFromError(new Error('boom')), { failed: true })
  const boundary = new plugin.PersonaBoundary({ fallback: 'FB', children: 'KIDS' })
  assert.equal(boundary.render(), 'KIDS')
  boundary.state = { failed: true }
  assert.equal(boundary.render(), 'FB')
  boundary.componentDidCatch(new Error('boom'), { componentStack: '' })
})

test('宿主返回缺数组的文档时，工作台照样渲染（render 期不许读 undefined 的属性）', async () => {
  const descriptor = await loadBundle()
  const plugin = descriptor.factory(createPlatformRequire())

  // 故意造一份"形状残缺"的命名空间值：没有 sections / userDefined。
  const broken = { identityCard: { fields: [] }, mutableLayer: {}, schemaVersion: 1 }
  const channel = {
    describe: async () => ({
      ok: true,
      value: { writable: true, namespaces: [{ ns: 'humanity-persona', value: broken, revision: 1 }] },
    }),
    replace: async () => ({ ok: false, error: { message: 'unused' } }),
    update: async () => ({ ok: false, error: { message: 'unused' } }),
  }

  const controller = new plugin.PersonaWorkbenchController()
  controller.attach(channel)
  await settle()

  assert.equal(controller.getSnapshot().status, 'ready', '缺数组不该被判成失败')
  const markup = render(
    nodeRequire('react').createElement(plugin.createWorkbenchSeat(controller), { t: (key) => key }),
  )
  assert.ok(markup.length > 0, '残缺文档也要能渲染出界面，而不是把外壳带崩')
})

test('顶层配置命名空间在宿主与浏览器两侧必须一致（独立判断开关就写在它上面）', async () => {
  const client = await loadBundle().then((descriptor) => descriptor.factory(createPlatformRequire()))
  assert.equal(client.HUMANITY_NAMESPACE, SETTINGS_NAMESPACE, '写错命名空间等于开关点了没反应')
})

test('技能页：名字、说明、落盘状态、来源与文件路径都在（回答"技能在哪、是什么"）', async () => {
  const client = (await loadBundle()).factory(createPlatformRequire())
  const { ctx, localeNamespaces } = createFakeContext()
  client.apply(ctx)
  const translate = translator(localeNamespaces)

  const controller = fakeSnapshotController({
    skills: [
      {
        name: 'roleplay-memory-verify',
        description: '在角色扮演会话中回答剧情事实前先检索记忆库',
        content: '# 适用场景\n\n角色扮演里被问及剧情事实时。',
        status: 'on-disk',
        file: '/home/user/project/skills/roleplay-memory-verify/SKILL.md',
        origin: '新技能：roleplay-memory-verify',
        decidedAt: '2026-09-25T18:00:00.000Z',
        disabled: false,
        pluginDeps: ['Humanity'],
      },
      {
        name: 'not-flushed-yet',
        description: '还没落盘的',
        content: 'x',
        status: 'runtime-only',
        file: '',
        origin: '',
        decidedAt: '',
        disabled: false,
        pluginDeps: [],
      },
    ],
  })
  const markup = render(nodeRequire('react').createElement(client.SkillsPage, { t: translate, controller }))

  assert.match(markup, /roleplay-memory-verify/)
  assert.match(markup, /已存成文件/)
  assert.match(markup, /还没存成文件/, '没存成文件的技能要如实标注（它就是"找不到"的那种）')
  assert.match(markup, /\/home\/user\/project\/skills\/roleplay-memory-verify\/SKILL\.md/, '必须给出文件路径')
  assert.match(markup, /新技能：roleplay-memory-verify/, '要显示来源提案')
  assert.match(markup, /data-tooltip="[^"]*不会自动执行/, '机制说明挂在标题的「?」上（不再铺成说明段）')
  assert.ok(markup.includes(CARD_SKELETON), '技能卡要用统一骨架（左元信息 | 中内容 | 右操作）')
  assert.ok(!visibleText(markup).includes('不会自动执行'), '机制说明不该同时留在正文里')
  assert.match(markup, /Humanity/, '用到插件的能力时要指名警告（卸载对应插件后这条技能就废了）')
  assert.ok(visibleText(markup).includes('Humanity'), '插件依赖是警告：必须留在正文里，不许收进 ? ')
  assert.ok(!markup.includes('看正文'), '按钮只有「编辑」「停用」：编辑展开即可看正文（用户 2026-09-26 定）')
})

test('技能页：没有技能时给空态与"批准后会出现"的指引（不空白、不假装）', async () => {
  const client = (await loadBundle()).factory(createPlatformRequire())
  const { ctx, localeNamespaces } = createFakeContext()
  client.apply(ctx)

  const markup = render(
    nodeRequire('react').createElement(client.SkillsPage, {
      t: translator(localeNamespaces),
      controller: fakeSnapshotController({ skills: [] }),
    }),
  )
  assert.match(markup, /还没有技能/)
  assert.match(markup, /待确认/, '空态要告诉用户技能从哪来')
})

test('技能页：控制器缺席时照样渲染（崩溃防线，不许读 undefined）', async () => {
  const client = (await loadBundle()).factory(createPlatformRequire())
  const { ctx, localeNamespaces } = createFakeContext()
  client.apply(ctx)

  const markup = render(nodeRequire('react').createElement(client.SkillsPage, { t: translator(localeNamespaces) }))
  assert.ok(markup.length > 0, '缺席也要出界面，而不是把外壳带崩')
})

test('人格卡：注入账目就写在卡上（装得下报条数，装不下如实警告到小节）', async () => {
  /** 起一个装好插件的工作台，返回渲染结果。 */
  const renderWith = async (document) => {
    const descriptor = await loadBundle()
    const plugin = descriptor.factory(createPlatformRequire())
    const { ctx, registrations, localeNamespaces } = createFakeContext(createFakeChannel(document).channel)
    plugin.apply(ctx)
    await settle()
    return render(nodeRequire('react').createElement(mainComponent(registrations), { t: translator(localeNamespaces) }))
  }
  const seeded = (itemsFor) => {
    const document = emptyPersona()
    document.identityCard.fields.forEach((field) => {
      field.value = '值'
    })
    document.identityCard.initializedAt = '2026-09-23T00:00:00.000Z'
    document.identityCard.sealedAt = '2026-09-23T00:00:00.000Z'
    document.mutableLayer.sections.forEach((section) => {
      section.items = itemsFor(section.title)
    })
    return document
  }

  // 装得下：只报条数，不吓人。
  const small = await renderWith(seeded(() => ['一条']))
  assert.match(small, /进提示词 \d+\/\d+ 条/, '卡上要如实写出"进去了几条"')
  assert.equal(small.includes('进不了提示词'), false, '全都进得去时不该报警告')

  // 装不下：必须点名到小节（用户 2026-09-26 发现提示词被截断后才看得见这件事）。
  // 每条都写成不同的字：**完全相同的条目会被规范化折叠掉**（去重是宿主行为，不是这里的考题）。
  const huge = await renderWith(seeded((title) => Array.from({ length: 20 }, (_, index) => `${title}第${index}条${'填'.repeat(60)}`)))
  assert.match(huge, /进不了提示词/, '超出预算时必须给出警告，而不是让用户去翻提示词')
  assert.match(huge, /超出注入预算/, '警告要说清原因')
  assert.match(huge, /条。/, '警告要说明怎么办')
})

/* ---------------------------------------------------------------------------
 * 0.1.13 人格页交互改造（用户 2026-10-09）：默认无输入框 / 项名下删除 / 底部添加
 *
 * 这几条都在**渲染标记**上取证（判据 V5 / V3① / V6 的界面半边）；"真删"与"宿主拒绝"
 * 在 `test/client-persona-ui.test.mjs` 用注入/投影读数另外取证。
 * ------------------------------------------------------------------------- */

/** 一份有"可删的东西"的文档：自定义字段 + 自定义小节 + 用户定义一条。 */
function uiPersona() {
  const document = emptyPersona()
  document.identityCard.fields[0].value = '小安'
  document.identityCard.fields.push({ key: '归属地', value: '示例城市', custom: true })
  document.identityCard.initializedAt = '2026-09-23T00:00:00.000Z'
  document.identityCard.sealedAt = '2026-09-23T00:00:00.000Z'
  document.mutableLayer.sections[0].items = ['主人']
  // 0.1.14：「经验教训」不再是原生项 —— 夹具显式当自定义项加进来（与工作台"添加小节"同语义）。
  withSection(document, '经验教训', ['别在深夜做决定'])
  document.mutableLayer.sections.push({ title: '决定权', items: ['技术判断我说了算'] })
  document.mutableLayer.userDefined.push({ key: '咖啡', value: '不加糖' })
  return document
}

/** 起一个装好文档的人格控制器（工作台默认页签就是人格页）。 */
async function bootUiPersona(document = uiPersona()) {
  const client = (await loadBundle()).factory(createPlatformRequire())
  const controller = new client.PersonaWorkbenchController()
  controller.attach(createFakeChannel(document).channel)
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (controller.getSnapshot().status === 'ready') break
    await settle()
  }
  assert.equal(controller.getSnapshot().status, 'ready', '控制器没在预期时间内读到文档')
  return { client, controller }
}

/** 渲染整个人格工作台（默认页签 = 人格），返回静态标记。 */
async function renderPersona(client, controller) {
  const seat = client.createWorkbenchSeat(
    controller,
    new client.MemoryWorkbenchController(),
    new client.EvolutionWorkbenchController(),
  )
  // `t` 只回键名：这一组断言看的是**结构与标记**，不是文案（文案由字典测试单独钉住）。
  return render(nodeRequire('react').createElement(seat, { t: (key) => key }))
}

/** 数一数标记里的**文本输入控件**（复选框不算：身份卡顶部那个独立判断开关是 checkbox，不是输入框）。 */
const textInputCount = (markup) => (markup.split('<input').length - 1) - (markup.split('type="checkbox"').length - 1)

/** 找一个标记片段的**位置**；找不到直接断言失败（免得 indexOf 的 -1 让顺序断言静默通过）。 */
function at(markup, needle) {
  const index = markup.indexOf(needle)
  assert.ok(index >= 0, `渲染标记里找不到：${needle}`)
  return index
}

/** 某一项**名称区**的标记区间：从项块起点到内容区起点（`data-persona-content`）。 */
function nameRegion(markup, itemId) {
  const start = at(markup, `data-persona-item="${itemId}"`)
  const end = at(markup, `data-persona-content="${itemId}"`)
  assert.ok(start < end, `${itemId} 的内容区应当在名称区之后`)
  return markup.slice(start, end)
}

/** 某一项**内容区**的标记区间：从内容控件那层 `<span>` 开始（到页面结尾，断言只看开头）。 */
function contentRegion(markup, itemId) {
  const marker = at(markup, `data-persona-content="${itemId}"`)
  const start = markup.lastIndexOf('<span', marker)
  assert.ok(start >= 0, `${itemId} 的内容控件应当包在一层 span 里`)
  return markup.slice(start)
}

/* ---------------------------------------------------------------------------
 * 真机修复（0.1.13 装上后用户截图）：V14 按钮并排 / V15 输入框可读
 *
 * 这两条判据都写成**可机械复核的判据函数** + **阴性对照**：
 * 判据函数先在同一次真实渲染上判"成立"，再拿"修复前的标记"判"不成立" ——
 * 这样它就不是恒真的（防"我觉得更好看"）。
 * ------------------------------------------------------------------------- */

/** 取某个标记所在**开标签**的整段（含 style）。 */
function openTagOf(markup, marker) {
  const at = markup.indexOf(marker)
  if (at < 0) return ''
  return markup.slice(markup.lastIndexOf('<', at), markup.indexOf('>', at) + 1)
}

/**
 * **V14 判据**：某一项的「改名」「删除」是否在**同一个横向容器**里。
 *
 * 成立条件（两条缺一不可）：① 有 `data-persona-actions=<项 id>` 这一格，且它的样式是**横向**
 * （`display:flex` + `flex-direction:row`，不是 column）；② 这一格里同时有改名与删除两个标记。
 *
 * ⚠️ 0.1.13 追加 5 改成三栏后，动作格从"名字下面"搬到了**第三栏**（内容格右边），
 * 所以区间是**从动作格起、到下一个项的项名格止**（旧写法切到 `data-persona-content` 已经切到前面去了）。
 * @param markup - 渲染标记。
 * @param itemId - 项 id。
 * @returns 并排成立时为 true。
 */
function actionsShareRow(markup, itemId) {
  const rowAt = markup.indexOf(`data-persona-actions="${itemId}"`)
  if (rowAt < 0) return false
  const tag = openTagOf(markup, `data-persona-actions="${itemId}"`)
  if (!/display:flex/.test(tag) || !/flex-direction:row/.test(tag) || /flex-direction:column/.test(tag)) return false
  const next = markup.indexOf('data-persona-cell="name"', rowAt + 1)
  const cell = markup.slice(rowAt, next < 0 ? undefined : next)
  return cell.includes('data-persona-action="rename"') && cell.includes('data-persona-action="delete"')
}

/**
 * **V15 判据**：内容那层包装**是否真的会把控件拉满**整列宽。
 *
 * 为什么这么判：真机缺陷的根因是"包装层不会拉伸子元素"——原语 `Input` 的外层是
 * `inline-flex`（收缩到内容宽），而 0.1.13 给它套了一层 `display:block` 包装 ⇒ 输入框只剩
 * ≈135px（用户截图里"姓名只剩前半"就是这么来的）。所以判据是**包装层必须是纵向 flex**
 * （`align-items: stretch` 会把子项横向拉满），**或者**控件自带 `width:100%`（`<textarea>` 就是这种）。
 * ⚠️ **只加 `width:100%` 到 block 包装上不算数** —— 那正是修复前的形状（阴性对照钉这一点）。
 * @param markup - 渲染标记。
 * @param itemId - 项 id。
 * @returns 控件会被拉满时为 true。
 */
function contentStretchesControl(markup, itemId) {
  const markerAt = markup.indexOf(`data-persona-content="${itemId}"`)
  if (markerAt < 0) return false
  const tag = openTagOf(markup, `data-persona-content="${itemId}"`)
  const flexColumn = /display:flex/.test(tag) && /flex-direction:column/.test(tag)
  // 控件必须是这层的**直接子元素**（否则拉伸到的是别的层，控件照样窄）。
  const control = markup.slice(markup.indexOf('>', markerAt) + 1, markup.indexOf('>', markerAt) + 200)
  const directChild = /^<(input|textarea|span)/.test(control)
  const ownWidth = /^<(input|textarea)[^>]*style="[^"]*width:100%/.test(control)
  return directChild && (flexColumn || ownWidth)
}

/** 修复前的形状（0.1.13 首版/返工的标记）：`display:block` 包装 + 裸 `<input>`，按钮上下堆叠。 */
const OLD_IDENTITY_ROW = [
  '<div style="margin-bottom:8px" data-persona-item="identity:4">',
  '<div style="display:grid;grid-template-columns:minmax(96px, 160px) minmax(0, 1fr);align-items:start;gap:12px">',
  '<div style="display:flex;flex-direction:column;align-items:flex-start;gap:4px">',
  '<span style="font-size:13px">原型</span>',
  '<span data-persona-action="rename" data-persona-item="identity:4"><button>改名</button></span>',
  '<span data-persona-action="delete" data-persona-item="identity:4"><button>删除</button></span>',
  '</div>',
  '<span data-persona-content="identity:4" data-persona-editor="value" style="display:block;min-width:0">',
  '<input value="DeepSeek（用户主动提供）"/>',
  '</span></div></div>',
].join('')

/** 三栏改造**之前**的动作格形状（真机截图那一版）：有 `data-persona-actions`，但是**纵向**容器。 */
const OLD_STACKED_ACTIONS = [
  '<div style="margin-bottom:8px" data-persona-item="identity:4">',
  '<div style="display:grid;grid-template-columns:minmax(96px, 160px) minmax(0, 1fr);align-items:start;gap:12px">',
  '<div style="display:flex;flex-direction:column;align-items:flex-start;gap:4px">',
  '<span style="font-size:13px">原型</span>',
  '<div style="display:flex;flex-direction:column;align-items:flex-start;gap:4px" data-persona-actions="identity:4">',
  '<span data-persona-action="rename" data-persona-item="identity:4"><button>改名</button></span>',
  '<span data-persona-action="delete" data-persona-item="identity:4"><button>删除</button></span>',
  '</div></div>',
  '<span data-persona-content="identity:4" data-persona-editor="value" style="display:flex;flex-direction:column">',
  '<input value="x"/></span></div>',
].join('')

test('V14 判据本身不是恒真的（阴性对照）：旧形状必须判"不并排"', () => {
  assert.equal(actionsShareRow(OLD_IDENTITY_ROW, 'identity:4'), false, '没有动作格时判据必须为假')
  assert.equal(
    actionsShareRow(OLD_STACKED_ACTIONS, 'identity:4'),
    false,
    '动作格是**纵向**容器（真机截图那一版）时判据必须为假',
  )
  assert.equal(contentStretchesControl(OLD_IDENTITY_ROW, 'identity:4'), false, 'block 包装 + 裸 input 必须判"不会拉满"')
  // 只把宽度补上（`display:block;width:100%`）**仍然**不算修好：外层 inline-flex 依旧收缩。
  const widthOnly = OLD_IDENTITY_ROW.replace('style="display:block;min-width:0"', 'style="display:block;width:100%;min-width:0"')
  assert.equal(contentStretchesControl(widthOnly, 'identity:4'), false, '只加 width:100% 到 block 包装上骗不过判据')
  // 把包装改成纵向 flex 之后，同一个判据才为真 —— 说明它辨的是"会不会拉伸"，不是"有没有写 width"。
  const flexFixed = OLD_IDENTITY_ROW.replace('style="display:block;min-width:0"', 'style="display:flex;flex-direction:column;width:100%;min-width:0"')
  assert.equal(contentStretchesControl(flexFixed, 'identity:4'), true)
})

test('V14 正面：同一项的「改名」「删除」在**同一行**（动作格里左右并排）', async () => {
  const { client, controller } = await bootUiPersona()
  const markup = await renderPersona(client, controller)

  // 两个自定义项：两个动作都在，且同属一个横向容器。
  for (const id of ['identity:4', 'section:决定权']) {
    assert.equal(actionsShareRow(markup, id), true, `${id} 的「改名」「删除」应当并排`)
  }
  // 横向容器的样式读数（人工可核对）：横向 + 不换行。
  const rowTag = openTagOf(markup, 'data-persona-actions="section:决定权"')
  assert.match(rowTag, /display:flex/)
  assert.match(rowTag, /flex-direction:row/)
  assert.match(rowTag, /flex-wrap:nowrap/)
  assert.equal(rowTag.includes('flex-direction:column'), false, '不能是纵向容器')

  // ⚠️ 0.1.14：已经没有"可删但不可改名"的项了 —— 自定义项两个动作都有（上面已验），
  // 原生项两个都没有（下面验）。旧用例里那半段（拿「经验教训」当"标准小节"）随产品决定删除。
  // 锁定项（两个动作都没有）：动作格作为**空占位**仍然在（三栏结构要一致），但里面没有任何动作。
  for (const id of ['identity:0', 'section:对用户称呼']) {
    const at = markup.indexOf(`data-persona-actions="${id}"`)
    assert.ok(at >= 0, `${id} 应当有空的动作格占位（三栏结构一致）`)
    const cell = markup.slice(at, markup.indexOf('data-persona-cell="name"', at + 1))
    assert.equal(cell.includes('data-persona-action='), false, `${id} 的动作格必须是空的`)
  }
})

test('V15 正面：身份卡的输入框**会被拉满整列**（长值可读，不再只剩前半）', async () => {
  // 夹具用长值形态：姓名「本名：「示例」；别名…」与人格偏好那句（要测的是长度与可读性）。
  const document = uiPersona()
  document.identityCard.fields[0].value = '本名：「示例」；别名：「例子」或「例」'
  document.identityCard.fields[2].value = '示例偏好项；示例标注！'
  const { client, controller } = await bootUiPersona(document)
  const markup = await renderPersona(client, controller)

  // ① 值本身完整可达（必要条件；真正的病根在宽度上，所以下面还有 ②）。
  assert.match(markup, /value="本名：「示例」；别名：「例子」或「例」"/, '姓名长值完整在 value 里')
  assert.match(markup, /value="示例偏好项；示例标注！"/, '人格偏好长值完整在 value 里')

  // ② 控件会被拉满：身份卡值 / 用户定义值都走 `editorCell`，人格卡多行框自带 width:100%。
  for (const id of ['identity:0', 'identity:2', 'identity:4', 'section:决定权', 'section:经验教训']) {
    assert.equal(contentStretchesControl(markup, id), true, `${id} 的控件应当被包装层拉满整列`)
  }
  // ③ 包装层样式读数（人工可核对），以及多行框仍然自带宽度。
  const tag = openTagOf(markup, 'data-persona-content="identity:0"')
  assert.match(tag, /display:flex/)
  assert.match(tag, /flex-direction:column/)
  assert.match(tag, /width:100%/)
  assert.match(contentRegion(markup, 'section:经验教训'), /<textarea[^>]*width:100%/, '多行框照旧自带宽度')

  // ④ 改名与底部添加表单的输入框走的是同一层包装 —— 一起被修好。
  controller.beginRename('section:决定权')
  const renaming = await renderPersona(client, controller)
  assert.equal(contentStretchesControl(renaming, 'section:决定权'), true)
  assert.match(openTagOf(renaming, 'data-persona-editor="rename"'), /flex-direction:column/)
  controller.cancelRename()
  controller.openAdd('identity')
  const adding = await renderPersona(client, controller)
  for (const marker of ['data-persona-editor="add-name"', 'data-persona-editor="add-value"']) {
    assert.match(openTagOf(adding, marker), /display:flex/)
    assert.match(openTagOf(adding, marker), /flex-direction:column/)
  }
})

test('V16 回归口径：默认态名称区仍无输入框、内容区仍是输入框（真机修复没把 V5/V12 改回去）', async () => {
  const { client, controller } = await bootUiPersona()
  const markup = await renderPersona(client, controller)

  const ids = ['identity:0', 'identity:4', 'section:决定权', 'section:对用户称呼', 'section:经验教训', 'section:决定权']
  for (const id of ids) {
    const region = nameRegion(markup, id)
    assert.equal(region.includes('<input'), false, `${id} 的名称区仍不许有输入框`)
    assert.equal(region.includes('<textarea'), false, `${id} 的名称区仍不许有多行框`)
  }
  for (const id of ['identity:0', 'identity:4']) {
    assert.match(contentRegion(markup, id), /^<span data-persona-content="[^"]+" data-persona-editor="value"[^>]*><input/)
  }
  assert.match(contentRegion(markup, 'section:经验教训'), /^<span data-persona-content="section:经验教训"[^>]*data-persona-editor="section"[^>]*><textarea/)
})

/* ---------------------------------------------------------------------------
 * 0.1.13 追加 5：三栏布局（名称 | 内容 | 动作）—— V17 / V18
 * ------------------------------------------------------------------------- */

/**
 * **V17 判据**：同一项的三格是否**按 名称 → 内容 → 动作 顺序横向排列**（动作在内容**右侧**）。
 *
 * 位置判据（DOM 顺序）+ 结构判据（三格同属一个声明的三轨网格容器）合起来才说明"横向一行"：
 * 只判顺序的话，"三个上下堆叠的块"也能满足顺序。
 * @param markup - 渲染标记。
 * @param itemId - 项 id。
 * @returns 三栏结构成立时为 true。
 */
function threeColumnRow(markup, itemId) {
  const nameAt = markup.indexOf(`data-persona-cell="name" data-persona-item="${itemId}"`)
  const contentAt = markup.indexOf(`data-persona-content="${itemId}"`)
  const actionsAt = markup.indexOf(`data-persona-actions="${itemId}"`)
  if (nameAt < 0 || contentAt < 0 || actionsAt < 0) return false
  if (!(nameAt < contentAt && contentAt < actionsAt)) return false
  // 三格必须落在**同一个**三轨网格容器里（容器起点在名称格之前、且是网格）。
  const listAt = markup.lastIndexOf('data-persona-list="', nameAt)
  if (listAt < 0) return false
  const listTag = markup.slice(markup.lastIndexOf('<', listAt), markup.indexOf('>', listAt))
  const tracks = /grid-template-columns:([^";]*)/.exec(listTag)
  return /display:grid/.test(listTag) && tracks !== null && splitTracks(tracks[1]).length === 3
}

/** 把 `grid-template-columns` 的值切成轨（按空格切，但不切开 `minmax(a, b)` 这种带括号的）。 */
function splitTracks(value) {
  return (value.match(/minmax\([^)]*\)|max-content|min-content|auto|[\d.]+(?:px|fr|%)/g) ?? [])
}

/** 列表网格的列宽定义读数（V18 的来源）。 */
function tracksOf(markup, listKind) {
  const tag = openTagOf(markup, `data-persona-list="${listKind}"`)
  const found = /grid-template-columns:([^";]*)/.exec(tag)
  return found === null ? undefined : found[1].trim()
}

/**
 * **V18 判据**：内容栏是否"**弹性吃满 + 有可用下限**"。
 *
 * 从渲染出来的 `grid-template-columns` 直接读：
 * - 第一轨（名称）必须是**窄的固定轨**（`minmax(…px…)`）；
 * - 第二轨（内容）必须是 `minmax(<≥下限>px, <n>fr)` —— `fr` = 吃满剩余，`px` 下限 = 可用宽度下限；
 * - 第三轨（动作）必须是**收缩轨**（`max-content`），不抢内容栏的宽度。
 *
 * ⚠️ 这条判据的意义在于**构造上成立**：模板里写了 `minmax(240px, 1fr)`，
 * 内容栏在任何视口下都不会窄于 240px（窄到放不下时宁可整行溢出，也不把内容压回去）。
 * 阴性对照见下一条用例：固定窄宽 / 下限太小，判据都必须为假。
 * @param tracks - `grid-template-columns` 的值。
 * @param floor - 可用宽度下限（px）。
 * @returns 成立时为 true。
 */
function contentColumnUsable(tracks, floor = 240) {
  if (tracks === undefined) return false
  const parts = splitTracks(tracks)
  if (parts.length !== 3) return false
  const [name, content, actions] = parts
  if (!/^minmax\(\s*\d+(?:\.\d+)?px\s*,/.test(name)) return false
  const middle = /^minmax\(\s*(\d+(?:\.\d+)?)px\s*,\s*(\d+(?:\.\d+)?)fr\s*\)$/.exec(content)
  if (middle === null) return false
  if (Number(middle[1]) < floor) return false
  if (Number(middle[2]) < 1) return false
  return actions === 'max-content'
}

test('V18 判据本身不是恒真的（阴性对照）：固定窄宽 / 下限太小都必须判失败', () => {
  assert.equal(contentColumnUsable('minmax(96px, 160px) minmax(240px, 1fr) max-content'), true, '当前形态成立')
  assert.equal(
    contentColumnUsable('minmax(96px, 160px) 220px max-content'),
    false,
    '内容栏固定窄宽（220px）⇒ 必须判失败',
  )
  assert.equal(
    contentColumnUsable('minmax(96px, 160px) minmax(0, 1fr) max-content'),
    false,
    '弹性但没有下限（minmax(0,1fr)）⇒ 必须判失败（可能被压到很窄）',
  )
  assert.equal(
    contentColumnUsable('minmax(96px, 160px) minmax(120px, 1fr) max-content'),
    false,
    '下限只有 120px ⇒ 必须判失败',
  )
  assert.equal(contentColumnUsable('minmax(96px, 160px) minmax(0, 1fr)'), false, '只有两轨 ⇒ 不是三栏')
  assert.equal(contentColumnUsable(undefined), false, '读不到列宽定义 ⇒ 不能算成立')
})

test('V17 正面：每一项的三格都按「名称 → 内容 → 动作」横向排列（动作在内容右侧）', async () => {
  const { client, controller } = await bootUiPersona()
  const markup = await renderPersona(client, controller)

  const ids = [
    'identity:0',
    'identity:1',
    'identity:2',
    'identity:3',
    'identity:4',
    // 0.1.14：原生小节只剩 4 个；「经验教训」「决定权」是夹具当**自定义项**加进来的，同样三栏一行。
    'section:对用户称呼',
    'section:说话风格',
    'section:交付格式',
    'section:行为边界',
    'section:经验教训',
    'section:决定权',
  ]
  for (const id of ids) {
    assert.equal(threeColumnRow(markup, id), true, `${id} 应当是"名称 → 内容 → 动作"三栏一行`)
  }

  // 两个列表容器都是**三轨网格**，且列宽定义一致（这样跨列表也对齐）。
  // （0.1.14：`userDefined` 列表随区块下线，不再渲染。）
  for (const kind of ['identity', 'section']) {
    const tag = openTagOf(markup, `data-persona-list="${kind}"`)
    assert.match(tag, /display:grid/)
    assert.equal(splitTracks(tracksOf(markup, kind)).length, 3, `${kind} 列表必须是三轨`)
    assert.equal(tracksOf(markup, kind), tracksOf(markup, 'identity'), '三张列表的栅格必须完全一致')
  }

  // 垂直居中：容器声明 align-items:center（用户要的"整齐"）。
  assert.match(openTagOf(markup, 'data-persona-list="section"'), /align-items:center/)

  // 反面：动作**不在**内容下方 —— 若把动作格排在内容格之前（旧的"名字下方"版式），判据为假。
  const oldOrder = markup
    .replace('data-persona-cell="name" data-persona-item="section:决定权"', 'data-persona-cell="name" data-persona-item="__moved__"')
  assert.equal(threeColumnRow(oldOrder, 'section:决定权'), false, '名称格挪走之后判据必须为假（判据不是恒真的）')
})

test('V18 正面：内容栏弹性吃满且下限 240px；控件确实落在这条弹性轨里', async () => {
  const { client, controller } = await bootUiPersona()
  const markup = await renderPersona(client, controller)

  // ① 两道栅格（身份卡 / 人格卡）都必须满足"弹性 + 下限"。
  //    （0.1.14：「用户定义」列表随区块下线，不再渲染，因此不再有第三道。）
  for (const kind of ['identity', 'section']) {
    const tracks = tracksOf(markup, kind)
    assert.equal(contentColumnUsable(tracks), true, `${kind} 的内容栏必须弹性吃满且有 ≥240px 下限（实际：${tracks}）`)
  }

  // ② 控件确实落在这条弹性轨里（V15 的判据：包装层把控件拉满整格）。
  for (const id of ['identity:0', 'identity:2', 'identity:4', 'section:经验教训', 'section:决定权']) {
    assert.equal(contentStretchesControl(markup, id), true, `${id} 的内容控件必须被拉满弹性轨`)
  }

  // ③ 底部添加入口的内部网格与列表**同一套列宽**（所以输入区与上面的项严格对齐）。
  controller.openAdd('section')
  const adding = await renderPersona(client, controller)
  const bandTag = openTagOf(adding, 'data-persona-add="section"')
  assert.match(bandTag, /grid-column:1 \/ -1/, '添加区横跨三栏')
  const inner = /<div style="(display:grid;grid-template-columns:[^"]*)"/.exec(
    adding.slice(adding.indexOf('data-persona-add="section"')),
  )
  assert.ok(inner !== null, '添加区内部应当有网格')
  const innerTracks = /grid-template-columns:([^";]*)/.exec(inner[1])
  assert.equal(innerTracks[1].trim(), tracksOf(adding, 'section'), '添加区的列宽必须与列表一致')
  // 添加区的三个控件各就其位：名称在第一栏、内容在第二栏、保存/取消在动作栏。
  const cells = ['data-persona-editor="add-name"', 'data-persona-editor="add-value"', 'data-persona-action="add-save"']
  const positions = cells.map((marker) => adding.indexOf(marker))
  assert.ok(positions.every((value) => value >= 0), '三个控件都必须渲染')
  assert.ok(positions[0] < positions[1] && positions[1] < positions[2], '添加区也按 名称 → 内容 → 动作 排')
})

test('V5 形态：**名称区没有输入框**，而**内容区一直是输入框**（用户 2026-10-09 的口径）', async () => {
  const { client, controller } = await bootUiPersona()
  const markup = await renderPersona(client, controller)

  // ① 内容区：每一项都有可编辑控件（单行框 / 多行框），**不需要**先点一下。
  for (const id of ['identity:0', 'identity:4']) {
    assert.match(
      contentRegion(markup, id),
      new RegExp(`^<span data-persona-content="${id}"[^>]*data-persona-editor="value"[^>]*><input`),
      `${id} 的内容区必须是输入框`,
    )
  }
  assert.match(
    contentRegion(markup, 'section:经验教训'),
    /^<span data-persona-content="section:经验教训"[^>]*data-persona-editor="section"[^>]*><textarea/,
    '小节内容区必须有多行框',
  )

  // ② 名称区：一个输入控件都没有（这就是用户说的"名称不要输入框"）。
  for (const id of ['identity:0', 'identity:4', 'section:决定权', 'section:经验教训', 'section:对用户称呼']) {
    const region = nameRegion(markup, id)
    assert.equal(region.includes('<input'), false, `${id} 的名称区不该有输入框`)
    assert.equal(region.includes('<textarea'), false, `${id} 的名称区不该有多行框`)
    assert.equal(region.includes('data-persona-editor'), false, `${id} 的名称区不该有任何编辑控件`)
  }

  // ③ 全页读数（便于人工核对）：输入框只出现在"内容区"与"底部添加表单"里，且默认没有展开的添加表单。
  assert.equal(markup.includes('data-persona-add="'), false, '默认态没有展开的添加表单')
  assert.ok(textInputCount(markup) > 0, '内容区确实渲染了输入框（不是整页都没有）')
  assert.match(markup, /value="小安"/, '内容以输入框的值呈现')
})

test('V5 阴性对照：名称区**不**是可编辑控件，内容区才是 —— 两者在同一次渲染里同时成立', async () => {
  const { client, controller } = await bootUiPersona()
  const markup = await renderPersona(client, controller)

  // 身份卡第一项：名称「姓名」是纯文字（`<span>`），内容「小安」在 `<input value>` 里。
  const name = nameRegion(markup, 'identity:0')
  assert.match(name, />姓名</, '名称以一串纯文字出现')
  assert.equal(name.includes('data-persona-editor'), false, '名称区没有编辑控件')
  assert.match(contentRegion(markup, 'identity:0'), /value="小安"/, '内容在输入框里')

  // 小节：名称「经验教训」纯文字；内容进 textarea（值作为子节点渲染）。
  const sectionName = nameRegion(markup, 'section:经验教训')
  assert.match(sectionName, />经验教训</)
  assert.equal(sectionName.includes('data-persona-editor'), false)
  assert.match(
    contentRegion(markup, 'section:经验教训'),
    /<textarea[^>]*>别在深夜做决定<\/textarea>/,
    '小节内容在可编辑的多行框里',
  )
})

test('V3 正面：**锁定的 8 项**在界面上没有删除入口，其余项都有', async () => {
  const { client, controller } = await bootUiPersona()
  const markup = await renderPersona(client, controller)
  const deleteMarker = (id) => `data-persona-action="delete" data-persona-item="${id}"`

  // ① 锁定的 8 项：一个删除控件都没有。
  for (const id of ['identity:0', 'identity:1', 'identity:2', 'identity:3']) {
    assert.equal(markup.includes(deleteMarker(id)), false, `${id} 是锁定项，界面上不该有删除入口`)
  }
  for (const title of ['对用户称呼', '说话风格', '交付格式', '行为边界']) {
    assert.equal(markup.includes(deleteMarker(`section:${title}`)), false, `「${title}」是锁定项，界面上不该有删除入口`)
    assert.match(markup, new RegExp(`data-persona-item="section:${title}"[^>]*data-locked="true"`), `「${title}」要标明是锁定项`)
  }

  // ② 其余项（自定义字段 / **非原生的**小节，含原来的「经验教训」）：删除入口在。
  //    ⚠️ 0.1.14：「经验教训」不再是原生项，因此它**有**删除入口 —— 这条正是用户要的"其余都一样待遇"。
  for (const id of ['identity:4', 'section:经验教训', 'section:决定权']) {
    assert.equal(markup.includes(deleteMarker(id)), true, `${id} 应当可以删除`)
  }

  // ③ 位置：三栏顺序 **名称 → 内容 → 动作**（0.1.13 追加 5 的布局：动作在内容**右侧**，
  //    不再是"名字下方" —— 那条老要求已被用户的新布局取代）。
  for (const [name, id] of [['归属地', 'identity:4'], ['决定权', 'section:决定权']]) {
    const nameAt = at(markup, `>${name}<`)
    const contentAt = at(markup, `data-persona-content="${id}"`)
    const deleteAt = at(markup, deleteMarker(id))
    assert.ok(nameAt < contentAt, `「${name}」：名称栏在内容栏左边`)
    assert.ok(contentAt < deleteAt, `「${name}」：删除按钮在内容栏**右边**（三栏布局）`)
  }
})

test('V3 删除要二次确认：界面先出确认带，确认前内容一个字不动', async () => {
  const { client, controller } = await bootUiPersona()

  controller.requestDelete('section:决定权')
  const pending = await renderPersona(client, controller)
  assert.match(pending, /data-persona-action="delete-confirm-band" data-persona-item="section:决定权"/, '要点名删的是哪一项')
  assert.match(pending, /data-persona-action="delete-confirm" data-persona-item="section:决定权"/)
  assert.match(pending, /data-persona-action="delete-cancel" data-persona-item="section:决定权"/)
  assert.match(pending, />决定权</, '确认之前这一项还在界面上')
  assert.equal(controller.getSnapshot().draft.mutableLayer.sections.some((s) => s.title === '决定权'), true)

  controller.cancelDelete()
  const cancelled = await renderPersona(client, controller)
  assert.equal(cancelled.includes('delete-confirm-band'), false, '取消之后确认带消失')
  assert.match(cancelled, />决定权</, '取消不删任何东西')
})

test('V3 锁定项连二次确认都进不去：界面上没有确认带，草稿也不动', async () => {
  const { client, controller } = await bootUiPersona()

  // 「对用户称呼」是锁定的标准小节：强行请求删除，控制器直接静默拒绝。
  controller.requestDelete('section:对用户称呼')
  assert.equal(controller.getSnapshot().pendingDelete, undefined)
  const markup = await renderPersona(client, controller)
  assert.equal(markup.includes('delete-confirm-band'), false, '锁定项不该出现确认带')
  assert.equal(
    controller.getSnapshot().draft.mutableLayer.sections.some((s) => s.title === '对用户称呼'),
    true,
  )
})

test('V6 添加走底部入口：默认只有一个按钮，点开才出现输入区 + 保存按钮', async () => {
  const { client, controller } = await bootUiPersona()

  const closed = await renderPersona(client, controller)
  assert.equal(closed.includes('data-persona-add="'), false, '默认态没有展开的输入区')
  assert.match(closed, /data-persona-action="add-open"/, '底部要有添加入口')
  // 两个入口：身份卡加字段 / 人格卡加小节（0.1.14：「用户定义」加一条已随区块下线）。
  assert.equal(closed.split('data-persona-action="add-open"').length - 1, 2)

  controller.openAdd('identity')
  const opened = await renderPersona(client, controller)
  assert.match(opened, /data-persona-add="identity"/, '点开之后出现输入区')
  assert.match(opened, /data-persona-editor="add-name"/)
  assert.match(opened, /data-persona-editor="add-value"/)
  assert.match(opened, /data-persona-action="add-save"/, '输入区下方要有保存按钮')
  assert.match(opened, /data-persona-action="add-cancel"/)
  // 空输入 ⇒ 保存按钮是禁用的（不给"点了却什么都不发生"的按钮）。
  const save = opened.slice(at(opened, 'data-persona-action="add-save"'), at(opened, 'data-persona-action="add-cancel"'))
  assert.match(save, /disabled/, '空输入时保存按钮必须禁用')

  // 填齐之后按钮可用，保存后新项出现在列表里。
  controller.setAddField('name', '时区')
  controller.setAddField('value', 'UTC+8')
  const filled = await renderPersona(client, controller)
  const saveFilled = filled.slice(at(filled, 'data-persona-action="add-save"'), at(filled, 'data-persona-action="add-cancel"'))
  assert.equal(saveFilled.includes('disabled'), false, '填齐之后保存按钮可用')

  await controller.commitAdd()
  const afterSave = await renderPersona(client, controller)
  assert.match(afterSave, />时区</, '保存后新项出现在列表里')
  assert.equal(afterSave.includes('data-persona-add="identity"'), false, '保存后表单收起')
})

test('V6 取消：表单收起、草稿一个字不动', async () => {
  const { client, controller } = await bootUiPersona()

  controller.openAdd('section')
  controller.setAddField('name', '原型')
  controller.setAddField('value', '女仆长·示例')
  controller.cancelAdd()

  const markup = await renderPersona(client, controller)
  assert.equal(markup.includes('data-persona-add="section"'), false, '取消后表单收起')
  assert.equal(markup.includes('>原型<'), false, '取消不留下半成品')
  assert.equal(controller.getSnapshot().draft.mutableLayer.sections.some((s) => s.title === '原型'), false)
})

test('V4 界面半边：删掉的小节不再出现在列表里（不复活成空壳）', async () => {
  const { client, controller } = await bootUiPersona()

  // 0.1.12 的形态是"标准小节永远补齐"：删掉之后界面会当场长回一个空壳（删了还在、还打不进字）。
  controller.requestDelete('section:经验教训')
  controller.confirmDelete()

  const markup = await renderPersona(client, controller)
  assert.equal(markup.includes('data-persona-item="section:经验教训"'), false, '整项删除后列表里不再有它')
  assert.equal(markup.includes('>别在深夜做决定<'), false, '它的内容也不再显示')
  // 其它小节与锁定项照旧在（不是整张卡都没了）。
  assert.match(markup, />对用户称呼</)
  assert.match(markup, />决定权</)
})

/* ---------------------------------------------------------------------------
 * 0.1.13 追加：给**自定义项**加「改名」入口（V10 界面半边 / V11 / V12 / V13 界面）
 * ------------------------------------------------------------------------- */

/** 某个项有没有某个动作入口（标记里 `data-persona-action` + `data-persona-item` 成对出现）。 */
const hasAction = (markup, action, itemId) => markup.includes(`data-persona-action="${action}" data-persona-item="${itemId}"`)

/** 锁定的 8 项（4 个核心身份字段 + 4 个锁定小节）。 */
const LOCKED_IDS = [
  'identity:0',
  'identity:1',
  'identity:2',
  'identity:3',
  'section:对用户称呼',
  'section:说话风格',
  'section:交付格式',
  'section:行为边界',
]
/** 非原生的小节（0.1.14 起与用户自己加的小节**同待遇**：可删、可改名）。 */
const STANDARD_UNLOCKED_IDS = ['section:经验教训']

test('V10 界面：自定义项有「改名」入口，点了名称那一格才出现输入框（+ 确定/取消）', async () => {
  const { client, controller } = await bootUiPersona()
  const closed = await renderPersona(client, controller)

  // 两个自定义项各一个入口：自定义身份卡字段 / 非原生小节（含原来的「经验教训」）。
  for (const id of ['identity:4', 'section:决定权', 'section:经验教训']) {
    assert.equal(hasAction(closed, 'rename', id), true, `${id} 应当有「改名」入口`)
  }
  assert.equal(closed.includes('data-persona-rename='), false, '默认态没有展开的改名输入框')

  controller.beginRename('section:决定权')
  const opened = await renderPersona(client, controller)
  assert.match(opened, /data-persona-editor="rename" data-persona-rename="section:决定权"/, '名称那一格换成输入框')
  assert.equal(hasAction(opened, 'rename-confirm', 'section:决定权'), true)
  assert.equal(hasAction(opened, 'rename-cancel', 'section:决定权'), true)
  // 输入框里预填**当前名字**（改名不是"重新起一个"，用户看得见自己在改什么）。
  assert.match(opened, /data-persona-rename="section:决定权"[^>]*><input[^>]*value="决定权"/)
})

test('V11 反面：**锁定的 8 项**都没有「改名」入口（名字是插件认的标识）', async () => {
  const { client, controller } = await bootUiPersona()
  const markup = await renderPersona(client, controller)

  // 0.1.14：只有锁定的 8 项（身份卡 4 + 原生小节 4）没有改名入口；
  // 非原生小节（`STANDARD_UNLOCKED_IDS`，即原来的「经验教训」）**有**入口 —— 见上面 V10。
  for (const id of LOCKED_IDS) {
    assert.equal(hasAction(markup, 'rename', id), false, `${id} 不该有「改名」入口`)
  }
  // 反面还要有另一半：这些项**强行**请求改名也进不去（连输入框都不出现）。
  for (const id of LOCKED_IDS) {
    controller.beginRename(id)
    assert.equal(controller.getSnapshot().renaming, undefined, `${id} 强行 beginRename 也必须是空操作`)
  }
  // 而非原生项强行改名**能**进去（证明这条判据不是"一律拒绝"的恒真式）。
  controller.beginRename('section:经验教训')
  assert.notEqual(controller.getSnapshot().renaming, undefined, '「经验教训」应当进得了改名态')
  controller.cancelRename()

  const after = await renderPersona(client, controller)
  assert.equal(after.includes('data-persona-rename='), false, '取消后一个改名输入框都不留')
})

test('V12 不破新口径：默认态名称区仍无输入框；改名态只动那一项，内容区照旧可编辑', async () => {
  const { client, controller } = await bootUiPersona()
  const before = await renderPersona(client, controller)

  // ① 默认态：**所有**项的名称区都没有输入控件（上一轮的口径不能因为加了改名而破掉）。
  const allIds = ['identity:0', 'identity:1', 'identity:2', 'identity:3', 'identity:4']
  // 0.1.14：原生 4 个 + 非原生的自定义小节（含原来的「经验教训」）。
  for (const title of ['对用户称呼', '说话风格', '交付格式', '行为边界', '经验教训', '决定权']) {
    allIds.push(`section:${title}`)
  }
  for (const id of allIds) {
    assert.equal(nameRegion(before, id).includes('<input'), false, `默认态 ${id} 的名称区不该有输入框`)
  }

  // ② 改名态：只有被改名的那一项名称区有输入框，其余项一个都没有。
  //    （0.1.14：「用户定义」不再是可改名的项 ⇒ 这里拿非原生小节当样本。）
  controller.beginRename('section:经验教训')
  const during = await renderPersona(client, controller)
  assert.match(during, /data-persona-rename="section:经验教训"/)
  for (const id of allIds.filter((value) => value !== 'section:经验教训')) {
    assert.equal(nameRegion(during, id).includes('<input'), false, `改名 ${id} 时别人的名称区不该冒出输入框`)
  }

  // ③ 内容区仍可编辑（改的是名字，不是内容）。
  assert.match(contentRegion(during, 'section:经验教训'), /[^>]*><textarea/, '小节内容区照旧是多行框')
  assert.match(contentRegion(during, 'section:决定权'), /[^>]*><textarea/, '小节内容区照旧是多行框')
  assert.match(contentRegion(during, 'identity:0'), /[^>]*><input/, '身份卡字段内容区照旧是单行框')
})

test('V13 界面：空名 / 没改动 / 重名 / 撞标准名都有明确提示，且确定键禁用', async () => {
  const { client, controller } = await bootUiPersona()
  const issueOf = async () => {
    const markup = await renderPersona(client, controller)
    const found = /data-persona-rename-issue="([a-z]+)"/.exec(markup)
    return found === null ? undefined : found[1]
  }
  const confirmDisabled = async () => {
    const markup = await renderPersona(client, controller)
    const from = markup.indexOf('data-persona-action="rename-confirm"')
    const to = markup.indexOf('data-persona-action="rename-cancel"')
    return markup.slice(from, to).includes('disabled')
  }

  controller.beginRename('section:决定权')
  // 打开时预填的就是当前名字 ⇒ 状态是"没有可提交的改动"（不是错误，但**明确写出来**，
  // 这样确定键为什么是灰的永远有解释 —— 不留"点了没反应"的按钮）。
  assert.equal(await issueOf(), 'unchanged', '刚打开时名字没变 ⇒ 明确写出"没有可提交的改动"')
  assert.equal(await confirmDisabled(), true, '没改动 ⇒ 确定键禁用')

  controller.setRenameName('   ')
  assert.equal(await issueOf(), 'empty', '空名（连空格也算空）')
  assert.equal(await confirmDisabled(), true)

  // 0.1.14：保留名只剩"锁定的 8 项"（4 个固定层字段名 + 4 个原生小节标题）。
  // 原来的「经验教训」不再是保留名 —— 改成它是**合法**的（只要不撞已有项），见下一条用例。
  controller.setRenameName('对用户称呼')
  assert.equal(await issueOf(), 'reserved', '撞原生锁定小节名 ⇒ 保留名，不给自定义项用')
  assert.equal(await confirmDisabled(), true)

  controller.setRenameName('决定权')
  assert.equal(await issueOf(), 'unchanged', '改回原名同样没有可提交的改动')
  assert.equal(await confirmDisabled(), true)

  controller.cancelRename()
  const cancelled = await renderPersona(client, controller)
  assert.equal(cancelled.includes('data-persona-rename='), false, '取消后名字输入框消失')
  assert.equal(cancelled.includes('data-persona-rename-issue'), false, '提示也一起消失')
})

test('V13 界面：重名（同层 / 跨层）都明确报出来，且不许静默覆盖', async () => {
  // 多造两项，才能同时考"同层重名"（小节 ↔ 小节）与"跨层重名"（字段 ↔ 用户定义的键）。
  const document = uiPersona()
  document.identityCard.fields.push({ key: '决定权', value: '我说了算', custom: true })
  document.mutableLayer.sections.push({ title: '原型', items: ['女仆长·示例'] })
  const { client, controller } = await bootUiPersona(document)
  const draftBefore = JSON.stringify(controller.getSnapshot().draft)

  // ① 同层重名：自定义小节「决定权」改成另一个自定义小节「原型」。
  controller.beginRename('section:决定权')
  controller.setRenameName('原型')
  assert.match(await renderPersona(client, controller), /data-persona-rename-issue="duplicate"/, '同层重名要报出来')
  controller.confirmRename()
  assert.equal(JSON.stringify(controller.getSnapshot().draft), draftBefore, '被拦下时草稿一个字不动')
  assert.equal(controller.getSnapshot().renaming !== undefined, true, '表单不关：用户看得见自己填的名字')
  controller.cancelRename()

  // ② 跨层重名：自定义字段「归属地」改成「咖啡」（已被「用户定义」占用）——
  //    宿主会以 `identity.shadows-mutable` 拒，所以这里必须提前拦住。
  controller.beginRename('identity:4')
  controller.setRenameName('咖啡')
  assert.match(await renderPersona(client, controller), /data-persona-rename-issue="duplicate"/, '跨层重名同样要报')
  controller.confirmRename()
  assert.equal(JSON.stringify(controller.getSnapshot().draft), draftBefore, '同样零改动（绝不静默覆盖别的项）')
  controller.cancelRename()

  // ③ 名字一个都没被顶掉。⚠️ 0.1.14：「咖啡」是「用户定义」的键 —— 它**不再渲染**（区块已下线），
  //    所以这里改判**数据**：它仍在草稿里、一个字节没动（V7：下线 ≠ 毁数据）；
  //    同时钉一句"界面确实不再渲染它"（不是渲染了但没读出来）。
  const markup = await renderPersona(client, controller)
  for (const name of ['原型', '决定权', '归属地']) {
    assert.match(markup, new RegExp(`>${name}<`), `「${name}」必须还在原处`)
  }
  assert.equal(markup.includes('data-persona-list="userDefined"'), false, '「用户定义」区块不再渲染')
  assert.deepEqual(
    controller.getSnapshot().draft.mutableLayer.userDefined,
    [{ key: '咖啡', value: '不加糖' }],
    '「用户定义」的数据仍在草稿里（下线 ≠ 删数据）',
  )
})
