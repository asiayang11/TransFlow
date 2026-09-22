import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PdfCanvas from "./PdfCanvas";
import {
  getDocument,
  getHealth,
  getPage,
  prefetchPages,
  translatePage,
  uploadDocument,
} from "./api";
import type { DocumentRecord, HealthRecord, PageResult, PageStatus } from "./types";

const LANGUAGE_OPTIONS = [
  { value: "zh-CN", label: "简体中文" },
  { value: "en", label: "English" },
  { value: "ja", label: "日本語" },
  { value: "ko", label: "한국어" },
  { value: "fr", label: "Français" },
  { value: "de", label: "Deutsch" },
  { value: "es", label: "Español" },
];

const STATUS_LABEL: Record<PageStatus, string> = {
  pending: "等待",
  queued: "队列中",
  preparing: "准备模型",
  analyzing: "分析页面",
  translating: "翻译中",
  typesetting: "重建版面",
  generating: "生成 PDF",
  validating: "验证页面",
  ready: "已缓存",
  error: "失败",
};

const ACTIVE_STATUSES: PageStatus[] = [
  "queued",
  "preparing",
  "analyzing",
  "translating",
  "typesetting",
  "generating",
  "validating",
];

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function queueCopy(page?: PageResult | DocumentRecord["pages"][number]) {
  if (!page || page.status !== "queued") return null;
  if (page.queue_position) {
    return `当前排在第 ${page.queue_position} 位${page.queue_total ? `，队列共 ${page.queue_total} 页` : ""}。切换到本页后已自动提升优先级。`;
  }
  return "正在取得版面处理资源，即将开始。";
}

function locationTask(): { documentId: string; page: number } | null {
  const match = window.location.pathname.match(/^\/tasks\/([a-f0-9]{32})\/?$/);
  if (!match) return null;
  const requestedPage = Number(new URLSearchParams(window.location.search).get("page"));
  return {
    documentId: match[1],
    page: Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1,
  };
}

function taskUrl(documentId: string, page: number) {
  return `/tasks/${documentId}?page=${page}`;
}

