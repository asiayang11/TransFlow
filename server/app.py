#!/usr/bin/env python3
"""TransFlow MVP HTTP server backed by PDFMathTranslate/BabelDOC.

The server owns document metadata and translation scheduling. Every translated
page is a real PDF produced by BabelDOC, so figures, formulas, coordinates and
the original page geometry remain part of the PDF instead of being recreated
as an HTML overlay.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import threading
import uuid
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

try:
    from pypdf import PdfReader, PdfWriter
except ImportError as exc:  # pragma: no cover - startup guidance
    raise SystemExit(
        "缺少后端依赖。请运行：uv pip install --python .venv-babeldoc/bin/python -r server/requirements.txt"
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
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_dotenv(ROOT / ".env")

HOST = os.getenv("TRANSFLOW_HOST", "127.0.0.1")
PORT = int(os.getenv("TRANSFLOW_PORT", "8787"))
FRONTEND_ORIGIN = os.getenv("TRANSFLOW_FRONTEND_ORIGIN", "http://127.0.0.1:5173")
DATA_DIR = (ROOT / os.getenv("TRANSFLOW_DATA_DIR", "runtime")).resolve()
PREFETCH_PAGES = max(1, min(10, int(os.getenv("TRANSFLOW_PREFETCH_PAGES", "5"))))
MAX_WORKERS = max(1, min(4, int(os.getenv("TRANSFLOW_MAX_WORKERS", "2"))))
MAX_FILE_SIZE = 50 * 1024 * 1024
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
if OPENAI_API_KEY == "sk-your-key-here":
    OPENAI_API_KEY = ""
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
SOURCE_LANGUAGE = os.getenv("TRANSFLOW_SOURCE_LANGUAGE", "en")
LLM_MODE = os.getenv("TRANSFLOW_LLM_MODE", "openai").lower()
if LLM_MODE not in {"openai", "mock"}:
    raise SystemExit("TRANSFLOW_LLM_MODE 必须是 openai 或 mock。")

DATA_DIR.mkdir(parents=True, exist_ok=True)

ENGINE_VERSION = 4
LOCK = threading.RLock()
BABELDOC_LOCK = threading.Lock()
EXECUTOR = ThreadPoolExecutor(max_workers=MAX_WORKERS, thread_name_prefix="transflow")
DOCUMENTS: dict[str, dict[str, Any]] = {}


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def document_dir(document_id: str) -> Path:
    return DATA_DIR / document_id


def metadata_path(document_id: str) -> Path:
    return document_dir(document_id) / "metadata.json"


def source_text_path(document_id: str, page_number: int) -> Path:
    return document_dir(document_id) / "pages" / f"page-{page_number:04d}.txt"


def translated_page_path(document_id: str, page_number: int) -> Path:
    return document_dir(document_id) / "translated-pages" / f"page-{page_number:04d}.pdf"


def translated_document_path(document_id: str) -> Path:
    return document_dir(document_id) / "translated.pdf"


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
            engine_changed = record.get("engine_version") != ENGINE_VERSION
            record["engine_version"] = ENGINE_VERSION
            if engine_changed:
                translated_document_path(record["id"]).unlink(missing_ok=True)
            for page in record.get("pages", []):
                output = translated_page_path(record["id"], page["page_number"])
                if engine_changed or not output.exists() or page.get("status") in {"queued", "translating"}:
                    page["status"] = "pending"
                    page["error"] = None
            DOCUMENTS[record["id"]] = record
            save_document(record)
        except (OSError, ValueError, KeyError):
            continue


load_existing_documents()


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
        "translated_pdf_ready": translated_document_path(record["id"]).exists(),
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


def sanitize_error(exc: Exception) -> str:
    message = str(exc)
    if OPENAI_API_KEY:
        message = message.replace(OPENAI_API_KEY, "***")
    return message[-800:] or exc.__class__.__name__


def target_language_for_engine(language: str) -> str:
    return {"zh-CN": "zh", "zh-TW": "zh-TW"}.get(language, language)


def write_mock_page(document_id: str, page_number: int, output: Path) -> None:
    """Copy one source page for deterministic, offline UI tests."""
    reader = PdfReader(str(document_dir(document_id) / "source.pdf"))
    writer = PdfWriter()
    writer.add_page(reader.pages[page_number - 1])
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("wb") as stream:
        writer.write(stream)


async def run_pdfmathtranslate_async(
    document_id: str,
    page_number: int,
    target_language: str,
    output: Path,
) -> None:
    from babeldoc.format.pdf.high_level import async_translate as babeldoc_translate
    from pdf2zh_next import BasicSettings
    from pdf2zh_next import OpenAISettings
    from pdf2zh_next import PDFSettings
    from pdf2zh_next import SettingsModel
    from pdf2zh_next import TranslationSettings
    from pdf2zh_next import create_babeldoc_config

    job_dir = document_dir(document_id) / "jobs" / f"page-{page_number:04d}"
    job_dir.mkdir(parents=True, exist_ok=True)
    settings = SettingsModel(
        basic=BasicSettings(debug=False),
        translation=TranslationSettings(
            lang_in=SOURCE_LANGUAGE,
            lang_out=target_language_for_engine(target_language),
            output=str(job_dir),
            qps=max(1, int(os.getenv("TRANSFLOW_LLM_QPS", "2"))),
            pool_max_workers=max(1, int(os.getenv("TRANSFLOW_LLM_WORKERS", "2"))),
            no_auto_extract_glossary=True,
        ),
        pdf=PDFSettings(
            pages=str(page_number),
            no_dual=True,
            no_mono=False,
            watermark_output_mode="no_watermark",
            only_include_translated_page=True,
            translate_table_text=True,
        ),
        translate_engine_settings=OpenAISettings(
            openai_model=OPENAI_MODEL,
            openai_base_url=OPENAI_BASE_URL,
            openai_api_key=OPENAI_API_KEY,
            openai_timeout="180",
            openai_send_temprature=False,
            openai_send_reasoning_effort=False,
        ),
    )

    source_pdf = document_dir(document_id) / "source.pdf"
    settings.validate_settings()
    babeldoc_config = create_babeldoc_config(settings, source_pdf)
    mono_pdf: Path | None = None
    # Call BabelDOC directly so it runs inside our controlled worker while the
    # PDF remains a clean production artifact (debug overlays stay disabled).
    async for event in babeldoc_translate(translation_config=babeldoc_config):
        if event.get("type") == "error":
            raise RuntimeError(event.get("error") or "PDFMathTranslate 翻译失败。")
        if event.get("type") == "finish":
            result = event["translate_result"]
            if result.mono_pdf_path:
                mono_pdf = Path(result.mono_pdf_path)
            break
    if not mono_pdf or not mono_pdf.exists():
        raise RuntimeError("PDFMathTranslate 未生成单语译文 PDF。")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(".tmp.pdf")
    shutil.copyfile(mono_pdf, temporary)
    temporary.replace(output)


def merge_translated_document(document_id: str) -> bool:
    with LOCK:
        record = get_record(document_id)
        if not all(page["status"] == "ready" for page in record["pages"]):
            return False
    writer = PdfWriter()
    for page_number in range(1, record["page_count"] + 1):
        reader = PdfReader(str(translated_page_path(document_id, page_number)))
        if len(reader.pages) != 1:
            raise RuntimeError(f"第 {page_number} 页译文产物页数异常。")
        writer.add_page(reader.pages[0])
    output = translated_document_path(document_id)
    temporary = output.with_suffix(".tmp.pdf")
    with temporary.open("wb") as stream:
        writer.write(stream)
    temporary.replace(output)
    return True


def schedule_translation(document_id: str, page_number: int, *, force: bool = False) -> bool:
    with LOCK:
        record = get_record(document_id)
        page = get_page_record(record, page_number)
        if page["status"] in {"queued", "translating"}:
            return False
        if not force and page["status"] == "ready":
            return False
        page["status"] = "queued"
        page["error"] = None
        page["updated_at"] = utc_now()
        save_document(record)
    EXECUTOR.submit(translate_worker, document_id, page_number)
    return True


def translate_worker(document_id: str, page_number: int) -> None:
    output = translated_page_path(document_id, page_number)
    try:
        record = get_record(document_id)
        update_page(document_id, page_number, status="translating", error=None)
        if LLM_MODE == "mock":
            write_mock_page(document_id, page_number, output)
        else:
            if not OPENAI_API_KEY:
                raise RuntimeError("后端尚未配置 OPENAI_API_KEY。")
            # BabelDOC owns native models and caches that are not safe to initialize
            # concurrently. Its internal translation pool still issues LLM calls in parallel.
            with BABELDOC_LOCK:
                asyncio.run(
                    run_pdfmathtranslate_async(
                        document_id, page_number, record["target_language"], output
                    )
                )
        update_page(document_id, page_number, status="ready", error=None)
        merge_translated_document(document_id)
        rolling_page = page_number + PREFETCH_PAGES
        if rolling_page <= record["page_count"]:
            schedule_translation(document_id, rolling_page)
    except Exception as exc:  # Keep the executor alive and surface an actionable error.
        update_page(document_id, page_number, status="error", error=sanitize_error(exc))


def create_document(filename: str, target_language: str, body: bytes) -> dict[str, Any]:
    document_id = uuid.uuid4().hex
    directory = document_dir(document_id)
    directory.mkdir(parents=True, exist_ok=False)
    source = directory / "source.pdf"
    source.write_bytes(body)
    try:
        reader = PdfReader(str(source))
        if reader.is_encrypted:
            raise ApiError(
                HTTPStatus.UNPROCESSABLE_ENTITY,
                "PDF_ENCRYPTED",
                "暂不支持加密 PDF，请移除密码后重试。",
            )
        page_count = len(reader.pages)
        if page_count < 1:
            raise ApiError(HTTPStatus.UNPROCESSABLE_ENTITY, "PDF_EMPTY", "PDF 中没有页面。")
        (directory / "pages").mkdir(parents=True, exist_ok=True)
        pages: list[dict[str, Any]] = []
        for index, pdf_page in enumerate(reader.pages, start=1):
            try:
                text = pdf_page.extract_text() or ""
            except Exception:
                text = ""
            source_text_path(document_id, index).write_text(text, encoding="utf-8")
            pages.append(
                {"page_number": index, "status": "pending", "error": None, "updated_at": None}
            )
    except ApiError:
        shutil.rmtree(directory, ignore_errors=True)
        raise
    except Exception as exc:
        shutil.rmtree(directory, ignore_errors=True)
        raise ApiError(
            HTTPStatus.UNPROCESSABLE_ENTITY,
            "PDF_INVALID",
            "无法解析该 PDF，文件可能已损坏。",
        ) from exc

    record = {
        "id": document_id,
        "filename": filename,
        "size_bytes": len(body),
        "page_count": page_count,
        "target_language": target_language,
        "status": "active",
        "created_at": utc_now(),
        "engine_version": ENGINE_VERSION,
        "pages": pages,
    }
    with LOCK:
        DOCUMENTS[document_id] = record
        save_document(record)
    for page_number in range(1, min(page_count, PREFETCH_PAGES) + 1):
        schedule_translation(document_id, page_number)
    return record


class TransFlowHandler(BaseHTTPRequestHandler):
    server_version = "TransFlowMVP/0.2"

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

    def send_file(self, path: Path, filename: str | None = None) -> None:
        data = path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/pdf")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "private, max-age=31536000, immutable")
        if filename:
            quoted = urllib.parse.quote(filename)
            self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{quoted}")
        self.cors_headers()
        self.end_headers()
        self.wfile.write(data)

    def send_error_json(self, error: ApiError) -> None:
        self.send_json(error.status, {"error": {"code": error.code, "message": error.message}})

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
                        "engine": "PDFMathTranslate/BabelDOC",
                        "base_url_configured": bool(OPENAI_BASE_URL),
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
                self.send_json(
                    HTTPStatus.OK,
                    {
                        "page_number": page_number,
                        "status": page["status"],
                        "error": page.get("error"),
                        "updated_at": page.get("updated_at"),
                        "source_text": source_text_path(document_id, page_number).read_text(
                            encoding="utf-8"
                        ),
                        "translated_pdf_url": (
                            f"/api/v1/documents/{document_id}/pages/{page_number}/translated.pdf"
                            if page["status"] == "ready"
                            else None
                        ),
                    },
                )
                return

            match = re.fullmatch(
                r"/api/v1/documents/([a-f0-9]+)/pages/(\d+)/translated\.pdf", path
            )
            if match:
                document_id, page_raw = match.groups()
                page_number = int(page_raw)
                record = get_record(document_id)
                page = get_page_record(record, page_number)
                output = translated_page_path(document_id, page_number)
                if page["status"] != "ready" or not output.exists():
                    raise ApiError(HTTPStatus.CONFLICT, "PAGE_NOT_READY", "该页译文尚未生成。")
                self.send_file(output)
                return

            match = re.fullmatch(r"/api/v1/documents/([a-f0-9]+)/translated\.pdf", path)
            if match:
                document_id = match.group(1)
                record = get_record(document_id)
                output = translated_document_path(document_id)
                if not output.exists():
                    raise ApiError(HTTPStatus.CONFLICT, "DOCUMENT_NOT_READY", "整本译文尚未生成。")
                stem = Path(record["filename"]).stem
                self.send_file(output, f"{stem}-{record['target_language']}.pdf")
                return

            raise ApiError(HTTPStatus.NOT_FOUND, "ROUTE_NOT_FOUND", "接口不存在。")
        except ApiError as error:
            self.send_error_json(error)
        except Exception as exc:
            self.send_error_json(
                ApiError(HTTPStatus.INTERNAL_SERVER_ERROR, "INTERNAL_ERROR", sanitize_error(exc))
            )

    def do_POST(self) -> None:  # noqa: N802
        try:
            path = urllib.parse.urlparse(self.path).path
            if path == "/api/v1/documents":
                content_type = self.headers.get("Content-Type", "").split(";", 1)[0]
                if content_type != "application/pdf":
                    raise ApiError(
                        HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "PDF_REQUIRED", "请上传 PDF 文件。"
                    )
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0:
                    raise ApiError(HTTPStatus.BAD_REQUEST, "FILE_EMPTY", "PDF 文件为空。")
                if length > MAX_FILE_SIZE:
                    raise ApiError(
                        HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                        "FILE_TOO_LARGE",
                        "PDF 最大支持 50 MB。",
                    )
                body = self.rfile.read(length)
                if not body.startswith(b"%PDF-"):
                    raise ApiError(
                        HTTPStatus.UNPROCESSABLE_ENTITY, "PDF_INVALID", "文件内容不是有效 PDF。"
                    )
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
                    raise ApiError(
                        HTTPStatus.BAD_REQUEST, "PAGE_OUT_OF_RANGE", "预热起始页超出范围。"
                    )
                scheduled = []
                for page_number in range(
                    start_page, min(record["page_count"], start_page + count - 1) + 1
                ):
                    if schedule_translation(document_id, page_number):
                        scheduled.append(page_number)
                self.send_json(HTTPStatus.ACCEPTED, {"scheduled_pages": scheduled})
                return

            match = re.fullmatch(r"/api/v1/documents/([a-f0-9]+)/pages/(\d+)/translate", path)
            if match:
                document_id, page_raw = match.groups()
                page_number = int(page_raw)
                translated_page_path(document_id, page_number).unlink(missing_ok=True)
                translated_document_path(document_id).unlink(missing_ok=True)
                schedule_translation(document_id, page_number, force=True)
                self.send_json(
                    HTTPStatus.ACCEPTED, {"page_number": page_number, "status": "queued"}
                )
                return

            raise ApiError(HTTPStatus.NOT_FOUND, "ROUTE_NOT_FOUND", "接口不存在。")
        except ApiError as error:
            self.send_error_json(error)
        except (TypeError, ValueError):
            self.send_error_json(
                ApiError(HTTPStatus.BAD_REQUEST, "INVALID_REQUEST", "请求参数无效。")
            )
        except Exception as exc:
            self.send_error_json(
                ApiError(HTTPStatus.INTERNAL_SERVER_ERROR, "INTERNAL_ERROR", sanitize_error(exc))
            )


def main() -> None:
    print("TransFlow backend")
    print(f"  HTTP: http://{HOST}:{PORT}")
    print(f"  Engine: PDFMathTranslate/BabelDOC")
    print(f"  LLM mode: {LLM_MODE}")
    print(f"  Model: {OPENAI_MODEL}")
    print(f"  API key: {'configured' if OPENAI_API_KEY else 'missing'}")
    print(f"  Base URL: {'configured' if OPENAI_BASE_URL else 'missing'}")
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
