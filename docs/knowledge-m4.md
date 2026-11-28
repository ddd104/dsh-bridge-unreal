# Wiki / RAG M4：混合检索与图谱关联

日期：2026-11-27（北京时间）。承接 [M3 设置与云端向量](knowledge-m3.md)。

本文的评估和安装边界保留 M4 交付记录；[M5](knowledge-m5.md) 已接入已发布 UE 快照、Wiki 资产验证和干净安装验证。下述 `unverified_asset` 描述适用于未导入有效快照的查询，M4 模拟评分不追溯改写。

M4 将可选语义检索接入 DSH 的 `unreal_knowledge / project_context`，同时保留全文、源码和旧 UE 回退。只有启用 Embedding、具备凭据且目标工程存在兼容的已发布向量索引时，才发送当前问题生成查询向量。查询不重建文档索引；保存配置、打开设置和普通聊天不触发文档向量化。

## 使用与关闭

沿用 M3 的设置和手动构建操作。可用索引发布后，`project_context` 默认尝试混合检索；设置页显示可用模式及本次宿主运行的查询请求数、缓存命中和服务报告 Token。实际是否用了向量以每次结果的 `retrievalMode` 为准。

```json
{
  "tool": "project_context",
  "arguments": {
    "query": "STR 唤醒后 UDisplayLifecycle 的实现和约束在哪里？",
    "retrievalMode": "auto"
  }
}
```

`query` 限 1～4000 个 UTF-16 字符。`retrievalMode: "base"` 强制本次查询零网络；全局关闭 Embedding 或移除 Key 使查询回到基础模式。工程策略可设置 `memory.semanticRetrieval: false`，只关闭该工程的语义检索，保留基础索引。该字段不参与索引策略指纹；目录、排除规则或分块等索引策略变更仍须显式更新索引。

查询期间配置/凭据变化会取消共享请求并清空缓存；工程开关关闭后丢弃返回的语义结果。已经提交的请求可能计费。工作区、工程描述符或 UE 绑定变化时拒绝交付旧结果。

## 查询流程

1. 固定一个 `current.json` generation，全文、向量与源码图谱均读取该版本。并发构建可发布新版本，但不会改变进行中查询的版本。
2. 优先读取全文与源码图谱候选。只有没有可用证据或精确符号无法关联时，才回退源码扫描。其他知识工具保持既有路由。
3. 核对配置、凭据、向量空间、维度及索引映射，再查询缓存或调用云端 Embedding。查询输入为 NFC 规范化、首尾去空格的问题文本，不发送整段对话或工程文件。
4. 对相同 generation 的向量执行余弦搜索，与全文候选按 RRF 融合：`1 / (60 + rank)`。不直接相加 BM25 和余弦分数。精确类名、符号、路径或别名命中优先；按 chunk 去重，最多 10 个片段、每文档最多 2 个。
5. 返回前重新核对文档原文件哈希、片段和解析器版本。Wiki 的 `sources/symbols/assets` 用作图谱种子，并验证源码文件与已发布源码清单的哈希。最多 24 个节点、32 条边、32 个显式关联，扩展一跳。
6. 对整个返回值执行 Token/字符预算，优先裁剪派生导航摘要，再去除低优先级证据。保留引用整体，供 `read_chunk/read_source` 回读。

向量余弦阈值暂定 **0.35**，尚未经真实服务与工程校准。索引查询沿用 Worker 中的有界精确扫描，不依赖额外向量 DLL。小型评估中的 Worker 启动和来源校验有可见开销，不宣称速度提升或大型工程性能。

## 调用、缓存和回退

| 项目 | 行为 |
| --- | --- |
| 查询缓存 | 内存内最多 128 项、TTL 5 分钟；按工程、完整模型空间指纹、输入哈希、`plain-query-v1` 隔离 |
| 相同并发问题 | 共用一次请求；取消一个订阅者不影响其他订阅者，最后一个取消才中止请求 |
| 不同问题并发 | 最多 2 个查询向量请求；忙时直接使用基础检索 |
| 时间限制 | HTTP 为配置超时与 5 秒的较小者；语义分支 10 秒，可另有 Worker 退出开销 |
| 重试 | 查询请求不重试；服务错误后当前配置冷却 30 秒，期间使用基础检索 |
| 重启 | 不持久化查询/查询向量，不自动发请求；缓存与运行时计量重置 |
| 无配置/无 Key/无索引/空间变化 | 基础检索，零查询 Embedding 请求 |
| 401/429/超时/维度错误/向量损坏 | 返回降级原因，保留可验证的全文与源码证据 |
| 查询期间策略变化 | 拒绝旧范围结果，要求显式更新索引 |

配置/凭据变更使查询缓存和冷却失效。相同问题命中缓存仍核对凭据、索引和当前来源。`retrieval.queryEmbedding` 分别记录本次请求数、缓存命中、是否共享、服务用量和耗时；`retrieval.documentEmbeddingRequests` 恒为 0。共享请求计费量归发起者，全局总量只计一次。服务未返回的用量不推算为真实账单。

## 证据与兼容字段

保留 `memory/sources/warnings/authority` 等入口，新增：

