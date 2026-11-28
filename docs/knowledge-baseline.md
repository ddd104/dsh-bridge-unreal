# Wiki / RAG M0：基线与回归样本

日期：2026-11-27（北京时间）。对应实现大纲第 13 节的首个阶段 **M0**。

本文保留 M0 交付时的历史基线。后续 [M1](knowledge-m1.md) 已接入宿主离线服务，[M2](knowledge-m2.md) 已修复中文子串与重复内容 ID 两项缺陷。当前问题集版本为 2，保留全部问题 ID、查询与相关来源，旧缺口已改为正向断言；报告阶段为 M2。下文旧路由说明和 10/11 指标用于历史比较。

## 当前无 Embedding 流程

DSH 对话的 `unreal_knowledge` 经 `bridge.knowledge` 发送 `knowledge_call` 给该会话绑定的 UE 编辑器。编辑器将文档、源码与图谱查询交给知识 Worker；资产实时检查由编辑器处理。回答继续由当前对话模型完成。

| 当前条件 | 实际行为 |
| --- | --- |
| 无 Embedding 配置、已有基础索引 | 文档全文检索 + 源码搜索 + ProjectGraph + `project_context`，无需 Embedding API Key |
| 基础索引缺失 | `project_status` 返回 `missing / needsUpdate`；`project_context` 保留当前源码证据、`memory: null` 和更新提示；`graph_query` 返回 `cache_identity_mismatch` |
| 用户更新知识库 | `project_update` 显式构建全文与图谱；当前仍为全量重建 |
| 普通查询 | 不重建全文库，不改变已发布 generation；`project_search` 会扫描当前文本文件 |
| 未绑定 / 绑定编辑器断开 | DSH 入口分别返回 `NOT_BOUND` / `DISCONNECTED`，目前尚无 DSH 离线知识服务 |
| 旧编辑器缺少能力 | 返回 `KNOWLEDGE_UNAVAILABLE` |
| 只读模式 | 仍允许知识查询；不要求写入批准 |
| 来源变化 | 当前源码搜索读取新内容；`validate_evidence` 标记变化；旧哈希回读返回 `source_changed` |
| 未命中 | 返回缺失证据提示，不能据此认定工程没有该功能 |

Worker 可以在本地临时工程中独立测试，不代表当前 DSH 对外入口已经支持无 UE 查询。工作区与绑定编辑器一致性的统一校验属于后续 M1；本阶段只固定已有的会话路由及本地副本隔离行为。

## 固定问题集

数据位于 `unreal/DSHUnrealBridge/Tools/test/fixtures/knowledge-baseline/`，包括 Markdown、CSV、JSON、C++ 解析样本和模拟资产注册表。全部为合成测试资料，不读取用户工程、真实凭据或生产资产。

`questions.json` 的 `question` 保存可供后续模型评测使用的问题，`query` 是本轮直接输入检索器的词，`route` 指定检索入口，`relevantPaths` 是人工标注的相关来源。不能仅因返回了任意内容就判定成功。

| 样本 | 数量 | 验证内容 |
| --- | --- | --- |
| 中文 | 3 | 完整中文句子、全文子串漏召回、源码子串补充 |
| 精确符号 | 2 | `UDisplayLifecycle` 的源码与真实构建图谱定位 |
| 文档 | 3 | Markdown 约束、CSV 信号周期、JSON 配置 |
| 资产 | 2 | 完整资产引用的文档命中和图谱定位 |
| 中英文混合 | 1 | `project_context` 同时包含来源、文档及代码入口 |
| 无答案 | 2 | 全文空结果、上下文不把缺失证据当否定结论 |

图谱返回资产包路径 `/Game/UI/WBP_PowerStatus`，查询输入仍使用完整对象路径 `/Game/UI/WBP_PowerStatus.WBP_PowerStatus`；预期值遵循现有返回协议。

另有场景检查：缺少索引时不隐式构建、查询不重写索引、中文与空格目录、相同工程描述符的两个工作副本互不串数据、原文行号与 SHA-256 回读、陈旧证据拒绝、同内容文档 ID 冲突、无配置零网络请求。

