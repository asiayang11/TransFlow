import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import PdfPagePair, { pageStageLabel, STATUS_LABEL } from "./PdfPagePair";
import { LatestRequest } from "./latest-request";
import AppHeader from "./AppHeader";
import { usePdfScrollReader } from "./usePdfScrollReader";
import {
  getDocument,
  getHealth,
  prefetchPages,
  setTranslationMode,
  translatePage,
  uploadDocument,
} from "./api";
import type { DocumentRecord, HealthRecord, PageStatus, PageSummary } from "./types";

const LANGUAGE_OPTIONS = [
  { value: "zh-CN", label: "简体中文" },
  { value: "en", label: "English" },
  { value: "ja", label: "日本語" },
  { value: "ko", label: "한국어" },
  { value: "fr", label: "Français" },
  { value: "de", label: "Deutsch" },
  { value: "es", label: "Español" },
];

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

function translatedPageUrl(documentId: string, page: PageSummary) {
  if (page.status !== "ready" && !page.artifact_revision && !page.artifact_kind) return null;
  return `/api/v1/documents/${documentId}/pages/${page.page_number}/translated.pdf?v=${encodeURIComponent(page.artifact_revision || "legacy")}`;
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

export default function PdfWorkspace() {
  const inputRef = useRef<HTMLInputElement>(null);
  const navigationVersion = useRef(0);
  const documentRequest = useRef(new LatestRequest());
  const uploadingRef = useRef(false);
  const [health, setHealth] = useState<HealthRecord | null>(null);
  const [targetLanguage, setTargetLanguage] = useState("zh-CN");
  const [documentRecord, setDocumentRecord] = useState<DocumentRecord | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [restoringTask, setRestoringTask] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changingMode, setChangingMode] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [clockNow, setClockNow] = useState(Date.now());
  const { pagesRef, controlsRef, renderRange, jumpToPage } = usePdfScrollReader(documentRecord?.id, currentPage, setCurrentPage);
  const hasActivePages = documentRecord?.pages.some(page => ACTIVE_STATUSES.includes(page.status));

  useEffect(() => {
    if (!documentRecord) return;
    const handleKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.isContentEditable || /INPUT|SELECT|TEXTAREA|BUTTON|A/.test(target.tagName)
          || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        event.preventDefault();
        jumpToPage(Math.max(1, Math.min(documentRecord.page_count,
          currentPage + (event.key === "ArrowRight" ? 1 : -1))));
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [documentRecord?.id, documentRecord?.page_count, currentPage, jumpToPage]);

  useEffect(() => {
    if (!hasActivePages) return;
    const timer = setInterval(() => setClockNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasActivePages]);

  useEffect(() => {
    getHealth().then(setHealth).catch(() => setHealth(null));
  }, []);

  const restoreFromLocation = useCallback(async () => {
    const version = ++navigationVersion.current;
    documentRequest.current.cancel();
    setDocumentRecord(null);
    const task = locationTask();
    if (!task) {
      setCurrentPage(1);
      setRestoringTask(false);
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
      if (restoredPage !== task.page) {
        window.history.replaceState(null, "", taskUrl(restored.id, restoredPage));
      }
    } catch (restoreError) {
      if (version !== navigationVersion.current) return;
      setDocumentRecord(null);
      setError(restoreError instanceof Error ? restoreError.message : "无法恢复翻译任务");
    } finally {
      if (version === navigationVersion.current) setRestoringTask(false);
    }
  }, []);

  useEffect(() => {
    void restoreFromLocation();
    const handlePopState = () => void restoreFromLocation();
    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
      navigationVersion.current += 1;
      documentRequest.current.cancel();
    };
  }, [restoreFromLocation]);

  const refreshDocument = useCallback(async () => {
    if (!documentRecord) return;
    const version = navigationVersion.current;
    const signal = documentRequest.current.start();
    try {
      const next = await getDocument(documentRecord.id, signal);
      if (documentRequest.current.owns(signal) && version === navigationVersion.current) setDocumentRecord(next);
    } catch (requestError) {
      if (!signal.aborted) throw requestError;
    }
  }, [documentRecord?.id]);

  useEffect(() => {
    if (!documentRecord) return;
    window.history.replaceState(
      null,
      "",
      taskUrl(documentRecord.id, currentPage),
    );
    let cancelled = false;
    // Keep the URL responsive, but do not reprioritize translation for every
    // transient page passed during a fast scroll.
    const timer = setTimeout(async () => {
      try {
        await prefetchPages(documentRecord.id, currentPage, documentRecord.prefetch_pages);
        if (!cancelled) await refreshDocument();
      } catch (syncError) {
        if (!cancelled) setError(syncError instanceof Error ? syncError.message : "无法加载页面");
      }
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [documentRecord?.id, currentPage, refreshDocument]);

  useEffect(() => {
    if (!documentRecord) return;
    if (!hasActivePages && documentRecord.pages[currentPage - 1]?.status !== "pending") return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    const poll = async () => {
      try {
        if (!document.hidden) await refreshDocument();
        failures = 0;
      } catch {
        failures += 1;
      } finally {
        if (!cancelled) timer = setTimeout(poll, Math.min(10000, 1000 * 2 ** failures));
      }
    };
    timer = setTimeout(poll, 1000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [documentRecord?.id, hasActivePages, documentRecord?.pages[currentPage - 1]?.status, refreshDocument]);

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
    documentRequest.current.cancel();
    setRestoringTask(false);
    setDocumentRecord(null);
    setCurrentPage(1);
    setError(null);
    window.history.pushState(null, "", "/pdf");
  };

  const retryPage = useCallback(async (page: number) => {
    if (!documentRecord) return;
    const version = navigationVersion.current;
    setError(null);
    try {
      await translatePage(documentRecord.id, page);
      if (version === navigationVersion.current) await refreshDocument();
    } catch (retryError) {
      if (version === navigationVersion.current) setError(retryError instanceof Error ? retryError.message : "重试失败");
    }
  }, [documentRecord?.id, refreshDocument]);

  const toggleTranslationMode = async () => {
    if (!documentRecord || changingMode) return;
    const version = navigationVersion.current;
    setChangingMode(true);
    try {
      await setTranslationMode(documentRecord.id, documentRecord.translation_mode === "full" ? "reading" : "full");
      await refreshDocument();
    } catch (modeError) {
      if (version === navigationVersion.current) setError(modeError instanceof Error ? modeError.message : "切换模式失败");
    } finally {
      setChangingMode(false);
    }
  };

  const readyCount = useMemo(
    () => documentRecord?.pages.filter((page) => page.status === "ready").length ?? 0,
    [documentRecord],
  );

  const currentSummary = documentRecord?.pages[currentPage - 1];
  const selectedLanguage = LANGUAGE_OPTIONS.find((item) => item.value === targetLanguage)?.label;
  const isDemoTask = documentRecord?.execution_mode === "mock";
  const fileUrl = documentRecord
    ? `/api/v1/documents/${documentRecord.id}/source.pdf`
    : null;

  return (
    <main className="app-shell">
      <AppHeader active="pdf">
        <div className="topbar-actions">
          {health && (
            <span className={`model-state ${health.llm_configured ? "is-ready" : "is-warning"}`}>
              <i />
              {health.llm_mode === "mock"
                ? "演示模式 · 不翻译"
                : health.llm_configured
                  ? health.model
                  : "等待 API Key"}
            </span>
          )}
          {documentRecord && (
            <>
              <button className="secondary-button" disabled={changingMode} onClick={() => void toggleTranslationMode()}>
                {changingMode ? "正在调整队列…" : documentRecord.translation_mode === "full" ? "停止全文预取" : "翻译全文"}
              </button>
              {documentRecord.merge_error && <span role="alert" title={documentRecord.merge_error}>全文合并失败，单页仍可阅读</span>}
              {documentRecord.translated_pdf_ready && (
                <a
                  className="secondary-button download-button"
                  href={`/api/v1/documents/${documentRecord.id}/translated.pdf`}
                >{isDemoTask ? "下载原文测试副本" : documentRecord.translated_pdf_current ? "下载译文 PDF" : "下载上次完整译文"}</a>
              )}
              <button className="secondary-button" onClick={reset}>翻译新文档</button>
            </>
          )}
        </div>
      </AppHeader>

      {!documentRecord ? (
        <section className="upload-view">
          {health?.llm_mode === "mock" && <div className="demo-banner" role="status">当前是流程演示环境：右侧会复制原文，不会调用翻译模型。</div>}
          <div className="hero-copy">
            <span className="eyebrow">PAGE-BY-PAGE TRANSLATION</span>
            <h1>让每一页，<br />都在语境里被理解。</h1>
            <p>{health?.llm_mode === "mock"
              ? "拖入 PDF 体验上传、任务和左右对照。右侧只显示原文副本。"
              : "拖入 PDF。TransFlow 会优先翻译当前页并预取后续 4 页，用 PDFMathTranslate 重建译文页面，让原文与译文始终并排。"}</p>
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
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  if (!uploading && !restoringTask) inputRef.current?.click();
                }
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
                  <span className="primary-button">选择 PDF</span>
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
            {isDemoTask && <div className="demo-banner" role="status">这是测试任务。右侧是原文副本，未执行翻译；请在真实后端重新上传文档。</div>}
            <div className="document-meta">
              <span className="file-badge">PDF</span>
              <div>
                <strong title={documentRecord.filename}>{documentRecord.filename}</strong>
                <small>{documentRecord.page_count} 页 · {formatBytes(documentRecord.size_bytes)}</small>
              </div>
            </div>
            <div className="cache-summary">
              <div><strong>{readyCount}</strong><span>{isDemoTask ? "测试副本" : "已缓存"}</span></div>
              <div><strong>{documentRecord.page_count}</strong><span>总页数</span></div>
            </div>
            <div className="page-list" aria-label="页面列表">
              {documentRecord.pages.map((page) => (
                <button
                  key={page.page_number}
                  className={`page-item ${currentPage === page.page_number ? "is-active" : ""}`}
                  onClick={() => jumpToPage(page.page_number)}
                  aria-current={currentPage === page.page_number ? "page" : undefined}
                >
                  <span className="page-number">{String(page.page_number).padStart(2, "0")}</span>
                  <span className="page-progress-copy">
                    <span className="page-label">第 {page.page_number} 页</span>
                    <span className="page-stage" title={pageStageLabel(page, isDemoTask)}>{pageStageLabel(page, isDemoTask)}</span>
                    <span className="page-progress-track" aria-hidden="true">
                      <i style={{ width: `${page.progress}%` }} />
                    </span>
                  </span>
                  <span className={`page-progress-value status-${page.status}`}>
                    {page.status === "ready"
                      ? isDemoTask ? "副本" : page.quality?.status === "needs_review" ? "!" : "✓"
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
            <div className="pdf-reader-controls" ref={controlsRef}>
              <div className="workspace-toolbar">
                <div>
                  <span className="eyebrow">BILINGUAL VIEW</span>
                  <h2>第 {currentPage} 页</h2>
                </div>
                <div className="page-controls">
                  <button onClick={() => jumpToPage(currentPage - 1)} disabled={currentPage === 1} aria-label="上一页">←</button>
                  <span>{currentPage} / {documentRecord.page_count}</span>
                  <button onClick={() => jumpToPage(currentPage + 1)} disabled={currentPage === documentRecord.page_count} aria-label="下一页">→</button>
                </div>
                <div className="toolbar-status">
                  <span className={`status-pill status-${currentSummary?.status || "pending"}`}>
                    <i />{pageStageLabel(currentSummary, isDemoTask) || STATUS_LABEL[currentSummary?.status || "pending"]}
                  </span>
                  <span>目标：{selectedLanguage}</span>
                </div>
              </div>
              <div className="reader-options">
                <label>同步缩放
                  <select aria-label="同步缩放" value={zoom} onChange={(event) => setZoom(Number(event.target.value))}>
                    <option value={1}>适应宽度</option>
                    <option value={1.5}>放大 1.5 倍</option>
                    <option value={2}>放大 2 倍</option>
                    <option value={3}>放大 3 倍</option>
                  </select>
                </label>
                <span>连续滚动 · 支持 ← → 翻页</span>
              </div>
            </div>
            <div className="pdf-page-stack" ref={pagesRef} style={{ "--pdf-zoom": zoom } as CSSProperties}>
              {fileUrl && documentRecord.pages.map(page => {
                const render = page.page_number >= renderRange.first && page.page_number <= renderRange.last;
                const translatedUrl = translatedPageUrl(documentRecord.id, page);
                return <PdfPagePair key={`${documentRecord.id}:${page.page_number}`} page={page} fileUrl={fileUrl}
                  translatedUrl={translatedUrl} demo={isDemoTask} language={selectedLanguage}
                  render={render} now={render && !translatedUrl ? clockNow : 0} retry={retryPage} />;
              })}
            </div>
            {error && <div className="error-banner workspace-error">{error}</div>}
          </div>
        </section>
      )}
    </main>
  );
}
