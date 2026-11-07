# DSH 插件拆分记录

- 来源：`https://github.com/ddd104/dsh-unreal-bridge`
- 来源提交：`b26bb673c3752c6e847b7405591edce0412dac87`（0.6.1）
- 目标：`https://github.com/ddd104/dsh-bridge-unreal`（0.6.2）
- 运行时包名：保留 `dsh-unreal-bridge`；客户端模块、Remote namespace、插件行标识、缓存路径和 UE 通信协议保持兼容。

迁入 `src/` 的完整 DSH 宿主与客户端、相关测试、协议和视觉说明、构建打包与发行包安装脚本、许可证和依赖锁文件。根目录提交无 sourcemap 的发行 JS，直接满足 DSH 的 GitHub / 本地目录安装入口。

`unreal/` 的 UE C++、知识工具与项目技能，以及 `editors/` 的 VS Code、Rider、Android Studio、独立代码附件插件继续由原仓库维护。本仓库不包含 UE DLL、项目资产、node_modules 或本机配置；原仓库文件未删除，现有使用者仍可继续使用。

原本直接读取同仓库 UE 源码的两项协议对照测试改为显式读取 `DSH_UE_PLUGIN_ROOT`，避免新仓库依赖固定的相邻目录。指定不存在或不兼容的目录时测试失败，不会静默跳过；未指定时显示跳过原因。

发布前运行 `npm ci`、`npm run check` 和 `npm run package:dsh`。需要跨端校验时设置 `DSH_UE_PLUGIN_ROOT`。实际 UE 连接和编辑器功能验收需要运行 UE 工程；包安装检查不能代替这些验收。
