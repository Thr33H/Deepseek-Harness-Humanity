/**
 * 记忆页面**容器**：订阅控制器状态，把点击翻译成控制器调用。
 *
 * 数据只有一个来源：控制器快照（它背后是 `humanity-memory` 命名空间的投影）。页面自己**不缓存**
 * 任何记忆 —— 操作发出后由宿主重新投影回来，界面不做乐观更新（避免"界面显示已归档、宿主其实没动"）。
 * 布局在 `MemoryBody.tsx`。
 * @module deepseek-harness-humanity/client/memory-page
 */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { useCallback, useSyncExternalStore } from 'react'

import { NS } from './locales.js'
import type { MemoryItemOp } from './MemoryItem.js'
import { MemoryBody } from './MemoryBody.js'
import type { MemoryWorkbenchController } from './memory-controller.js'
import type { MemoryEntryView } from './memory-document.js'

export interface MemoryPageProps extends PropsLocale<typeof NS> {
  controller: MemoryWorkbenchController
}

/**
 * 记忆页面。
 * @param props - 字典座位与记忆控制器。
 * @returns 记忆页；状态由宿主投影驱动。
 */
export function MemoryPage(props: MemoryPageProps) {
  const { t } = props
  const controller = props.controller
  // 第三个参数是服务端渲染用的快照：缺了它 SSR 会直接报错（测试与服务端预渲染都走同一条路径）。
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)

  const onOp = useCallback(
    (op: MemoryItemOp, entry: MemoryEntryView) => {
      if (op === 'pin' || op === 'unpin') {
        // 固定/取消固定共用一条命令：按钮显示的是"点下去会变成什么"，状态取当前条目。
        void controller.setPinned(entry.fingerprint, op === 'pin' ? !entry.pinned : false)
        return
      }
      void dispatch(controller, op, entry)
    },
    [controller],
  )

  return <MemoryBody t={t} controller={controller} state={state} onOp={onOp} />
}

/** 把点击翻译成控制器上对应的方法（固定/取消固定单独处理，它需要当前状态）。 */
function dispatch(
  controller: MemoryWorkbenchController,
  op: Exclude<MemoryItemOp, 'pin' | 'unpin'>,
  entry: MemoryEntryView,
): Promise<void> {
  switch (op) {
    case 'confirm':
      return controller.confirm(entry.fingerprint)
    case 'reject':
      return controller.reject(entry.fingerprint)
    case 'archive':
      return controller.archive(entry.fingerprint)
    case 'restore':
      return controller.restore(entry.fingerprint)
    case 'remove':
      return controller.remove(entry.fingerprint)
  }
}
