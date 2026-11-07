# 迁移验证

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
