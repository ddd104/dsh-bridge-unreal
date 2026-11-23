# DSH 与 UE 插件同步记录

- 来源：`https://github.com/ddd104/dsh-unreal-bridge`
- 首次拆分提交：`b26bb673c3752c6e847b7405591edce0412dac87`（0.6.1）
- 本次同步提交：`c95de19f3fba2fbb9845981734870572a12504c4`（DSH 0.6.5 / UE 0.5.5）
- 目标：`https://github.com/ddd104/dsh-bridge-unreal`（0.6.5）
- 运行时包名：保留 `dsh-unreal-bridge`；客户端模块、Remote namespace、插件行标识、缓存路径和 UE 通信协议保持兼容。

迁入 `src/` 的完整 DSH 宿主与客户端、相关测试、协议和视觉说明、构建打包与发行包安装脚本、许可证和依赖锁文件。根目录提交无 sourcemap 的发行 JS，直接满足 DSH 的 GitHub / 本地目录安装入口。

`unreal/DSHUnrealBridge` 已包含并同步 UE C++、知识工具与项目技能。UE 知识工具准备脚本 `scripts/prepare-knowledge.ps1` 同步到本仓库，可在本仓库独立准备运行时与工具构建产物。`editors/` 的 VS Code、Rider、Android Studio、独立代码附件插件仍留在原仓库。本次不复制 UE DLL、项目资产、node_modules、知识缓存或本机配置；原仓库保持不变。

两项协议对照测试现在默认读取本仓库的 UE 源码，保证 DSH 与 UE 端一起验证；仍可用 `DSH_UE_PLUGIN_ROOT` 指定其他插件目录进行交叉检查。指定不存在或不兼容的目录时测试失败，不会静默跳过。保留目标仓库已有的 Windows 临时目录与符号链接测试适配。

2026-11-11 同步增加 `unreal_data_table_patch` 及 UE 对应实现、自动化测试和预览验证脚本，并同步 MCP 内层失败识别。保持目标仓库安装入口、包名、发布构建方式和仅支持 UE 5.8 的说明；DSH 发行版本升为 0.6.3，避免与既有 0.6.2 安装混淆。

2026-11-17 同步至 DSH 0.6.4 / UE 0.5.4，增加 DataTable 逐行写入、新增、批量改名、删除、复制、清空和嵌套容器删除，以及 Content Browser 右键“添加到 DSH”的手动候选资产列表。候选与实时 Actor/组件分开显示。迁入对应 DSH 测试、UE 自动化测试及 `asset-candidates-e2e.mjs`、`datatable-rows-e2e.mjs`，保留本仓库的 Windows 测试适配和跨插件目录协议校验选项。

2026-11-23 同步至 DSH 0.6.5 / UE 0.5.5。迁入全量 MCP 默认开放策略、工具描述中的可用性和只读信息、新增 21 项精确只读查询，以及 EditorToolset / SlateInspectorToolset 的 Editor 依赖。脚本执行、Slate 桌面交互和旧 DataTable 写入入口按源版本默认开放；显式的桌面输入禁用配置继续生效。同步目录快照、覆盖测试、MCP 端到端验证脚本与开放审计说明；审计中的真实 UE 和业务工程验证明确标为原仓库记录，本次迁移验收另见 `validation.md`。

依赖范围未变化，保留目标锁文件中已验证的依赖记录，仅更新根包版本。源锁文件的 `iconv-lite` 版本字段与下载归档不一致，因此不整体覆盖目标锁文件。

发布前运行 `npm ci`、`npm run check` 和 `npm run package:dsh`。实际 UE 连接和编辑器功能验收需要运行 UE 5.8 工程；包安装检查不能代替这些验收。
