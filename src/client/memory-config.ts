/**
 * 记忆工作台的**配置写入**（模式 / 高级开关）：乐观翻转 + 串行排队 + 失败回退。
 *
 * 为什么单独一个文件：这一段有自己的一整套纪律 ——
 * 1. **先本地翻**：开关当拍就动（官方 Switch 的滑块动画靠这一拍），写失败再撤回；
 * 2. **改动记进 pending**：宿主重投影是异步的，写完立刻回读会读到旧值（见 `memory-sync.ts` 文件头）；
 * 3. **写入排队**：两个开关几乎同时拨时，第二次会带着过期修订号被宿主的乐观并发控制拒绝
 *    （官方 `ConfigForm.enqueue` 是同一条做法）；
 * 4. **失败必须说清楚**：撤回之后要把宿主给的原因留住（回读会清掉 error，所以要接住再放回去）。
 * @module deepseek-harness-humanity/client/memory-config
 */
import type { MemoryAdvancedView, MemoryWorkbenchState } from './memory-document.js'
import type { PendingChanges } from './memory-sync.js'

/**
 * 一次配置写入要用的宿主面（控制器提供；写手自己不碰状态机内部）。
 */
export interface ConfigWriteHost {
  /** 当前快照（读 advanced / policy 的现值）。 */
  snapshot(): MemoryWorkbenchState
  /** 换一个状态快照。 */
  update(patch: Partial<MemoryWorkbenchState>): void
  /** 未确认改动的**同一份**对象（与投影采纳共用的那份；写手就地改它）。 */
  pending(): PendingChanges
  /** 串行写一次配置；返回宿主是否收下。 */
  write(busy: string, patch: Record<string, unknown>): Promise<boolean>
  /** 静默回读一次（刷新修订号与真值）。 */
  reload(): Promise<void>
}

/**
 * **配置写入**（记忆模式 / 高级开关）的本地流程：乐观翻转 + 串行排队 + 失败回退。
 *
 * 为什么单独一个类：这一段有自己的一整套纪律 —— 先本地翻（开关当拍就动，官方 Switch 的滑块
 * 动画靠这一拍）、改动记进 pending（宿主重投影是异步的，立刻回读会读到旧值）、写入排队
 * （两个开关几乎同时拨时，第二次会带着过期修订号被拒）、失败就撤掉这一条并回读。
 * 混在命令派发里读不出这条边界。
 */
export class ConfigWrites {
  private tail: Promise<unknown> = Promise.resolve()

  constructor(private readonly host: ConfigWriteHost) {}

  /** 串行执行（官方 `ConfigForm.enqueue` 的同款做法）。 */
  private queue(run: () => Promise<boolean>): Promise<boolean> {
    const next = this.tail.then(run, run)
    this.tail = next.catch(() => undefined)
    return next
  }

  /**
   * 切模式（写顶层 `humanity` 配置，开关即时生效，P-030）。
   *
   * 切模式同时**关掉高级覆盖**：否则上一轮残留的高级值会把新模式拖回原样（P-030 的"预设即默认"）。
   * @param mode - 目标模式。
   */
  async setMode(mode: string): Promise<void> {
    const before = this.host.snapshot().policy
    const pending = this.host.pending()
    pending.mode = mode
    pending.customized = false
    this.host.update({ policy: { ...before, mode, customized: false }, error: undefined })
    const ok = await this.queue(() => this.host.write('mode', { modules: { memory: { mode, advanced: { customized: false } } } }))
    if (ok) return
    delete this.host.pending().mode
    delete this.host.pending().customized
    this.host.update({ policy: before })
  }

  /**
   * 改高级开关（任何一项都意味着用户要自己说了算 ⇒ 一并打开 `customized`）。
   *
   * 写回的是**整份生效值**（`state.advanced` 就是宿主投影来的生效开关）+ 这一处改动，
   * 而不是只写被改的那一项（2026-09-26 审计 C6）：配置里若存着"三层全关但模式不是 off"
   * 这种宿主会按模式回退的组合，只写单项会让那份矛盾永远留在配置里 ——
   * 界面显示"三层都在生效"（回退后的真值），配置却写着全关，下一次投影又是一轮打脸。
   * 以所见为底写回，用户拨第一次开关时配置就被修成与界面一致。
   * @param patch - 改动的高级开关。
   */
  async setAdvanced(patch: Partial<MemoryAdvancedView>): Promise<void> {
    const state = this.host.snapshot()
    const pending = this.host.pending()
    pending.advanced = { ...pending.advanced, ...patch }
    pending.customized = true
    this.host.update({
      advanced: { ...state.advanced, ...patch },
      // 调过高级开关 ⇒ 模式显示成「自定义」（宿主投影会给出同一个结论，这里只是别让标签迟一拍）。
      policy: { ...state.policy, customized: true },
      error: undefined,
    })
    const next = { ...state.advanced, ...patch, customized: true }
    const ok = await this.queue(() => this.host.write('advanced', { modules: { memory: { advanced: next } } }))
    if (!ok) await this.rollback(patch, state.advanced, state.policy)
  }

  /**
   * 写失败：只撤掉**这一条**改动，然后回读 —— 界面回到宿主真实的那个值，不靠猜。
   *
   * ⚠️ 回读会把 `error` 清掉（那是一次成功的读取），所以先把失败原因**接住再放回去** ——
   * 否则用户看到的是"开关自己弹回去了"，一个字都没有（G-002：失败必须说清楚）。
   */
  private async rollback(patch: Partial<MemoryAdvancedView>, advanced: MemoryAdvancedView, policy: MemoryWorkbenchState['policy']): Promise<void> {
    const reason = this.host.snapshot().error
    const pending = this.host.pending()
    const rest = { ...(pending.advanced ?? {}) }
    for (const key of Object.keys(patch)) delete rest[key as keyof MemoryAdvancedView]
    pending.advanced = Object.keys(rest).length === 0 ? undefined : rest
    delete pending.customized
    this.host.update({ advanced, policy })
    await this.host.reload()
    if (reason !== undefined && reason !== '') this.host.update({ error: reason })
  }
}
