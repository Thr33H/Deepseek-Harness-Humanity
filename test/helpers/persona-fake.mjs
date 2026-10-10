/**
 * 测试用的假设置通道（人格工作台的 Host 侧替身）。
 *
 * 为什么这里可以用假货、而 `persona-tools.test.mjs` 坚持用真货：两边要证的命题不同。
 * 工具那一侧要证"DSH 的管线真的执行了我们的判定"（guard 先于函数体、参数契约真的编译），
 * 所以必须真；工作台这一侧要证的是**状态机与本地校验**（保存前拦截、修订号回传、
 * 宿主拒绝的呈现），这些逻辑全在我们自己的代码里，一个按契约实现的通道替身就能测到，
 * 而且能构造真服务很难造的场景（修订号冲突、命名空间缺失、只读 provider）。
 *
 * 通道的**契约**取自 DSH 0.1.5-rc.2 的
 * `dsh-api-settings-controller/lib/typert.remote-client.d.ts`：
 * `describe(): RemoteResult<SettingsDescribeValue>`、`replace(ns, section, expectedRevision)`。
 */
import { CORE_IDENTITY_KEYS, STANDARD_SECTION_TITLES } from '../../lib/persona/constants.js'
import { PERSONA_NAMESPACE } from '../../lib/persona/section.js'

/** 造一份"什么都没写"的人格文档（与宿主 schema 默认值同形）。 */
export function emptyPersona() {
  return {
    schemaVersion: 1,
    identityCard: {
      fields: CORE_IDENTITY_KEYS.map((key) => ({ key, value: '', custom: false })),
      initializedAt: '',
      sealedAt: '',
    },
    mutableLayer: {
      sections: STANDARD_SECTION_TITLES.map((title) => ({ title, items: [] })),
      userDefined: [],
    },
  }
}

/** 深拷贝，避免测试与控制器共享同一份对象。 */
const clone = (value) => JSON.parse(JSON.stringify(value))

/**
 * 让文档里**存在**一个小节并给它这些条目（不存在就建一节）—— 与工作台"添加小节"同语义。
 *
 * 为什么测试需要它（0.1.14）：原生项只剩 4 个，`emptyPersona()` 里**没有**「习惯与偏好 /
 * 经验教训 / 情绪 / 未结修正」了 —— 它们和用户自己加的小节一样是**自定义项**。
 * 旧夹具直接写 `sections.find((s) => s.title === '经验教训').items = [...]`：那一刻
 * `find` 返回 `undefined`，夹具自己就炸了（`Cannot set properties of undefined`），
 * 而那条用例真正想断言的东西（删除 / 改名 / 注入…）跟"它是不是原生项"无关。
 * 用这个 helper 显式把它当**自定义项**加进去，夹具的意图反而更清楚了。
 * @param persona - 待修改的文档（原地改）。
 * @param title - 小节标题。
 * @param items - 条目；省略则只保证小节存在（保持原有条目）。
 * @returns 同一个文档（便于串起来写）。
 */
export function withSection(persona, title, items) {
  const existing = persona.mutableLayer.sections.find((section) => section.title === title)
  if (existing === undefined) {
    persona.mutableLayer.sections.push({ title, items: items === undefined ? [] : [...items] })
    return persona
  }
  if (items !== undefined) existing.items = [...items]
  return persona
}

/**
 * 造一个假通道。
 * @param document - 宿主里"当前生效"的文档。
 * @param options - 可覆盖的行为：`writable`（只读 provider）、`present`（命名空间缺失）、
 *   `failDescribe` / `failReplace`（远端拒绝的原因）、`revision`（初始修订号）。
 * @returns 通道本体、调用记录与可变状态。
 */
export function createFakeChannel(document = emptyPersona(), options = {}) {
  const state = {
    document: clone(document),
    revision: options.revision ?? 1,
    writable: options.writable ?? true,
    present: options.present ?? true,
  }
  const calls = { describe: 0, replace: [], update: [] }
  /** 顶层配置命名空间（独立判断开关）的替身：默认没有用户覆盖 ⇒ schema 默认值（开）。 */
  const config = {
    value: { independentJudgment: options.independentJudgment ?? true },
    revision: options.configRevision ?? 7,
  }

  const channel = {
    async describe() {
      calls.describe += 1
      if (options.failDescribe !== undefined) return { ok: false, error: { message: options.failDescribe } }
      return {
        ok: true,
        value: {
          writable: state.writable,
          namespaces: state.present
            ? [
                { ns: PERSONA_NAMESPACE, value: clone(state.document), revision: state.revision },
                { ns: 'humanity', value: clone(config.value), revision: config.revision },
              ]
            : [],
        },
      }
    },
    async replace(ns, section, expectedRevision) {
      calls.replace.push({ ns, section: clone(section), expectedRevision })
      if (options.failReplace !== undefined) return { ok: false, error: { message: options.failReplace } }
      // 真实 provider 会带上乐观并发控制；替身至少要把"过期修订号"这件事表现出来。
      if (expectedRevision !== undefined && expectedRevision !== state.revision) {
        return { ok: false, error: { message: `settings/conflict: revision ${state.revision} != ${expectedRevision}` } }
      }
      state.document = clone(section)
      state.revision += 1
      return { ok: true, value: { ns, value: clone(state.document), revision: state.revision } }
    },
    async update(ns, patch, expectedRevision) {
      calls.update.push({ ns, patch: clone(patch), expectedRevision })
      if (options.failUpdate !== undefined) return { ok: false, error: { message: options.failUpdate } }
      if (expectedRevision !== undefined && expectedRevision !== config.revision) {
        return { ok: false, error: { message: `settings/conflict: revision  != ` } }
      }
      config.value = { ...config.value, ...clone(patch) }
      config.revision += 1
      // 与真宿主契约一致：`settings.update` 返回 **void**（无 value）；新值只能写后回读 describe。
      // 旧假实现返回 view，把调用方的解析错误养成了「测试绿、真机坏」（2026-09-25 真机反馈）。
      return { ok: true, value: undefined }
    },
  }

  return { channel, calls, state, config }
}

