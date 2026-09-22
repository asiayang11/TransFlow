"""Tiny generated fixtures exercise structural checks without LLM calls."""
from pathlib import Path
import tempfile
import unittest

import pymupdf
from pdf_quality import validate


class QualityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="transflow-quality-")
        self.addCleanup(self.temp.cleanup)
        self.source = Path(self.temp.name) / "source.pdf"
        self.output = Path(self.temp.name) / "output.pdf"
        self.make_pdf(self.source)

    def make_pdf(self, path, width=595, text=None):
        with pymupdf.open() as doc:
            page = doc.new_page(width=width, height=842)
            page.insert_textbox((30, 30, width - 30, 300), text if text is not None else
                                "This is a sufficiently long source paragraph about reliable translation. " * 3)
            doc.save(path)

    def test_identical_text_requires_review(self):
        self.make_pdf(self.output)
        result = validate(self.source, self.output, "en", "zh-CN")
        self.assertEqual(result["status"], "needs_review")
        self.assertFalse(result["semantic_accuracy_verified"])

    def test_geometry_mismatch_is_rejected(self):
        self.make_pdf(self.output, width=500)
        with self.assertRaisesRegex(ValueError, "尺寸"):
            validate(self.source, self.output, "en", "zh-CN")

    def test_missing_text_requires_review(self):
        self.make_pdf(self.output, text="")
        result = validate(self.source, self.output, "en", "zh-CN")
        self.assertEqual(result["status"], "needs_review")

    def test_same_language_is_not_flagged_as_untranslated(self):
        self.make_pdf(self.output)
        self.assertEqual(validate(self.source, self.output, "en", "en")["warnings"], [])


if __name__ == "__main__":
    unittest.main()
