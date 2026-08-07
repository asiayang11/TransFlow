#!/usr/bin/env python3
"""TransFlow MVP HTTP server backed by PDFMathTranslate/BabelDOC.

The server owns document metadata and translation scheduling. Every translated
page is a real PDF produced by BabelDOC, so figures, formulas, coordinates and
the original page geometry remain part of the PDF instead of being recreated
as an HTML overlay.
"""

from __future__ import annotations

import asyncio
import heapq
import json
import os
import re
import shutil
import threading
import time
import uuid
import urllib.parse
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
DOCUMENTS: dict[str, dict[str, Any]] = {}

FOREGROUND_PRIORITY = 0
PREFETCH_PRIORITY = 100
SCHEDULER_WORKERS = MAX_WORKERS if LLM_MODE == "mock" else 1

ACTIVE_PAGE_STATUSES = {
    "queued",
    "preparing",
    "analyzing",
    "translating",
    "typesetting",
    "generating",
    "validating",
}

# BabelDOC reports exact internal stage progress. These ranges turn those
# events into a stable, user-facing page lifecycle. The final 3% is reserved
# for validating and atomically publishing the generated PDF.
BABELDOC_STAGE_MAP: dict[str, tuple[str, str, int, int]] = {
    "Parse PDF and Create Intermediate Representation": (
        "analyzing", "正在解析 PDF", 5, 15
    ),
    "DetectScannedFile": ("analyzing", "正在检测扫描页面", 15, 18),
    "Parse Page Layout": ("analyzing", "正在识别页面版面", 18, 31),
    "Parse Table": ("analyzing", "正在识别表格与 OCR", 31, 34),
    "Parse Paragraphs": ("analyzing", "正在识别文本段落", 34, 39),
    "Parse Formulas and Styles": ("analyzing", "正在识别公式与样式", 39, 45),
    "Automatic Term Extraction": ("analyzing", "正在提取页面术语", 45, 48),
    "Translate Paragraphs": ("translating", "正在翻译文本", 45, 80),
    "Typesetting": ("typesetting", "正在重建译文版面", 80, 88),
    "Add Fonts": ("typesetting", "正在匹配译文字体", 88, 90),
    "Generate drawing instructions": ("generating", "正在生成 PDF 绘图指令", 90, 93),
    "Subset font": ("generating", "正在嵌入字体", 93, 95),
    "Save PDF": ("generating", "正在保存译文 PDF", 95, 97),
}


class PageTelemetry:
    """Thread-safe timings for one page translation run."""

    def __init__(self, queued_at: str | None):
        self.started = time.monotonic()
        self.stage_started = self.started
        self.stage_name = "worker"
        self.lock = threading.Lock()
        self.stage_durations_ms: dict[str, int] = {}
        self.values: dict[str, Any] = {
            "queue_wait_ms": self._queue_wait_ms(queued_at),
            "total_ms": 0,
            "stage_durations_ms": self.stage_durations_ms,
            "llm_logical_requests": 0,
            "llm_cache_hits": 0,
            "llm_request_attempts": 0,
            "llm_rate_limit_errors": 0,
            "llm_error_count": 0,
            "llm_latency_ms_total": 0,
            "llm_latency_ms_max": 0,
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "layout_model_reused": False,
            "layout_model_load_ms": 0,
            "translator_reused": False,
            "translator_create_ms": 0,
            "table_ocr_used": False,
            "table_model_reused": False,
            "table_model_load_ms": 0,
        }

    @staticmethod
    def _queue_wait_ms(queued_at: str | None) -> int:
        if not queued_at:
            return 0
        try:
            queued = datetime.fromisoformat(queued_at)
            return max(0, round((datetime.now(timezone.utc) - queued).total_seconds() * 1000))
        except ValueError:
            return 0

    def transition(self, name: str) -> dict[str, Any]:
        with self.lock:
            now = time.monotonic()
            elapsed = round((now - self.stage_started) * 1000)
            self.stage_durations_ms[self.stage_name] = (
                self.stage_durations_ms.get(self.stage_name, 0) + elapsed
            )
            self.stage_name = name
            self.stage_started = now
            return self._snapshot_locked(now)

    def record_llm_attempt(self, elapsed_ms: int, error: Exception | None) -> None:
        with self.lock:
            self.values["llm_request_attempts"] += 1
            self.values["llm_latency_ms_total"] += elapsed_ms
            self.values["llm_latency_ms_max"] = max(
                self.values["llm_latency_ms_max"], elapsed_ms
            )
            if error:
                self.values["llm_error_count"] += 1
                if error.__class__.__name__ == "RateLimitError" or getattr(
                    error, "status_code", None
                ) == 429:
                    self.values["llm_rate_limit_errors"] += 1

    def set_values(self, **values: Any) -> None:
        with self.lock:
            self.values.update(values)

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            return self._snapshot_locked(time.monotonic())

    def finish(self, name: str) -> dict[str, Any]:
        snapshot = self.transition(name)
        snapshot["total_ms"] = round((time.monotonic() - self.started) * 1000)
        return snapshot

    def _snapshot_locked(self, now: float) -> dict[str, Any]:
        values = dict(self.values)
        durations = dict(self.stage_durations_ms)
        durations[self.stage_name] = durations.get(self.stage_name, 0) + round(
            (now - self.stage_started) * 1000
        )
        values["stage_durations_ms"] = durations
        values["total_ms"] = round((now - self.started) * 1000)
        return values


