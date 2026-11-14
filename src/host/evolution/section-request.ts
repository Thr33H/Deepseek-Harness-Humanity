/**
 * 自进化**命令槽**的文档形状（从 `section-doc.ts` 拆出：那份文件已贴着 200 行质量门）。
 *
 * 命令槽是"客户端写、宿主消费"的单格：宿主消费完把 `request` 清回空（见 `shouldClearRequest`）。
 * 命令集本身在 `constants.ts` 的 `EVOLUTION_OPS`（也是校验用的那一份，别在别处另写一张表）。
 * @module humanity/evolution/section-request
 */
import Schema from '@deepseek-ai/schemastery'

/** 命令槽的文档形状。 */
export interface EvolutionRequestView {
  op: string
  id: string
  mode: string
  rescanKind: string
  rescanValue: string
}

/** 命令槽的 schema（默认值即"没有命令"）。 */
export const EvolutionRequestSchema = Schema.object({
  op: Schema.string().default(''),
  id: Schema.string().default(''),
  mode: Schema.string().default(''),
  rescanKind: Schema.string().default(''),
  rescanValue: Schema.string().default(''),
}).default({
  op: '',
  id: '',
  mode: '',
  rescanKind: '',
  rescanValue: '',
})
