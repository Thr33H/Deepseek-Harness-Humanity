/**
 * 记忆策略的解析：**预设模式 × 高级开关 → 生效策略**（P-030）。
 *
 * 为什么单独一个文件：这里回答的是"开关怎么算出生效行为"，与"数据长什么样"（`model.ts`）
 * 是两件事。全部消费方（写入管线、检索、注入、工作台）都只读 `resolveMemoryPolicy` 的结果，
 * 不各自去算 —— 否则"模式说关、某个实现说开"这类不一致只会以行为诡异的形式出现。
 * @module humanity/memory/policy
 */
import type { MemoryAdvancedConfig, MemoryMode } from '../config.js'
import {
  DEFAULT_INJECT_LIMIT,
  DEFAULT_INJECT_TOKEN_BUDGET,
  DECAY_HALF_LIFE_DAYS,
  DECAY_UNUSED_DAYS,
  MAX_INJECT_LIMIT,
  RELEVANCE_THRESHOLD,
} from './constants.js'
import type { MemoryPolicy, MemoryPolicyOverrides } from './types.js'

/**
 * 四个预设模式解析出的基础策略（P-030 / §4.2.2）。
 *
 * - `off`：什么都不做（不写、不检索、不注入、也不跑衰减归档），已有数据原样保留；
 * - `session`：只留会话层 —— 想要"记得住当前对话"但不要跨会话记忆的用户；
 * - `balanced`（默认）：三层开启、注入 0–3 条、衰减归档开启、向量关闭；
 * - `manual`：写入与衰减照常，但**不自动注入**，全部记忆只能由 `humanity_recall` 取用。
 */
const PRESET_POLICIES: Readonly<Record<MemoryMode, Omit<MemoryPolicy, 'mode'>>> = {
  off: {
    scopes: { 'long-term': false, workspace: false, session: false },
    autoWrite: false,
    autoInject: false,
    injectLimit: 0,
    injectTokenBudget: 0,
    relevanceThreshold: RELEVANCE_THRESHOLD,
    decayUnusedDays: DECAY_UNUSED_DAYS,
    decayHalfLifeDays: DECAY_HALF_LIFE_DAYS,
    // 模式 off 是"记忆功能关闭"：既不写也不注入，维护动作（衰减归档）同样不跑。
    decay: false,
    vector: false,
    pinFrequent: false,
    autoWriteSensitive: false,
  },
  session: {
    scopes: { 'long-term': false, workspace: false, session: true },
    autoWrite: true,
    autoInject: true,
    injectLimit: DEFAULT_INJECT_LIMIT,
    injectTokenBudget: DEFAULT_INJECT_TOKEN_BUDGET,
    relevanceThreshold: RELEVANCE_THRESHOLD,
    decayUnusedDays: DECAY_UNUSED_DAYS,
    decayHalfLifeDays: DECAY_HALF_LIFE_DAYS,
    decay: true,
    vector: false,
    pinFrequent: false,
    autoWriteSensitive: false,
  },
  balanced: {
    scopes: { 'long-term': true, workspace: true, session: true },
    autoWrite: true,
    autoInject: true,
    injectLimit: DEFAULT_INJECT_LIMIT,
    injectTokenBudget: DEFAULT_INJECT_TOKEN_BUDGET,
    relevanceThreshold: RELEVANCE_THRESHOLD,
    decayUnusedDays: DECAY_UNUSED_DAYS,
    decayHalfLifeDays: DECAY_HALF_LIFE_DAYS,
    decay: true,
    vector: false,
    pinFrequent: false,
    autoWriteSensitive: false,
  },
  manual: {
    scopes: { 'long-term': true, workspace: true, session: true },
    autoWrite: true,
    autoInject: false,
    injectLimit: 0,
    injectTokenBudget: 0,
    relevanceThreshold: RELEVANCE_THRESHOLD,
    decayUnusedDays: DECAY_UNUSED_DAYS,
    decayHalfLifeDays: DECAY_HALF_LIFE_DAYS,
    decay: true,
    vector: false,
    pinFrequent: false,
    autoWriteSensitive: false,
  },
}

/** 把注入条数夹到硬上限内。开关只能调小，不能调大（P-028）。 */
function clampInjectLimit(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_INJECT_LIMIT
  const rounded = Math.trunc(value)
  if (rounded < 0) return 0
  return rounded > MAX_INJECT_LIMIT ? MAX_INJECT_LIMIT : rounded
}

/** 把阈值夹到 0–1：超出这个范围的分要么全过、要么全不过，那不是"更严"，是没有意义。 */
function clampThreshold(value: number): number {
  if (!Number.isFinite(value)) return RELEVANCE_THRESHOLD
  return Math.min(1, Math.max(0, value))
}

