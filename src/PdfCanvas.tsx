import { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export interface PdfCanvasProps {
  fileUrl: string;
  pageNumber: number;
  loadingLabel?: string;
  displayPageNumber?: number;
  onPageRatio?: (ratio: number) => void;
}

interface OpenPdf {
  task: ReturnType<typeof pdfjsLib.getDocument>;
  users: number;
  dispose?: ReturnType<typeof setTimeout>;
}

const openPdfs = new Map<string, OpenPdf>();

function acquirePdf(url: string) {
  let entry = openPdfs.get(url);
  if (!entry) {
    const task = pdfjsLib.getDocument(url);
    void task.promise.catch(() => undefined);
    entry = { task, users: 0 };
    openPdfs.set(url, entry);
  }
  const open = entry;
  clearTimeout(open.dispose);
  open.users += 1;
  return { task: open.task, release: () => {
    if (--open.users > 0) return;
    // A jump can move the whole render window in the same React commit.
    open.dispose = setTimeout(() => {
      openPdfs.delete(url);
      void open.task.destroy().catch(() => undefined);
    }, 0);
  } };
}

export default function PdfCanvas({ fileUrl, pageNumber, loadingLabel, displayPageNumber = pageNumber, onPageRatio }: PdfCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const documentRef = useRef<ReturnType<typeof pdfjsLib.getDocument> | null>(null);
  const [paperWidth, setPaperWidth] = useState(0);

  useEffect(() => {
    const { task, release } = acquirePdf(fileUrl);
    documentRef.current = task;
    return () => {
      documentRef.current = null;
      release();
    };
  }, [fileUrl]);

  useEffect(() => {
    const paper = canvasRef.current?.parentElement;
    if (!paper) return;
    const measure = () => setPaperWidth(paper.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(paper);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let disposed = false;
    let renderTask: { cancel: () => void; promise: Promise<void> } | null = null;
    const documentTask = documentRef.current;
    const canvas = canvasRef.current;
    if (!paperWidth || !canvas || !documentTask) return;

    const render = async () => {
      setLoading(true);
      setError(null);
      try {
        const pdf = await documentTask.promise;
        if (disposed) return;
        const page = await pdf.getPage(pageNumber);
        if (disposed) return;
        const baseViewport = page.getViewport({ scale: 1 });
        onPageRatio?.(baseViewport.width / baseViewport.height);
        const scale = Math.min(4, paperWidth / baseViewport.width);
        const viewport = page.getViewport({ scale });
        // Bound backing-store memory, including on Retina displays at 3x zoom.
        const ratio = Math.min(window.devicePixelRatio || 1, Math.sqrt(6_000_000 / (viewport.width * viewport.height)));
        const context = canvas.getContext("2d");
        if (!context || disposed) return;

        canvas.width = Math.floor(viewport.width * ratio);
        canvas.height = Math.floor(viewport.height * ratio);
        renderTask = page.render({
          canvasContext: context,
          viewport,
          transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
        });
        await renderTask.promise;
        page.cleanup();
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
  }, [fileUrl, pageNumber, paperWidth, onPageRatio]);

  return (
    <>
      {loading && (
        <div className="page-loading" role="status">
          <span />{loadingLabel || "正在渲染 PDF 页面"}
        </div>
      )}
      {error && <div className="inline-error">{error}</div>}
      <canvas ref={canvasRef} aria-label={`PDF 第 ${displayPageNumber} 页`} data-rendered={!loading && !error} />
    </>
  );
}
