# Wiki / RAG M1：DSH 项目与知识服务

日期：2026-11-27（北京时间）。对应实施大纲第 13 节的 **M1**；M0 问题集继续保留。

本文保留 M1 交付时的范围与测试记录。后续 [M5](knowledge-m5.md) 已增加独立 UE 导出、宿主导入及离线资产快照，并通过真实 UE/干净 DSH 安装验证；运行时要求以 M5 和 package.json 为准。

## 已交付

DSH 从当前对话绑定的 UE 识别项目，显式启动本地基础索引任务，并通过原有 `unreal_knowledge` 查询文档、源码和源码图谱。解析及同步 SQLite 操作运行在独立 Worker。打开会话、保存设置、登记项目和普通查询不会启动构建；全部基础流程不使用 Embedding。

| 代码 | 职责 |
| --- | --- |
| `src/project-context.mjs` | 共享项目发现、本机路径映射验证、稳定工作副本身份、项目句柄及绑定核对；Skills 复用最近工程查找 |
| `src/knowledge-service.mjs` | DSH / UE 查询路由、旧路径回退、工作区和绑定切换校验 |
| `src/knowledge-jobs.mjs` | 显式任务、进度、取消、幂等请求、持久状态和 generation 发布 |
| `src/knowledge-worker.mjs` | 宿主后台入口，共享 `Tools/knowledge-core.mjs` |
| `Tools/knowledge-worker.mjs` | 保留旧 UE CLI、锁及原缓存契约 |
| `lib/knowledge-worker.js` | DSH 自包含发布产物，包含核心、默认配置和文档解析器；不加载用户工程中的可执行工具 |

## 使用方法

1. 在当前对话的 Unreal Editor 面板绑定 UE 工程。
2. 调用 `unreal_knowledge_projects({})` 查看绑定工程及完整资料、缓存路径。无需再选知识项目；后续操作可省略 `projectHandle`，传入时必须与绑定一致。
3. 明确更新基础索引时调用 `unreal_knowledge_build({projectHandle, requestId})`，其中 `requestId` 是 UUID。立即返回 `job`，构建在后台继续。
4. 用 `unreal_knowledge_status({projectHandle, jobId})` 查看任务；省略 `jobId` 查看最近任务与已发布版本。
5. 查询仍用 `unreal_knowledge({tool, arguments, projectHandle?, backend?})`。`backend` 默认 `auto`；`local` 强制本地，`editor` 明确查询匹配的旧 UE 索引。取消使用 `unreal_knowledge_cancel({projectHandle, jobId})`。

相同项目和 `requestId` 返回同一任务，包括终态；重新构建使用新 UUID。基础任务只写派生缓存，不修改工程资料或资产，允许在 `allowWrites: false` 下运行。已有知识记录写入的批准策略保持不变。

设置页表单与按钮属于 M3。M1 提供以下 Remote：

| Remote | 作用域 |
| --- | --- |
| `knowledgeWorkspaceProjects(agent)` | 会话：发现并登记已验证项目 |
| `knowledgeProjects()` | 全局：只列出已登记且仍可访问的项目，不猜测最近会话 |
| `knowledgeStatus({projectHandle, jobId?})` | 全局：明确项目后查看状态 |
| `knowledgeBuild({projectHandle, requestId})` | 全局：明确项目后启动基础构建 |
| `knowledgeCancel({projectHandle, jobId})` | 全局：取消该项目任务 |

`unreal_state.knowledge.capability` 为 `dsh_local_knowledge_v1`。此能力属于 DSH，不修改 UE 旧工具目录或握手版本。

## 查询与兼容边界

| 条件 | 行为 |
| --- | --- |
| 无 UE 绑定或无法验证绑定工程的本机路径 | 明确返回绑定或路径错误，不猜测 DSH 工作区 |
| 工作区 A 绑定 UE B | 使用 UE B 的知识库；显式传入 A 的句柄会被拒绝 |
| 无本地索引、有匹配 UE | 状态、上下文及图谱继续使用旧索引；源码搜索和回读可在 DSH 执行 |
| 无本地索引、UE 离线 | 源码搜索、回读仍可用；上下文返回源码和更新提示，图谱要求显式构建 |
| 有本地已发布版本且当前宿主已识别绑定工程 | 文档、源码图谱、上下文可离线查询；一次查询固定一份 generation |
| 本地 Worker / SQLite 不可用 | 有匹配 UE 知识能力时回退；否则返回具体错误，不阻止其他桥接功能 |
| 构建进行中、失败或取消 | 已发布旧版本继续可读 |
| 查询中切换 UE 绑定 | 拒绝旧结果；后台构建仍归属于创建时的项目 |