- `retrievalMode: base | hybrid`、`degradedReasons`、`indexGeneration`、`profileFingerprint`。
- `memory.relevantDocs` 的 `documentId/chunkId/sourceHash/location/metadata`，以及 `channels/ranks/channelScores/exactMatch/sourceStatus`。`score` 为 RRF 分数，不是相关性概率。
- `graphAssociations` 的 generation、深度及 Wiki 链接。源码/符号可为 `resolved`；缺失、过期或无法读取的目标有明确状态。
- `memory.graphContext` 中经过来源验证的节点/边；源码节点带 `sourceHash/sourceStatus`。
- `retrieval` 的候选数、查询用量、来源警告、总耗时；`contextBudget` 的预算、估算、裁剪状态。

`sourceStatus: current` 只表示与当前文件字节匹配，不保证作者内容正确。Wiki `status: confirmed` 是作者标记；派生摘要统一标为 `summaryAuthority: unverified_navigation_only`，不能替代当前引用。旧文档索引无法验证的命中标为 `unverified_legacy_index`。来源已删除或改变的新版片段不会继续返回为当前证据。

资产关联统一标为 `unverified_asset`，不能从 Wiki 路径推断资产存在或实时状态。M5 将接入版本对齐的 UE 快照；当前可显式使用匹配编辑器的资产查询。无召回证据不代表目标不存在。

## 总上下文预算

| 设置 | 默认 | 范围 |
| --- | --- | --- |
| `knowledgeContextMaxTokens` | 12000 | 2048～64000 |
| `knowledgeContextMaxChars` | 24000 | 2048～128000 |

两个限制同时适用于本地、未构建及 UE 回退的 `project_context` 总序列化结果。没有当前对话模型的分词器时，使用 UTF-8 字节数作为保守 Token 上界估计，**不是实际模型输入 Token**。异常冗长元数据无法装入最小预算时返回明确的无证据降级包；不会截出虚构的引用行号。外层模型工具封装不计入这两个项目上下文限制。

## 可复现评估

运行 `npm run test:knowledge-m4`，生成 `.test-state/knowledge-m4/results.json`。同一工程、同一发布版本和同一组问题分别运行旧 `project_context`、新版强制基础模式和混合模式。保留 M0/M2 的 13 个问题，再加入 2 个改述问题；每组 15 个，其中 12 个有答案问题计入 Recall、2 个无答案问题单独统计、1 个 UE 资产图谱问题因 M5 尚未接入而排除评分。原 M0 基线文件和独立测试不变。

本次 Node 24.15.0 的确定性模拟结果：

| 指标 | 旧检索 | 新版基础检索 | 混合检索 |
| --- | ---: | ---: | ---: |
| 平均 Recall@10 | 0.8333 | 0.8333 | 1.0000 |
| 无答案问题返回空证据 | 2/2 | 2/2 | 2/2 |
| 引用哈希/来源回读通过 | 36/36 | 29/29 | 36/36 |
| 单次端到端 P50 / P95（毫秒） | 274 / 289 | 542 / 592 | 907 / 945 |
| 平均 UTF-8 Token 上界估算 | 6757 | 8302 | 9222 |
| 查询请求 / 缓存命中 | 0 / 0 | 0 / 0 | 11 / 4 |
| 查询触发文档向量请求 | 0 | 0 | 0 |

初次构建 5 个片段，文档向量请求 1 次；模拟服务报告 40 Token。查询/构建用量完整保存在 JSON。两个改述问题的向量按预设概念返回，因此表格证明链路、融合与引用行为，**不能用于宣称真实模型质量提升**。实际模型 Token、真实工程召回与性能、UE 资产快照准确性仍需对应环境评测。

## 回归与发行验证

`npm run check` 验证宿主和界面；`scripts/check-knowledge.ps1 -RunTests` 验证原 UE 知识工具；`npm run test:knowledge-baseline` 复跑原 13 题基线。`scripts/settings-runtime-check.mjs` 使用真实 DSH Loader/Settings/凭据服务，但只操作临时 profile，新增上下文预算保存/重启恢复、无索引基础模式及零查询调用检查。

`npm run package:dsh` 生成五个 JS 文件的 tgz。解包后设置 `DSH_EMBEDDING_TEST_PACKAGE` 指向 `package` 目录，运行 `node --test test/knowledge-retrieval.test.mjs test/embedding.test.mjs`，可直接验证包内知识与向量 Worker。该流程同时使用系统 Node 和已安装 DSH 的 Electron Node 运行；实际解包宿主另经隔离设置运行时检查。

最终结果：宿主 **448/448**（新增 14 项 M4 专项）、原知识工具 **59/59**、原 13 题基线及其 **20/20** 检查通过。真实 DSH 0.2.2-rc.5 的源码宿主与解包宿主均通过 **10/10** 项隔离设置检查。实际 tgz 的 Worker 在 Node **24.15.0** 和 DSH/Electron Node **24.21.0** 上分别通过 **27/27** 项 M3/M4 测试；发行包只有五个 JS 文件，无 sourcemap。保留已有发行兼容声明，不据此扩大完整安装支持矩阵。

首轮全量回归有一项本机模拟服务连接失败；独立 14 项复测和全量 448 项复跑均通过，未复现根因。M4 还修复了 M3 状态读取竞争：任务完成与异步索引读取交错时，不再将刚完成的任务和此前读取的旧索引组合返回。

未连接真实付费服务，未使用用户密钥，未修改用户 DSH profile、安装插件或重启 UE。完整安装与 UE 快照协作属于 M5；PDF/OCR 仍是独立子阶段。
