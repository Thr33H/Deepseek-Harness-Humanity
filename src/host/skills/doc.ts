/**
 * 技能清单在设置投影里的形状（M7）。
 *
 * 为什么单独一个文件、而不塞进 `evolution/section-doc.ts`：那份文档已经贴着 200 行质量门，
 * 而且技能清单的字段归技能模块自己维护更清楚 —— 宿主投影只是它的一个消费面。
 * @module humanity/skills/doc
 */
import Schema from '@deepseek-ai/schemastery'

/** 投影里的技能数组（字段与 `inventory.ts` 的 `SkillView` 一一对应）。 */
export const SkillViewsSchema = Schema.array(
  Schema.object({
    name: Schema.string().default(''),
    description: Schema.string().default(''),
    content: Schema.string().default(''),
    status: Schema.string().default(''),
    file: Schema.string().default(''),
    origin: Schema.string().default(''),
    decidedAt: Schema.string().default(''),
    disabled: Schema.boolean().default(false),
    /** 这条技能用到的插件（卸载对应插件后它无法正常工作）。 */
    pluginDeps: Schema.array(Schema.string()).default([]),
  }),
).default([])
