# Wiki / RAG M5：UE 快照协作与分发验证

日期：2026-11-27（北京时间）。承接 [M4](knowledge-m4.md)。

M5 将 UE 资产快照导出与旧图谱重建拆开。DSH 显式导入已完成的一代快照后，可以在 UE 离线时继续分页读取资产证据，并将 Wiki 资产链接关联到同一代快照。缓存跨 DSH 重启保留；重启后需重新绑定并识别工程，随后仍可离线使用该缓存。导出、导入和快照查询不请求 Embedding，也不重建基础或向量索引。

## 使用流程

更新 DSH 插件，并用目标引擎编译、更新 UE 插件后重启编辑器。`unreal_state.knowledge` 返回宿主能力 `dsh_published_snapshots_v1` 和 `snapshotExportAvailable`；匹配的 UE 连接须声明 `ue_snapshot_export_v1`。当前对话绑定决定工程；`unreal_knowledge` 外层可选的 `projectHandle` 只用于核对该绑定。

以下均为 `unreal_knowledge` 参数。每个新任务生成新的 UUID；`jobId` 等于首次提交的 `requestId`。

```json
{"tool":"snapshot_export_start","arguments":{"requestId":"7c659e64-9283-4595-b992-eaa2b68b0b7f"}}
{"tool":"snapshot_export_status","arguments":{"jobId":"7c659e64-9283-4595-b992-eaa2b68b0b7f"}}
{"tool":"snapshot_import","arguments":{"jobId":"7c659e64-9283-4595-b992-eaa2b68b0b7f"}}
{"tool":"read_asset_snapshot","backend":"local","arguments":{"assetPath":"/Game/M5/BP_Saved","section":"blueprint","offset":0,"limit":64}}
```

等导出状态为 `succeeded` 后再导入。`snapshot_export_cancel` 接受相同 `jobId`，取消正在运行的 UE 导出；重复开始请求返回原任务。任务另有 `running/failed/cancelled/interrupted` 状态，重启后的未完成任务不会自动恢复，须用新 UUID 显式启动。导入是可取消的宿主请求，成功返回 `status: imported`；它不转发给 UE。导入时仍须连接原导出编辑器，导入完成后才能离线查询。

导出只生成快照。原菜单“更新项目图谱与知识记忆”继续执行旧的扫描加建图流程；本阶段独立导出入口是工具调用，没有新增菜单或设置页按钮。已有实时 `asset_snapshot/inspect_asset` 和 `backend: editor` 路径保持可用。

## 发布与项目隔离

UE 使用现有增量扫描/快照缓存，每次导出生成新的不可变目录：

```text
Plugins/DSHUnrealBridge/Cache/UE/published/
  generations/<generation>/manifest.json
  generations/<generation>/assets/<asset-path-md5>.json
  editors/<editorId>.json
  jobs/<requestId>.json

<UE 工程>/Plugins/DSHUnrealBridge/Cache/Knowledge/<projectId>/snapshots/
  current.json
  generations/<generation>/manifest.json
  generations/<generation>/assets/<asset-path-md5>.json
```

先完成详情与清单，再原子替换编辑器发布指针；未完成目录不会被导入。原生 manifest schema 为 1，记录工程描述符、编辑器、引擎、采集时间、generation、覆盖范围、详情及磁盘包哈希。原生 `projectId` 沿用工程 `.uproject` 绝对路径，DSH 核对后映射到自身工作副本的 SHA256 项目身份。`editorId` 由已认证桥接连接注入，不能靠工具参数选择另一编辑器。

DSH 在 Worker 中校验项目、编辑器、完成指针、清单/详情 SHA1、工程描述符和磁盘包哈希；只允许工程或工程插件 Content 下的包，拒绝链接和越界路径。重复导入同一代保持幂等；损坏的现有代不会被覆盖。短发布锁防止多个宿主同时替换指针，发布前后再次检查取消、工程和绑定；失败回滚指针。一次查询固定基础 `indexGeneration` 和独立的 `snapshotGeneration`，二者不要求相同 UUID，也不会把导入快照当作重建文档索引。

导入最多 50000 个资产、单份 JSON 32 MiB、详情总量 1 GiB；每个源包/sidecar 最多 2 GiB。宿主导入超时 120 秒，查询沿用知识查询超时。UE 同时只运行一个独立导出或旧知识更新，内存保留最近 64 个任务；已发布代暂不自动回收。

## 证据、新鲜度和降级

持久证据仅包含已保存且采集/发布时未标记 dirty 的资产。未保存、dirty 或工程外资产被排除，`excluded` 和覆盖信息说明缺口。导出不保存资产。`.uasset/.umap` 及 `.uexp/.ubulk/.uptnl` 的内容和存在性都参与校验；新 sidecar、删除或修改包会使证据失效。修改工程描述符也使导入快照失效。

- `sourceStatus: current_on_disk`：当前磁盘包与采集证据的哈希匹配。
- `evidenceKind: saved_package_snapshot`、`liveState: not_verified`：历史编辑器采集，不能证明未保存对象、PIE 实例或当前内存状态。
- `snapshotStatus.available`：有可用的导入指针；`freshness: checked_per_asset` 表示状态查询不扫描所有包，实际读取时逐资产校验。
- `search_asset_snapshots` 可列出 `package_changed/package_missing/source_unavailable`；详情读取拒绝过期资产。缺失或排除项不是资产不存在的证明。