class EngineRuntime:
    """Owns expensive native models for the lifetime of the HTTP process."""

    def __init__(self):
        self.lock = threading.Lock()
        self.layout_model: Any | None = None
        self.table_model: Any | None = None
        self.translators: dict[tuple[str, ...], Any] = {}
        self.layout_load_ms = 0
        self.table_load_ms = 0

    def get_layout_model(self) -> tuple[Any, bool, int]:
        with self.lock:
            if self.layout_model is not None:
                return self.layout_model, True, 0
            started = time.monotonic()
            from babeldoc.docvision.base_doclayout import DocLayoutModel

            self.layout_model = DocLayoutModel.load_available()
            self.layout_load_ms = round((time.monotonic() - started) * 1000)
            return self.layout_model, False, self.layout_load_ms

    def get_table_model(self) -> tuple[Any, bool, int]:
        with self.lock:
            if self.table_model is not None:
                return self.table_model, True, 0
            started = time.monotonic()
            from babeldoc.docvision.table_detection.rapidocr import RapidOCRModel

            self.table_model = RapidOCRModel()
            self.table_load_ms = round((time.monotonic() - started) * 1000)
            return self.table_model, False, self.table_load_ms

    def get_translator(self, settings: Any) -> tuple[Any, bool, int]:
        engine = settings.translate_engine_settings
        key = (
            settings.translation.lang_in,
            settings.translation.lang_out,
            str(engine.openai_model),
            str(engine.openai_base_url),
            str(settings.translation.qps),
            str(engine.openai_api_key)[-8:],
        )
        with self.lock:
            if key in self.translators:
                return self.translators[key], True, 0
            started = time.monotonic()
            from pdf2zh_next.translator.rate_limiter.qps_rate_limiter import QPSRateLimiter
            from pdf2zh_next.translator.translator_impl.openai import OpenAITranslator

            translator = OpenAITranslator(
                settings,
                QPSRateLimiter(settings.translation.qps),
            )
            create_ms = round((time.monotonic() - started) * 1000)
            self.translators[key] = translator
            return translator, False, create_ms

    def status(self) -> dict[str, Any]:
        with self.lock:
            return {
                "layout_model_ready": self.layout_model is not None,
                "layout_model_load_ms": self.layout_load_ms,
                "table_model_ready": self.table_model is not None,
                "table_model_load_ms": self.table_load_ms,
                "translator_count": len(self.translators),
            }


ENGINE_RUNTIME = EngineRuntime()


