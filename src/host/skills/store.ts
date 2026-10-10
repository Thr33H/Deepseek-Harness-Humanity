/**
 * 技能落盘的读写（走**官方文件服务** `ctx.fs`，不直接用 `node:fs`）。
 *
 * 为什么必须是 `ctx.fs`：
 * - `writeText(target, content, { kind: 'createIfAbsent' })` 在官方本地后端里是**硬链接发布**：
 *   目标已存在 ⇒ 报 `FS_NOT_OBSERVED`，**结构上不可能覆盖**用户已有的同名技能（P-041）；
 * - 编辑走 `replaceIfVersion`：先 `stat` 拿版本、写回时带上，**并发改动会被官方挡下**（不静默覆盖）；
 * - 官方后端顺手做了**原子写**与**自动建父目录**（`dsh-fs-local` 的 `writeFileAtomic`）：
 *   技能目录被 watcher 盯着，半截文件会被当成"解析失败"刷警告；
 * - 它同时是沙箱与观察策略的收口点。**删除**能力官方根本没有（`ctx.fs` 无删除方法，
 *   官方给模型的文件工具也只有 read/write/edit）——本模块不提供，工作台用"停用"替代。
 * `ctx.fs` 缺席时如实降级，不抛、不猜路径。
 * @module humanity/skills/store
 */
import type { Log } from '../log.js'
import { isSkillName, joinPath, skillFile, skillsRoot } from './paths.js'
import { isModelDisabled, parseSkillFile, renderSkillFile, type SkillDocument } from './render.js'

/** 解析后的目标（官方 `FsTarget` 的窄面）。 */
interface FsTargetLike {
  displayPath: string
}

/** 目录项（官方 `FsDirEntry` 的窄面）。 */
interface FsDirEntryLike {
  name: string
  type: string
}

/** metadata（官方 `FsInfo` 的窄面；`version` 是编辑用的乐观锁令牌）。 */
interface FsInfoLike {
  type: string
  version?: unknown
}

/** `ctx.fs` 的结构窄面：只用到的五个方法（升级时按 DEV-PLAN-M5 §3 重核）。 */
export interface FileSystemLike {
  /** ⚠️ 官方 `resolve` 是 **async**（返回 Promise）—— 第一版按同步抄过，写入必然失败。 */
  resolve(path: string, opts?: unknown): Promise<FsTargetLike>
  stat(target: FsTargetLike): Promise<FsInfoLike | undefined>
  readText(target: FsTargetLike): Promise<string>
  listDir(target: FsTargetLike): Promise<FsDirEntryLike[]>
  /**
   * 原子写。后两个参数是**官方 0.2.0 的 per-call 沙箱槽**（0.1.12 起本插件会传）：
   * `signal` 取消；`sandboxPolicy` = `{ mode, workspaceRoot, sessionId? }`，
   * **围栏后端用它判这次写入**（`dsh-fs-sandbox` 的 `checkedTarget`：
   * `const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()`），不传则回落部署默认。
   * 见 `docs/plans/humanity-0.1.12-skill-disk-root-fix.md` §3 与施工报告 §2 的源码原文。
   */
  writeText(
    target: FsTargetLike,
    content: string,
    expected?: unknown,
    signal?: AbortSignal,
    sandboxPolicy?: unknown,
  ): Promise<unknown>
}

/**
 * 一次落盘的**调用上下文**（0.1.12）：把调用会话解析出的沙箱策略与取消信号带到官方后端的这次写入上。
 *
 * 为什么需要它（根因）：插件的落盘发生在"批准提案 / 启动恢复"这类**没有 agent 会话**的时刻，
 * 那时没有任何会话身份可解析 ⇒ 后端只能回落部署默认模式（本部署 = `workspace-write`），
 * 而 `$DSH_HOME/skills` 不在 `workspaceRoot` 之下 ⇒ 一律被拒。带上调用会话的策略后，
 * "写不写得进去"就由**那次调用所在会话的权限**决定（`danger-full-access` 的会话可写）。
 */
export interface SkillWriteContext {
  /** 由调用会话解析出的 per-call 策略；缺席 ⇒ 后端用它自己的部署默认（旧行为）。 */
  sandboxPolicy?: unknown
  /** 调用方的取消信号（工具侧由 `exec.signal` 提供）。 */
  signal?: AbortSignal
}

/** 新建结果：**绝不覆盖**（目标已存在时不做任何改动）。 */
export type WriteOutcome = 'written' | 'exists'

/** 写回结果：`missing` = 要改的文件已经不在了（不重建，免得把"编辑"变成"复活"）。 */
export type WriteRawOutcome = 'written' | 'exists' | 'missing'

/** 目录里的一条技能。 */
export interface SkillOnDisk {
  name: string
  description: string
  /** 面向用户的路径（官方 `displayPath`）。 */
  file: string
  disabled: boolean
}

