# 迁移验证

## 2026-11-11：DSH 与 UE 两端同步（0.6.3）

- 来源提交 `f990988254f936f720cb30bca116f6b6a4b83ab3`。逐项比对 30 个 DSH 源码文件与 171 个 UE 插件文件，除文本换行格式外内容一致，无遗漏或目标端多余实现文件。
- `npm run check`：363 项测试，362 通过、0 失败、1 跳过。跳过项仅为本机 Windows 文件符号链接权限；两项协议测试默认读取本仓库 UE 源码并通过。
- `npm run package:dsh`：生成 `dist/dsh/dsh-unreal-bridge-0.6.3.tgz`，旧版 0.6.2 安装包保留到 `dist/dsh/previous/`，主目录只保留当前版本供安装脚本识别。
- 在独立 `DSH_HOME` 下，使用本机 DSH 官方 CLI 将 0.6.3 安装包安装到 `bridge-sync-063` profile，禁用安装脚本仍安装成功。实际加载该 profile 安装的宿主，成功注册 28 个工具（包含 `unreal_data_table_patch`），本机动态端口监听及资源释放正常。
- `scripts/prepare-knowledge.ps1` 与原仓库一致，PowerShell 语法检查通过；README 本地链接及 Git 空白检查通过。
- 本次未运行知识工具准备下载、UE 5.8 C++ 编译、UE 原生自动化测试或真实工程修改验证。UE 源码和配套测试已同步，使用新增能力前需在 UE 5.8 工程中编译插件。

本次未修改原仓库或日常 DSH 配置，未提交或推送 Git；远端安装需发布后另行验证。以下为首次迁移的历史记录。

## 2026-11-07：首次迁移（0.6.2）

验证日期：2026-11-07。目标版本：0.6.2；本机 DSH：0.2.1-rc.2。

- `npm ci --no-audit --no-fund`：成功，使用仓库锁文件安装独立开发依赖。
- 设置 `DSH_UE_PLUGIN_ROOT` 后执行 `npm run check`：359 项测试，358 通过、0 失败、1 跳过。跳过项仅为 Windows 当前权限无法创建文件符号链接；目录 junction 保护及两个 UE 跨仓库协议测试均通过。
- `check:package`：npm 无安装脚本打包检查通过，主入口、客户端入口、Remote 入口及 bundle patch 均包含；客户端注册的模块 ID 与包名一致；开发源码、测试、UE 文件及 sourcemap 未进入包。
- `npm run package:dsh`：成功生成 `dist/dsh/dsh-unreal-bridge-0.6.2.tgz` 与四个安装辅助文件。
- 将 `DSH_HOME` 指向忽略目录 `.test-state/dsh-home`，使用已安装 DSH 的官方 CLI，以 `--profile bridge-install-test add file:D:/AI/dsh-bridge-unreal --ignore-scripts` 安装：成功。插件自动加入该测试 profile 的 `dsh.profile.bundles`。
- 对另一个独立测试 profile `bridge-archive-test` 安装生成的 `.tgz`（同样禁用安装脚本）：成功，解析到版本 0.6.2。
- 直接加载该测试 profile 实际安装的 `lib/index.js`，使用临时状态目录、动态端口及只读设置启动宿主：成功注册 27 个工具，WebSocket 监听成功，之后正常释放资源。
- `src/` 与原仓库来源提交对应的工作区文件逐项对照：无运行逻辑改动。源仓库保持未修改。

真实安装测试未修改用户的日常 DSH profile。安装日志中有上游 peer dependency 提示，未阻止安装或上述宿主加载。未运行 UE 编辑器连接及资产修改验收；这些行为沿用原实现，需要实际工程另行验证。远端 GitHub 下载只有在本地文件推送后才能验收；本地目录安装成功不等于远端已发布。