export default function App() {
  const inputRef = useRef<HTMLInputElement>(null);
  const navigationVersion = useRef(0);
  const uploadingRef = useRef(false);
  const selectionRef = useRef("");
  const [health, setHealth] = useState<HealthRecord | null>(null);
  const [targetLanguage, setTargetLanguage] = useState("zh-CN");
  const [documentRecord, setDocumentRecord] = useState<DocumentRecord | null>(null);
  const [pageResult, setPageResult] = useState<PageResult | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [restoringTask, setRestoringTask] = useState(false);
  const [error, setError] = useState<string | null>(null);
  selectionRef.current = `${documentRecord?.id ?? ""}:${currentPage}`;

  useEffect(() => {
    getHealth().then(setHealth).catch(() => setHealth(null));
  }, []);

  const restoreFromLocation = useCallback(async () => {
    const version = ++navigationVersion.current;
    const task = locationTask();
    if (!task) {
      setDocumentRecord(null);
      setPageResult(null);
      setCurrentPage(1);
      return;
    }
    setRestoringTask(true);
    setError(null);
    try {
      const restored = await getDocument(task.documentId);
      if (version !== navigationVersion.current) return;
      const restoredPage = Math.min(restored.page_count, task.page);
      setDocumentRecord(restored);
      setTargetLanguage(restored.target_language);
      setCurrentPage(restoredPage);
      setPageResult(null);
      if (restoredPage !== task.page) {
        window.history.replaceState(null, "", taskUrl(restored.id, restoredPage));
      }
    } catch (restoreError) {
      if (version !== navigationVersion.current) return;
      setDocumentRecord(null);
      setPageResult(null);
      setError(restoreError instanceof Error ? restoreError.message : "无法恢复翻译任务");
    } finally {
      if (version === navigationVersion.current) setRestoringTask(false);
    }
  }, []);

  useEffect(() => {
    void restoreFromLocation();
    const handlePopState = () => void restoreFromLocation();
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [restoreFromLocation]);

  const refreshDocument = useCallback(async () => {
    if (!documentRecord) return;
    const version = navigationVersion.current;
    const next = await getDocument(documentRecord.id);
    if (version === navigationVersion.current && selectionRef.current.startsWith(`${documentRecord.id}:`)) setDocumentRecord(next);
  }, [documentRecord?.id]);

  const refreshPage = useCallback(async () => {
    if (!documentRecord) return;
    const version = navigationVersion.current;
    const selection = `${documentRecord.id}:${currentPage}`;
    const next = await getPage(documentRecord.id, currentPage);
    if (version === navigationVersion.current && selectionRef.current === selection) setPageResult(next);
  }, [documentRecord?.id, currentPage]);

  useEffect(() => {
    if (!documentRecord) return;
    window.history.replaceState(
      null,
      "",
      taskUrl(documentRecord.id, currentPage),
    );
    setPageResult(null);
    let cancelled = false;
    const sync = async () => {
      try {
        await prefetchPages(documentRecord.id, currentPage, documentRecord.prefetch_pages);
        if (!cancelled) await Promise.all([refreshDocument(), refreshPage()]);
      } catch (syncError) {
        if (!cancelled) setError(syncError instanceof Error ? syncError.message : "无法加载页面");
      }
    };
    void sync();
    return () => { cancelled = true; };
  }, [documentRecord?.id, currentPage]);

  useEffect(() => {
    if (!documentRecord) return;
    const active = documentRecord.pages.some((page) => ACTIVE_STATUSES.includes(page.status));
    const currentActive = pageResult && (
      pageResult.status === "pending" || ACTIVE_STATUSES.includes(pageResult.status)
    );
    if (!active && !currentActive) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    const poll = async () => {
      try {
        if (!document.hidden) await Promise.all([refreshDocument(), refreshPage()]);
        failures = 0;
      } catch {
        failures += 1;
      } finally {
        if (!cancelled) timer = setTimeout(poll, Math.min(10000, 1000 * 2 ** failures));
      }
    };
    timer = setTimeout(poll, 1000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [documentRecord?.id, documentRecord?.pages.some((page) => ACTIVE_STATUSES.includes(page.status)), pageResult?.status, refreshDocument, refreshPage]);

  const handleFile = async (file?: File) => {
    if (!file || uploadingRef.current) return;
    if (file.size > 50 * 1024 * 1024) {
      setError("PDF 最大支持 50 MB。");
      return;
    }
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      setError("请拖入 PDF 文件。");
      return;
    }

    setError(null);
    setUploading(true);
    uploadingRef.current = true;
    const version = ++navigationVersion.current;
    try {
      const created = await uploadDocument(file, targetLanguage);
      if (version !== navigationVersion.current) return;
      setDocumentRecord(created);
      setCurrentPage(1);
      setPageResult(null);
      window.history.pushState(null, "", taskUrl(created.id, 1));
    } catch (uploadError) {
      if (version === navigationVersion.current) setError(uploadError instanceof Error ? uploadError.message : "上传失败");
    } finally {
      uploadingRef.current = false;
      setUploading(false);
    }
  };

  const reset = () => {
    navigationVersion.current += 1;
    selectionRef.current = "";
    setRestoringTask(false);
    setDocumentRecord(null);
    setPageResult(null);
    setCurrentPage(1);
    setError(null);
    window.history.pushState(null, "", "/");
  };

  const retryCurrent = async () => {
    if (!documentRecord) return;
    setError(null);
    try {
      await translatePage(documentRecord.id, currentPage);
      await refreshDocument();
      await refreshPage();
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : "重试失败");
    }
  };

  const readyCount = useMemo(
    () => documentRecord?.pages.filter((page) => page.status === "ready").length ?? 0,
    [documentRecord],
  );

  const currentSummary = documentRecord?.pages[currentPage - 1];
  const visibleProgress = pageResult?.page_number === currentPage ? pageResult : currentSummary;
  const selectedLanguage = LANGUAGE_OPTIONS.find((item) => item.value === targetLanguage)?.label;
  const fileUrl = documentRecord
    ? `/api/v1/documents/${documentRecord.id}/source.pdf`
    : null;

  return (
    <main className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={reset} aria-label="返回上传页">
          <span className="brand-mark">T</span>
          <span>TransFlow</span>
          <small>文档翻译工作台</small>
        </button>
        <div className="topbar-actions">
          {health && (
            <span className={`model-state ${health.llm_configured ? "is-ready" : "is-warning"}`}>
              <i />
              {health.llm_mode === "mock"
                ? "演示模型"
                : health.llm_configured
                  ? health.model
                  : "等待 API Key"}
            </span>
          )}
          {documentRecord && (
            <>
              {documentRecord.translated_pdf_ready && (
                <a
                  className="secondary-button download-button"
                  href={`/api/v1/documents/${documentRecord.id}/translated.pdf`}
                >下载译文 PDF</a>
              )}
              <button className="secondary-button" onClick={reset}>翻译新文档</button>
            </>
          )}
        </div>
      </header>

      {!documentRecord ? (
        <section className="upload-view">
          <div className="hero-copy">
            <span className="eyebrow">PAGE-BY-PAGE TRANSLATION</span>
            <h1>让每一页，<br />都在语境里被理解。</h1>
            <p>拖入 PDF。TransFlow 会优先翻译当前页并预取后续 4 页，用 PDFMathTranslate 重建译文页面，让原文与译文始终并排。</p>
          </div>

          <div className="upload-panel">
            <div
              className={`dropzone ${dragging ? "is-dragging" : ""} ${uploading ? "is-uploading" : ""}`}
              onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={(event) => { event.preventDefault(); setDragging(false); }}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                void handleFile(event.dataTransfer.files[0]);
              }}
              onClick={() => !uploading && inputRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") inputRef.current?.click();
              }}
            >
              <input
                ref={inputRef}
                type="file"
                accept="application/pdf,.pdf"
                hidden
                onChange={(event) => void handleFile(event.target.files?.[0])}
              />
              <div className="upload-icon"><span>PDF</span></div>
              {uploading || restoringTask ? (
                <>
                  <h2>{restoringTask ? "正在恢复翻译任务" : "正在读取文档"}</h2>
                  <p>{restoringTask ? "正在载入页面状态和已缓存译文。" : "解析页数和文字，随后自动预热前 5 页。"}</p>
                  <div className="progress-track"><span /></div>
                </>
              ) : (
                <>
                  <h2>{dragging ? "松手即可上传" : "把 PDF 拖到这里"}</h2>
                  <p>或点击选择文件 · 最大 50 MB</p>
                  <button className="primary-button" type="button">选择 PDF</button>
                </>
              )}
            </div>

            <div className="upload-options">
              <label>
                <span>翻译为</span>
                <select value={targetLanguage} onChange={(event) => setTargetLanguage(event.target.value)}>
                  {LANGUAGE_OPTIONS.map((language) => (
                    <option value={language.value} key={language.value}>{language.label}</option>
                  ))}
                </select>
              </label>
              <div className="privacy-note">
                <span>本机存储</span>
                <p>文件保存在本地后端，不创建公开链接。</p>
              </div>
            </div>
            {error && <div className="error-banner">{error}</div>}
          </div>

          <div className="trust-row">
            <span>原版式重建</span>
            <span>逐页缓存</span>
            <span>左右对照</span>
          </div>
        </section>
      ) : (
        <section className="workspace-view">
          <aside className="page-rail">
            <div className="document-meta">
              <span className="file-badge">PDF</span>
              <div>
                <strong title={documentRecord.filename}>{documentRecord.filename}</strong>
                <small>{documentRecord.page_count} 页 · {formatBytes(documentRecord.size_bytes)}</small>
              </div>
            </div>
            <div className="cache-summary">
              <div><strong>{readyCount}</strong><span>已缓存</span></div>
              <div><strong>{documentRecord.page_count}</strong><span>总页数</span></div>
            </div>
            <div className="page-list" aria-label="页面列表">
              {documentRecord.pages.map((page) => (
                <button
                  key={page.page_number}
                  className={`page-item ${currentPage === page.page_number ? "is-active" : ""}`}
                  onClick={() => setCurrentPage(page.page_number)}
                >
                  <span className="page-number">{String(page.page_number).padStart(2, "0")}</span>
                  <span className="page-progress-copy">
                    <span className="page-label">第 {page.page_number} 页</span>
                    <span className="page-stage" title={page.stage_label}>{page.stage_label}</span>
                    <span className="page-progress-track" aria-hidden="true">
                      <i style={{ width: `${page.progress}%` }} />
                    </span>
                  </span>
                  <span className={`page-progress-value status-${page.status}`}>
                    {page.status === "ready"
                      ? "✓"
                      : page.status === "error"
                        ? "!"
                        : page.status === "queued" && page.queue_position
                          ? `#${page.queue_position}`
                          : `${page.progress}%`}
                  </span>
                </button>
              ))}
            </div>
          </aside>

          <div className="comparison-area">
            <div className="workspace-toolbar">
              <div>
                <span className="eyebrow">BILINGUAL VIEW</span>
                <h2>第 {currentPage} 页</h2>
              </div>
              <div className="page-controls">
                <button
                  onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
                  disabled={currentPage === 1}
                  aria-label="上一页"
                >←</button>
                <span>{currentPage} / {documentRecord.page_count}</span>
                <button
                  onClick={() => setCurrentPage((page) => Math.min(documentRecord.page_count, page + 1))}
                  disabled={currentPage === documentRecord.page_count}
                  aria-label="下一页"
                >→</button>
              </div>
              <div className="toolbar-status">
                <span className={`status-pill status-${currentSummary?.status || "pending"}`}>
                  <i />{currentSummary?.stage_label || STATUS_LABEL[currentSummary?.status || "pending"]}
                </span>
                <span>目标：{selectedLanguage}</span>
              </div>
            </div>

            <div className="comparison-grid">
              <article className="document-pane source-pane">
                <header><span>ORIGINAL</span><strong>原文</strong></header>
                {fileUrl && (
                  <PdfCanvas fileUrl={fileUrl} pageNumber={currentPage} loadingLabel="正在渲染原文页" />
                )}
              </article>

              <article className="document-pane translation-pane">
                <header><span>TRANSLATION</span><strong>{selectedLanguage}</strong></header>
                {pageResult?.page_number === currentPage && pageResult.status === "ready" && pageResult.translated_pdf_url ? (
                  <PdfCanvas
                    fileUrl={`${pageResult.translated_pdf_url}?v=${encodeURIComponent(pageResult.updated_at || "ready")}`}
                    pageNumber={1}
                    loadingLabel="正在渲染译文 PDF 页"
                  />
                ) : (
                  <div className="translation-page">
                    {pageResult?.page_number === currentPage && pageResult.status === "error" ? (
                    <div className="translation-message error-state">
                      <span>!</span>
                      <h3>这一页没有翻译成功</h3>
                      <p>{pageResult.error || "模型请求失败，请重试。"}</p>
                      <button className="primary-button" onClick={() => void retryCurrent()}>重新翻译</button>
                    </div>
                  ) : (
                    <div className="translation-message">
                      <div className="progress-percentage">{visibleProgress?.progress ?? 0}<small>%</small></div>
                      <h3>{visibleProgress?.stage_label || "等待调度"}</h3>
                      <p>
                        {visibleProgress?.status === "queued"
                          ? queueCopy(visibleProgress)
                          : "PDFMathTranslate 正在保留插图和公式，并重建对应的译文页面。"}
                      </p>
                      <div
                        className="translation-progress-track"
                        role="progressbar"
                        aria-label={`第 ${currentPage} 页翻译进度`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={visibleProgress?.progress ?? 0}
                      >
                        <span style={{ width: `${visibleProgress?.progress ?? 0}%` }} />
                      </div>
                      <div className="progress-meta">
                        <span>
                          {visibleProgress?.status === "queued" && visibleProgress.queue_position
                            ? `队列第 ${visibleProgress.queue_position} 位`
                            : STATUS_LABEL[visibleProgress?.status || "pending"]}
                        </span>
                        <strong>{visibleProgress?.progress ?? 0}%</strong>
                      </div>
                    </div>
                    )}
                  </div>
                )}
              </article>
            </div>
            {error && <div className="error-banner workspace-error">{error}</div>}
          </div>
        </section>
      )}
    </main>
  );
}