class LazyTableModel:
    """Load RapidOCR only if DocLayout actually found a table on this page."""

    def __init__(self, telemetry: PageTelemetry):
        self.telemetry = telemetry

    def handle_document(self, pages, *args, **kwargs):
        pages = list(pages)
        if not pages:
            return
        model, reused, load_ms = ENGINE_RUNTIME.get_table_model()
        self.telemetry.set_values(
            table_ocr_used=True,
            table_model_reused=reused,
            table_model_load_ms=load_ms,
        )
        yield from model.handle_document(pages, *args, **kwargs)


class PriorityTranslationScheduler:
    """Small priority queue with reprioritization and prefetch cancellation."""

    def __init__(self, worker_count: int):
        self.worker_count = worker_count
        self.condition = threading.Condition()
        self.heap: list[tuple[int, int, str, int]] = []
        self.entries: dict[tuple[str, int], tuple[int, int]] = {}
        self.sequence = 0
        self.stopped = False
        self.threads = [
            threading.Thread(
                target=self._run,
                name=f"transflow-priority-{index + 1}",
                daemon=True,
            )
            for index in range(worker_count)
        ]
        for thread in self.threads:
            thread.start()

    def submit(self, document_id: str, page_number: int, priority: int) -> bool:
        key = (document_id, page_number)
        with self.condition:
            existing = self.entries.get(key)
            if existing and priority >= existing[0]:
                return False
            self.sequence += 1
            version = self.sequence
            self.entries[key] = (priority, version)
            heapq.heappush(self.heap, (priority, version, document_id, page_number))
            self.condition.notify()
            return True

    def cancel_prefetch_except(
        self, document_id: str, keep_pages: set[int]
    ) -> list[int]:
        cancelled: list[int] = []
        with self.condition:
            for key, (_priority, _version) in list(self.entries.items()):
                queued_document, page_number = key
                if (
                    queued_document == document_id
                    and page_number not in keep_pages
                ):
                    del self.entries[key]
                    cancelled.append(page_number)
            self.condition.notify_all()
        return cancelled

    def snapshot(self) -> list[tuple[str, int, int]]:
        with self.condition:
            ordered = sorted(
                (priority, version, document_id, page_number)
                for (document_id, page_number), (priority, version) in self.entries.items()
            )
        return [
            (document_id, page_number, priority)
            for priority, _version, document_id, page_number in ordered
        ]

    def shutdown(self) -> None:
        with self.condition:
            self.stopped = True
            self.condition.notify_all()
        for thread in self.threads:
            thread.join(timeout=2)

    def _run(self) -> None:
        while True:
            with self.condition:
                while not self.heap and not self.stopped:
                    self.condition.wait()
                if self.stopped:
                    return
                priority, version, document_id, page_number = heapq.heappop(self.heap)
                key = (document_id, page_number)
                if self.entries.get(key) != (priority, version):
                    continue
                del self.entries[key]
            refresh_queue_metadata()
            translate_worker(document_id, page_number)


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def default_metrics() -> dict[str, Any]:
    return {
        "queue_wait_ms": 0,
        "total_ms": 0,
        "stage_durations_ms": {},
        "llm_logical_requests": 0,
        "llm_cache_hits": 0,
        "llm_request_attempts": 0,
        "llm_rate_limit_errors": 0,
        "llm_error_count": 0,
        "llm_latency_ms_total": 0,
        "llm_latency_ms_max": 0,
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "layout_model_reused": False,
        "layout_model_load_ms": 0,
        "translator_reused": False,
        "translator_create_ms": 0,
        "table_ocr_used": False,
        "table_model_reused": False,
        "table_model_load_ms": 0,
    }