/**
 * 这份高级开关是不是**自相矛盾**：模式不是 off，却把三层全关掉。
 *
 * 用户不会"故意关掉所有层还选平衡模式"：那种状态只会让记忆功能静默失效
 * （工具不注册、检索恒空、写入一律被拒），而界面看起来一切正常 —— 这类"配置上合法、
 * 语义上不可能"的组合必须有人拦。拦在**配置翻译处**而不是 `resolveMemoryPolicy`：
 * 后者是纯计算器，显式传 `{ scopes: 全 false }` 的调用方（测试、高级用法）有权这么做，
 * 不该被悄悄改掉；只有**配置**里长出来的矛盾才需要回退。
 * @param advanced - 配置里的高级开关。
 * @param mode - 当前预设模式。
 * @returns 矛盾时为 true。
 */
export function isDegenerateAdvanced(advanced: MemoryAdvancedConfig | undefined, mode: MemoryMode): boolean {
  if (advanced === undefined || advanced === null) return false
  if (!advanced.customized || mode === 'off') return false
  return !advanced.longTerm && !advanced.work && !advanced.session
}

/**
 * 把配置里的高级开关翻成策略覆盖。
 *
 * `customized` 为假时返回 `undefined` —— **完全跟随预设模式**（P-030：预设切换即给出一套默认值，
 * 不会被上一轮残留的值拖住）。三层全关但模式不是 off（见 {@link isDegenerateAdvanced}）时同样
 * 回退到预设，避免记忆功能静默失效；调用方会用日志把这件事说清楚。
 * @param advanced - 配置里的高级开关。
 * @param mode - 当前预设模式。
 * @returns 策略覆盖；跟随预设时为 undefined。
 */
export function overridesOf(advanced: MemoryAdvancedConfig | undefined, mode: MemoryMode): MemoryPolicyOverrides | undefined {
  // 防御：settings 未 attach 时 advanced 可能是 undefined → 跟随预设。
  if (advanced === undefined || advanced === null) return undefined
  if (!advanced.customized) return undefined
  if (isDegenerateAdvanced(advanced, mode)) return undefined
  return {
    scopes: { 'long-term': advanced.longTerm, workspace: advanced.work, session: advanced.session },
    injectLimit: advanced.maxInject,
    decay: advanced.decay,
    // 0.1.10（B2）：衰减窗口可配；缺字段（老配置/测试的部分对象）时留给 `resolveMemoryPolicy`
    // 用预设值兜底（undefined ⇒ 取预设的 90），因此这里不做 `?? 90` —— 那会造出第二份默认值。
    ...(advanced.decayUnusedDays === undefined ? {} : { decayUnusedDays: advanced.decayUnusedDays }),
    // 向量检索在 MVP 恒关闭（P-027）：即便用户把开关打开也不生效，但**不报错**。
    vector: false,
  }
}

/**
 * 当前策略下记忆是否**可写**：模式 off（autoWrite 关）或三层全关时，
 * 注册写入工具与注入引导语都只会让模型白跑一趟。
 * @param policy - 当前生效策略。
 */
export function canRemember(policy: MemoryPolicy): boolean {
  if (!policy.autoWrite) return false
  return policy.scopes['long-term'] || policy.scopes.workspace || policy.scopes.session
}

/** 天数类参数的夹取：小于 1 天没有意义（会让"长期未用"退化成"立刻衰减"）。 */
function clampDays(value: number): number {
  if (!Number.isFinite(value)) return DECAY_UNUSED_DAYS
  return Math.max(1, Math.trunc(value))
}

/**
 * 解析生效策略：预设模式 + 高级开关。
 *
 * 全部消费方（写入管线、检索、注入、工作台）都读这个结果，不各自去算 ——
 * 否则"模式说关、某个实现说开"这类不一致只会以行为诡异的形式出现。
 * @param mode - 预设模式。
 * @param overrides - 用户动过的高级开关。
 */
export function resolveMemoryPolicy(
  mode: MemoryMode,
  overrides: MemoryPolicyOverrides = {},
): MemoryPolicy {
  // 防御：settings 服务未 attach 时 source() 返回的 entry 可能缺 schema 默认值 → mode 为 undefined。
  // 回退到 'balanced'（P-032 默认模式），而不是让 PRESET_POLICIES[undefined] 崩溃。
  const safeMode: MemoryMode = mode != null && mode in PRESET_POLICIES ? mode : 'balanced'
  const preset = PRESET_POLICIES[safeMode]
  return {
    mode: safeMode,
    scopes: { ...preset.scopes, ...overrides.scopes },
    autoWrite: overrides.autoWrite ?? preset.autoWrite,
    autoInject: overrides.autoInject ?? preset.autoInject,
    injectLimit: clampInjectLimit(overrides.injectLimit ?? preset.injectLimit),
    injectTokenBudget: Math.max(0, overrides.injectTokenBudget ?? preset.injectTokenBudget),
    decay: overrides.decay ?? preset.decay,
    vector: overrides.vector ?? preset.vector,
    relevanceThreshold: clampThreshold(overrides.relevanceThreshold ?? preset.relevanceThreshold),
    decayUnusedDays: clampDays(overrides.decayUnusedDays ?? preset.decayUnusedDays),
    decayHalfLifeDays: clampDays(overrides.decayHalfLifeDays ?? preset.decayHalfLifeDays),
    pinFrequent: preset.pinFrequent,
    autoWriteSensitive: preset.autoWriteSensitive,
  }
}
