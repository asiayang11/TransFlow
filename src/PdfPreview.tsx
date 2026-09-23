import { lazy, Suspense } from "react";
import type { PdfCanvasProps } from "./PdfCanvas";

// The upload screen does not need PDF.js. Load the viewer only when a task
// is opened; Vite keeps the worker and renderer in separate cached assets.
const PdfCanvas = lazy(() => import("./PdfCanvas"));

export default function PdfPreview(props: PdfCanvasProps) {
  return (
    <Suspense fallback={<div role="status">正在加载 PDF 阅读器…</div>}>
      <PdfCanvas {...props} />
    </Suspense>
  );
}