def page_preflight(text: str) -> dict[str, Any]:
    text_character_count = len(re.sub(r"\s+", "", text))
    return {
        "text_character_count": text_character_count,
        "native_text": text_character_count >= 20,
    }


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
                if engine_changed or not output.exists() or page.get("status") in ACTIVE_PAGE_STATUSES:
                    page.update(
                        status="pending",
                        progress=0,
                        stage="pending",
                        stage_label="等待调度",
                        stage_current=0,
                        stage_total=0,
                        queue_position=None,
                        queue_total=0,
                        queued_at=None,
                        started_at=None,
                        error=None,
                    )
                if page["status"] == "ready":
                    page.update(
                        progress=100,
                        stage="ready",
                        stage_label="翻译完成",
                        stage_current=1,
                        stage_total=1,
                    )
                else:
                    page.setdefault("progress", 0)
                    page.setdefault("stage", page["status"])
                    page.setdefault("stage_label", "等待调度")
                    page.setdefault("stage_current", 0)
                    page.setdefault("stage_total", 0)
                page.setdefault("queue_position", None)
                page.setdefault("queue_total", 0)
                page.setdefault("queued_at", None)
                page.setdefault("started_at", None)
                page.setdefault("finished_at", None)
                page.setdefault("priority", None)
                page.setdefault("metrics", default_metrics())
                if "preflight" not in page:
                    text_path = source_text_path(record["id"], page["page_number"])
                    text = text_path.read_text(encoding="utf-8") if text_path.exists() else ""
                    page["preflight"] = page_preflight(text)
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


def page_summary(page: dict[str, Any]) -> dict[str, Any]:
    return {
        "page_number": page["page_number"],
        "status": page["status"],
        "error": page.get("error"),
        "updated_at": page.get("updated_at"),
        "progress": int(page.get("progress", 0)),
        "stage": page.get("stage", page["status"]),
        "stage_label": page.get("stage_label", "等待调度"),
        "stage_current": int(page.get("stage_current", 0)),
        "stage_total": int(page.get("stage_total", 0)),
        "queue_position": page.get("queue_position"),
        "queue_total": int(page.get("queue_total", 0)),
        "queued_at": page.get("queued_at"),
        "started_at": page.get("started_at"),
        "finished_at": page.get("finished_at"),
        "metrics": page.get("metrics", default_metrics()),
        "preflight": page.get(
            "preflight", {"native_text": False, "text_character_count": 0}
        ),
    }


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
        "pages": [page_summary(page) for page in record["pages"]],
    }


def sanitize_error(exc: Exception) -> str:
    message = str(exc)
    if OPENAI_API_KEY:
        message = message.replace(OPENAI_API_KEY, "***")
    return message[-800:] or exc.__class__.__name__


def target_language_for_engine(language: str) -> str:
    return {"zh-CN": "zh", "zh-TW": "zh-TW"}.get(language, language)


def map_babeldoc_progress(event: dict[str, Any]) -> dict[str, Any] | None:
    """Map a BabelDOC progress event to a monotonic page progress update."""
    if event.get("type") not in {"progress_start", "progress_update", "progress_end"}:
        return None
    raw_stage = str(event.get("stage", ""))
    stage_progress = float(event.get("stage_progress", 0) or 0)
    if event.get("type") == "progress_end":
        stage_progress = 100.0
    stage_progress = max(0.0, min(100.0, stage_progress))
    mapped = BABELDOC_STAGE_MAP.get(raw_stage)
    if mapped:
        status, label, start, end = mapped
        progress = round(start + (end - start) * stage_progress / 100)
    else:
        status = "analyzing"
        label = raw_stage or "正在分析页面"
        overall = max(0.0, min(100.0, float(event.get("overall_progress", 0) or 0)))
        progress = round(5 + overall * 0.92)
    return {
        "status": status,
        "stage": status,
        "stage_label": label,
        "progress": min(97, progress),
        "stage_current": int(event.get("stage_current", 0) or 0),
        "stage_total": int(event.get("stage_total", 0) or 0),
        "error": None,
    }


def write_mock_page(document_id: str, page_number: int, output: Path) -> None:
    """Copy one source page for deterministic, offline UI tests."""
    reader = PdfReader(str(document_dir(document_id) / "source.pdf"))
    writer = PdfWriter()
    writer.add_page(reader.pages[page_number - 1])
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("wb") as stream:
        writer.write(stream)


