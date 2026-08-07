import { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

interface PdfCanvasProps {
  fileUrl: string;
  pageNumber: number;
}

export default function PdfCanvas({ fileUrl, pageNumber }: PdfCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let disposed = false;
    let renderTask: { cancel: () => void; promise: Promise<void> } | null = null;
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;

    const render = async () => {
      setLoading(true);
      setError(null);
      try {
        const documentTask = pdfjsLib.getDocument(fileUrl);
        const pdf = await documentTask.promise;
        const page = await pdf.getPage(pageNumber);
        const baseViewport = page.getViewport({ scale: 1 });
        const availableWidth = Math.max(280, host.clientWidth - 32);
        const scale = Math.min(1.7, availableWidth / baseViewport.width);
        const viewport = page.getViewport({ scale });
        const ratio = window.devicePixelRatio || 1;
        const context = canvas.getContext("2d");
        if (!context || disposed) return;

        canvas.width = Math.floor(viewport.width * ratio);
        canvas.height = Math.floor(viewport.height * ratio);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        renderTask = page.render({
          canvasContext: context,
          viewport,
          transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
        });
        await renderTask.promise;
        if (!disposed) setLoading(false);
      } catch (renderError) {
        if (!disposed) {
          setLoading(false);
          setError(renderError instanceof Error ? renderError.message : "PDF 页面渲染失败");
        }
      }
    };

    void render();
    return () => {
      disposed = true;
      renderTask?.cancel();
    };
  }, [fileUrl, pageNumber]);

  return (
    <div className="pdf-canvas-host" ref={hostRef}>
      {loading && <div className="page-loading"><span />正在渲染原文页</div>}
      {error && <div className="inline-error">{error}</div>}
      <canvas ref={canvasRef} aria-label={`PDF 第 ${pageNumber} 页`} />
    </div>
  );
}