## 已知缺口不是功能通过

| 缺口 | M0 固定的观察结果 | 后续目标 |
| --- | --- | --- |
| 连续中文子串 | 文档包含“车辆休眠唤醒流程需要重新绑定显示窗口”，全文查询“唤醒”未命中；源码搜索可以命中 | M2 改善中文全文检索 |
| 同内容多路径文档 | 两份内容相同的文件生成相同 ID，插入 SQLite 触发主键冲突 | M2 分离来源身份与内容哈希 |

测试将缺口标为 `known-gap`，保存理想相关来源和当前实际结果。缺口检查通过仅表示问题可复现。后续修复时要更新该条基线、移除缺口标记，并保留原来的问题与理想预期，不能简单删掉样本。

重复 ID 的失败在独立内存数据库中复现，不破坏已经发布的测试索引。测试会在 `finally` 中关闭数据库，并核对已发布索引未变化。

## 运行与报告

在仓库根目录执行：

```powershell
npm run test:knowledge-baseline
node --test test/knowledge-baseline.test.mjs test/knowledge-contract.test.mjs
```

Windows 自动使用随 UE 插件交付的 Node 24.15.0 运行知识库测试，验证交付的 `dist` 与实际 Worker；不要求安装 Tools 的开发依赖。非 Windows 使用当前 Node，需自行满足知识工具的 Node / SQLite 要求，本轮没有验证其他平台。

结果写入 `.test-state/knowledge-baseline/results.json`，包含样本版本、运行时版本、查询渠道、返回路径、Recall@10、耗时、已知缺口、来源回读检查与网络请求计数。文件仅在本地作为派生报告；以命令退出码判断整体是否通过，报告中的单条结果不替代测试退出码。

`Recall@10` 按返回的前 10 项去重后计算，每条有答案的问题等权取平均，包含中文漏召回样本；无答案问题独立检查，不以 0 纳入召回率。当前合成样本为 **10/11 ≈ 0.9091**，两条无答案问题均无目标命中，源码引用检查 **2/2**。这些指标不代表真实工程质量或模型回答准确率；各路耗时仅作同环境参考，不设机器相关的固定速度阈值。

基线测试拦截 `fetch`、HTTP(S) 与 TCP 连接并统计调用尝试，即使调用方吞掉网络错误也会失败。没有执行云端 Embedding 或 DeepSeek 调用；不测模型输入 Token、模型答案或付费用量。

`npm test` / `npm run check` 已纳入 M0 基线。嵌套启动测试器时清除父进程的 `NODE_TEST_CONTEXT`，并验证子进程确实执行了问题集，防止 Node 跳过递归测试后仍返回成功。

完整知识工具自检：

```powershell
./scripts/check-knowledge.ps1 -PluginRoot ./unreal/DSHUnrealBridge -RunTests
```

使用显式 `PluginRoot` 可避开部分 Windows PowerShell 环境中默认参数求值时 `PSScriptRoot` 为空的问题。

## 本次验证范围

- M0 Worker 基线：20/20 通过（包含父测试和已知缺口复现）。
- 全部知识工具：ProjectGraph 5/5、ProjectMemorySystem 21/21、Worker 22/22 通过；固定 Node 文件校验通过。
- 宿主基线及跨语言知识工具目录契约：3/3 通过。宿主路由使用模拟传输，验证未绑定、断开、能力缺失、两个会话路由及只读模式。
- DSH 构建通过。完整 `npm run check` 已尝试，但未全通过：当前受限环境阻止本机连接（`EACCES`）和部分符号链接创建（`EPERM`），相关网络发现用例也出现后续断言失败。不能将完整宿主回归标为通过。
- 未启动真实 UE 编辑器，未执行蓝图编译、真实资产检查或 DeepSeek 回答评测。M0 无 UE C++ 和业务检索逻辑改动，不需要重编 UE DLL。
