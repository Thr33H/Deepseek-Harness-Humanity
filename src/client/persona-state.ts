/**
 * 工作台的**状态容器**：持有当前快照与订阅者，负责"换快照并通知"与"改草稿"。
 *
 * 为什么单独一层：状态容器与远程同步是两件独立的事 —— 前者决定"界面看到什么、什么时候重渲染"，
 * 后者决定"怎么和宿主说话"。分成基类之后，控制器（`persona-controller.ts`）里只剩远程调用与
 * 用户操作，读代码时不必在订阅机制里穿行。
 * @module deepseek-harness-humanity/client/persona-state
 */
import { asDocument, clone, emptyDocument, type PersonaIssueView, type PersonaWorkbenchState } from './persona-document.js'
import type { PersonaNamespaceView } from './persona-channel.js'
import type { PersonaDocument } from '../host/persona/types.js'

/** 供桌面与面板共用的状态容器基类。 */
export abstract class PersonaStateBase {
  protected state: PersonaWorkbenchState = {
    status: 'idle',
    writable: false,
    stored: emptyDocument(),
    draft: emptyDocument(),
    saving: false,
    savedAt: '',
    issues: [],
    // 与宿主 schema 的默认值一致（缺省即开），读不到时界面也显示开。
    independentJudgment: true,
    independentJudgmentSaving: false,
  }

  private readonly listeners = new Set<() => void>()

  /** 订阅状态变化；返回退订函数（直接交给 `useSyncExternalStore`）。 */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 当前快照。引用稳定：只有 `update()` 会换对象。 */
  readonly getSnapshot = (): PersonaWorkbenchState => this.state

  /** 改草稿：先深拷贝再改，保证旧快照对新快照是只读历史。 */
  protected edit(mutate: (draft: PersonaDocument) => void): void {
    const draft = clone(this.state.draft)
    mutate(draft)
    this.update({ draft })
  }

  /** 换一个新状态对象并通知订阅者。 */
  protected update(patch: Partial<PersonaWorkbenchState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }

  /**
   * 用宿主返回的一段值重建基线（stored = draft = 生效文档），并记录修订号。
   *
   * 抓异常是有意的：`adopt` 在 `load()` / `save()` 的异步链上被调用，抛出去就是未处理的 rejection；
   * 形状不对只该降级成"读不到"，不该把界面的其余部分带走。
   * @param view - 宿主返回的命名空间视图。
   * @param writable - 宿主是否接受写入。
   * @param options - 本次读取/保存附带的警告、保存时间，以及顶层配置里的独立判断开关。
   */
  protected adopt(
    view: PersonaNamespaceView,
    writable: boolean,
    options: {
      warnings?: readonly PersonaIssueView[]
      savedAt?: string
      independentJudgment?: { value: boolean; revision: number }
    } = {},
  ): void {
    let document: PersonaDocument
    try {
      document = asDocument(view.value)
    } catch (error) {
      this.update({
        status: 'failed',
        writable: false,
        error: error instanceof Error ? error.message : String(error),
      })
      return
    }

    this.update({
      status: 'ready',
      writable,
      error: undefined,
      revision: view.revision,
      stored: document,
      draft: clone(document),
      saving: false,
      savedAt: options.savedAt ?? '',
      issues: options.warnings ?? [],
      // 项级交互状态（待确认删除 / 添加表单 / 改名表单）跟着这一次重建一起清掉：新草稿里那些项
      // 可能已经不存在（删除后保存、重新加载），留着就是指向已消失项的幽灵态。
      pendingDelete: undefined,
      addForm: undefined,
      renaming: undefined,
      // 顶层开关与人格文档是两份数据：这一次读取没带上它时**保持原值**（别把它重置成默认）。
      ...(options.independentJudgment === undefined
        ? { independentJudgmentSaving: false }
        : {
            independentJudgment: options.independentJudgment.value,
            independentJudgmentRevision: options.independentJudgment.revision,
            independentJudgmentSaving: false,
          }),
    })
  }
}
