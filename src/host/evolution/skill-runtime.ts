/**
 * 技能子系统的装配（从 `evolution/index.ts` 拆出：那份文件贴着 200 行行数门）。
 *
 * fs 句柄由 `ctx.inject` 的生命周期回调维护、store 每次**现读**它 ——
 * 因为 apply 阶段 fs 服务还没挂载，`ctx.get` 那一次取到的永远是 `undefined`
 * （2026-09-26 真机实证：5 条技能全落在 `runtime-only`、一个文件都没写出来）。
 * @module humanity/evolution/skill-runtime
 */
import type { Context } from '@deepseek-ai/cordis'

import type { Log } from '../log.js'
import { resolveDshHome } from '../skills/paths.js'
import { createSkillStore, type FileSystemLike } from '../skills/store.js'
import { createSkillBridge, type SkillBridge } from './skills.js'
import type { SkillStore } from '../skills/store.js'

/** 技能子系统：落盘入口 + 注册桥。 */
export interface SkillRuntime {
  store: SkillStore
  bridge: SkillBridge
}

/**
 * 装配技能子系统。
 * @param ctx - 宿主上下文。
 * @param log - 日志门面。
 * @returns 落盘入口与注册桥（两者共用同一个 store）。
 */
export function installSkillRuntime(ctx: Context, log: Log): SkillRuntime {
  let fsHandle: FileSystemLike | undefined
  ctx.inject(['fs'], (sctx) => {
    fsHandle = (sctx as unknown as { fs?: FileSystemLike }).fs
    return () => {
      fsHandle = undefined
    }
  })
  const store = createSkillStore(() => fsHandle, () => resolveDshHome(), log)
  return { store, bridge: createSkillBridge(ctx, log, store) }
}
