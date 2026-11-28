# Wiki / RAG M2：Wiki 与文档基础

日期：2026-11-27（北京时间）。对应实现大纲第 13 节 M2，承接 [M1 本地知识服务](knowledge-m1.md)。

M2 增加稳定文档身份、Wiki 元数据与链接、结构化片段、中文全文检索和原文回读。基础构建与查询不调用 Embedding。本文保留 M2 的交付记录；后续已完成独立的 [文本型 PDF 与页码引用](knowledge-pdf.md)，OCR 仍未实现。

## Wiki 页面

当前版本统一从工程 `ProjectKnowledge/` 读取知识资料。此前放在其他目录的 Markdown 如需参与知识索引，请移入该目录后手动更新索引；插件不自动搬动文件。可选 YAML frontmatter 示例：

```markdown
---
id: display-wake
title: 显示恢复流程
type: system
status: draft
aliases: [STR, 唤醒, 恢复显示]
tags: [车辆, 显示]
sources: [Source/Vehicle/DisplayLifecycle.cpp]
symbols: [UDisplayLifecycle]
assets: [/Game/UI/WBP_PowerStatus.WBP_PowerStatus]
relatedPages: [display-overview]
---
# 显示恢复流程
参见 [设计约束](../architecture/architecture_rules.md#显示)。
```

`id/title/type/status` 为非空字符串；其余字段为字符串数组。状态支持 `draft`（默认）、`confirmed`、`deprecated`。frontmatter 最多 64 KiB，数组每项最多 2048 字符、每字段最多 128 项；拒绝重复键、YAML alias 展开和错误类型。解析失败的文档被跳过并返回 warning；重复显式页面 ID 会使构建失败，保留宿主已发布版本。

普通 Markdown 行内链接及完整/折叠 reference 链接按页面目录解析，`sources` 相对工程根，`relatedPages` 支持显式页面 ID 或相对路径。验证结果保存在 `metadata.references`：`resolved`、`missing`、`missing_anchor`、`outside_project`、`invalid`、`unindexed_page`、`external` 或 `unverified`。外部 URL 不联网检查；`symbols/assets` 仍标为待图谱/UE 核实，具体关联属于 M4/M5。暂不支持双链语法或完整 CommonMark 渲染。

`metadata.status` 是作者声明；`sourceStatus: current` 仅表示来源字节仍与索引一致，不能据此确认运行行为。

## 身份、分块与引用

| 对象 | 行为 |
| --- | --- |
| 文档 ID | 项目工作副本真实路径 + 显式 Wiki ID；无显式 ID 时使用项目相对路径。编辑内容不换 ID；显式 ID 可跨页面重命名保留。不同路径同内容文件不冲突，不同工作副本隔离 |
| 来源版本 | `sourceHash` 为原文件字节 SHA-256，与文档 ID 分开 |
| 片段 ID | 文档 ID、解析/分块版本、标题路径、片段文本哈希及重复出现序号；保留独立 `chunkHash` |
| Markdown | 标题层级、段落、代码块、列表、小表格；原始行号和 UTF-16 字符偏移，含 BOM/CRLF |
| JSON / Proto / 其他文本 | 引用原始文本范围；解析器的格式化摘要不冒充原始行号 |
| DOCX | `word/document.xml` 中从 1 开始的段落序号，包含空段落；拆分长段落时给出段内字符范围；不读取页眉页脚等其他部件 |
| XLS / XLSX | 工作表名、真实行号与单元格范围；保留空单元格位置，首个非空行作为表头，必要时重复并附 `headerRange` |

沿用 `memory.chunking.targetChars`（默认 1800）与 `overlapChars`（默认 180），新增可选 `maxChars`（默认 target 的两倍）。target 范围 32～32000，overlap 小于 target，max 范围 target～64000。小结构尽量完整；超长结构有界拆分，保留原始位置和重叠。宽表头超过复制预算时只保留表头位置，避免重复文字撑破预算。字符预算按 JS UTF-16 单位计，拆分不截断代理对；模型 Token 预算仍属于后续检索阶段。

单个原文件上限 64 MiB；DOCX 正文解压上限 32 MiB；单工作表提取最多 200 万个声明范围内单元格。超过限制会返回明确 warning，不静默作为空内容。