def instrument_translator(translator: Any, telemetry: PageTelemetry) -> None:
    """Measure physical OpenAI attempts, including attempts hidden by retries."""
    translator._transflow_telemetry = telemetry
    if getattr(translator, "_transflow_instrumented", False):
        return
    completions = getattr(getattr(translator, "client", None), "chat", None)
    completions = getattr(completions, "completions", None)
    create = getattr(completions, "create", None)
    if not create:
        return

    def measured_create(*args: Any, **kwargs: Any):
        started = time.monotonic()
        error: Exception | None = None
        try:
            return create(*args, **kwargs)
        except Exception as exc:
            error = exc
            raise
        finally:
            active_telemetry = getattr(translator, "_transflow_telemetry", None)
            if active_telemetry:
                active_telemetry.record_llm_attempt(
                    round((time.monotonic() - started) * 1000), error
                )

    completions.create = measured_create
    translator._transflow_instrumented = True


def translator_counters(translator: Any) -> dict[str, int]:
    def atomic_value(name: str) -> int:
        value = getattr(translator, name, 0)
        return int(getattr(value, "value", value) or 0)

    return {
        "llm_logical_requests": int(getattr(translator, "translate_call_count", 0) or 0),
        "llm_cache_hits": int(getattr(translator, "translate_cache_call_count", 0) or 0),
        "prompt_tokens": atomic_value("prompt_token_count"),
        "completion_tokens": atomic_value("completion_token_count"),
    }


def collect_translator_metrics(
    translator: Any, telemetry: PageTelemetry, baseline: dict[str, int]
) -> None:
    current = translator_counters(translator)
    telemetry.set_values(
        **{
            key: max(0, value - baseline.get(key, 0))
            for key, value in current.items()
        }
    )


