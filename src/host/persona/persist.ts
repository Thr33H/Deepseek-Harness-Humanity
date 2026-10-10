/**
 * 人格文档的**落盘**与**历史移交**。
 *
 * 两件事在一起，是因为它们必须成对且有序：先把被取代的旧内容交给历史（P-009：历史不参与注入、
 * 不删除），再改生效快照。顺序反了就会出现"新值生效但旧的丢了"。
 * 单独一个文件的原因：这是与"当前生效文档"不同的第二条数据流（append-only 的审计），
 * 混在 `section.ts` 里会让人以为它也是人格真源的一部分。
 * @module humanity/persona/persist
 */
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'

import type { Log } from '../log.js'
import { PERSONA_NAMESPACE } from './section.js'
import type { PersonaDocument, WriteSource } from './types.js'

/** 历史接收方：把被取代的旧内容交出去。存储未就绪时为空，此时静默跳过（历史是审计，不是功能前提）。 */
export type HistorySink = (entry: {
  at: string
  source: WriteSource
  path: string
  previous: string
  reason: string
}) => void

/**
 * 校验通过之后的落盘：先记历史，再改生效快照。
 *
 * 顺序有意如此（P-009）：万一写入失败，历史里最多多一条"旧值"记录，而不会出现
 * "新值生效但旧的丢了"。历史按 `stored` 比对 —— 已经要删掉的自定义节，它的条目该作为
 * "被取代"留档，不能因为节没了就连历史也不记。
 *
 * ⚠️ `settings` 与读取路径**必须是同一个句柄**（由 `installPersonaSection` 的注入回调捕获）。
 * 早先这里用 `ctx.get('settings')` 现取：那依赖调用时的上下文能解析出该服务，而写入实际落在
 * 设置注册表里**当前**那一条 registration 上 —— 两者一旦分叉（重新注册 / detach 后重挂），
 * 就会"写进新的、读出旧的"（前任在人格热更新上踩过同类坑）。
 * @param settings - 读取路径用的同一个设置服务句柄；未接上时返回 undefined。
 * @param history - 历史接收方（存储未就绪时返回 undefined）。
 * @param before - 生效中的旧快照。
 * @param stored - 要落盘的新快照（已过生效口径）。
 * @param writeSource - 写入来源，进历史记录。
 */
export async function persistPersona(
  settings: () => SettingsProvider | undefined,
  history: () => HistorySink | undefined,
  before: PersonaDocument,
  stored: PersonaDocument,
  writeSource: WriteSource,
): Promise<void> {
  const live = settings()
  if (live === undefined) throw new Error('设置服务未挂载，无法写入人格文档')

  const sink = history()
  if (sink !== undefined) {
    for (const entry of supersededBy(before, stored)) {
      sink({ at: new Date().toISOString(), source: writeSource, ...entry })
    }
  }

  await live.replace(PERSONA_NAMESPACE, stored as unknown as Record<string, never>)
}

/**
 * 列出"被新快照取代或删除的旧内容"。
 *
 * 只比对**有内容**的旧项：空值被删掉不算历史（那只是用户清空了自己没写过的东西）。
 * 返回顺序稳定（先固定层、再小标题、最后兜底层），方便测试与人工核对。
 * @param before - 生效中的旧快照。
 * @param after - 候选新快照。
 * @returns 被取代的条目。
 */
export function supersededBy(
  before: PersonaDocument,
  after: PersonaDocument,
): Array<{ path: string; previous: string; reason: string }> {
  const superseded: Array<{ path: string; previous: string; reason: string }> = []

  for (const field of before.identityCard.fields) {
    if (field.value === '') continue
    const next = after.identityCard.fields.find((candidate) => candidate.key === field.key)
    if (next?.value === field.value) continue
    superseded.push({
      path: `identityCard.fields.${field.key}`,
      previous: field.value,
      reason: next === undefined ? 'removed' : 'superseded',
    })
  }

  for (const section of before.mutableLayer.sections) {
    const nextItems = after.mutableLayer.sections.find((candidate) => candidate.title === section.title)?.items ?? []
    for (const item of section.items) {
      if (nextItems.includes(item)) continue
      superseded.push({
        path: `mutableLayer.sections.${section.title}`,
        previous: item,
        reason: 'superseded',
      })
    }
  }

  for (const entry of before.mutableLayer.userDefined) {
    const next = after.mutableLayer.userDefined.find((candidate) => candidate.key === entry.key)
    if (next?.value === entry.value) continue
    superseded.push({
      path: `mutableLayer.userDefined.${entry.key}`,
      previous: entry.value,
      reason: next === undefined ? 'removed' : 'superseded',
    })
  }

  return superseded
}
