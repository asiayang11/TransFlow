import { useLayoutEffect, useRef, type RefObject } from "react";

type Direction = -1 | 1;
const EDGE_TOLERANCE = 3;
const WHEEL_GAP_MS = 220;
const WHEEL_DISTANCE = 45;
const SWIPE_DISTANCE = 50;
const CONTROLS = "button, a, input, select, textarea, label, [contenteditable]";

function canScroll(element: Element, direction: Direction) {
  return direction === -1
    ? element.scrollTop > EDGE_TOLERANCE
    : element.scrollHeight - element.clientHeight - element.scrollTop > EDGE_TOLERANCE;
}

function atPageEdge(viewport: Element, reader: HTMLElement, target: Element, direction: Direction) {
  if (canScroll(viewport, direction)) return false;
  for (let element: Element | null = target; element && element !== reader; element = element.parentElement) {
    if (/^(auto|scroll)$/.test(getComputedStyle(element).overflowY) &&
        element.scrollHeight > element.clientHeight && canScroll(element, direction)) return false;
  }
  return true;
}

export function usePdfPageGestures(
  readerRef: RefObject<HTMLDivElement | null>,
  documentId: string | undefined,
  page: number,
  pageCount: number,
  setPage: (next: number) => void,
) {
  const wheelGesture = useRef({ direction: 0, lastAt: 0, distance: 0, turned: false });
  const landing = useRef<{ documentId: string; page: number; direction: Direction } | null>(null);

  useLayoutEffect(() => {
    const reader = readerRef.current;
    const viewport = document.scrollingElement;
    if (!reader || !viewport || !documentId) return;

    let bottomObserver: ResizeObserver | undefined;
    let stopFollowingBottom: ReturnType<typeof setTimeout> | undefined;
    const stopFollowing = () => {
      bottomObserver?.disconnect();
      if (stopFollowingBottom !== undefined) clearTimeout(stopFollowingBottom);
    };
    const destination = landing.current;
    landing.current = null;
    if (destination?.documentId === documentId && destination.page === page) {
      if (destination.direction === 1) {
        viewport.scrollTop = 0;
      } else {
        const followBottom = () => { viewport.scrollTop = viewport.scrollHeight; };
        followBottom();
        // An adjacent page can have a different height or render asynchronously.
        bottomObserver = new ResizeObserver(followBottom);
        bottomObserver.observe(reader);
        stopFollowingBottom = setTimeout(stopFollowing, 1500);
      }
    }

    const turn = (direction: Direction) => {
      const next = page + direction;
      if (next < 1 || next > pageCount || landing.current) return false;
      landing.current = { documentId, page: next, direction };
      setPage(next);
      return true;
    };

    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || !event.deltaY ||
          Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      const target = event.target;
      if (!(target instanceof Element) || target.closest(CONTROLS)) return;
      const direction = event.deltaY > 0 ? 1 : -1;
      const now = performance.now();
      const gesture = wheelGesture.current;
      if (now - gesture.lastAt > WHEEL_GAP_MS || gesture.direction !== direction) {
        gesture.direction = direction;
        gesture.distance = 0;
        gesture.turned = false;
      }
      gesture.lastAt = now;
      if (gesture.turned) {
        event.preventDefault();
        return;
      }
      stopFollowing();
      if (!atPageEdge(viewport, reader, target, direction)) {
        gesture.distance = 0;
        return;
      }
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
      gesture.distance += Math.abs(event.deltaY) * unit;
      if (gesture.distance >= WHEEL_DISTANCE && turn(direction)) {
        gesture.turned = true;
        event.preventDefault();
      }
    };

    let swipe: { start: Touch; target: Element; atTop: boolean; atBottom: boolean } | null = null;
    const onTouchStart = (event: TouchEvent) => {
      stopFollowing();
      swipe = null;
      const target = event.target;
      if (event.touches.length !== 1 || !(target instanceof Element) || target.closest(CONTROLS)) return;
      swipe = {
        start: event.touches[0],
        target,
        atTop: atPageEdge(viewport, reader, target, -1),
        atBottom: atPageEdge(viewport, reader, target, 1),
      };
    };
    const onTouchEnd = (event: TouchEvent) => {
      const gesture = swipe;
      swipe = null;
      if (!gesture || event.touches.length > 0) return;
      const end = Array.from(event.changedTouches).find(touch => touch.identifier === gesture.start.identifier);
      if (!end) return;
      const dy = gesture.start.clientY - end.clientY;
      if (Math.abs(dy) < SWIPE_DISTANCE || Math.abs(dy) <= Math.abs(end.clientX - gesture.start.clientX)) return;
      const direction = dy > 0 ? 1 : -1;
      if ((direction === 1 ? gesture.atBottom : gesture.atTop) &&
          atPageEdge(viewport, reader, gesture.target, direction)) turn(direction);
    };
    const onTouchCancel = () => { swipe = null; };

    reader.addEventListener("wheel", onWheel, { passive: false });
    reader.addEventListener("touchstart", onTouchStart, { passive: true });
    reader.addEventListener("touchend", onTouchEnd, { passive: true });
    reader.addEventListener("touchcancel", onTouchCancel, { passive: true });
    return () => {
      stopFollowing();
      reader.removeEventListener("wheel", onWheel);
      reader.removeEventListener("touchstart", onTouchStart);
      reader.removeEventListener("touchend", onTouchEnd);
      reader.removeEventListener("touchcancel", onTouchCancel);
    };
  }, [documentId, page, pageCount, readerRef, setPage]);
}
