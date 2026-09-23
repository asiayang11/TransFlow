# TransFlow MVP

拖入 PDF，后端通过 PDFMathTranslate/BabelDOC 做版面分析、文本翻译和 PDF 重建；前端使用 PDF.js 将原文页与译文页并排渲染。译文不是 HTML 覆盖层，而是真实 PDF 页面，因此插图、公式、页尺寸和文本坐标能够保持对应。

## MVP 能力

- 拖拽上传 PDF，校验格式、大小、加密状态和页数；
- 上传后优先处理当前页，并在后台预取后续 4 页；切换页面会自动调整队列优先级；
- 每个翻译任务有稳定 URL：`/tasks/{task_id}?page={page}`，刷新或复制链接后可恢复；
- PDFMathTranslate/BabelDOC 保留插图、公式、表格和页面几何；
- Ark/OpenAI-compatible `base_url`、`api_key`、`model` 配置；
- 左右 PDF.js 同尺度逐页对照、页级状态与失败重试；
- 两侧同步缩放（适应宽度 / 1.5 / 2 / 3 倍），支持左右方向键翻页；等待页显示含排队的实际已用时间；
- 每页展示真实处理进度和当前阶段，100% 后才加载译文 PDF；
- DocLayout 与 OpenAI Client/Translator 进程级复用，RapidOCR 仅在页面检测到表格时按需加载；
- 原始 PDF 的首批缓存页在上传时预拆为单页输入，其余页面按需拆分；多页可并行等待 LLM，全局在途请求受控，429 重试有明确上限；
- 服务启动时预热 DocLayout 和默认中文 Translator；表格 OCR 默认关闭，仅在 `TRANSFLOW_TRANSLATE_TABLE_TEXT=true` 时按需启用；
- 页级记录队列、各阶段、LLM 请求、缓存命中、429 与 Token 指标；最新记录写入 `runtime/{task_id}/timings/page-xxxx.json`，每次执行另存 `page-xxxx-attempt-yyyy.json`，汇总写入 `summary.json`；
- 逐页译文 PDF 缓存，全部完成后合并并提供下载；
- “翻译全文”会排入剩余页面，刷新及服务重启后可继续；“停止全文预取”取消排队中的后台页面，已运行页面继续完成；
- 每个标签页具有独立阅读窗口，避免互相取消预取（闲置窗口在后续导航时按 5 分钟过期）；
- 模型请求排队优先服务当前阅读页，并按全局 QPS 平滑发出；等待超过 60 秒的后台请求会提升优先级以避免饿死。已发出的请求不会强行取消；
- 页处理最多为 `TRANSFLOW_MAX_WORKERS + 1`：额外 1 个通道仅供优先页启动，模型在途请求仍受 `TRANSFLOW_LLM_MAX_IN_FLIGHT` 限制；
- 本地 HTTP API 与持久化元数据，契约见 `docs/openapi.yaml`。

当前 MVP 只启用稳定的后端模型接入。网页端 ChatGPT 登录态没有官方、可跨站调用的浏览器 API，直接复用登录 Cookie 会受 CORS、安全策略和会话变更影响，因此未把该不可靠链路伪装成可用功能。

## 环境要求

- Node.js 20+
- Python 3.12（`pdf2zh-next` 要求 Python 3.10–3.13）
- [uv](https://docs.astral.sh/uv/)（推荐）
- macOS 首次运行约需下载 330 MB 的 BabelDOC 版面模型与字体

## 首次安装

```bash
npm install
uv venv --python 3.12 .venv-babeldoc
uv pip install --python .venv-babeldoc/bin/python -r server/requirements.txt
cp .env.example .env
```

编辑 `.env`：

```dotenv
OPENAI_API_KEY=你的密钥
OPENAI_MODEL=你的模型或 Ark endpoint ID
OPENAI_BASE_URL=https://你的-openai-compatible-host/v1

# 性能与上游保护，可按模型配额调整
TRANSFLOW_MAX_WORKERS=2
TRANSFLOW_LLM_QPS=4
TRANSFLOW_LLM_WORKERS=4
TRANSFLOW_LLM_MAX_IN_FLIGHT=4
TRANSFLOW_LLM_MAX_ATTEMPTS=3
TRANSFLOW_LLM_TIMEOUT_SECONDS=120
TRANSFLOW_TRANSLATE_TABLE_TEXT=false
```

当前项目已验证 `OPENAI_BASE_URL=https://ark-cn-beijing.bytedance.net/api/v3` 的 `chat/completions` 链路。请求不会发送 `verbosity` 字段。

## 启动

后端：

```bash
npm run backend
```

前端（另一个终端）：

```bash
npm run dev
```

打开 `http://127.0.0.1:5173`。第一次真实翻译会初始化本地模型和字体，后续任务会复用缓存。

逐页性能数据也可通过 `GET /api/v1/documents/{task_id}/timings` 查询。若要保留 BabelDOC 中间文件用于故障排查，设置 `TRANSFLOW_KEEP_JOB_FILES=true`；默认成功后清理，避免 `runtime` 持续膨胀。

## 离线界面验证

自动回归测试：`.venv-babeldoc/bin/python -m unittest discover -s server -p 'test_*.py' -v`。
前端构建与请求顺序测试：`npm run check`。实施记录和验收边界见 [优化验收记录](docs/optimization-acceptance.md)。
测试使用隔离临时目录和 Mock，不加载用户任务、不调用模型。

真实译文发布前会在独立进程中检查页数、尺寸/裁剪/旋转和可渲染性。
疑似未翻译、文字缺失、异常字符、越界或过小字号会显示“需复核”，而非声称语义质量已经合格。
重试期间保留上次成功产物，新的检查失败不会覆盖旧 PDF。

在 `.env` 中设置：

```dotenv
TRANSFLOW_LLM_MODE=mock
```

Mock 模式会运行上传、队列、逐页 PDF 和整本合并流程，但译文页只是原页副本，不会调用模型。
页面、任务状态和下载入口会明确标注“原文副本（未翻译）”；要获得译文，请使用 `.env` 中的真实模型模式重新上传。

## 许可说明

本项目当前按个人自用 MVP 集成 `pdf2zh-next`（AGPL-3.0）。若未来对外提供网络服务或商业化，需要先完成依赖许可、源码提供义务和模型服务条款评审。
