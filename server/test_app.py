"""Offline regression checks; never load user tasks or call the model."""
import importlib.util
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


if __name__ == "__main__":
    unittest.main()
