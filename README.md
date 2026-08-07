# TransFlow MVP

拖入 PDF，后端通过 PDFMathTranslate/BabelDOC 做版面分析、文本翻译和 PDF 重建；前端使用 PDF.js 将原文页与译文页并排渲染。译文不是 HTML 覆盖层，而是真实 PDF 页面，因此插图、公式、页尺寸和文本坐标能够保持对应。

## MVP 能力

- 拖拽上传 PDF，校验格式、大小、加密状态和页数；
- 上传后优先翻译前 5 页，之后滚动补齐整本；
- PDFMathTranslate/BabelDOC 保留插图、公式、表格和页面几何；
- Ark/OpenAI-compatible `base_url`、`api_key`、`model` 配置；
- 左右 PDF.js 同尺度逐页对照、页级状态与失败重试；
- 逐页译文 PDF 缓存，全部完成后合并并提供下载；
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

## 离线界面验证

在 `.env` 中设置：

```dotenv
TRANSFLOW_LLM_MODE=mock
```

Mock 模式会运行上传、队列、逐页 PDF 和整本合并流程，但译文页只是原页副本，不会调用模型。

## 许可说明

本项目当前按个人自用 MVP 集成 `pdf2zh-next`（AGPL-3.0）。若未来对外提供网络服务或商业化，需要先完成依赖许可、源码提供义务和模型服务条款评审。
