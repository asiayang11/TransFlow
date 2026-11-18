import { memo, useState, type CSSProperties, type ReactNode } from "react";
import { X } from "@phosphor-icons/react";
import PdfPreview from "./PdfPreview";
import type { PageStatus, PageSummary } from "./types";

export const STATUS_LABEL: Record<PageStatus, string> = {
  pending: "等待", queued: "队列中", preparing: "准备模型", analyzing: "分析页面",
  translating: "翻译中", typesetting: "重建版面", generating: "生成 PDF",
  validating: "验证页面", ready: "已缓存", error: "失败",
};

export function pageStageLabel(page: PageSummary | undefined, demo: boolean) {
  return demo && page?.status === "ready" ? "原文副本（未翻译）" : page?.stage_label;
}

function Paper({ children }: { children?: ReactNode }) {
  return <div className="pdf-canvas-host"><div className="pdf-page-surface">{children}</div></div>;
}

function PageProgress({ page, now, onRetry }: { page: PageSummary; now: number; onRetry: () => void }) {
  if (page.status === "error") return (
    <div className="translation-message error-state">
      <span>!</span><h3>这一页没有翻译成功</h3>
      <p>{page.error || "模型请求失败，请重试。"}</p>
      <button className="primary-button" onClick={onRetry}>重新翻译</button>
    </div>
  );
  const elapsed = page.queued_at ? Math.max(0, Math.floor((now - Date.parse(page.queued_at)) / 1000)) : null;
  const stalled = page.updated_at ? Math.floor((now - Date.parse(page.updated_at)) / 1000) : 0;
  const description = page.status === "queued"
    ? page.queue_position
      ? `当前排在第 ${page.queue_position} 位${page.queue_total ? `，队列共 ${page.queue_total} 页` : ""}。`
      : "正在取得版面处理资源，即将开始。"
    : page.stage === "translating"
      ? `正在等待模型返回译文。${page.stage_total ? ` 已处理 ${page.stage_current}/${page.stage_total} 个文本单元。` : ""}${stalled >= 30 ? ` 已有 ${stalled} 秒没有新的进度。` : ""}`
      : "PDFMathTranslate 正在保留插图和公式，并重建对应的译文页面。";
  return (
    <div className="translation-message">
      <div className="progress-percentage">{page.progress}<small>%</small></div>
      <h3>{page.stage_label || "等待调度"}</h3>
      {elapsed !== null && <small>本次已等待 {Math.floor(elapsed / 60)} 分 {elapsed % 60} 秒（含排队）</small>}
      <p>{description}</p>
      <div className="translation-progress-track" role="progressbar" aria-label={`第 ${page.page_number} 页翻译进度`}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={page.progress}>
        <span style={{ width: `${page.progress}%` }} />
      </div>
      <div className="progress-meta">
        <span>{page.status === "queued" && page.queue_position ? `队列第 ${page.queue_position} 位` : STATUS_LABEL[page.status]}</span>
        <strong>{page.progress}%</strong>
      </div>
    </div>
  );
}

const PdfPagePair = memo(function PdfPagePair({ page, fileUrl, translatedUrl, demo, language, render, now, retry }: {
  page: PageSummary;
  fileUrl: string;
  translatedUrl: string | null;
  demo: boolean;
  language?: string;
  render: boolean;
  now: number;
  retry: (page: number) => void;
}) {
  const [ratio, setRatio] = useState(1 / Math.SQRT2);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const number = page.page_number;
  const onRetry = () => retry(number);
  const notices: { key: string; title: string; messages: string[]; retry?: boolean }[] = [];
  if (page.quality?.status === "needs_review") notices.push({
    key: `${page.attempt}:quality:${page.artifact_revision ?? ""}`,
    title: "需复核", messages: page.quality.warnings,
  });
  if (translatedUrl && page.status !== "ready") {
    const failed = page.status === "error";
    notices.push({
      key: `${page.attempt}:${failed ? "retry-failed" : "retry-active"}`,
      title: "正在展示上次成功结果",
      messages: [failed ? page.error || "本次翻译失败，请重试。" : page.stage_label],
      retry: failed,
    });
  }
  return (
    <section className="pdf-page-pair" aria-label={`第 ${number} 页`} data-pdf-page={number}>
      {notices.some(({ key }) => dismissed.includes(key)) && (
        <button className="pdf-notice-action pdf-notice-reopen" type="button" onClick={() => setDismissed([])}>查看本页提示</button>
      )}
      {notices.filter(({ key }) => !dismissed.includes(key)).map(({ key, title, messages, retry }) => (
        <div className="pdf-page-notice" key={key}>
          <div className="pdf-page-notice-copy" role={render ? "status" : undefined}>
            <strong>{title}</strong>
            {messages.map((message, index) => <p key={index}>{message}</p>)}
          </div>
          {retry && <button className="pdf-notice-action" type="button" onClick={onRetry}>重试</button>}
          <button className="pdf-notice-action pdf-notice-close" type="button" aria-label={`关闭提示：${title}`} title="关闭提示"
            onClick={() => setDismissed(previous => [...previous, key])}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      ))}
      <div className="comparison-grid" style={{ "--pdf-ratio": ratio } as CSSProperties}>
        <article className="document-pane source-pane">
          <header><span>ORIGINAL · {number}</span><strong>原文</strong></header>
          <Paper>{render && <PdfPreview fileUrl={fileUrl} pageNumber={number} onPageRatio={setRatio} loadingLabel="正在渲染原文页" />}</Paper>
        </article>
        <article className="document-pane translation-pane">
          <header><span>{demo ? "TEST COPY · NOT TRANSLATED" : `TRANSLATION · ${number}`}</span><strong>{demo ? "原文副本（未翻译）" : language}</strong></header>
          <Paper>{render && (translatedUrl ? (
            <PdfPreview fileUrl={translatedUrl} pageNumber={1} displayPageNumber={number}
              loadingLabel={demo ? "正在渲染原文测试副本" : "正在渲染译文 PDF 页"} />
          ) : <PageProgress page={page} now={now} onRetry={onRetry} />)}</Paper>
        </article>
      </div>
    </section>
  );
});

export default PdfPagePair;
