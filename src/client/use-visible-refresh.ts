/**
 * 「切回来就刷新一次」的工作台小钩子。
 *
 * ### 为什么需要它（2026-11-22 用户真机撞到）
 *
 * 工作台的数据是宿主投影过来的，而**对话会改变它**：时间基准学到你的时区、记忆多了一条、
 * 调度重排了……但页面只在挂载时取一次。于是常见情形是：左边标签页在聊天，右边标签页开着
 * 工作台 —— 聊完了切回来，页面上还是那会儿的旧值（用户看到的"对话后时间没变"就是它）。
 *
 * ### 为什么只在"重新可见"时刷，不定时轮询
 *
 * 自进化页的设置项是**受控草稿**（正在输入的值在本地）。定时轮询会把新快照推进去，
 * 把用户正在输入的东西冲掉。切回标签页是用户主动离开又回来的时刻，那时刷新不会打断输入。
 * @module deepseek-harness-humanity/client/use-visible-refresh
 */
import { useEffect } from 'react'

/**
 * 页面重新可见（或窗口重新获得焦点）时调用一次 `reload`。
 * @param reload - 重新取一次数据的回调；调用方应保证它在依赖不变时是稳定的（`useCallback`）。
 */
export function useVisibleRefresh(reload: () => void): void {
  useEffect(() => {
    if (typeof document === 'undefined') return
    const tick = (): void => {
      if (document.visibilityState !== 'visible') return
      reload()
    }
    const onFocus = (): void => tick()
    document.addEventListener('visibilitychange', tick)
    window.addEventListener('focus', onFocus)
    return () => {
      document.removeEventListener('visibilitychange', tick)
      window.removeEventListener('focus', onFocus)
    }
  }, [reload])
}
