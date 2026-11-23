/**
 * 情绪工作台的**通道形状**：命名空间名 + 文档解析。
 *
 * 与人格/记忆同一套接法：客户端只认 `describe()` 里的一个命名空间，
 * 宿主把当前状态投影在里面，这边只读。
 *
 * 解析必须**容错**：`describe` 的 `value` 是 `unknown`，而工作台是"看得见就行"的东西——
 * 一份形状不对的文档应当显示成"没有数据"，不该让整页白屏（与 `memory-document.ts` 同一纪律）。
 * @module deepseek-harness-humanity/client/emotion-channel
 */
import type { EmotionView } from '../host/emotion/view.js'

/** 命名空间名（写在宿主 `section.ts`，两边必须逐字一致）。 */
export const EMOTION_NAMESPACE = 'humanity-emotion'

/** 命名空间里的文档（= 宿主投影的视图 + 一条状态提示）。 */
export interface EmotionDocument extends EmotionView {
  notice: string
}

/** 安全取字符串。 */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 安全取数字（非有限值按 0）。 */
function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * 把 `value` 解析成情绪文档（缺字段一律补空，绝不抛）。
 * @param value - 命名空间里的原始值。
 * @returns 一定可用的文档。
 */
export function asEmotionDocument(value: unknown): EmotionDocument {
  const raw = (value ?? {}) as Record<string, unknown>
  const charges = Array.isArray(raw.charges) ? raw.charges : []
  return {
    charges: charges.map((entry) => {
      const charge = (entry ?? {}) as Record<string, unknown>
      return {
        kind: asString(charge.kind),
        label: asString(charge.label),
        target: asString(charge.target) || 'world',
        targetLabel: asString(charge.targetLabel),
        intensity: asNumber(charge.intensity),
        // 比上次多/少（工作台画箭头用）。缺字段就是 0：老投影里没有这一项，不该画一个假箭头。
        delta: asNumber(charge.delta),
        // 上一次评估之前的值（画"从上次到现在净变化"的段用）；缺失/空 = -1，界面据此不画段。
        before: charge.before === undefined || charge.before === null ? -1 : asNumber(charge.before),
        tier: asString(charge.tier) || 'calm',
        cause: asString(charge.cause),
        since: asString(charge.since),
      } as EmotionDocument['charges'][number]
    }),
    sensitivities: (Array.isArray(raw.sensitivities) ? raw.sensitivities : []).map((entry) => {
      const item = (entry ?? {}) as Record<string, unknown>
      return {
        kind: asString(item.kind),
        label: asString(item.label),
        target: asString(item.target) || 'world',
        targetLabel: asString(item.targetLabel),
        // 夹到 0–1：这是条上的宽度，坏值画出一道超出轨道的条只会像渲染坏了。
        level: Math.max(0, Math.min(1, asNumber(item.level))),
        cause: asString(item.cause),
        delta: asNumber(item.delta),
        levelBefore: Math.max(0, Math.min(1, asNumber(item.levelBefore))),
        at: asString(item.at),
      } as EmotionDocument['sensitivities'][number]
    }),
    warmth: asNumber(raw.warmth),
    warmthCause: asString(raw.warmthCause),
    compositeLabel: asString(raw.compositeLabel),
    compositeParts: Array.isArray(raw.compositeParts)
      ? raw.compositeParts.map((part) => asString(part)).filter((part) => part !== '')
      : [],
    perceived: asString(raw.perceived),
    perceivedAt: asString(raw.perceivedAt),
    energy: asNumber(raw.energy),
    energyLevel: (asString(raw.energyLevel) || 'fresh') as EmotionDocument['energyLevel'],
    settledAt: asString(raw.settledAt),
    updatedAt: asString(raw.updatedAt),
    notice: asString(raw.notice),
  }
}
