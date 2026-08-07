#!/usr/bin/env python3
"""TransFlow MVP HTTP server.

Uses only the Python standard library plus pypdf. PDF pages are rendered through
Poppler's pdftoppm binary and translated through the OpenAI Responses API.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

try:
    from pypdf import PdfReader
except ImportError as exc:  # pragma: no cover - startup guidance
    raise SystemExit(
        "Missing dependency 'pypdf'. Run: python3 -m pip install -r server/requirements.txt"
    ) from exc


ROOT = Path(__file__).resolve().parents[1]


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


load_dotenv(ROOT / ".env")

HOST = os.getenv("TRANSFLOW_HOST", "127.0.0.1")
PORT = int(os.getenv("TRANSFLOW_PORT", "8787"))
FRONTEND_ORIGIN = os.getenv("TRANSFLOW_FRONTEND_ORIGIN", "http://127.0.0.1:5173")
DATA_DIR = (ROOT / os.getenv("TRANSFLOW_DATA_DIR", "runtime")).resolve()
PREFETCH_PAGES = max(1, min(10, int(os.getenv("TRANSFLOW_PREFETCH_PAGES", "5"))))
MAX_WORKERS = max(1, min(8, int(os.getenv("TRANSFLOW_MAX_WORKERS", "2"))))
MAX_FILE_SIZE = 50 * 1024 * 1024
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
if OPENAI_API_KEY == "sk-your-key-here":
    OPENAI_API_KEY = ""
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-5.6-luna")
OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
LLM_MODE = os.getenv("TRANSFLOW_LLM_MODE", "openai").lower()
if LLM_MODE not in {"openai", "mock"}:
    raise SystemExit("TRANSFLOW_LLM_MODE must be either 'openai' or 'mock'.")
PDFTOPPM = os.getenv("PDFTOPPM_PATH") or shutil.which("pdftoppm")

DATA_DIR.mkdir(parents=True, exist_ok=True)

LOCK = threading.RLock()
EXECUTOR = ThreadPoolExecutor(max_workers=MAX_WORKERS, thread_name_prefix="transflow")
DOCUMENTS: dict[str, dict[str, Any]] = {}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def document_dir(document_id: str) -> Path:
    return DATA_DIR / document_id


def metadata_path(document_id: str) -> Path:
    return document_dir(document_id) / "metadata.json"


def save_document(record: dict[str, Any]) -> None:
    path = metadata_path(record["id"])
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def load_existing_documents() -> None:
    for path in DATA_DIR.glob("*/metadata.json"):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
            for page in record.get("pages", []):
                if page.get("status") in {"queued", "translating"}:
                    page["status"] = "pending"
                    page["error"] = None
            DOCUMENTS[record["id"]] = record
            save_document(record)
        except (OSError, ValueError, KeyError):
            continue


load_existing_documents()


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def public_document(record: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": record["id"],
        "filename": record["filename"],
        "size_bytes": record["size_bytes"],
        "page_count": record["page_count"],
        "target_language": record["target_language"],
        "status": record["status"],
        "created_at": record["created_at"],
        "prefetch_pages": PREFETCH_PAGES,
        "pages": [
            {
                "page_number": page["page_number"],
                "status": page["status"],
                "error": page.get("error"),
                "updated_at": page.get("updated_at"),
            }
            for page in record["pages"]
        ],
    }


def get_record(document_id: str) -> dict[str, Any]:
    with LOCK:
        record = DOCUMENTS.get(document_id)
        if not record:
            raise ApiError(HTTPStatus.NOT_FOUND, "DOCUMENT_NOT_FOUND", "文档不存在或已删除。")
        return record


def get_page_record(record: dict[str, Any], page_number: int) -> dict[str, Any]:
    if page_number < 1 or page_number > record["page_count"]:
        raise ApiError(HTTPStatus.NOT_FOUND, "PAGE_NOT_FOUND", "页码超出文档范围。")
    return record["pages"][page_number - 1]


def update_page(document_id: str, page_number: int, **updates: Any) -> None:
    with LOCK:
        record = get_record(document_id)
        page = get_page_record(record, page_number)
        page.update(updates)
        page["updated_at"] = utc_now()
        save_document(record)


def preview_path(document_id: str, page_number: int) -> Path:
    return document_dir(document_id) / "previews" / f"page-{page_number:04d}.png"


def source_text_path(document_id: str, page_number: int) -> Path:
    return document_dir(document_id) / "pages" / f"page-{page_number:04d}.txt"


def translation_path(document_id: str, page_number: int) -> Path:
    return document_dir(document_id) / "translations" / f"page-{page_number:04d}.json"


def ensure_preview(document_id: str, page_number: int) -> Path:
    output = preview_path(document_id, page_number)
    if output.exists():
        return output
    if not PDFTOPPM:
        raise RuntimeError("未找到 pdftoppm。请安装 Poppler，或设置 PDFTOPPM_PATH。")

    output.parent.mkdir(parents=True, exist_ok=True)
    prefix = output.with_suffix("")
    command = [
        PDFTOPPM,
        "-f",
        str(page_number),
        "-l",
        str(page_number),
        "-singlefile",
        "-png",
        "-r",
        "110",
        str(document_dir(document_id) / "source.pdf"),
        str(prefix),
    ]
    render_env = os.environ.copy()
    # Codex's bundled Poppler is relocatable, while its fontconfig file can still
    # contain build-machine paths. Point it at the relocated config and a local
    # writable cache. Normal system Poppler installations do not need this.
    poppler_dependency_root = Path(PDFTOPPM).resolve().parents[2]
    bundled_fonts = poppler_dependency_root / "native/poppler/poppler/etc/fonts"
    if bundled_fonts.exists():
        font_cache = DATA_DIR / ".fontconfig-cache"
        font_cache.mkdir(parents=True, exist_ok=True)
        render_env["FONTCONFIG_FILE"] = str(bundled_fonts / "fonts.conf")
        render_env["FONTCONFIG_PATH"] = str(bundled_fonts)
        render_env["XDG_CACHE_HOME"] = str(font_cache)
    result = subprocess.run(
        command,
        capture_output=True,
        text=True,
        timeout=90,
        check=False,
        env=render_env,
    )
    if result.returncode != 0 or not output.exists():
        detail = (result.stderr or result.stdout or "unknown render error").strip()[-500:]
        raise RuntimeError(f"PDF 页面渲染失败：{detail}")
    return output


def extract_response_text(payload: dict[str, Any]) -> str:
    if isinstance(payload.get("output_text"), str):
        return payload["output_text"]
    chunks: list[str] = []
    for item in payload.get("output", []):
        if item.get("type") != "message":
            continue
        for content in item.get("content", []):
            if content.get("type") == "output_text" and content.get("text"):
                chunks.append(content["text"])
    return "".join(chunks).strip()


def call_openai(document_id: str, page_number: int, target_language: str, source_text: str, image: Path) -> tuple[str, dict[str, Any]]:
    if LLM_MODE == "mock":
        time.sleep(0.35)
        body = source_text.strip() or "（该页没有可提取文字；真实模型会从页面图像中读取内容。）"
        return f"【演示译文 · {target_language} · 第 {page_number} 页】\n\n{body}", {"mock": 1}
    if not OPENAI_API_KEY:
        raise RuntimeError("后端尚未配置 OPENAI_API_KEY。请复制 .env.example 为 .env 并填写密钥。")

    image_data = base64.b64encode(image.read_bytes()).decode("ascii")
    prompt = (
        "Translate one PDF page into " + target_language + ". "
        "Use the page image as visual context to recover reading order, headings, captions, tables, "
        "and text that extraction may have missed. Preserve formulas, numbers, citations, URLs, and line breaks. "
        "Return only JSON matching the requested schema. Do not summarize or explain.\n\n"
        "Extracted page text:\n" + (source_text.strip() or "[No extractable text; read the page image]")
    )
    schema = {
        "type": "object",
        "properties": {"translation": {"type": "string"}},
        "required": ["translation"],
        "additionalProperties": False,
    }
    request_payload = {
        "model": OPENAI_MODEL,
        "store": False,
        "reasoning": {"effort": "low"},
        "input": [
            {
                "role": "user",
                "content": [
                    {"type": "input_text", "text": prompt},
                    {
                        "type": "input_image",
                        "image_url": f"data:image/png;base64,{image_data}",
                        "detail": "low",
                    },
                ],
            }
        ],
        "text": {
            "format": {
                "type": "json_schema",
                "name": "page_translation",
                "strict": True,
                "schema": schema,
            },
            "verbosity": "low",
        },
        "safety_identifier": hashlib.sha256(f"transflow-local-{document_id}".encode()).hexdigest()[:32],
    }
    request = urllib.request.Request(
        f"{OPENAI_BASE_URL}/responses",
        data=json.dumps(request_payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {OPENAI_API_KEY}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            response_payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            message = json.loads(raw).get("error", {}).get("message", raw)
        except ValueError:
            message = raw
        raise RuntimeError(f"OpenAI API 返回 {exc.code}：{str(message)[:500]}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"无法连接 OpenAI API：{exc.reason}") from exc

    output_text = extract_response_text(response_payload)
    if not output_text:
        raise RuntimeError("模型返回了空结果。")
    try:
        parsed = json.loads(output_text)
        translation = parsed["translation"].strip()
    except (ValueError, KeyError, AttributeError) as exc:
        raise RuntimeError("模型结果不符合翻译 JSON Schema。") from exc
    if not translation:
        raise RuntimeError("模型返回了空译文。")
    return translation, response_payload.get("usage") or {}


def translate_worker(document_id: str, page_number: int) -> None:
    try:
        record = get_record(document_id)
        page = get_page_record(record, page_number)
        if page["status"] == "ready":
            return
        update_page(document_id, page_number, status="translating", error=None)
        image = ensure_preview(document_id, page_number)
        source_text = source_text_path(document_id, page_number).read_text(encoding="utf-8")
        translation, usage = call_openai(
            document_id,
            page_number,
            record["target_language"],
            source_text,
            image,
        )
        output = translation_path(document_id, page_number)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(
            json.dumps({"translated_text": translation, "usage": usage}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        update_page(document_id, page_number, status="ready", error=None)
    except Exception as exc:  # Keep the worker alive; expose an actionable page error.
        update_page(document_id, page_number, status="error", error=str(exc)[:800])


def schedule_translation(document_id: str, page_number: int, *, force: bool = False) -> bool:
    with LOCK:
        record = get_record(document_id)
        page = get_page_record(record, page_number)
        if not force and page["status"] in {"queued", "translating", "ready"}:
            return False
        page["status"] = "queued"
        page["error"] = None
        page["updated_at"] = utc_now()
        save_document(record)
    EXECUTOR.submit(translate_worker, document_id, page_number)
    return True


def create_document(filename: str, target_language: str, body: bytes) -> dict[str, Any]:
    document_id = uuid.uuid4().hex
    directory = document_dir(document_id)
    directory.mkdir(parents=True, exist_ok=False)
    source = directory / "source.pdf"
    source.write_bytes(body)
    try:
        reader = PdfReader(str(source))
        if reader.is_encrypted:
            raise ApiError(HTTPStatus.UNPROCESSABLE_ENTITY, "PDF_ENCRYPTED", "暂不支持加密 PDF，请移除密码后重试。")
        page_count = len(reader.pages)
        if page_count < 1:
            raise ApiError(HTTPStatus.UNPROCESSABLE_ENTITY, "PDF_EMPTY", "PDF 中没有可读取的页面。")
        pages_dir = directory / "pages"
        pages_dir.mkdir(parents=True, exist_ok=True)
        pages: list[dict[str, Any]] = []
        for index, pdf_page in enumerate(reader.pages, start=1):
            try:
                text = pdf_page.extract_text() or ""
            except Exception:
                text = ""
            source_text_path(document_id, index).write_text(text, encoding="utf-8")
            pages.append(
                {
                    "page_number": index,
                    "status": "pending",
                    "error": None,
                    "updated_at": None,
                }
            )
    except ApiError:
        shutil.rmtree(directory, ignore_errors=True)
        raise
    except Exception as exc:
        shutil.rmtree(directory, ignore_errors=True)
        raise ApiError(HTTPStatus.UNPROCESSABLE_ENTITY, "PDF_INVALID", "无法解析该 PDF，文件可能已损坏。") from exc

    record = {
        "id": document_id,
        "filename": filename,
        "size_bytes": len(body),
        "page_count": page_count,
        "target_language": target_language,
        "status": "active",
        "created_at": utc_now(),
        "pages": pages,
    }
    with LOCK:
        DOCUMENTS[document_id] = record
        save_document(record)
    for page_number in range(1, min(page_count, PREFETCH_PAGES) + 1):
        schedule_translation(document_id, page_number)
    return record


class TransFlowHandler(BaseHTTPRequestHandler):
    server_version = "TransFlowMVP/0.1"

    def log_message(self, format_string: str, *args: Any) -> None:
        print(f"[{self.log_date_time_string()}] {format_string % args}")

    def cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", FRONTEND_ORIGIN)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header(
            "Access-Control-Allow-Headers",
            "Content-Type, X-Filename, X-Target-Language",
        )
        self.send_header("Vary", "Origin")

    def send_json(self, status: int, payload: Any) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.cors_headers()
        self.end_headers()
        self.wfile.write(data)

    def send_error_json(self, error: ApiError) -> None:
        self.send_json(
            error.status,
            {"error": {"code": error.code, "message": error.message}},
        )

    def read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except ValueError as exc:
            raise ApiError(HTTPStatus.BAD_REQUEST, "INVALID_JSON", "请求 JSON 格式无效。") from exc

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(HTTPStatus.NO_CONTENT)
        self.cors_headers()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        try:
            path = urllib.parse.urlparse(self.path).path
            if path == "/api/v1/health":
                self.send_json(
                    HTTPStatus.OK,
                    {
                        "status": "ok",
                        "llm_mode": LLM_MODE,
                        "llm_configured": LLM_MODE == "mock" or bool(OPENAI_API_KEY),
                        "model": OPENAI_MODEL,
                        "prefetch_pages": PREFETCH_PAGES,
                    },
                )
                return

            match = re.fullmatch(r"/api/v1/documents/([a-f0-9]+)", path)
            if match:
                self.send_json(HTTPStatus.OK, public_document(get_record(match.group(1))))
                return

            match = re.fullmatch(r"/api/v1/documents/([a-f0-9]+)/pages/(\d+)", path)
            if match:
                document_id, page_raw = match.groups()
                page_number = int(page_raw)
                record = get_record(document_id)
                page = get_page_record(record, page_number)
                translated_text = None
                usage = None
                output = translation_path(document_id, page_number)
                if output.exists():
                    result = json.loads(output.read_text(encoding="utf-8"))
                    translated_text = result.get("translated_text")
                    usage = result.get("usage")
                self.send_json(
                    HTTPStatus.OK,
                    {
                        "page_number": page_number,
                        "status": page["status"],
                        "error": page.get("error"),
                        "updated_at": page.get("updated_at"),
                        "source_text": source_text_path(document_id, page_number).read_text(encoding="utf-8"),
                        "translated_text": translated_text,
                        "usage": usage,
                    },
                )
                return

            match = re.fullmatch(r"/api/v1/documents/([a-f0-9]+)/pages/(\d+)/preview", path)
            if match:
                document_id, page_raw = match.groups()
                page_number = int(page_raw)
                record = get_record(document_id)
                get_page_record(record, page_number)
                image = ensure_preview(document_id, page_number)
                data = image.read_bytes()
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "image/png")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "private, max-age=3600")
                self.cors_headers()
                self.end_headers()
                self.wfile.write(data)
                return

            raise ApiError(HTTPStatus.NOT_FOUND, "ROUTE_NOT_FOUND", "接口不存在。")
        except ApiError as error:
            self.send_error_json(error)
        except Exception as exc:
            self.send_error_json(ApiError(HTTPStatus.INTERNAL_SERVER_ERROR, "INTERNAL_ERROR", str(exc)[:500]))

    def do_POST(self) -> None:  # noqa: N802
        try:
            path = urllib.parse.urlparse(self.path).path
            if path == "/api/v1/documents":
                content_type = self.headers.get("Content-Type", "").split(";", 1)[0]
                if content_type != "application/pdf":
                    raise ApiError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "PDF_REQUIRED", "请上传 application/pdf 文件。")
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0:
                    raise ApiError(HTTPStatus.BAD_REQUEST, "FILE_EMPTY", "PDF 文件为空。")
                if length > MAX_FILE_SIZE:
                    raise ApiError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "FILE_TOO_LARGE", "PDF 最大支持 50 MB。")
                body = self.rfile.read(length)
                if not body.startswith(b"%PDF-"):
                    raise ApiError(HTTPStatus.UNPROCESSABLE_ENTITY, "PDF_INVALID", "文件内容不是有效 PDF。")
                filename = urllib.parse.unquote(self.headers.get("X-Filename", "document.pdf"))
                filename = Path(filename).name[:180] or "document.pdf"
                target_language = self.headers.get("X-Target-Language", "zh-CN")[:20]
                record = create_document(filename, target_language, body)
                self.send_json(HTTPStatus.CREATED, public_document(record))
                return

            match = re.fullmatch(r"/api/v1/documents/([a-f0-9]+)/prefetch", path)
            if match:
                document_id = match.group(1)
                payload = self.read_json()
                record = get_record(document_id)
                start_page = int(payload.get("start_page", 1))
                count = max(1, min(10, int(payload.get("count", PREFETCH_PAGES))))
                if start_page < 1 or start_page > record["page_count"]:
                    raise ApiError(HTTPStatus.BAD_REQUEST, "PAGE_OUT_OF_RANGE", "预热起始页超出范围。")
                scheduled = []
                for page_number in range(start_page, min(record["page_count"], start_page + count - 1) + 1):
                    if schedule_translation(document_id, page_number):
                        scheduled.append(page_number)
                self.send_json(HTTPStatus.ACCEPTED, {"scheduled_pages": scheduled})
                return

            match = re.fullmatch(r"/api/v1/documents/([a-f0-9]+)/pages/(\d+)/translate", path)
            if match:
                document_id, page_raw = match.groups()
                page_number = int(page_raw)
                output = translation_path(document_id, page_number)
                output.unlink(missing_ok=True)
                schedule_translation(document_id, page_number, force=True)
                self.send_json(HTTPStatus.ACCEPTED, {"page_number": page_number, "status": "queued"})
                return

            raise ApiError(HTTPStatus.NOT_FOUND, "ROUTE_NOT_FOUND", "接口不存在。")
        except ApiError as error:
            self.send_error_json(error)
        except (TypeError, ValueError):
            self.send_error_json(ApiError(HTTPStatus.BAD_REQUEST, "INVALID_REQUEST", "请求参数无效。"))
        except Exception as exc:
            self.send_error_json(ApiError(HTTPStatus.INTERNAL_SERVER_ERROR, "INTERNAL_ERROR", str(exc)[:500]))


def main() -> None:
    print("TransFlow backend")
    print(f"  HTTP: http://{HOST}:{PORT}")
    print(f"  LLM mode: {LLM_MODE}")
    print(f"  Model: {OPENAI_MODEL}")
    print(f"  API key: {'configured' if OPENAI_API_KEY else 'missing'}")
    print(f"  PDF renderer: {PDFTOPPM or 'missing'}")
    server = ThreadingHTTPServer((HOST, PORT), TransFlowHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        EXECUTOR.shutdown(wait=False, cancel_futures=True)


if __name__ == "__main__":
    main()
