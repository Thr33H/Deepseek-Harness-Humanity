#!/bin/sh
# 统一校验入口的兼容外壳。
#
# 真正的实现在 package.json 的 `verify` script（build → typecheck → test），
# 之所以不把逻辑写在这里：本仓库要求跨平台，而 `.sh` 在 Windows 上需要额外的 shell 才能跑。
# 规范入口是 `pnpm verify`；这个文件只是给按固定路径 `scripts/verify.sh` 调用的外部工具
# （例如审计协议）留一个可执行落点，内容故意保持一行转发，避免出现第二份步骤定义。
exec pnpm run verify
