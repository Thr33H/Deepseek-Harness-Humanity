/**
 * 旧设置文件 → 自有文档表的**一次性迁移**。
 *
 * ### 为什么必须做
 *
 * 0.1.7 的官方迁移把 `settings.yaml` 改名为 `settings.yaml.imported`，然后逐段尝试导入；
 * 我们的四个命名空间（`humanity-*` 与 `humanity`）在新版本里**没有同名 Loader 条目**，
 * 于是被判为"无归属段落"，内容**只留在改名后的文件里**。
 * 其中最要紧的是 `humanity-persona`：人格文档本体就在那儿，插件自己的存储域里只有历史表。
 * 不迁移 = 人格卡回落到默认值 = 用户眼里的数据丢失。
 *
 * ### 纪律
 *
 * - **只读**源文件：绝不改写 `settings.yaml.imported`（它是最后一道兜底副本）；
 * - **幂等**：文档表里已经有该命名空间就跳过，绝不覆盖已有内容；
 * - **失败必须响**：读不到 / YAML 坏 / 写不进去，一律 `log.error` 并留下原因，不静默；
 * - 源文件找不到**不是错误**（全新安装就是这样），只记一条 info。
 * @module humanity/migrate
 */
import { load as parseYaml } from 'js-yaml'

import type { DocumentStore } from './documents.js'
import { reportBootFailure } from './log.js'
import type { Log } from './log.js'

/** 我们用到的那两个 `node:fs` 函数。 */
interface FsModule {
  existsSync(path: string): boolean
  readFileSync(path: string, encoding: 'utf8'): string
}

/**
 * 取 `node:fs`。
 *
 * 为什么走动态 import + 结构化类型：本仓库的宿主编译**没有 `@types/node`**
 * （只有 DSH 自己的类型面），静态 `import 'node:fs'` 会让 `tsc` 直接报"找不到模块"。
 * 运行时它在 Node 里必然存在，这里只声明真正调用的两个函数。
 * @returns 最小文件系统面。
 */
async function loadFs(): Promise<FsModule> {
  const specifier: string = 'node:fs'
  return (await import(specifier)) as FsModule
}

/** 需要从旧设置里搬过来的命名空间（顺序即优先级，仅影响日志）。 */
export const MIGRATED_NAMESPACES = ['humanity-persona', 'humanity'] as const

/** 迁移结果（测试与启动日志都用它）。 */
export interface MigrationResult {
  /** 真的搬过来的命名空间。 */
  readonly imported: string[]
  /** 已经有内容、按幂等原则跳过的命名空间。 */
  readonly skipped: string[]
  /** 源文件路径（没找到时为空）。 */
  readonly source: string
  /** 没做迁移时的原因（人类可读）；做了就是空串。 */
  readonly reason: string
}

/** 候选源文件（先看官方改名后的那份，再看原始文件）。 */
function candidateSources(home: string): string[] {
  return [`${home}/settings.yaml.imported`, `${home}/settings.yaml`]
}

/**
 * 把旧设置里的两个命名空间灌进文档表。
 *
 * @param documents - 文档表句柄（存储已就绪）。
 * @param log - 日志门面。
 * @param home - `$DSH_HOME`；未设置时返回 `undefined` 调用的结果（跳过并记日志）。
 * @returns 迁移结果。
 */
export async function migrateLegacyDocuments(
  documents: DocumentStore,
  log: Log,
  home: string | undefined,
): Promise<MigrationResult> {
  if (home === undefined || home === '') {
    log.warn('DSH_HOME 未设置，跳过旧设置迁移（不会读写任何文件）')
    return { imported: [], skipped: [], source: '', reason: 'DSH_HOME 未设置' }
  }

  const fs = await loadFs()
  const source = candidateSources(home).find((candidate) => fs.existsSync(candidate))
  if (source === undefined) {
    log.info('没有旧设置文件可迁移（全新安装的正常情形）')
    return { imported: [], skipped: [], source: '', reason: '没有旧设置文件' }
  }

  let parsed: unknown
  try {
    parsed = parseYaml(fs.readFileSync(source, 'utf8'))
  } catch (error) {
    reportBootFailure(log, `旧设置文件解析失败（人格文档只能靠它恢复，请人工查看）：${source}`, error)
    return { imported: [], skipped: [], source, reason: '旧设置文件解析失败' }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    log.error(`旧设置文件内容不是一个映射，无法迁移：${source}`)
    return { imported: [], skipped: [], source, reason: '旧设置文件内容不是一个映射' }
  }

  const imported: string[] = []
  const skipped: string[] = []
  for (const ns of MIGRATED_NAMESPACES) {
    const value = (parsed as Record<string, unknown>)[ns]
    if (value === undefined) {
      skipped.push(ns)
      continue
    }
    if (documents.read(ns) !== undefined) {
      // 幂等：已经搬过就不再动（也绝不覆盖用户在新版本里改过的内容）。
      skipped.push(ns)
      continue
    }
    try {
      await documents.write(ns, value)
      imported.push(ns)
      log.info(`已从旧设置迁移命名空间 ${ns}（源文件原样保留：${source}）`)
    } catch (error) {
      reportBootFailure(log, `命名空间 ${ns} 迁移写入失败（内容仍在 ${source}，未丢失）`, error)
    }
  }

  if (imported.length === 0) log.info(`旧设置里没有需要迁移的内容（已跳过：${skipped.join(', ') || '无'}）`)
  return { imported, skipped, source, reason: '' }
}