async def run_pdfmathtranslate_async(
    document_id: str,
    page_number: int,
    target_language: str,
    output: Path,
    telemetry: PageTelemetry,
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
    record = get_record(document_id)
    page = get_page_record(record, page_number)
    preflight = page.get("preflight", {"native_text": False})
    llm_qps = max(1, int(os.getenv("TRANSFLOW_LLM_QPS", "2")))
    llm_workers = max(1, int(os.getenv("TRANSFLOW_LLM_WORKERS", "2")))
    settings = SettingsModel(
        basic=BasicSettings(debug=False),
        translation=TranslationSettings(
            lang_in=SOURCE_LANGUAGE,
            lang_out=target_language_for_engine(target_language),
            output=str(job_dir),
            qps=llm_qps,
            pool_max_workers=llm_workers,
            term_qps=llm_qps,
            term_pool_max_workers=llm_workers,
            no_auto_extract_glossary=True,
        ),
        pdf=PDFSettings(
            pages=str(page_number),
            no_dual=True,
            no_mono=False,
            watermark_output_mode="no_watermark",
            only_include_translated_page=True,
            translate_table_text=False,
            skip_scanned_detection=bool(preflight.get("native_text")),
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

    update_page(
        document_id,
        page_number,
        status="preparing",
        stage="preparing",
        stage_label="正在准备版面模型",
        progress=1,
        stage_current=0,
        stage_total=1,
        started_at=page.get("started_at") or utc_now(),
        queue_position=None,
        queue_total=0,
        metrics=telemetry.transition("准备版面模型"),
        error=None,
    )
    source_pdf = document_dir(document_id) / "source.pdf"
    settings.validate_settings()
    layout_model, layout_reused, layout_load_ms = ENGINE_RUNTIME.get_layout_model()
    translator, translator_reused, translator_create_ms = ENGINE_RUNTIME.get_translator(
        settings
    )
    telemetry.set_values(
        layout_model_reused=layout_reused,
        layout_model_load_ms=layout_load_ms,
        translator_reused=translator_reused,
        translator_create_ms=translator_create_ms,
    )
    # pdf2zh-next currently does not expose a layout model injection point.
    # Patch its factory only while building this serialized BabelDOC job.
    from babeldoc.docvision.doclayout import DocLayoutModel
    from unittest.mock import patch

    with (
        patch.object(DocLayoutModel, "load_available", return_value=layout_model),
        patch("pdf2zh_next.high_level.get_translator", return_value=translator),
    ):
        babeldoc_config = create_babeldoc_config(settings, source_pdf)
    babeldoc_config.table_model = LazyTableModel(telemetry)
    instrument_translator(babeldoc_config.translator, telemetry)
    translator_baseline = translator_counters(babeldoc_config.translator)
    update_page(
        document_id,
        page_number,
        status="preparing",
        stage="preparing",
        stage_label="版面模型准备完成",
        progress=5,
        stage_current=1,
        stage_total=1,
        metrics=telemetry.transition("版面模型准备完成"),
    )
    mono_pdf: Path | None = None
    last_reported_progress = 5
    last_reported_stage = "preparing"
    last_reported_at = 0.0
    # Call BabelDOC directly so it runs inside our controlled worker while the
    # PDF remains a clean production artifact (debug overlays stay disabled).
    async for event in babeldoc_translate(translation_config=babeldoc_config):
        mapped_progress = map_babeldoc_progress(event)
        if mapped_progress:
            now = time.monotonic()
            next_progress = max(last_reported_progress, mapped_progress["progress"])
            stage_changed = mapped_progress["stage_label"] != last_reported_stage
            should_persist = (
                stage_changed
                or next_progress > last_reported_progress
                or now - last_reported_at >= 0.5
                or event.get("type") == "progress_end"
            )
            if should_persist:
                if stage_changed:
                    telemetry.transition(mapped_progress["stage_label"])
                mapped_progress["progress"] = next_progress
                mapped_progress["metrics"] = telemetry.snapshot()
                update_page(document_id, page_number, **mapped_progress)
                last_reported_progress = next_progress
                last_reported_stage = mapped_progress["stage_label"]
                last_reported_at = now
        if event.get("type") == "error":
            raise RuntimeError(event.get("error") or "PDFMathTranslate 翻译失败。")
        if event.get("type") == "finish":
            result = event["translate_result"]
            if result.mono_pdf_path:
                mono_pdf = Path(result.mono_pdf_path)
            break
    collect_translator_metrics(
        babeldoc_config.translator, telemetry, translator_baseline
    )
    if not mono_pdf or not mono_pdf.exists():
        raise RuntimeError("PDFMathTranslate 未生成单语译文 PDF。")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(".tmp.pdf")
    shutil.copyfile(mono_pdf, temporary)
    update_page(
        document_id,
        page_number,
        status="validating",
        stage="validating",
        stage_label="正在验证并发布译文页",
        progress=98,
        stage_current=0,
        stage_total=1,
        metrics=telemetry.transition("验证并发布译文页"),
    )
    translated_reader = PdfReader(str(temporary))
    if len(translated_reader.pages) != 1:
        temporary.unlink(missing_ok=True)
        raise RuntimeError("译文页面产物页数异常。")
    media_box = translated_reader.pages[0].mediabox
    if float(media_box.width) <= 0 or float(media_box.height) <= 0:
        temporary.unlink(missing_ok=True)
        raise RuntimeError("译文页面尺寸无效。")
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


def refresh_queue_metadata() -> None:
    snapshot = SCHEDULER.snapshot()
    positions = {
        (document_id, page_number): (index, len(snapshot), priority)
        for index, (document_id, page_number, priority) in enumerate(snapshot, start=1)
    }
    with LOCK:
        changed_records: set[str] = set()
        for record in DOCUMENTS.values():
            for page in record.get("pages", []):
                if page.get("status") != "queued":
                    continue
                queue_data = positions.get((record["id"], page["page_number"]))
                if queue_data:
                    position, total, priority = queue_data
                    label = "当前页优先处理中" if priority == FOREGROUND_PRIORITY else f"排队中，第 {position} 位"
                    updates = {
                        "queue_position": position,
                        "queue_total": total,
                        "priority": priority,
                        "stage_label": label,
                    }
                else:
                    updates = {
                        "queue_position": None,
                        "queue_total": len(snapshot),
                        "stage_label": "正在取得处理资源",
                    }
                if any(page.get(key) != value for key, value in updates.items()):
                    page.update(updates)
                    page["updated_at"] = utc_now()
                    changed_records.add(record["id"])
        for document_id in changed_records:
            save_document(DOCUMENTS[document_id])


def cancel_obsolete_prefetch(document_id: str, keep_pages: set[int]) -> list[int]:
    cancelled = SCHEDULER.cancel_prefetch_except(document_id, keep_pages)
    if not cancelled:
        return []
    with LOCK:
        record = get_record(document_id)
        for page_number in cancelled:
            page = get_page_record(record, page_number)
            if page.get("status") == "queued":
                page.update(
                    status="pending",
                    stage="pending",
                    stage_label="等待调度",
                    progress=0,
                    queue_position=None,
                    queue_total=0,
                    priority=None,
                    queued_at=None,
                    error=None,
                    updated_at=utc_now(),
                )
        save_document(record)
    refresh_queue_metadata()
    return cancelled


def schedule_translation(
    document_id: str,
    page_number: int,
    *,
    force: bool = False,
    priority: int = PREFETCH_PRIORITY,
) -> bool:
    with LOCK:
        record = get_record(document_id)
        page = get_page_record(record, page_number)
        if page["status"] == "queued":
            reprioritized = SCHEDULER.submit(document_id, page_number, priority)
            if reprioritized:
                page["priority"] = priority
                page["updated_at"] = utc_now()
                save_document(record)
            refresh_queue_metadata()
            return reprioritized
        if page["status"] in ACTIVE_PAGE_STATUSES:
            return False
        if not force and page["status"] == "ready":
            return False
        queued_at = utc_now()
        page["status"] = "queued"
        page["error"] = None
        page["progress"] = 0
        page["stage"] = "queued"
        page["stage_label"] = "排队等待处理"
        page["stage_current"] = 0
        page["stage_total"] = 0
        page["queue_position"] = None
        page["queue_total"] = 0
        page["priority"] = priority
        page["queued_at"] = queued_at
        page["started_at"] = None
        page["finished_at"] = None
        page["metrics"] = default_metrics()
        page["updated_at"] = queued_at
        save_document(record)
    SCHEDULER.submit(document_id, page_number, priority)
    refresh_queue_metadata()
    return True


def translate_worker(document_id: str, page_number: int) -> None:
    output = translated_page_path(document_id, page_number)
    telemetry: PageTelemetry | None = None
    try:
        record = get_record(document_id)
        page = get_page_record(record, page_number)
        telemetry = PageTelemetry(page.get("queued_at"))
        if LLM_MODE == "mock":
            mock_stages = [
                ("preparing", "正在准备版面模型", 5),
                ("analyzing", "正在识别页面版面", 28),
                ("analyzing", "正在识别段落、公式与样式", 45),
                ("translating", "正在翻译文本", 78),
                ("typesetting", "正在重建译文版面", 89),
                ("generating", "正在生成译文 PDF", 97),
            ]
            mock_stage_delay = max(
                0.0, min(30.0, float(os.getenv("TRANSFLOW_MOCK_STAGE_DELAY", "0.12")))
            )
            for index, (status, label, progress) in enumerate(mock_stages, start=1):
                metrics = telemetry.transition(label)
                update_page(
                    document_id,
                    page_number,
                    status=status,
                    stage=status,
                    stage_label=label,
                    progress=progress,
                    stage_current=index,
                    stage_total=len(mock_stages),
                    started_at=page.get("started_at") or utc_now(),
                    queue_position=None,
                    queue_total=0,
                    metrics=metrics,
                    error=None,
                )
                time.sleep(mock_stage_delay)
            write_mock_page(document_id, page_number, output)
            update_page(
                document_id,
                page_number,
                status="validating",
                stage="validating",
                stage_label="正在验证并发布译文页",
                progress=98,
                stage_current=0,
                stage_total=1,
                metrics=telemetry.transition("验证并发布译文页"),
            )
            translated_reader = PdfReader(str(output))
            if len(translated_reader.pages) != 1:
                raise RuntimeError("译文页面产物页数异常。")
        else:
            if not OPENAI_API_KEY:
                raise RuntimeError("后端尚未配置 OPENAI_API_KEY。")
            # BabelDOC owns native models and caches that are not safe to initialize
            # concurrently. Its internal translation pool still issues LLM calls in parallel.
            with BABELDOC_LOCK:
                update_page(
                    document_id,
                    page_number,
                    status="preparing",
                    stage="preparing",
                    stage_label="正在初始化翻译引擎",
                    progress=1,
                    started_at=utc_now(),
                    queue_position=None,
                    queue_total=0,
                    metrics=telemetry.transition("初始化翻译引擎"),
                    error=None,
                )
                asyncio.run(
                    run_pdfmathtranslate_async(
                        document_id,
                        page_number,
                        record["target_language"],
                        output,
                        telemetry,
                    )
                )
        finished_at = utc_now()
        update_page(
            document_id,
            page_number,
            status="ready",
            stage="ready",
            stage_label="翻译完成",
            progress=100,
            stage_current=1,
            stage_total=1,
            queue_position=None,
            queue_total=0,
            finished_at=finished_at,
            metrics=telemetry.finish("完成"),
            error=None,
        )
        merge_translated_document(document_id)
    except Exception as exc:  # Keep the executor alive and surface an actionable error.
        update_page(
            document_id,
            page_number,
            status="error",
            stage="error",
            stage_label="翻译失败",
            queue_position=None,
            queue_total=0,
            finished_at=utc_now(),
            metrics=telemetry.finish("失败") if telemetry else default_metrics(),
            error=sanitize_error(exc),
        )


SCHEDULER = PriorityTranslationScheduler(SCHEDULER_WORKERS)


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
                {
                    "page_number": index,
                    "status": "pending",
                    "stage": "pending",
                    "stage_label": "等待调度",
                    "progress": 0,
                    "stage_current": 0,
                    "stage_total": 0,
                    "queue_position": None,
                    "queue_total": 0,
                    "priority": None,
                    "queued_at": None,
                    "started_at": None,
                    "finished_at": None,
                    "metrics": default_metrics(),
                    "preflight": page_preflight(text),
                    "error": None,
                    "updated_at": None,
                }
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
        priority = FOREGROUND_PRIORITY if page_number == 1 else PREFETCH_PRIORITY + page_number
        schedule_translation(document_id, page_number, priority=priority)
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
                        "scheduler": {
                            "workers": SCHEDULER.worker_count,
                            "queue_depth": len(SCHEDULER.snapshot()),
                        },
                        "engine_runtime": ENGINE_RUNTIME.status(),
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
                payload = page_summary(page)
                payload.update(
                    {
                        "source_text": source_text_path(document_id, page_number).read_text(
                            encoding="utf-8"
                        ),
                        "translated_pdf_url": (
                            f"/api/v1/documents/{document_id}/pages/{page_number}/translated.pdf"
                            if page["status"] == "ready"
                            else None
                        ),
                    }
                )
                self.send_json(
                    HTTPStatus.OK,
                    payload,
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
                window = set(
                    range(
                        start_page,
                        min(record["page_count"], start_page + count - 1) + 1,
                    )
                )
                cancelled = cancel_obsolete_prefetch(document_id, window)
                for offset, page_number in enumerate(sorted(window)):
                    priority = (
                        FOREGROUND_PRIORITY
                        if page_number == start_page
                        else PREFETCH_PRIORITY + offset
                    )
                    if schedule_translation(document_id, page_number, priority=priority):
                        scheduled.append(page_number)
                self.send_json(
                    HTTPStatus.ACCEPTED,
                    {"scheduled_pages": scheduled, "cancelled_pages": cancelled},
                )
                return

            match = re.fullmatch(r"/api/v1/documents/([a-f0-9]+)/pages/(\d+)/translate", path)
            if match:
                document_id, page_raw = match.groups()
                page_number = int(page_raw)
                translated_page_path(document_id, page_number).unlink(missing_ok=True)
                translated_document_path(document_id).unlink(missing_ok=True)
                schedule_translation(
                    document_id,
                    page_number,
                    force=True,
                    priority=FOREGROUND_PRIORITY,
                )
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
    if LLM_MODE == "openai":
        print("正在预加载 DocLayout 模型...")
        _model, reused, load_ms = ENGINE_RUNTIME.get_layout_model()
        print(f"  DocLayout: {'reused' if reused else f'loaded in {load_ms} ms'}")
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
        SCHEDULER.shutdown()


if __name__ == "__main__":
    main()
