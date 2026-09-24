# TransFlow

本地运行的 PDF 翻译工作台：拖入 PDF，逐页查看原文与译文，并在翻译完成后下载译文 PDF。后端使用 [PDFMathTranslate-next（`pdf2zh-next`）](https://github.com/PDFMathTranslate-next/PDFMathTranslate-next) / BabelDOC 分析和重建页面；前端用 PDF.js 并排显示两份 PDF，而不是用 HTML 文本盖在原文上。

> 当前是个人使用的 MVP，不是托管服务。现有翻译链路调用 **OpenAI-compatible 文本接口**；它不会把页面图片传给多模态模型。版面重建和语义翻译是两件事，图文位置尽量对应不等于译文质量已得到保证。

## 已支持什么

| 能力 | 当前行为 |
| --- | --- |
| PDF 输入 | 拖拽或选择 PDF，单文件上限 50 MB；拒绝损坏、无页面或加密的文件。以可提取文本的英文 PDF 为主要适用对象。 |
| 翻译语言 | 源语言默认英语，可用 `TRANSFLOW_SOURCE_LANGUAGE` 调整；页面可选简体中文、英语、日语、韩语、法语、德语、西班牙语作为目标语言。实际效果取决于模型和字体。 |
| 逐页翻译 | 上传后优先处理第 1 页，默认预取前 5 页；翻页时提升当前页优先级，并预取随后页面。译文由 BabelDOC 输出为真实 PDF 页面。 |
| 对照阅读 | 左右同页对照、同步缩放、方向键翻页；显示页级阶段、进度、排队位置和失败重试。完成前不把原文副本当作译文展示。 |
| 任务恢复 | 每个任务有 `/tasks/{id}?page={页码}` 本地地址；刷新页面或重启后端后可读取已保存的任务与产物。 |
| 全文与下载 | 点击「翻译全文」排入剩余页面；全部完成后下载合并译文 PDF。「停止全文预取」只撤销尚未开始的后台任务，不会中断已运行页面。 |
| 质量提示 | 发布前检查 PDF 页数、几何信息、可渲染性和部分文本异常；可疑页面标为「需复核」，**不代表已完成语义校对**。重试期间保留上次成功的页面。 |
| 性能记录 | `runtime/{task_id}/timings/` 保存页级阶段、排队、模型请求和缓存指标，供定位慢页；详见 [优化验收记录](docs/optimization-acceptance.md)。 |
| HTTP API | 后端提供上传、状态、预取、重试、全文模式、PDF 下载和耗时查询；接口契约见 [OpenAPI](docs/openapi.yaml)。 |

## 快速开始

已在 macOS + Node.js 20+ + Python 3.12 上开发验证；其他系统尚未做完整验收。建议安装 [uv](https://docs.astral.sh/uv/) 管理 Python 环境。首次运行需要联网安装依赖，以及下载 BabelDOC 所需的版面模型和字体；后续启动会复用本机缓存，但进程重启仍需重新将模型载入内存。

```bash
npm ci
uv venv --python 3.12 .venv-babeldoc
uv pip install --python .venv-babeldoc/bin/python -r server/requirements.txt
cp .env.example .env
```

编辑 `.env`，至少填入模型服务的密钥、模型名和 API 根地址：

```dotenv
TRANSFLOW_LLM_MODE=openai
OPENAI_API_KEY=你的_API_Key
OPENAI_MODEL=你的模型名或 Endpoint_ID
OPENAI_BASE_URL=https://你的兼容服务地址/v1
```

`OPENAI_BASE_URL` 应是兼容服务的 API 根地址，**不要**加 `/chat/completions`。例如已验证过 `https://ark-cn-beijing.bytedance.net/api/v3` 的 `chat/completions` 链路；使用其他服务时请按其文档填写根地址。后端不会发送 `verbosity` 字段。模型需要支持兼容的 Chat Completions 文本请求；仅“配置了 Key”不等于模型一定可用。不要提交 `.env` 或在客户端代码里填写密钥。

分别在两个终端启动：

```bash
npm run backend
```

```bash
npm run dev
```

打开 [http://127.0.0.1:5173](http://127.0.0.1:5173)。后端默认监听 `127.0.0.1:8787`；可用 `http://127.0.0.1:8787/api/v1/health` 查看服务状态。修改 `.env` 后需要重启后端。

使用流程：

1. 在上传页选目标语言，把 PDF 拖入页面或点击选择文件。
2. 原文可立即阅读；译文页按队列和阶段逐页生成，完成后自动显示在右侧。若页面提示「需复核」，请人工检查漏译、图表和公式。
3. 翻页会预取附近页面。若需要整本译文，点击「翻译全文」，待全部页面完成后下载。保存任务 URL 可继续阅读。

模型请求可能产生费用；翻译所需的文本会发送到 `.env` 指定的模型服务商。原始 PDF、单页产物和任务记录保存在本机 `runtime/`，不会因为离开页面而自动删除。任务 URL **不是访问控制机制**；当前没有账户、权限或对外部署防护，请保持默认的本地监听地址。

## 配置与排障

| 配置 | 默认值 | 用途 |
| --- | --- | --- |
| `TRANSFLOW_SOURCE_LANGUAGE` | `en` | 源语言；当前页面没有自动识别或切换入口。 |
| `TRANSFLOW_PREFETCH_PAGES` | `5` | 阅读窗口的预取页数，后端限制为 1–10。 |
| `TRANSFLOW_MAX_WORKERS` | `2` | 并行处理页数；前台页可额外占用一个处理通道。 |
| `TRANSFLOW_LLM_QPS` / `TRANSFLOW_LLM_MAX_IN_FLIGHT` | `4` / `4` | 全局请求节奏和最大在途请求数，应按模型配额调整。 |
| `TRANSFLOW_LLM_MAX_ATTEMPTS` / `TRANSFLOW_LLM_TIMEOUT_SECONDS` | `3` / `120` | 模型请求重试次数和单次超时秒数。 |
| `TRANSFLOW_TRANSLATE_TABLE_TEXT` | `false` | 开启后按需加载表格 OCR；默认关闭以缩短普通页面等待。 |
| `TRANSFLOW_KEEP_JOB_FILES` | `false` | 保留 BabelDOC 中间文件以便排障；会增加磁盘占用。 |
| `TRANSFLOW_DATA_DIR` | `runtime` | 本地任务与耗时记录目录。 |

完整默认配置见 [.env.example](.env.example)。页级数据位于 `runtime/{task_id}/timings/page-xxxx.json`，单次执行记录位于 `page-xxxx-attempt-yyyy.json`，汇总位于 `summary.json`；也可调用 `GET /api/v1/documents/{task_id}/timings`。

如果右侧仍是英文，先检查页面或 `/api/v1/health` 是否标为 `mock`：Mock 只复制原文，用来验证交互，**不会翻译**。切回 `TRANSFLOW_LLM_MODE=openai`、重启后端，并重新上传生成真实任务；已有 Mock 任务不会变成译文任务。若是真实任务但提示「需复核」，应检查该页内容和模型返回，不要把 PDF 结构检查当作翻译质量保证。

本地无模型费用地验证页面流程，可在 `.env` 中设 `TRANSFLOW_LLM_MODE=mock`。测试命令：

```bash
npm run check
.venv-babeldoc/bin/python -m unittest discover -s server -p 'test_*.py' -v
```

这些自动测试不调用真实模型；真实译文的语义质量仍需用目标 PDF 人工验收。

## 尚未支持 / 后续方向

- **多模态翻译内核**：将页面图像或区域裁剪与结构化文本一起输入视觉模型，建立可验证的逐段回填协议。目前只是版面模型 + 文本 LLM，不应宣传为多模态翻译。
- **Markdown 导出**：原文/译文 Markdown、图片资源和公式的结构化导出；不计划直接从译文 PDF 反向提取为 Markdown。
- **复杂文档质量**：扫描件的可靠 OCR 路由、表格与图中文字翻译、跨页上下文与术语表、图表/公式语义校验及视觉回归。
- **产品化体验**：任务列表与删除、文本搜索/选择、持久化暂停、更完整的浏览器自动化测试和冷/热启动性能基准。
- **外部集成**：稳定的翻译能力接口及平台连接器（如闲鱼），在权限、数据隔离和配额机制完善后再开放。

不会通过读取 ChatGPT 网页 Cookie 或模拟其私有接口来复用网页订阅。未来若提供用户自带模型能力，也应基于正式 API 凭证和明确的费用/隐私边界。更多产品设想见 [PRD v0.2](docs/PRD-v0.2.md)，其中的规划项**不代表已经实现**。

## License

TransFlow 自身代码采用 [GNU Affero General Public License v3.0](LICENSE)（`AGPL-3.0-only`）。上游 `pdf2zh-next==2.8.2` 也标注为 [AGPL-3.0](https://pypi.org/project/pdf2zh-next/2.8.2/)；其他依赖仍保留各自的许可证。AGPL 不是“仅限非商业使用”许可证。若未来向他人分发或提供网络服务，应遵守适用的源码提供等义务，并核对模型服务条款。