/** 技能落盘入口。 */
export interface SkillStore {
  /** `ctx.fs` 与 `DSH_HOME` 是否都在场。 */
  available(): boolean
  /** 列目录里的技能（目录包 `<name>/SKILL.md` 与官方扁平 `<name>.md` 都认）。 */
  list(): Promise<SkillOnDisk[]>
  /** 读一条技能（不在或格式不合法时 `undefined`，不抛）。 */
  read(name: string): Promise<SkillDocument | undefined>
  /** 读全文（**编辑**要用原文：保住用户手写的官方增强字段，见 `render.ts` 的说明）。 */
  readRaw(name: string): Promise<string | undefined>
  /** 落盘一条技能；目标已存在返回 `exists`（绝不覆盖）。`context` 带上调用会话的沙箱策略（0.1.12）。 */
  write(skill: SkillDocument, context?: SkillWriteContext): Promise<WriteOutcome>
  /**
   * 写回全文：`mustExist` ⇒ 带版本乐观锁（编辑）；否则 createIfAbsent（只新建）。
   * @param name - 技能名；@param text - 完整 SKILL.md 文本。
   * @param options - 见上；服务缺席时抛（由调用方如实回报）。
   */
  writeRaw(name: string, text: string, options: { mustExist: boolean }): Promise<WriteRawOutcome>
}

/**
 * 造技能落盘入口。
 *
 * ⚠️ 两个事实都走**现读函数**（不缓存句柄），这是 2026-09-26 真机验证逼出来的：
 * 第一版在 `apply()` 阶段一次性 `ctx.get('fs')`，那一刻 **fs 服务还没挂载** ⇒ 句柄恒 undefined；
 * 后来改用 `ctx.inject` 的生命周期回调把句柄记在闭包里，这里再每次现读。
 * @param readFs - 现读 `ctx.fs`（缺席即降级）。
 * @param readHome - 现读 `DSH_HOME`（缺席即降级）。
 * @param log - 日志门面。
 * @returns 落盘入口。
 */
export function createSkillStore(
  readFs: () => FileSystemLike | undefined,
  readHome: () => string | undefined,
  log: Log,
): SkillStore {
  const ready = (): { fs: FileSystemLike; home: string } | undefined => {
    const fs = readFs()
    const home = readHome()
    return fs === undefined || home === undefined ? undefined : { fs, home }
  }

  /** 读一个候选路径的全文（不存在/读不到一律 `undefined`）。 */
  const readAt = async (io: FileSystemLike, path: string): Promise<string | undefined> => {
    try {
      const target = await io.resolve(path)
      const info = await io.stat(target)
      if (info === undefined || info.type !== 'file') return undefined
      return await io.readText(target)
    } catch {
      return undefined
    }
  }

  /** 目录包优先，回落官方扁平文件。 */
  const readRaw = async (name: string): Promise<string | undefined> => {
    const env = ready()
    if (env === undefined || !isSkillName(name)) return undefined
    for (const path of [skillFile(env.home, name), joinPath(skillsRoot(env.home), `${name}.md`)]) {
      const text = await readAt(env.fs, path)
      if (text !== undefined) return text
    }
    return undefined
  }

  /** 写回实现：`mustExist` 决定用乐观锁还是排他新建；`context` 把调用会话的沙箱策略带下去。 */
  const writeRawImpl = async (
    name: string,
    text: string,
    mustExist: boolean,
    context: SkillWriteContext = {},
  ): Promise<WriteRawOutcome> => {
    const env = ready()
    if (env === undefined) throw new Error('文件服务（ctx.fs）或 DSH_HOME 不可用，无法写入技能')
    const target = await env.fs.resolve(skillFile(env.home, name))
    if (!mustExist) {
      try {
        await env.fs.writeText(target, text, { kind: 'createIfAbsent' }, context.signal, context.sandboxPolicy)
        return 'written'
      } catch (error) {
        if (hasCode(error, 'FS_NOT_OBSERVED')) return 'exists'
        throw error
      }
    }
    const info = await env.fs.stat(target)
    if (info === undefined || info.version === undefined) return 'missing'
    await env.fs.writeText(
      target,
      text,
      { kind: 'replaceIfVersion', version: info.version },
      context.signal,
      context.sandboxPolicy,
    )
    return 'written'
  }

  return {
    available: () => ready() !== undefined,
    readRaw,

    read: async (name) => {
      const text = await readRaw(name)
      return text === undefined ? undefined : parseSkillFile(text)
    },

    list: async () => {
      const env = ready()
      if (env === undefined) return []
      let entries: FsDirEntryLike[]
      try {
        const root = await env.fs.resolve(skillsRoot(env.home))
        if ((await env.fs.stat(root)) === undefined) return []
        entries = await env.fs.listDir(root)
      } catch (error) {
        log.warn('技能目录读取失败：列表降级为空（技能页会如实显示读不到）', error)
        return []
      }

      const found: SkillOnDisk[] = []
      for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
        if (entry.name.startsWith('.')) continue
        const path =
          entry.type === 'directory'
            ? joinPath(skillsRoot(env.home), entry.name, 'SKILL.md')
            : entry.type === 'file' && entry.name.endsWith('.md')
              ? joinPath(skillsRoot(env.home), entry.name)
              : undefined
        if (path === undefined) continue
        const text = await readAt(env.fs, path)
        const parsed = text === undefined ? undefined : parseSkillFile(text)
        if (text === undefined || parsed === undefined) continue
        found.push({
          name: parsed.name,
          description: parsed.description,
          file: path,
          disabled: isModelDisabled(text),
        })
      }
      return found
    },

    write: async (skill, context) =>
      (await writeRawImpl(skill.name, renderSkillFile(skill), false, context)) === 'written' ? 'written' : 'exists',
    writeRaw: (name, text, options) => writeRawImpl(name, text, options.mustExist),
  }
}

/** 错误码判定（`FsError` 带 `code` 字段）。 */
function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === code
}