查询保留原结果主要字段，增加 `knowledgeBackend`、`retrievalMode: "base"`、`projectId / projectHandle`、`indexGeneration` 和 `degradedReasons`。

**M1 本地索引覆盖文档和源码图谱，不导入 UE 资产快照。** `asset_snapshot / inspect_asset / read_asset_snapshot / search_asset_snapshots` 仍由匹配 UE 提供，资产图谱快照协作属于 M5。需要包含资产的旧图谱或原有 `project_context.remembered` 时显式使用 `backend: "editor"`；本地结果以 `assetEvidenceBackend: "ue_legacy"` 标明此边界。`experience_lookup` 和知识记录写入继续使用旧 UE 存储，本地重建不会覆盖 Evidence / Experiences。

M0 默认旧路径问题集保持通过。M1 交付时的中文全文子串、重复内容 ID、Wiki 元数据、分块和来源回读缺口已由 [M2](knowledge-m2.md) 补齐；下文测试数量为 M1 的历史记录。云端配置、收费向量任务和恢复按钮属于 M3。

## 项目与缓存

身份由规范化真实 `.uproject` 路径计算，描述符内容哈希单独记录。不同工作副本隔离，同项目多会话共享索引。描述符变化使旧索引不兼容，不更换工作副本 ID。知识库根目录由绑定工程决定，不使用 DSH 工作区或插件 `process.cwd()` 代替。

DSH 文件系统验证绑定工程的访问及双向本机路径映射。知识资料根固定为 `ProjectKnowledge`；链接到其他工程的 Wiki 根或缓存目录不能混入构建。首次访问时复制旧 DSH 状态目录的缓存并保留原件，目标已存在时不覆盖。旧文档范围的索引需要手动更新，已成功的向量缓存继续保留供复用。

```text
<UE 工程>/Plugins/DSHUnrealBridge/Cache/Knowledge/<working-copy-id>/
  current.json
  build.lock
  latest-job.json
  jobs/<request-id>.json
  generations/<generation>/
    ProjectMemory.project.json
    identity.json
    source-index.json
    Graph/
    Memory/
```

索引固定使用启动时的配置快照；任务记录配置指纹、项目、阶段、文件与图谱计数、错误及结束时间。项目 JSON 仍只允许工程相对路径；宿主缓存路径经内部 `hostPaths` 注入，工具参数不能任意指定路径。

每个项目一个构建锁，单个 DSH 服务最多同时构建 2 个项目、处理 4 个查询。发布仅替换小型 JSON 指针，不重命名打开中的数据库；Windows 临时占用有限重试。发布前核对文档、源码与描述符版本；变化时失败并保留旧版本。

取消和正常退出会终止 Worker。崩溃遗留任务显示 `interrupted`，不自动恢复；用户可用新请求 ID 重新构建。M1 暂不自动回收旧 generation 和未发布目录，避免删除仍被读取的数据库，后续补充知识缓存回收。

## 验证

```powershell
npm run check
./scripts/check-knowledge.ps1 -PluginRoot ./unreal/DSHUnrealBridge -RunTests
npm run package:dsh
```

M1 集成测试覆盖真实离线查询、多项目与会话隔离、多个候选、编辑器核对、兼容回退、幂等/取消/失败、工作区切换、退出清理、并发上限、目录链接，以及独立 bundle 的 XLS / Proto 解析。实际 Worker 内封锁并统计 `fetch`、HTTP(S) 与 TCP，基础构建和查询的网络调用尝试为 0。

本次结果：`npm run check` **413/413** 通过（含 M1 集成测试 **14/14**）；知识工具检查 **48/48** 通过（ProjectGraph 5、ProjectMemorySystem 21、Worker 22），固定 Node 哈希验证通过。`npm run package:dsh` 成功，实际 `.tgz` 解包后的独立 Worker 构建/查询测试通过。安装包位于 `dist/dsh/dsh-unreal-bridge-0.6.5.tgz`。

当前验证环境为 Windows Node 24.15.0。保留 Node 22 宿主声明，SQLite 不可用时在 Worker 路径报错并回退；不同 Node 22 小版本与真实 DSH / UE 安装联调属于后续兼容验证。本阶段未启动真实 UE、未修改 C++、未调用云端服务，未安装或重启用户现有插件。