## 检索与回读

`project_context.memory.relevantDocs` 返回片段级 `documentId`、`chunkId`、`sourceHash`、`chunkHash`、`headingPath`、`location`、元数据和原文摘录。SQLite FTS5 保留英文词项、符号和资产路径，另建中文单字/双字辅助词项，支持连续中文内部的短词与长子串匹配。完整查询命中优先于部分词命中；取消文档目录固定加分；每文档最多返回两个片段。摘录限 900 字符，不拼接不相邻的命中。

宿主能力 `dsh_document_chunks_v2` 在项目发现与 state 返回，原 `dsh_local_knowledge_v1` 能力保留。通过同一 `unreal_knowledge` 入口调用：

```json
{"tool":"read_chunk","arguments":{"chunkId":"<检索返回的 chunkId>","expectedHash":"<sourceHash>"}}
```

```json
{"tool":"read_document","arguments":{"documentId":"<检索返回的 documentId>","expectedHash":"<sourceHash>","offset":0,"maxChunks":8}}
```

回读只接受索引 ID，不接受任意文件路径。`read_chunk` 返回原文 `content` 与结构定位；`read_document` 返回连续分页片段、`totalChunks` 和 `nextOffset`。每页默认 8、最多 20 片段，正文合计最多 64000 字符；用返回的 `nextOffset` 继续读取。

查询和回读校验来源仍在工程与已配置知识目录内、未被符号链接替换、仍存在且哈希一致。变化/删除文档从新索引查询结果中过滤并返回 warning；回读分别报 `source_changed` / `source_missing`。跨工程 ID 不可读取。每次查询按文档去重校验哈希。

两个新工具只在 DSH 本地执行，`backend: editor`、缺少本地工程或基础索引时返回明确错误，运行错误也不会转发给旧 UE。旧 UE 原有工具目录与 C++ 协议未变。

## 索引升级与发布

新索引保存 `documents.jsonl`、`chunks.jsonl`、SQLite 文档/片段表，以及 manifest 中的 `documentIndexVersion: 2`、解析器版本和分块策略指纹。内容或解析/分块版本变化时不复用旧解析结果，删除文档时移除片段。

旧全文库保持只读查询兼容，返回 `index_upgrade_required` 提示；不提供新版片段回读或 `sourceStatus: current`。显式调用 `unreal_knowledge_build` 发布新版索引后即可使用回读。查询不隐式升级数据库。

宿主仍按 M1 全量构建新 generation 并原子发布，支持进度、取消和失败保留旧版本；底层 `updateMemory` 可复用未变解析结果，但 SQLite 全文库仍整体重建。M2 不宣称实现向量缓存或 SQLite 行级增量。

## 验证与交付边界

执行 `npm run check`、`scripts/check-knowledge.ps1 -RunTests`、`npm run package:dsh`，并用实际 tgz 中的独立 Worker 做隔离验证。M2 用例覆盖身份、链接、结构定位、Unicode、中文检索、分页、陈旧与跨工程拒绝、版本失效、旧索引兼容及宿主工具路由；保留 M0 全部 13 个问题与预期来源，将中文子串与重复 ID 两个缺口改为正向断言。

测试在 Windows Node 24.15.0 上进行。实际 Worker 拦截网络并验证构建、查询和两种回读均为零网络调用。YAML 与办公文档解析器随包分发，预编译工具不依赖 `node_modules`。

验收结果：宿主全量测试 **415/415** 通过；知识工具 **59/59** 通过（ProjectGraph 5、ProjectMemorySystem 21、Worker 33，含 M2 专项 11）。移走 Tools 构建依赖后，预编译工具检查与测试仍通过。M0 固定问题集 **13/13** 通过，有相关来源的 11 题平均 Recall@10 为 **1.0**（历史基线 10/11），两题无答案均不误报命中；这只是合成样本指标。打包成功，实际 tgz 解包的独立 Worker 已通过 XLS/Proto/Wiki 解析、中文别名检索与片段回读验证。

未运行真实 DSH/UE 安装联调，也未安装或重启用户插件。PDF/OCR、云端向量、图谱自动关联和 UE 快照迁移仍按后续阶段交付。
