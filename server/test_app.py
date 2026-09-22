"""Offline regression checks; never load user tasks or call the model."""
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

_runtime = tempfile.TemporaryDirectory(prefix="transflow-tests-")
os.environ["TRANSFLOW_DATA_DIR"] = _runtime.name
os.environ["TRANSFLOW_LLM_MODE"] = "mock"
os.environ["TRANSFLOW_MOCK_STAGE_DELAY"] = "0"
spec = importlib.util.spec_from_file_location("transflow_test_app", Path(__file__).with_name("app.py"))
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)
app.SCHEDULER.shutdown()


class ReliabilityTests(unittest.TestCase):
    def setUp(self):
        self.scheduler = app.PriorityTranslationScheduler(0)
        self.scheduler_patch = patch.object(app, "SCHEDULER", self.scheduler)
        self.scheduler_patch.start()
        self.record = {
            "id": "a" * 32, "page_count": 1, "target_language": "zh-CN",
            "pages": [{"page_number": 1, "status": "ready", "attempt": 1}],
        }
        app.DOCUMENTS[self.record["id"]] = self.record

    def tearDown(self):
        self.scheduler_patch.stop()

    def test_active_page_cannot_be_submitted_twice(self):
        self.scheduler.active.add((self.record["id"], 1))
        self.assertFalse(self.scheduler.submit(self.record["id"], 1, 0))
        self.assertEqual(self.scheduler.snapshot(), [])

    def test_retry_preserves_published_artifact(self):
        output = app.translated_page_path(self.record["id"], 1)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"last successful revision")
        self.assertTrue(app.schedule_translation(self.record["id"], 1, force=True))
        self.assertEqual(output.read_bytes(), b"last successful revision")
        self.assertFalse(app.schedule_translation(self.record["id"], 1, force=True))

    def test_invalid_page_does_not_change_task(self):
        with self.assertRaises(app.ApiError):
            app.schedule_translation(self.record["id"], 2, force=True)
        self.assertEqual(self.record["pages"][0]["status"], "ready")

    def test_metrics_do_not_count_failed_or_running_pages_as_completed(self):
        self.record["page_count"] = 3
        self.record["pages"] = [
            {"page_number": index, "status": status,
             "metrics": {"total_ms": 1000, "queue_wait_ms": 200}}
            for index, status in enumerate(["ready", "error", "translating"], 1)
        ]
        app.write_timing_summary(self.record)
        result = json.loads(app.timing_summary_path(self.record["id"]).read_text())
        self.assertEqual(result["completed_pages"], 1)
        self.assertEqual(result["failed_pages"], 1)
        self.assertEqual(result["active_pages"], 1)
        self.assertEqual(result["page_latency_p95_ms"], 1200)

    def test_full_mode_preserves_work_outside_reading_window(self):
        self.record["pages"][0]["status"] = "pending"
        self.assertEqual(app.set_translation_mode(self.record["id"], "full"), [1])
        self.assertEqual(app.cancel_obsolete_prefetch(self.record["id"], set()), [])
        self.assertEqual(len(self.scheduler.snapshot()), 1)

    def test_reading_mode_cancels_queued_background_work(self):
        self.record["pages"][0]["status"] = "pending"
        self.record["foreground_pages"] = []
        app.set_translation_mode(self.record["id"], "full")
        app.set_translation_mode(self.record["id"], "reading")
        self.assertEqual(self.scheduler.snapshot(), [])
        self.assertEqual(self.record["pages"][0]["status"], "pending")

    def test_invalid_mode_does_not_mutate_task(self):
        with self.assertRaises(app.ApiError):
            app.set_translation_mode(self.record["id"], "invalid")
        self.assertNotIn("translation_mode", self.record)


class FileDeliveryTests(unittest.TestCase):
    def request(self, headers):
        path = Path(_runtime.name) / "delivery.bin"
        if not path.exists():
            path.write_bytes(b"0123456789")
        handler = object.__new__(app.TransFlowHandler)
        handler.headers = headers
        handler.wfile = io.BytesIO()
        result = {}
        handler.send_response = lambda status: result.update(status=status)
        handler.send_header = lambda key, value: result.update({key: value})
        handler.end_headers = lambda: None
        handler.cors_headers = lambda: None
        handler.send_file(path)
        return result, handler.wfile.getvalue()

    def test_range(self):
        result, body = self.request({"Range": "bytes=2-5"})
        self.assertEqual(result["status"], 206)
        self.assertEqual(body, b"2345")
        self.assertEqual(result["Content-Range"], "bytes 2-5/10")

    def test_suffix_range(self):
        self.assertEqual(self.request({"Range": "bytes=-3"})[1], b"789")

    def test_invalid_range(self):
        self.assertEqual(self.request({"Range": "bytes=20-"})[0]["status"], 416)

    def test_cache_revalidation(self):
        first, _ = self.request({})
        result, body = self.request({"If-None-Match": first["ETag"]})
        self.assertEqual(result["status"], 304)
        self.assertEqual(body, b"")

    def test_stale_if_range_returns_full_file(self):
        result, body = self.request({"Range": "bytes=2-5", "If-Range": '"old"'})
        self.assertEqual(result["status"], 200)
        self.assertEqual(body, b"0123456789")


if __name__ == "__main__":
    unittest.main()
