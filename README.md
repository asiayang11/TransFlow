# TransFlow

TransFlow 是本地双语阅读工作台。打开公开网页或上传 PDF，即可在同一窗口对照原文和译文。网页翻译与 PDF 翻译使用独立后端，可以按需启动。

## 网页翻译

- 打开公开网址，按段落生成译文。两侧保留网页结构，支持滚动联动、同步缩放、常见页面交互、全屏阅读和阅读位置恢复。
- 自动识别上下文中的专名，只追加复核有歧义的候选。确认保留的名称由后端按原文回填。模型遗漏行内节点或占位符时，只对受影响的段落自动恢复，原有链接、代码和独立标点继续保留。
- 通过「定位未译段落」查找未完成内容，也可以查看原文、逐段重试。全屏下点击「提示」会列出失败段落的错误码和原因。最终失败记录写入 `runtime/web/translation-errors.jsonl`。
- 源站返回 HTTP 404 或 410 的图片、字体和样式会单独提示。「重试资源」用于暂时加载失败的资源。

网页模式面向公开文章和技术文档。登录页面、复杂表单、图内文字和视频翻译尚未支持。内置示例位于 `/web/demo`，技术边界和验收见 [网页 MVP 说明](docs/web-mvp.md)、[兼容性验收](docs/web-p0-review.md)及[阅读功能验收](docs/web-p1-review.md)。

## PDF 翻译

