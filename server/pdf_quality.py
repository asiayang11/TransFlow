"""Conservative PDF checks, isolated from the translation engine process.

These checks detect structural defects and suspicious output, not semantic
translation accuracy. Warnings are review hints, never an automatic deletion.
"""
import json
from pathlib import Path
import re
import sys


def validate(source: Path, output: Path, source_language: str, target_language: str) -> dict:
    import pymupdf

    warnings = []
    with pymupdf.open(source) as original, pymupdf.open(output) as translated:
        if len(original) != 1 or len(translated) != 1:
            raise ValueError("单页译文的页数必须与原文一致。")
        before, after = original[0], translated[0]
        for box in ("mediabox", "cropbox"):
            if any(abs(a - b) > 1 for a, b in zip(getattr(before, box), getattr(after, box))):
                raise ValueError("译文页面尺寸或裁剪区域与原文不一致。")
        if before.rotation != after.rotation:
            raise ValueError("译文页面旋转方向与原文不一致。")
        # Bound raster size for unusual PDF page dimensions.
        if after.rect.width <= 0 or after.rect.height <= 0:
            raise ValueError("译文页面尺寸无效。")
        scale = min(1, 900 / max(after.rect.width, after.rect.height))
        raster = after.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
        if raster.width < 1 or raster.height < 1:
            raise ValueError("译文无法渲染。")
        source_text = before.get_text()
        output_text = after.get_text()
        compact = lambda value: re.sub(r"\s+", "", value)
        if len(compact(source_text)) > 80 and len(compact(output_text)) < 20:
            warnings.append("译文可提取文字明显减少，请检查漏译或文字转图情况。")
        if (source_language.split("-")[0] != target_language.split("-")[0]
                and len(compact(source_text)) > 80
                and compact(source_text) == compact(output_text)):
            warnings.append("译文文字与原文完全相同，请检查是否未执行翻译。")
        if "\ufffd" in output_text:
            warnings.append("译文存在无法识别的字符，请检查字体或编码。")
        spans = [span for block in after.get_text("dict")["blocks"]
                 for line in block.get("lines", []) for span in line.get("spans", [])
                 if span.get("text", "").strip()]
        # Text coordinates are unrotated; compare to the unrotated page bounds.
        bounds = pymupdf.Rect(0, 0, after.cropbox.width, after.cropbox.height)
        if any(not (bounds + (-2, -2, 2, 2)).contains(pymupdf.Rect(span["bbox"])) for span in spans):
            warnings.append("检测到页边界外文字，请检查裁剪或排版溢出。")
        if spans and sum(span["size"] < 5 for span in spans) / len(spans) > 0.1:
            warnings.append("部分文字字号小于 5pt，请检查可读性。")
    return {
        "status": "needs_review" if warnings else "structural_checks_passed",
        "warnings": warnings,
        "checks": ["page_count", "page_geometry", "renderable", "text_sanity"],
        "semantic_accuracy_verified": False,
    }


if __name__ == "__main__":
    try:
        print(json.dumps(validate(Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3], sys.argv[4]), ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False))
        sys.exit(1)
