import { useCallback, useLayoutEffect, useRef, useState } from "react";

const BUFFER = 420;

export function usePdfScrollReader(documentId: string | undefined, page: number, setPage: (page: number) => void) {
  const pagesRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const current = useRef(page);
  current.current = page;
  const [renderRange, setRenderRange] = useState({ first: page, last: page });

  const readingTop = useCallback(() => {
    const controls = controlsRef.current;
    return controls ? controls.offsetHeight + (parseFloat(getComputedStyle(controls).top) || 0) : 0;
  }, []);

  const jumpToPage = useCallback((next: number) => {
    const row = pagesRef.current?.children[next - 1];
    if (!row) return;
    window.scrollTo({ top: window.scrollY + row.getBoundingClientRect().top - readingTop() - 8, behavior: "instant" });
  }, [readingTop]);

  useLayoutEffect(() => {
    const pages = pagesRef.current;
    if (!documentId || !pages?.children.length) return;
    const rows = pages.children;
    const root = document.documentElement;
    let frame = 0;
    let last = { first: 0, last: 0 };
    let readingInset = -1;

    // Rows stay mounted as lightweight placeholders. Use their natural positions
    // so scrolling never depends on wheel events or an estimated page offset.
    const pageAt = (y: number) => {
      let low = 0;
      let high = rows.length - 1;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (rows[mid].getBoundingClientRect().bottom > y) high = mid;
        else low = mid + 1;
      }
      return low + 1;
    };
    const sync = () => {
      frame = 0;
      const top = Math.min(readingTop(), window.innerHeight - 1);
      if (readingInset !== top) {
        readingInset = top;
        // Anchor the visible paper, not rows underneath the sticky controls.
        root.style.setProperty("--pdf-reading-inset", `${top}px`);
      }
      const viewport = document.scrollingElement;
      const atEnd = !!viewport && viewport.scrollTop > 0 &&
        viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 2;
      const active = atEnd ? rows.length : pageAt(top + 16);
      if (current.current !== active) {
        current.current = active;
        setPage(active);
      }
      const first = Math.min(Math.max(1, active - 1), pageAt(top - BUFFER));
      const lastPage = Math.max(Math.min(rows.length, active + 1), pageAt(window.innerHeight + BUFFER));
      if (first !== last.first || lastPage !== last.last) {
        last = { first, last: lastPage };
        setRenderRange(last);
      }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(sync); };

    jumpToPage(current.current);
    sync();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(pages);
    if (controlsRef.current) observer.observe(controlsRef.current);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      observer.disconnect();
      cancelAnimationFrame(frame);
      root.style.removeProperty("--pdf-reading-inset");
    };
  }, [documentId, jumpToPage, readingTop, setPage]);

  return { pagesRef, controlsRef, renderRange, jumpToPage };
}
