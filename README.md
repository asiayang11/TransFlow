# TransFlow MVP

拖入 PDF，后端解析元数据并以页面图像 + 页面文字调用多模态模型；前端提供逐页左右对照阅读，并默认缓存连续 5 页译文。

## 已实现

- PDF 拖拽上传与文件校验；
- 页数和逐页文字提取；
- 前端原文 PDF 渲染；
- 页面图像 + 文字的 OpenAI Responses API 翻译；
- 上传后自动预热前 5 页，翻页后继续预热当前页起 5 页；
- 逐页任务状态、失败原因和单页重试；
- 本地持久化元数据、页面预览和翻译缓存；
- OpenAPI 契约：`docs/openapi.yaml`。

## 环境要求

- Node.js 20+
- Python 3.11+
- Poppler（提供 `pdftoppm`）
- OpenAI API Key

macOS 安装 Poppler：

```bash
brew install poppler
```

## 首次安装

```bash
npm install
python3 -m venv .venv
.venv/bin/pip install -r server/requirements.txt
cp .env.example .env
```

编辑 `.env`，填入：

```dotenv
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5.6-luna
```

## 启动

终端 1：

```bash
npm run backend
```

终端 2：

```bash
npm run dev
```

浏览器打开 `http://127.0.0.1:5173`。

## 无 API Key 演示

将 `.env` 中的模式改为：

```dotenv
TRANSFLOW_LLM_MODE=mock
```

Mock 模式会完整运行上传、5 页预热、状态和对比界面，但不会产生真实译文或模型费用。
