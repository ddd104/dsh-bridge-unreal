# 文本型 PDF 解析与页码引用

日期：2026-11-27（北京时间）。完成 [实施大纲](../DSH_Unreal_Wiki_RAG_Implementation_Outline.md) 中 M2 留待独立交付的 PDF 子阶段，承接 [M5](knowledge-m5.md)。

## 使用

将带文本层的 PDF 放入工程 `ProjectKnowledge/`，显式更新基础索引后，通过原有 `project_context` 检索，再用 `read_chunk/read_document` 回读引用。无需安装 Python、Poppler、OCR、额外 Node 模块或配置 API Key。未配置 Embedding 时保持全文检索；开启且显式构建向量时，提取出的文本片段按现有规则参与向量化。

默认格式列表已加入 `.pdf`。已有工程若显式设置 `sourcePolicy.includeExtensions`，需自行把 `.pdf` 加入该允许列表；不会绕过工程的目录和排除策略。更新 DSH 包即可使用宿主解析；旧 UE 路径应更新插件的 `Tools/`、`Config/Knowledge/` 和 `ThirdParty/ProjectKnowledge/`。本次没有原生 C++ 改动，不要求为 PDF 功能重新编译 DLL。

## 引用与回读

PDF 复用稳定 `documentId/chunkId/sourceHash`、`dsh_document_chunks_v2` 和现有回读参数，新增位置类型：

```json
{
  "kind": "pdf",
  "page": 4,
  "pageLabel": "2",
  "textStart": 0,
  "textEnd": 180
}
```

`page` 是从 1 开始的物理 PDF 页序号，包括空白和扫描页。`pageLabel` 仅在文件提供 PageLabels 时返回，可能为罗马数字、前缀或重新编号；它不是识别页面上印刷数字的结果，也不能替代物理页码。

`textStart/textEnd` 是该页提取文本中的 UTF-16 偏移，末端不包含。它们不是 PDF 二进制偏移或源文件行号。长页按现有字符预算切分并保留重叠，片段不跨页，不会把拆分后拼接的人工换行当成原文。回读返回的 `content` 对应同一页文本范围，引用格式可写为“文件名，第 4 页（PDF 标签 2）”。

`read_document` 仍按片段分页，默认 8、最多 20 个片段，每页正文最多 64000 字符；用 `nextOffset` 继续读取。各片段保留物理页码。`read_chunk` 接受检索返回的 `chunkId` 和可选 `expectedHash`，核对来源仍在授权范围且原文件 SHA256 未改变。修改、删除和跨工程引用按现有错误拒绝，显式更新索引后才使用新证据。

## 无文本页与错误

`metadata.pdf` 返回 `pageCount/textPageCount/noTextPages`、`extraction: text_layer`、`ocrStatus: not_performed` 和 `complete`。`complete` 只表示每页都提取到了文本，不保证复杂版面、图表或页内图片已被理解。混合 PDF 中有文字的页继续进入检索，无文本页保留物理页码但不生成虚构文字片段。

| 状态 | 行为 |
| --- | --- |
| `pdf_needs_ocr_or_blank` | 页面没有可提取文本，提示“扫描内容需要 OCR”；也可能是空白页，不能仅凭文本提取结果判定。无命中不是没有相关知识的证明 |
| `pdf_password_required` | 跳过需密码的文件，提示提供解锁副本；不收集、猜测或持久化密码 |
| `pdf_parse_failed` | 损坏或无法解码的文件被跳过，其他文档继续索引 |
| `pdf_limit_exceeded` | 超过文件、页数或字符限制，整份 PDF 跳过，不发布截断内容 |
| `pdf_timeout` | 提取超时，销毁解析任务并报告跳过 |

构建结果保留诊断，索引另保存有界的 `document-warnings.json`；查询即使没有命中也提示构建时的解析缺口。诊断带 `At index build` 前缀，是该发布代的历史信息，修复文件后需显式重建。只含扫描图片的文档可以有文档记录而没有任何可检索片段。OCR 不属于本阶段，不会自动调用收费识别服务。

## 实现与边界

固定 PDF.js **6.5.438**，配套 DOMMatrix shim **3.1.4**；API、内部消息处理器、Adobe 中文 CMaps 与标准字体数据都进入自包含解析器和宿主 Knowledge Worker。文本读取按需加载，运行时不取网络资源，不解析工程侧可执行模块，不依赖 native canvas DLL。构建适配只去掉 PDF.js 的可选 canvas 初始化探测；第三方许可证随 UE 工具及 DSH 发布包保留。

限制：单原文件 64 MiB、最多 500 页、单页 100 万 UTF-16 字符、全文件 800 万字符。文档异步提取设 30 秒超时；同步 CPU 工作还受宿主外层 Worker 的任务超时与取消控制。按 PDF 文本内容顺序提取并保留显式换行，不重建多栏阅读顺序、表格结构、数学公式或图片语义；无法正确映射文字的特殊字体仍可能需要人工查看原页。

解析版本升级为 `wiki-documents-3-pdf`，现有片段和向量不能静默贴上新解析版本。旧索引提示显式更新基础索引；如需向量，再按原有手动流程生成。打开工程、保存设置、普通查询都不触发重建或收费文档向量化。

## 验证

仓库自有样本覆盖中文/英文、五页物理页码、不同 PageLabels、真正空白页、图片扫描页、旋转页、长页、密码保护和损坏文件；生成脚本为 `scripts/generate-pdf-fixtures.py`，测试直接使用已提交的 PDF，不依赖 Python。已渲染查看中文与长文本样本，并逐片段核对页内偏移。

- 宿主 `npm run check`：456/456，包括新增 2 项 PDF 集成测试。
- `scripts/check-knowledge.ps1 -RunTests`：63/63，包括新增 4 项解析/索引/回读测试。
- 原 13 题基线继续通过。
- 实际 tgz 解包后的 M3/M4/M5/PDF 共 35 项，在 Node 22.23.5、24.15.0 和 DSH/Electron Node 24.21.0 上分别 35/35 通过。
- 隔离 DSH profile 经官方安装后，真实 Loader/设置/凭据检查 10/10；最终、已测试和已安装的五个 JS bundle 哈希一致。UE 打包目录没有 `node_modules`，中文文本和物理页码仍可正确提取。
- 独立复制的 Knowledge Worker 在禁止 fetch、HTTP(S)、TCP 的环境完成 PDF 构建、检索和两种回读，网络尝试数为 0。
- 模拟 Embedding 验证仅发送提取文本、混合结果保留页码、未变化内容再次构建不新增文档向量请求；不代表真实服务的召回质量或账单。

分发包仍只有五个 JS 入口，无运行时 PDF 外部依赖。DSH 包为 `dist/dsh/dsh-unreal-bridge-0.6.5.tgz`；UE Win64 ZIP 复用 M5 已验证的原生 DLL，更新本阶段的工具、默认格式策略和许可证。本阶段验证 JavaScript 解析链路，没有再次启动 UE 或使用用户现有 profile。