上传 PDF 后逐页对照阅读，完成后可下载译文 PDF。后端用 [PDFMathTranslate-next](https://github.com/PDFMathTranslate-next/PDFMathTranslate-next) 和 BabelDOC 分析及重建版面，前端用 PDF.js 并排显示原文和译文。

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

项目在 macOS 上用 Node.js 20+ 验证，PDF 后端另用 Python 3.12。首次安装时运行以下命令，已有 `.env` 时直接编辑它。

```bash
npm ci
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

在一个终端启动前端：

```bash
npm run dev
```

**使用网页翻译**时，安装 Chromium，再在另一个终端启动网页后端。网页模式只需 Node.js 和 Chromium。

```bash
npm run web:install
npm run web:backend
```

打开[网页翻译工作台](http://127.0.0.1:5173/web)，输入公开网址、选择目标语言，点击「打开并翻译」。后端默认端口为 `8788`，在 [网页健康检查](http://127.0.0.1:8788/api/web/health) 查看服务状态。

**使用 PDF 翻译**时，建议通过 [uv](https://docs.astral.sh/uv/) 安装 Python 依赖，然后启动 PDF 后端。初次运行会下载版面模型和字体，后续启动复用本机缓存。

```bash
uv venv --python 3.12 .venv-babeldoc
uv pip install --python .venv-babeldoc/bin/python -r server/requirements.txt
npm run backend
```

打开 [PDF 翻译工作台](http://127.0.0.1:5173/pdf)。后端默认端口为 `8787`，在 [PDF 健康检查](http://127.0.0.1:8787/api/v1/health) 查看服务状态。

1. 在首页选择「PDF 翻译」，在上传页选目标语言，把 PDF 拖入页面或点击选择文件。
2. 原文可立即阅读；译文页按队列和阶段逐页生成，完成后自动显示在右侧。若页面提示「需复核」，请人工检查漏译、图表和公式。
3. 翻页会预取附近页面。若需要整本译文，点击「翻译全文」，待全部页面完成后下载。保存任务 URL 可继续阅读。

两个后端可以同时运行，工作台首页为 [127.0.0.1:5173](http://127.0.0.1:5173)。修改 `.env` 或拉取服务端更新后，重启对应后端。网页会话在后端重启后需重新打开网址。

翻译所需的文本会发送到 `.env` 指定的模型服务商，可能产生费用。原始 PDF、单页产物和任务记录保存在本机 `runtime/`。项目面向本地个人使用，默认只在本机监听。

## 配置与排障

| 网页配置 | 默认值 | 用途 |
| --- | --- | --- |
| `TRANSFLOW_WEB_AUTO_TERMS` | `true` | 按网页上下文自动识别专名，并批量复核歧义项。 |
| `TRANSFLOW_WEB_KEEP_TERMS` | `[]` | 追加明确保留原文的名称，如 `["MyProject"]`。 |
| `TRANSFLOW_WEB_THINKING` | `disabled` | 方舟模型的思考模式，设为 `default` 使用模型默认配置。 |

| 配置 | 默认值 | 用途 |
| --- | --- | --- |
| `TRANSFLOW_SOURCE_LANGUAGE` | `en` | 源语言；当前页面没有自动识别或切换入口。 |
| `TRANSFLOW_PREFETCH_PAGES` | `5` | 阅读窗口的预取页数，后端限制为 1–10。 |
| `TRANSFLOW_MAX_WORKERS` | `2` | 并行处理页数；前台页可额外占用一个处理通道。 |
| `TRANSFLOW_LLM_QPS` / `TRANSFLOW_LLM_MAX_IN_FLIGHT` | `4` / `4` | 全局请求节奏和最大在途请求数，应按模型配额调整。 |
| `TRANSFLOW_LLM_MAX_ATTEMPTS` / `TRANSFLOW_LLM_TIMEOUT_SECONDS` | `3` / `120` | 单次翻译调用的限流尝试上限，以及等待请求名额和模型网络操作的超时秒数。超时的 PDF 页会显示失败并可重试。 |
| `TRANSFLOW_PDF_THINKING` | `disabled` | PDF 翻译调用方舟时关闭深度思考。设为 `default` 使用模型默认配置。 |
| `TRANSFLOW_TRANSLATE_TABLE_TEXT` | `false` | 开启后按需加载表格 OCR；默认关闭以缩短普通页面等待。 |
| `TRANSFLOW_KEEP_JOB_FILES` | `false` | 保留 BabelDOC 中间文件以便排障；会增加磁盘占用。 |
| `TRANSFLOW_DATA_DIR` | `runtime` | PDF 任务、耗时记录和网页翻译诊断目录。 |

完整默认配置见 [.env.example](.env.example)。页级数据位于 `runtime/{task_id}/timings/page-xxxx.json`，单次执行记录位于 `page-xxxx-attempt-yyyy.json`，汇总位于 `summary.json`；也可调用 `GET /api/v1/documents/{task_id}/timings`。

如果右侧仍是英文，先检查页面或 `/api/v1/health` 是否标为 `mock`：Mock 只复制原文，用来验证交互，**不会翻译**。切回 `TRANSFLOW_LLM_MODE=openai`、重启后端，并重新上传生成真实任务；已有 Mock 任务不会变成译文任务。若是真实任务但提示「需复核」，应检查该页内容和模型返回，不要把 PDF 结构检查当作翻译质量保证。

本地无模型费用地验证 PDF 流程，可在 `.env` 中设 `TRANSFLOW_LLM_MODE=mock`。网页交互示例可直接使用 `/web/demo`，网页真实翻译需要模型配置。

## 测试

```bash
npm run check
npm run test:web
.venv-babeldoc/bin/python -m unittest discover -s server -p 'test_*.py' -v
```

`npm run test:web` 需要先安装 Chromium。上述测试使用本地测试数据和模型替身。另有 `npm run check:web:live` 可测试真实站点，会请求已配置的模型服务。

## 尚未支持 / 后续方向

- **多模态翻译内核**：将页面图像或区域裁剪与结构化文本一起输入视觉模型，建立可验证的逐段回填协议。目前只是版面模型 + 文本 LLM，不应宣传为多模态翻译。
- **Markdown 导出**：原文/译文 Markdown、图片资源和公式的结构化导出；不计划直接从译文 PDF 反向提取为 Markdown。
- **复杂文档质量**：扫描件的可靠 OCR 路由、表格与图中文字翻译、跨页上下文与术语表、图表/公式语义校验及视觉回归。
- **产品化体验**：任务列表与删除、文本搜索/选择、持久化暂停、更完整的浏览器自动化测试和冷/热启动性能基准。
- **外部集成**：稳定的翻译能力接口及平台连接器（如闲鱼），在权限、数据隔离和配额机制完善后再开放。

不会通过读取 ChatGPT 网页 Cookie 或模拟其私有接口来复用网页订阅。未来若提供用户自带模型能力，也应基于正式 API 凭证和明确的费用/隐私边界。更多产品设想见 [PRD v0.2](docs/PRD-v0.2.md)，其中的规划项**不代表已经实现**。

## License

TransFlow 自身代码采用 [GNU Affero General Public License v3.0](LICENSE)（`AGPL-3.0-only`）。上游 `pdf2zh-next==2.8.2` 也标注为 [AGPL-3.0](https://pypi.org/project/pdf2zh-next/2.8.2/)；其他依赖仍保留各自的许可证。AGPL 不是“仅限非商业使用”许可证。若未来向他人分发或提供网络服务，应遵守适用的源码提供等义务，并核对模型服务条款。
