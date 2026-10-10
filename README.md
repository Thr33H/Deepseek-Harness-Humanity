# Humanity

> **本仓库由 AI 编写**（署名：**澄** / Cheng）—— 代码、测试与文档由 AI 助手产出；需求、决策与验收由仓库所有者负责。

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.1.5--rc.2%20%7C%200.2.0--rc.2-4B6BFB.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![node](https://img.shields.io/badge/node-%3E%3D22-339933.svg)](https://nodejs.org/)

[English](README-EN.md) | 简体中文

**Humanity** 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的**拟人化套件**：
把**人格、记忆、技能、自进化与梦境**四件事收进同一个原生 Web 工作台，对外是一个可安装的
bundle，内部各模块互相独立、可单独开关。

它想解决的问题很朴素：**让你的 Agent 记得住事、有自己的性格，而且这些都在你看得见、改得动的地方。**

## 功能

| 模块 | 你得到什么 |
|---|---|
| **人格** | 身份卡 + 人格卡两栏编辑。原生项锁定（插件靠它们认标识），其余一切是自定义项：可增、可改名、可整项删除；每项的**名称固定、内容直接改**，不用"点一下才出现"；改动**即时生效**（热更新），并留一份可回滚的历史 |
| **记忆** | 三层记忆（长期 / 区域 / 会话）自动写入 + 七信号相关性检索；低风险内容自动落库，高风险内容**只生成提案等你批准**；条目可改归属、可合并去重、可归档与恢复；不会无限膨胀，也**不会被自动删掉** |
| **技能** | 自进化总结出来的技能落在官方用户技能目录，工作台里可新建 / 修改 / 停用 / 恢复；技能引用了哪个插件的工具，会**指名到插件**告警 |
| **自进化与梦境** | 后台定期扫描新会话 → 模型解析 → 产出记忆与提案，全程记账、可设每日上限；「梦境」把整理过程写成一条可读的运行时间线 |

另外还有：一个**总开关**与四个模块开关（改动即时生效）；开关注册进 DSH 设置服务，所以在 DSH 自己的设置里搜 `Humanity` 也能找到。

## 环境要求

- [dsh](https://www.npmjs.com/package/@deepseek-ai/dsh)：`0.1.5-rc.2` 起的 0.1.x，或 `0.2.0-rc.2` 起的 0.2.x（见 [兼容性](#兼容性)）
- Node **>= 22**
- 从源码安装时需要 [pnpm](https://pnpm.io/)（仓库随附 `pnpm-lock.yaml`）

## 安装

### 从 GitHub 安装（源码直达，当前推荐）

```bash
dsh plugin --profile web add github:Thr33H/Deepseek-Harness-Humanity
docker restart <容器名>          # 或重启你自己的 dsh 进程
```

Git 安装会在安装时跑一次构建（`prepare`）来产出 `lib/`。若 pnpm 提示 build script 被忽略
（pnpm 11 起有构建闸门），在 DSH 的插件页点「允许这些脚本并重试」，或在该 profile 的
`pnpm-workspace.yaml` 里放上：

```yaml
allowBuilds:
  esbuild: true
```

### 从 npm 安装

> ⚠️ 先确认 npm 上确有版本：`npm view deepseek-harness-humanity version`。
> 若查不到（尚未发布），请用上面的 GitHub 方式。

```bash
dsh plugin --profile web add deepseek-harness-humanity
docker restart <容器名>
```

`dsh plugin add` 会在 profile 目录里跑 pnpm，并**自动把本包追加进该 profile 的
`dsh.profile.bundles`**（因为本包在 `package.json` 里声明了 `dsh.bundle`）—— 不需要手改任何配置文件。

### 从本地源码装（要改代码时）

```bash
git clone https://github.com/Thr33H/Deepseek-Harness-Humanity.git
cd Deepseek-Harness-Humanity
pnpm install                     # prepare 会自动构建一次
dsh plugin --profile humanity-dev add "$PWD"
dsh --profile humanity-dev --port 3099 --no-open   # 先建隔离 profile 验证，别直接动正在用的那个
```

**装好以后**：侧栏出现 `Humanity` 入口（有待确认内容时图标带红点），点击进入工作台；开关在 DSH 设置里搜 `Humanity`。

### 更新 / 卸载

```bash
dsh plugin --profile web update deepseek-harness-humanity    # 更新
dsh plugin --profile web remove deepseek-harness-humanity    # 卸载
```

插件的数据（`$DSH_HOME/storages/humanity.json`、`$DSH_HOME/skills/`）是**独立数据**，卸载插件不会删除它们。

## 数据放在哪

| 内容 | 位置 |
|---|---|
| 人格卡、记忆条目、提案、运行记录 | `$DSH_HOME/storages/humanity.json`（版本化存储领域 `humanity`） |
| 人格历史（被取代 / 被删内容的留档） | 同一份存储的 `persona_history` 表，**有保留期**（默认 30 天，可设为永久） |
| 模块开关、记忆模式、自进化调度与预算 | `$DSH_HOME/settings.yaml` 的 `humanity` 段 |
| 技能文件 | `$DSH_HOME/skills/` |
| 会话 | `$DSH_HOME/sessions/`（DSH 自己的） |

一切都在 `$DSH_HOME` 里，跟着 DSH 一起备份 / 迁移；插件不往别处写。

## 会花你自己的钱（自进化）

「自进化」会**按调度调用模型**来整理会话（默认 `idle`：没有活跃对话满 30 分钟就自动整理一次，
**不是**"只有手动点才跑"；也可改成每日 / 每周 / 每月）。

- 预算：每次运行的会话数、每会话事件数、单次输入字节、单次输出 token 与**每日调用上限**都在自进化页可改；
  超预算只警告并停止，不会偷偷烧钱；
- 花费逐项记账显示在自进化页（今日调用数 / tokens）；
- **人格注入与记忆检索不调用模型**；记忆衰减核算是纯本地计算，**同样不调用模型**。

## 兼容性

机器判据就是本包的 `peerDependencies`：`^0.1.5-rc.2 || ^0.2.0-rc.2`（6 个官方 seam）。
**不在这个区间里的 DSH 会在启动时直接拒绝挂载整个 bundle**，表现为：人格卡从提示词消失、
工作台页面消失、`remember` / `recall` 工具消失（**数据不受损**）。

| DSH 版本 | 可装 | 说明 |
|---|---|---|
| `0.1.5-rc.2` / `0.1.5-rc.3` / `0.1.6` … 0.1.x | ✅ | 旧线 |
| `0.2.0-rc.2` … 0.2.x | ✅ | 新线（生产与靶机实测） |
| `0.1.7-rc.*` / `0.1.6-rc.*` / `0.2.1-rc.*` | ❌ | **已知缺口**：semver 的预发布"同段匹配"规则所致，需把该预发布段显式加进 peer 范围 |
| 其他 | ❌ | 低于下限或超出上界 |

## 开发

```bash
pnpm install
pnpm typecheck   # 全量类型检查（宿主 + 客户端）
pnpm build       # 产出 lib/index.js（宿主，ESM）与 lib/client.js（客户端，单文件 CJS bundle）
pnpm test        # 先构建，再跑全部测试
```

目录：

```
src/host/            宿主半边：开关、模块注册表、设置命名空间、存储领域
src/client/          客户端半边：侧栏入口、主工作台、文案字典
scripts/             构建脚本（tsc 编宿主，esbuild 打客户端 bundle）
test/                单元测试 + 真实服务组合测试 + 打包契约测试
cordis.patch.yml     本包作为 bundle 层提供的组合补丁
```

两条容易踩的线：

1. **客户端半边必须是单文件 bundle** —— 浏览器端的 `require` 只认 shell 播种的静态模块表，
   相对路径解析不了，所以 `src/client` 的相对导入必须在构建期内联掉。
2. **默认值只有一处** —— 改默认值只能改 `src/host/config.ts` 的 schema，`cordis.patch.yml`
   里刻意不写 `config:`；`test/manifest.test.mjs` 会盯着这件事。

贡献前请读 [CONTRIBUTING.md](CONTRIBUTING.md)；设计与边界说明见 [docs/](docs/)。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/USAGE.md](docs/USAGE.md) | 使用说明：人格卡、记忆三层的取舍、技能落盘、自进化与梦境的每个开关 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 架构与设计约束：模块边界、兼容门、为什么这样切 |
| [CHANGELOG.md](CHANGELOG.md) | 版本沿革（含每个修复要解决的真实症状） |

## License

[MIT](LICENSE) © 2026 Thr33H

## 致谢

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) —— 本插件只使用其公开 seam（槽位、设置、存储领域、cordis loader）
- 角色卡与记忆格式的设计参考了社区实践（Character Card V2/V3 规范、SillyTavern World Info）