分页支持属性、蓝图图目录/节点、变量、组件、材质表达式和实例参数；`section: blueprint` 配合 `graph` 的名称或路径读取节点。默认 64、最多 200 项，每页条目最多 64000 字符。`nextOffset/truncated` 表示续页；单项超限明确报错。搜索和详情不依赖文档基础索引。

Wiki 的 `assets` 关联返回 `resolved_snapshot/stale_snapshot_asset/not_in_snapshot`。`project_context.graphAssociations` 附加快照代、资产节点及一跳依赖；最多 20 个节点、32 条边，并纳入总上下文预算。`graph_query` 合并已校验的资产候选；`graph_impact` 的 `ueasset:<path>` 只报告该代中一跳反向依赖，不能推断完整运行时影响。

旧 UE 缺少 capability 时拒绝新导出调用，但保留旧资产查询。`backend: auto` 在本地快照不可用时可回退匹配编辑器，`local` 返回明确错误。快照损坏或过期不会丢弃仍有效的文档证据。UE 未连接时，导出/导入不可用，已导入快照仍能读取。新建配置、连接 UE 或普通查询均不会自动导出、导入或调用付费服务。

## 运行时和分发

宿主 Node 要求改为 **`^22.23.5 || >=24.15.0`**。实际 Node 22.13.0 的 `node:sqlite` 缺少 FTS5，不能完整构建知识库；仅能导入 SQLite 模块不足以判定支持。基础构建先检测 FTS5，不支持时返回 `KNOWLEDGE_FTS5_UNAVAILABLE`，不进入扫描或向量生成。UE 插件继续携带固定、校验过的 Node 24.15.0，运行时不依赖系统 Node。

| 验证环境 | 结果与范围 |
| --- | --- |
| Windows 系统 Node 24.15.0 | 宿主全量回归 454/454；解包 Worker 33/33 |
| 官方 Node 22.23.5 | 解包 M3/M4/M5 Worker 33/33 |
| DSH 0.2.2-rc.5 / Electron Node 24.21.0 | 解包 Worker 33/33；隔离 profile 官方安装、真实 Loader/设置/凭据检查 10/10 |
| 官方 Node 22.13.0 | 早期测试 13/33，20 项因无 FTS5 失败；最终包明确返回 `KNOWLEDGE_FTS5_UNAVAILABLE`，源码回读通过、Embedding 请求为 0；不在支持范围内 |
| Win64 UE 5.8.4-0+UE5 | UAT BuildPlugin 成功；原生 Knowledge 自动化 8/8；真实联调 7/7 |

真实 UE 联调使用中文、空格路径下的全新临时工程，验证打包 DLL 连接、独立导出不建旧图谱、请求幂等、真实 Blueprint 分页、未保存资产排除、Wiki 关联、实际取消、UE 断开并重启宿主后读取、磁盘包变化失效。干净 DSH 验证只安装到隔离 `DSH_HOME`，没有修改用户现有 profile。上述是本机引擎构建的验证，其他引擎构建须重新编译；现有 DSH 发行兼容清单保留历史声明，不将局部检查扩展为所有版本保证。

原知识工具检查 59/59 和原 13 题基线的 20/20 断言通过。最终全量回归首轮有一次 `tool-execution.test.mjs` 进程异常结束，没有具体断言诊断；该文件单独 4/4、全量复跑 454/454 通过，尚未复现根因。最终 tgz 已重新解包、在三种运行时验证并通过官方安装器安装到隔离 profile，安装后的五个 bundle 与最终 tgz 哈希一致。UE ZIP 共 168 个条目，已检查必需 DLL、Node、Worker 依赖以及构建诊断目录的排除。

DSH 发布命令为 `npm run package:dsh`，产物在 `dist/dsh/`，包含 tgz 和安装脚本。UE 使用目标引擎的 `RunUAT.bat BuildPlugin -Plugin=<绝对 uplugin 路径> -Package=<新输出目录> -TargetPlatforms=Win64`。若使用 `-NoDeleteHostProject` 保留诊断工程，分发时必须排除 `HostProject/Intermediate`。`Config/FilterPlugin.ini` 已补入 `Tools/knowledge-core.mjs` 和 `Tools/package.json`，防止仅源码目录可用而 UAT 包缺少 Worker 依赖。

复现真实 UE 联调：

```powershell
node scripts/knowledge-m5-e2e.mjs '<引擎根目录，包含 Engine/>' '<UAT 打包插件目录>'
```

执行 `./scripts/package-ue-release.ps1 -PackagedPlugin '<UAT 打包插件目录>' -EngineLabel UE5.8.4-Win64` 可检查 DLL/运行时入口、排除诊断工程和 Intermediate，并在 `dist/ue/` 生成包含 `DSHUnrealBridge/` 顶层目录的 ZIP 与 SHA256。应使用与实际编译引擎匹配的标签；标签本身不验证引擎 ABI。

该脚本创建 `.test-state/M5 UE 中文 */` 临时工程，启动并结束自己创建的 UE 进程，输出 `report.json`。解包 Worker 验证将 `DSH_EMBEDDING_TEST_PACKAGE` 指向解包后的 `package`，运行 `node --test test/embedding.test.mjs test/knowledge-retrieval.test.mjs test/knowledge-snapshots.test.mjs`。正式 profile 安装前仍应完整退出 DSH，安装完成后重启加载。

本阶段没有真实 Embedding 服务用量或模型质量结论。大型工程导出/哈希性能、完整真实模型评估仍待对应工程验证；文本 PDF 页码引用、OCR 和在线 Wiki 是独立后续阶段。
