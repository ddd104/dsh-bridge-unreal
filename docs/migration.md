# DSH 与 UE 插件同步记录

- 来源：`https://github.com/ddd104/dsh-unreal-bridge`
- 首次拆分提交：`b26bb673c3752c6e847b7405591edce0412dac87`（0.6.1）
- 本次同步提交：`f990988254f936f720cb30bca116f6b6a4b83ab3`（源包版本仍为 0.6.1）
- 目标：`https://github.com/ddd104/dsh-bridge-unreal`（0.6.3）
- 运行时包名：保留 `dsh-unreal-bridge`；客户端模块、Remote namespace、插件行标识、缓存路径和 UE 通信协议保持兼容。

迁入 `src/` 的完整 DSH 宿主与客户端、相关测试、协议和视觉说明、构建打包与发行包安装脚本、许可证和依赖锁文件。根目录提交无 sourcemap 的发行 JS，直接满足 DSH 的 GitHub / 本地目录安装入口。

`unreal/DSHUnrealBridge` 已包含并同步 UE C++、知识工具与项目技能。UE 知识工具准备脚本 `scripts/prepare-knowledge.ps1` 同步到本仓库，可在本仓库独立准备运行时与工具构建产物。`editors/` 的 VS Code、Rider、Android Studio、独立代码附件插件仍留在原仓库。本次不复制 UE DLL、项目资产、node_modules、知识缓存或本机配置；原仓库保持不变。

两项协议对照测试现在默认读取本仓库的 UE 源码，保证 DSH 与 UE 端一起验证；仍可用 `DSH_UE_PLUGIN_ROOT` 指定其他插件目录进行交叉检查。指定不存在或不兼容的目录时测试失败，不会静默跳过。保留目标仓库已有的 Windows 临时目录与符号链接测试适配。

2026-11-11 同步增加 `unreal_data_table_patch` 及 UE 对应实现、自动化测试和预览验证脚本，并同步 MCP 内层失败识别。保持目标仓库安装入口、包名、发布构建方式和仅支持 UE 5.8 的说明；DSH 发行版本升为 0.6.3，避免与既有 0.6.2 安装混淆。

发布前运行 `npm ci`、`npm run check` 和 `npm run package:dsh`。实际 UE 连接和编辑器功能验收需要运行 UE 5.8 工程；包安装检查不能代替这些验收。
