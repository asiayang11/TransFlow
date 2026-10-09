import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { ArrowCounterClockwise, ArrowLeft, ArrowRight, ArrowsClockwise, Check, LinkSimple, LinkSimpleBreak, Minus, Plus, GlobeHemisphereWest } from "@phosphor-icons/react";
import AppHeader from "./AppHeader";
import DemoDocument, { SAMPLES, initialDemoState, type DemoState, type SampleId } from "./DemoDocument";
import { AppLink, navigate } from "./navigation";

type Side = 0 | 1;
const SAMPLE_IDS: SampleId[] = ["guide", "article", "product"];
function sampleFromLocation(): SampleId {
  const value = new URLSearchParams(window.location.search).get("sample");
  return SAMPLE_IDS.includes(value as SampleId) ? value as SampleId : "guide";
}

export default function WebDemo() {
  const [sample, setSample] = useState<SampleId>(sampleFromLocation);
  const [url, setUrl] = useState(SAMPLES[sample].url);
  const [language, setLanguage] = useState("zh-CN");
  const [state, setState] = useState<DemoState>(initialDemoState);
  const [linked, setLinked] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const panes = useRef<(HTMLDivElement | null)[]>([null, null]);
  const linkedRef = useRef(linked);
  linkedRef.current = linked;
  const lastSide = useRef<Side>(0);
  const scrollFrame = useRef<number | null>(null);
  const scrollTargets = useRef<({ top: number; left: number } | null)[]>([null, null]);
  const restorePositions = useRef<{ top: number; left: number }[] | null>(null);

  const scrollPosition = (pane: HTMLDivElement) => ({ top: pane.scrollTop / Math.max(1, pane.scrollHeight - pane.clientHeight), left: pane.scrollLeft / Math.max(1, pane.scrollWidth - pane.clientWidth) });
  const setPosition = (side: Side, position: { top: number; left: number }) => {
    const pane = panes.current[side];
    if (!pane) return;
    const top = position.top * Math.max(0, pane.scrollHeight - pane.clientHeight);
    const left = position.left * Math.max(0, pane.scrollWidth - pane.clientWidth);
    scrollTargets.current[side] = { top, left };
    pane.scrollTo({ top, left, behavior: "instant" });
  };
  const syncFrom = (side: Side) => {
    const pane = panes.current[side];
    if (pane) setPosition(side === 0 ? 1 : 0, scrollPosition(pane));
  };
  const handleScroll = (side: Side) => {
    const pane = panes.current[side];
    if (!pane) return;
    const expected = scrollTargets.current[side];
    scrollTargets.current[side] = null;
    if (expected && Math.abs(pane.scrollTop - expected.top) < 2 && Math.abs(pane.scrollLeft - expected.left) < 2) return;
    lastSide.current = side;
    if (!linkedRef.current) return;
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = requestAnimationFrame(() => { syncFrom(side); scrollFrame.current = null; });
  };
  const changeZoom = (value: number) => {
    const positions = panes.current.map((pane) => pane ? scrollPosition(pane) : { top: 0, left: 0 });
    restorePositions.current = linkedRef.current ? [positions[lastSide.current], positions[lastSide.current]] : positions;
    setZoom(Math.max(.5, Math.min(2, Math.round(value * 100) / 100)));
  };
  useLayoutEffect(() => {
    restorePositions.current?.forEach((position, side) => setPosition(side as Side, position));
    restorePositions.current = null;
  }, [zoom]);

  const resetDocument = (next: SampleId) => {
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = null;
    setSample(next); setUrl(SAMPLES[next].url); setState(initialDemoState()); setError("");
    scrollTargets.current = [null, null];
    panes.current.forEach((pane) => pane?.scrollTo({ top: 0, left: 0, behavior: "instant" }));
  };
  useEffect(() => {
    const handleLocation = () => { if (window.location.pathname === "/web/demo") resetDocument(sampleFromLocation()); };
    window.addEventListener("popstate", handleLocation);
    return () => { window.removeEventListener("popstate", handleLocation); if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current); };
  }, []);
  useEffect(() => {
    const listeners = panes.current.map((pane) => {
      const handler = (event: WheelEvent) => {
        if (!event.ctrlKey && !event.metaKey) return;
        event.preventDefault();
        if (event.deltaY === 0) return;
        // Capture positions before React applies the shared zoom.
        const positions = panes.current.map((item) => item ? scrollPosition(item) : { top: 0, left: 0 });
        restorePositions.current = linkedRef.current ? [positions[lastSide.current], positions[lastSide.current]] : positions;
        setZoom((current) => Math.max(.5, Math.min(2, Math.round((current + (event.deltaY < 0 ? .25 : -.25)) * 100) / 100)));
      };
      pane?.addEventListener("wheel", handler, { passive: false });
      return () => pane?.removeEventListener("wheel", handler);
    });
    return () => listeners.forEach((remove) => remove());
  }, []);

  const chooseSample = (next: SampleId) => {
    if (sample === next) resetDocument(next);
    else navigate(`/web/demo?sample=${next}`);
    setNotice(`已打开${SAMPLES[next].label}示例，两侧展示相同内容。`);
  };
  const openUrl = (event: FormEvent) => {
    event.preventDefault();
    let parsed: URL;
    try { parsed = new URL(url.trim().includes("://") ? url.trim() : `https://${url.trim()}`); }
    catch { setError("请输入有效的网址，或选择下方的示例页面。"); return; }
    if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname.includes(".")) { setError("请输入以 http:// 或 https:// 开头的有效网址。"); return; }
    const next = SAMPLE_IDS.find((id) => parsed.origin === "https://demo.transflow.local" && parsed.pathname.replace(/\/$/, "") === `/${id}` && !parsed.search && !parsed.hash && !parsed.username && !parsed.password);
    if (!next) { setError("当前为旧版交互 Demo，仅支持内置示例。请从顶部「网页翻译」打开真实网址。"); return; }
    chooseSample(next);
  };
  const anchor = (side: Side, id: string) => {
    setState((current) => ({ ...current, tab: "overview", search: "" }));
    requestAnimationFrame(() => {
      const pane = panes.current[side];
      const target = pane?.querySelector<HTMLElement>(`[data-anchor="${id}"]`);
      if (!pane || !target) return;
      const top = target.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop - 22;
      lastSide.current = side;
      pane.scrollTo({ top, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
    });
  };
  const updateState = (next: Partial<DemoState>) => setState((current) => ({ ...current, ...next }));

  return (
    <main className="app-shell web-demo-shell">
      <AppHeader active="web" />
      <div className="web-workspace">
        <div className="web-page-heading"><div><AppLink href="/" className="back-link"><ArrowLeft size={15} />返回首页</AppLink><h1 tabIndex={-1}>一个网页，两个视角。</h1><p>在任意一侧操作，另一侧同步跟随。</p></div><span className="demo-label">交互 Demo</span></div>
        <section className="web-controls" aria-label="网页配置">
          <form onSubmit={openUrl} noValidate className="url-form"><label className={`url-input-wrap ${error ? "has-error" : ""}`}><GlobeHemisphereWest size={20} /><input aria-label="网页地址" aria-invalid={!!error} aria-describedby={error ? "url-error" : "demo-scope"} value={url} onChange={(event) => { setUrl(event.target.value); setError(""); }} placeholder="输入网页地址" autoComplete="off" spellCheck={false} /></label><label className="target-language"><span>翻译为</span><select aria-label="目标语言" value={language} onChange={(event) => setLanguage(event.target.value)}><option value="zh-CN">简体中文</option><option value="en">English</option><option value="ja">日本語</option><option value="ko">한국어</option><option value="fr">Français</option><option value="de">Deutsch</option><option value="es">Español</option></select></label><button className="primary-button" type="submit">打开示例<ArrowRight size={17} /></button></form>
          {error && <p className="url-error" id="url-error" role="alert">{error}</p>}
          <div className="sample-picker"><span>试试示例</span>{SAMPLE_IDS.map((id) => <button key={id} aria-pressed={sample === id} onClick={() => chooseSample(id)}>{sample === id && <Check size={13} />}{SAMPLES[id].label}</button>)}<span id="demo-scope" className="demo-scope">两侧内容相同，暂不加载外部网站或执行翻译。</span></div>
        </section>
        <div className="comparison-controls"><div className="sync-controls"><button className={`sync-toggle ${linked ? "is-linked" : ""}`} role="switch" aria-checked={linked} onClick={() => { const next = !linked; linkedRef.current = next; setLinked(next); if (next) syncFrom(lastSide.current); }}>{linked ? <LinkSimple size={17} /> : <LinkSimpleBreak size={17} />}<span>滚动联动{linked ? "开启" : "关闭"}</span><i aria-hidden="true" /></button><span className="interaction-hint">试试滚动、标签切换和展开内容</span></div><div className="zoom-controls"><span>同步缩放</span><button className="icon-button" aria-label="缩小两侧页面" disabled={zoom <= .5} onClick={() => changeZoom(zoom - .25)}><Minus size={15} /></button><select aria-label="两侧缩放比例" value={zoom} onChange={(event) => changeZoom(Number(event.target.value))}>{[.5, .75, 1, 1.25, 1.5, 1.75, 2].map((value) => <option value={value} key={value}>{Math.round(value * 100)}%</option>)}</select><button className="icon-button" aria-label="放大两侧页面" disabled={zoom >= 2} onClick={() => changeZoom(zoom + .25)}><Plus size={15} /></button><span className="control-divider" /><button className="icon-button" aria-label="重置缩放为 100%" disabled={zoom === 1} onClick={() => changeZoom(1)}><ArrowCounterClockwise size={17} /></button><button className="icon-button" aria-label="重新载入示例" onClick={() => { resetDocument(sample); setNotice("已重新载入示例，页面交互已重置。"); }}><ArrowsClockwise size={17} /></button></div></div>
        <section className="web-comparison" aria-label="网页对照预览">
          {([0, 1] as const).map((side) => <section className={`web-pane ${side === 0 ? "web-source" : "web-target"}`} aria-label={side === 0 ? "左侧原文页面" : "右侧对照页面"} key={side}><header className="web-pane-heading"><div><span className="pane-language-mark">{side === 0 ? "A" : "文"}</span><strong>{side === 0 ? "原文页面" : "对照页面"}</strong><span>{side === 0 ? "English" : "与原文相同"}</span></div><span>{side === 0 ? SAMPLES[sample].label : "未执行翻译"}</span></header><div className="web-viewport" tabIndex={0} aria-label={side === 0 ? "滚动左侧网页" : "滚动右侧网页"} ref={(node) => { panes.current[side] = node; }} onScroll={() => handleScroll(side)}><div className="web-scaled-content" style={{ zoom }}><DemoDocument sample={sample} state={state} onChange={updateState} onAnchor={(id) => anchor(side, id)} prefix={side === 0 ? "source" : "target"} /></div></div></section>)}
        </section>
        <footer className="web-demo-footer"><span>左右可操作 · Ctrl / Cmd + 滚轮缩放</span><span>目标语言设置仅供界面预览</span></footer>
        <div className="sr-only" role="status" aria-live="polite">{notice}</div>
      </div>
    </main>
  );
}
