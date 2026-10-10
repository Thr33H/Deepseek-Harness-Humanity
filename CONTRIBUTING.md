# 参与贡献

感谢你愿意为 Humanity 出力。这份文档说明**怎么在这个仓库里干活**，以及几条容易踩的线。

> English: this project is maintained in Chinese. Issues and pull requests in English are welcome —
> just keep the description concrete (what you did, what you saw, what you expected).

## 开始之前

- **先搜 Issue**：同样的问题可能已经有人报过或正在处理。
- **小改动直接提 PR**；大改动（新增模块、改数据结构、动兼容门）**先开 Issue 说清动机与取舍**，避免白做。
- **安全问题不要开公开 Issue** —— 走 [SECURITY.md](SECURITY.md) 的私密通道。

## 开发环境

| 项 | 版本 |
|---|---|
| Node | **>= 22** |
| pnpm | 与仓库随附的 `pnpm-lock.yaml` 一致（建议 pnpm 10/11） |
| dsh | `0.1.5-rc.2` 起的 0.1.x，或 `0.2.0-rc.2` 起的 0.2.x |

```bash
git clone https://github.com/Thr33H/Deepseek-Harness-Humanity.git
cd Deepseek-Harness-Humanity
pnpm install
pnpm verify          # build + typecheck + test，提交前一键过门
```

想真机验证改动时，**别动你正在用的那个 profile**，开一个隔离 profile：

```bash
dsh plugin --profile humanity-dev add "$PWD"
dsh --profile humanity-dev --port 3099 --no-open
```

## 常用命令

```bash
pnpm build        # 产出 lib/index.js（宿主 ESM）与 lib/client.js（客户端单文件 bundle）
pnpm typecheck    # 全量类型检查（宿主 + 客户端）
pnpm test         # 先构建，再跑全部测试
pnpm verify       # build + typecheck + test
```

## 四条容易踩的线

1. **客户端半边必须是单文件 bundle。** 浏览器端的 `require` 只认 shell 播种的静态模块表，
   相对路径解析不了 ⇒ `src/client` 里的相对导入必须在构建期内联掉（见 `scripts/build-client.mjs`）。
   bundle 里模块的 `id` 必须等于包名，脚本直接从 `package.json` 读，**不要手写**。
2. **默认值只有一处。** 改默认值只能改 `src/host/config.ts` 的 schema；`cordis.patch.yml` 里刻意不写 `config:`。
   `test/manifest.test.mjs` 会盯着这件事。
3. **只用 DSH 官方公开 seam**（槽位、`ctx.settings`、`ctx.storageDomain`、cordis loader）。
   需要可选能力时走 `loadOptional`，**不要**把插件变成硬依赖；不兼容时**停功能、不停 DSH**。
4. **数据要能跨版本活下来。** 存储领域带版本号，升级走迁移、默认值不漂移；改数据结构必须同时给迁移与测试。

## 代码约定

- TypeScript，宿主与客户端共用 `tsconfig.json` 的类型环境；新增文件请放进既有目录（`src/host/**` 或 `src/client/**`）。
- 单文件与单函数的尺寸有上限（由测试与构建脚本守住）；超了就拆，别硬塞。
- 面向用户的文案放文案字典，别在组件里散写字面量。
- 注释写**"为什么"**，不写"这行在干什么"。改动某条规则时，把它的来龙去脉补在注释里。

## 测试要求

- **新增行为必须配回归测试**；修缺陷时，测试要能复现"修之前的失败"。
- 提交前 `pnpm test` 必须**全绿**。红着的 PR 不会被合并。
- **不要写依赖当前时间的测试。** 需要时间就注入固定时间戳 —— 依赖墙钟的测试会随日期漂移，
  今天绿、几个月后红（本仓库在早期就吃过这个亏）。
- 涉及"只读 / 不改动生产数据"的测试，用临时目录或内存替身，别碰真实的 `$DSH_HOME`。

## 提交信息

沿用 [Conventional Commits](https://www.conventionalcommits.org/) 的形态，类型用：

`feat` · `fix` · `docs` · `refactor` · `test` · `chore`

标题里写**用户能感知的变化**，需要时在正文补"为什么"和"怎么验的"。一个提交只做一件事。

## Pull Request

PR 描述里请包含：

1. **做了什么**（一两句）；
2. **为什么**（对应哪个 Issue 或什么症状）；
3. **怎么验的**（跑过的命令与输出，真机验证请写清环境）；
4. **兼容性影响**（是否动 peer 范围、是否需要数据迁移、老数据怎么办）。

改动涉及界面时，附一张截图会省很多来回。**不要**在 PR 里提交 `lib/`（构建产物）或 `node_modules/`。

## 许可

提交即表示你同意以本仓库的 [MIT 许可证](LICENSE) 授权你的贡献。
