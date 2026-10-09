import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowCounterClockwise, ArrowLeft, ArrowRight, ArrowsClockwise, ArrowsOut, ArrowsIn, GlobeHemisphereWest, LinkSimple, LinkSimpleBreak, Minus, Plus } from '@phosphor-icons/react';
import AppHeader from './AppHeader';
import { AppLink } from './navigation';
import { WebMirror, type WebCommand, type WebStatus, type ParagraphInspection } from './web-mirror';
import { READING_KEY, parseReading, viewportLayout, type SavedReading, type ReadingPosition } from '../shared/web-reading.mjs';
import './web-reading.css';
import '@rrweb/replay/dist/style.css';

const languages = { 'zh-CN': '简体中文', en: 'English', ja: '日本語', ko: '한국어', fr: 'Français', de: 'Deutsch', es: 'Español' };
const examples = [['简洁文章', 'https://example.com'], ['技术文档', 'https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/details'], ['产品介绍', 'https://www.python.org/about/']];
async function request<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-TransFlow-Web': '1' }, body: body === undefined ? undefined : JSON.stringify(body), keepalive: method === 'DELETE' });
  const result = await response.json().catch(() => ({ error: '网页服务未启动，请运行 npm run web:backend。' }));
  if (!response.ok) throw new Error(result.error || '网页服务暂时不可用。');
  return result as T;
}

export default function WebWorkspace() {
  const [saved] = useState(() => { try { return parseReading(localStorage.getItem(READING_KEY)); } catch { return null; } });
  const [url, setUrl] = useState(saved?.url || '');
  const [language, setLanguage] = useState<keyof typeof languages>((saved?.language as keyof typeof languages) || 'zh-CN');
  const [sessionId, setSessionId] = useState('');
  const [status, setStatus] = useState<WebStatus | null>(null);
  const [opening, setOpening] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [linked, setLinked] = useState(true);
  const [zoom, setZoom] = useState(saved?.zoom || 1);
  const [mode, setMode] = useState<'desktop'|'adaptive'>(saved?.mode || 'desktop');
  const [fit, setFit] = useState(saved?.fit ?? true);
  const [scale, setScale] = useState(1);
  const [inspection, setInspection] = useState<ParagraphInspection|null>(null);
  const [inspectMode, setInspectMode] = useState(false);
  const [readingNote, setReadingNote] = useState('');
  const [fullscreen, setFullscreen] = useState(false);
  const [showNotices, setShowNotices] = useState(false);
  const fullscreenRef = useRef(fullscreen); fullscreenRef.current = fullscreen;
  const fullscreenButton = useRef<HTMLButtonElement>(null);
  const exitReading = () => {
    if(!fullscreenRef.current)return false;
    setFullscreen(false);setShowNotices(false);fullscreenButton.current?.focus();return true;
  };
  useEffect(()=>{
    if(!fullscreen)return;
    const previous=document.body.style.overflow;document.body.style.overflow='hidden';
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();exitReading();}};
    window.addEventListener('keydown',escape);
    return()=>{document.body.style.overflow=previous;window.removeEventListener('keydown',escape);};
  },[fullscreen]);
  const view = useRef({mode,fit,zoom,scale}); view.current = {mode,fit,zoom,scale};
  const applyLayout = useRef<(() => void)|null>(null);
  const restoring = useRef<ReadingPosition|null>(null);
  const documentUrl = useRef('');
  const lastSaved = useRef('');
  const bumpZoom = (delta:number) => { setFit(false); setZoom(Math.max(.25,Math.min(2,Math.round(view.current.scale*4)/4+delta))); };
  const persist = () => {
    if(!documentUrl.current || restoring.current || !mirror.current?.epoch) return;
    const position=mirror.current.getReadingPosition();if(!position)return;
    const state:SavedReading = {version:1,url:documentUrl.current,language:languageRef.current,...view.current,position,panX:roots.current[0]?.parentElement?.scrollLeft || 0};
    const raw=JSON.stringify(state); if(raw===lastSaved.current)return;
    try { localStorage.setItem(READING_KEY,raw);lastSaved.current=raw; } catch { setReadingNote('此浏览器无法保存阅读位置，刷新后需重新打开。'); }
  };
  const [renderBroken, setRenderBroken] = useState(false);
  const [offline, setOffline] = useState(false);
  const roots = useRef<(HTMLDivElement | null)[]>([null, null]);
  const mirror = useRef<WebMirror | null>(null);
  const activeId = useRef('');
  const generation = useRef(0);
  const languageRef = useRef(language); languageRef.current = language;
  const linkedRef = useRef(linked); linkedRef.current = linked;
  const zoomRef = useRef(zoom); zoomRef.current = zoom;
  const dirty = useRef(false);
  const reconnect = useRef<(() => void) | null>(null);
  const sendCommand = useCallback((command: WebCommand) => {
    const id = activeId.current;
    if (id) void request(`/api/web/sessions/${id}/commands`, { ...command, requestId: crypto.randomUUID() }).catch(reason => {
      if (activeId.current === id && !['hover', 'unhover', 'focus', 'blur', 'scroll', 'resize'].includes(command.type)) setError(reason.message);
    });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/web/health', { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error();
      const data = await response.json(); setOffline(false);
      if (!data.configured) setError('请在 .env 中填写 OPENAI_API_KEY，再重启网页服务。');
      else if (data.mode === 'mock') setError('当前为 mock 模式，不会生成译文。请切换为 openai 后重启网页服务。');
    }).catch(() => { if (!controller.signal.aborted) setOffline(true); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!sessionId || !roots.current[0] || !roots.current[1]) return;
    activeId.current = sessionId;
    const instance = new WebMirror(roots.current as HTMLDivElement[], sendCommand, bumpZoom, () => { setRenderBroken(true); setError('网页部分结构无法还原，请重新打开网址或尝试其他网页。'); }, {inspect:setInspection,escape:exitReading,interacted:()=>{if(restoring.current){restoring.current=null;setReadingNote('已继续阅读，位置会自动保存。');}}});
    mirror.current = instance; instance.inspectMode=inspectMode; instance.setLanguage(languageRef.current); instance.setLinked(linkedRef.current);
    let stream: EventSource;
    let restorationStarted=0; let matchedRestore=false; let latestStatus:WebStatus|null=null;
    const saveTimer=setInterval(()=>{
      if(restoring.current && latestStatus && !latestStatus.loading && instance.players[0].iframe.contentDocument?.body) {
        restorationStarted ||= Date.now();
        const elapsed=Date.now()-restorationStarted;
        const matched=instance.restoreReadingPosition(restoring.current,elapsed>2500);matchedRestore ||= matched;
        if(elapsed>2500){roots.current.forEach(root=>{if(root?.parentElement)root.parentElement.scrollLeft=saved?.panX||0;});restoring.current=null;setReadingNote(matchedRestore?'已恢复上次阅读位置。':'页面内容已变化，已按阅读进度恢复。');}
      }
      persist();
    },500);
    let recoveryTimer: ReturnType<typeof setTimeout>;
    const connect = () => {
    stream?.close();
    stream = new EventSource(`/api/web/sessions/${sessionId}/stream`);
    const current = stream;
    let lastSequence = -1;
    stream.onopen = () => { if (current === stream) setConnected(false); };
    stream.onerror = () => {
      if (current !== stream || activeId.current !== sessionId) return;
      setConnected(false);
      fetch(`/api/web/sessions/${sessionId}`).then(async response => {
        if (response.status === 404 && activeId.current === sessionId) { stream.close(); setError('网页会话已结束，请重新打开网址。'); }
      }).catch(() => {});
    };
    stream.onmessage = event => {
      if (current !== stream || activeId.current !== sessionId) return;
      const data = JSON.parse(event.data);
      if (data.type === 'bootstrap') {
        lastSequence = data.sequence; setError(''); setRenderBroken(false); setConnected(true);
        instance.bootstrap(data.epoch, data.events, data.translations, data.language); return;
      }
      if (data.sequence <= lastSequence) return;
      if (data.sequence !== lastSequence + 1) { stream.close(); setConnected(false); setError('网页同步中断，正在恢复页面状态…'); clearTimeout(recoveryTimer); recoveryTimer = setTimeout(connect, 500); return; }
      lastSequence = data.sequence;
      if (data.type === 'reset') instance.reset(data.epoch);
      else if (data.type === 'record' && data.epoch === instance.epoch) instance.record(data.event);
      else if (data.type === 'translations') instance.translations(data.epoch, data.language, data.entries);
      else if (data.type === 'language') instance.setLanguage(data.language);
      else if (data.type === 'translation-reset' && data.epoch === instance.epoch && data.language === instance.language) instance.clearTranslation(data.id);
      else if (data.type === 'status') {
        latestStatus=data;setStatus(data);instance.setBlocks(data.blocks);
        if(data.epoch===instance.epoch&&!data.loading&&data.url!=='about:blank')documentUrl.current=data.url;
        if (!dirty.current && data.url && data.url !== 'about:blank') setUrl(data.url);
      }
    };
    };
    reconnect.current = connect; connect();
    let resizeTimer: ReturnType<typeof setTimeout>;
    const resize = () => {
      const hosts = roots.current.map(root => root?.parentElement);
      const paneWidth=Math.min(...hosts.map(host=>host?.clientWidth||680));
      const paneHeight=Math.max(280,Math.floor(Math.min(...hosts.map(host=>host?.clientHeight||500))));
      const layout=viewportLayout({paneWidth,paneHeight,...view.current});
      setScale(layout.scale);instance.dimensions(layout.width,paneHeight,layout.scale);clearTimeout(resizeTimer);
      resizeTimer=setTimeout(()=>sendCommand({type:'resize',width:layout.width,height:layout.height}),250);
    };
    const observer = new ResizeObserver(resize);
    roots.current.forEach(root => { if (root?.parentElement) observer.observe(root.parentElement); }); applyLayout.current=resize;resize();
    const hosts=roots.current.map(root=>root?.parentElement);
    const pan=(event:Event)=>{const host=event.target as HTMLElement;if(linkedRef.current)hosts.forEach(other=>{if(other&&other!==host&&Math.abs(other.scrollLeft-host.scrollLeft)>1)other.scrollLeft=host.scrollLeft;});};
    hosts.forEach(host=>host?.addEventListener('scroll',pan));
    const close = () => { persist();void request(`/api/web/sessions/${sessionId}`, undefined, 'DELETE').catch(() => {}); };
    window.addEventListener('pagehide', close);
    return () => {
      close();clearInterval(saveTimer);hosts.forEach(host=>host?.removeEventListener('scroll',pan));applyLayout.current=null;
      stream.close(); clearTimeout(recoveryTimer); reconnect.current = null; observer.disconnect(); clearTimeout(resizeTimer); instance.destroy();
      window.removeEventListener('pagehide', close);
      if (activeId.current === sessionId) activeId.current = '';
      if (mirror.current === instance) mirror.current = null;
    };
  }, [sessionId, sendCommand]);
  useEffect(() => {applyLayout.current?.();},[zoom,mode,fit]);
  useEffect(() => {if(mirror.current)mirror.current.inspectMode=inspectMode;},[inspectMode]);
  useEffect(() => { mirror.current?.setLinked(linked); }, [linked]);
  useEffect(() => () => { generation.current++; }, []);

  const open = async (value: string, restore=false) => {
    const ticket = ++generation.current;
    let parsed: URL;
    try {
      const text = value.trim(); if (!text) throw new Error();
      parsed = new URL(text.includes('://') ? text : `https://${text}`);
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
    } catch { setError('请输入有效的 HTTP / HTTPS 公开网页地址。'); return; }
    restoring.current=restore?saved?.position||null:null;documentUrl.current='';setReadingNote(restore?saved?.position?'正在恢复上次阅读…':'已重新打开上次网页。':'');setInspection(null);
    setOpening(true); setError(''); dirty.current = false; setUrl(parsed.href);
    try {
      const paneWidth=roots.current[0]?.parentElement?.clientWidth||Math.max(320,(window.innerWidth-90)/2);
      const layout=viewportLayout({paneWidth,paneHeight:500,...view.current});
      const result = await request<{ id: string }>('/api/web/sessions', { url: parsed.href, language, width:layout.width, height:layout.height });
      if (ticket !== generation.current) { void request(`/api/web/sessions/${result.id}`, undefined, 'DELETE').catch(() => {}); return; }
      setStatus(null); setRenderBroken(false); setConnected(false); setSessionId(result.id); setOffline(false);
    } catch (reason) { if (ticket === generation.current) setError(reason instanceof Error ? reason.message : '网页打开失败。'); }
    finally { if (ticket === generation.current) setOpening(false); }
  };
  useEffect(()=>{const timer=setTimeout(()=>{if(saved?.url)void open(saved.url,true);},0);return()=>clearTimeout(timer);},[]);
  const submit = (event: FormEvent) => { event.preventDefault(); void open(url); };
  const navigation = (action: string) => {persist();restoring.current=null;setInspection(null);setError(''); dirty.current = false; sendCommand({ type: 'navigate', action }); };
  const summary = !sessionId ? '等待打开网页' : !connected ? '连接恢复中…' : status?.loading ? '正在加载网页…' : status?.translating ? `正在翻译 · ${status.completed} / ${status.total} 段${status.failed ? ` · ${status.failed} 段未完成` : ''}` : status?.translationError ? `已翻译 ${status.completed} / ${status.total} 段 · 部分未完成` : status?.total ? `已翻译 ${status.completed} / ${status.total} 段` : status?.metrics.captureMs != null ? '当前页面没有可翻译文字' : '正在识别网页文本…';
  const shownError = error || status?.error || '';
  const noticeCount = Number(!!shownError)+Number(offline)+Number(!!status?.translationError)+Number(!!sessionId&&!connected)+Number(!!status?.resourceFailures);

  return <main className={`app-shell web-demo-shell web-live-shell ${fullscreen?'is-fullscreen-reading':''}`}>
    <AppHeader active="web" />
    <div className="web-workspace">
      {fullscreen&&<div className="fullscreen-reading-bar"><strong title={status?.url||url}>{status?.url||url||'网页对照阅读'}</strong><span role="status">{opening?'正在创建会话…':summary}</span>{noticeCount>0&&<button className="reading-tool" aria-expanded={showNotices} aria-controls="web-notices" onClick={()=>setShowNotices(value=>!value)}>{noticeCount} 项提示</button>}<small>Esc 退出</small></div>}
      <div className="web-page-heading"><div><AppLink href="/" className="back-link"><ArrowLeft size={15} />返回首页</AppLink><h1>一个网页，两种语言。</h1><p>保留原站排版，从任意一侧继续浏览。</p></div><span className="web-status" role="status">{opening ? '正在创建会话…' : summary}</span></div>
      <section className="web-controls" aria-label="网页配置">
        <form onSubmit={submit} noValidate className="url-form">
          <label className={`url-input-wrap ${shownError ? 'has-error' : ''}`}><GlobeHemisphereWest size={20} /><input aria-label="网页地址" aria-invalid={!!shownError} aria-describedby={shownError ? 'url-error' : 'web-scope'} value={url} onChange={event => { dirty.current = true; setUrl(event.target.value); setError(''); }} placeholder="粘贴公开网页地址，例如 https://example.com" autoComplete="off" spellCheck={false} /></label>
          <label className="target-language"><span>翻译为</span><select aria-label="目标语言" disabled={opening} value={language} onChange={event => { const next = event.target.value as keyof typeof languages; setLanguage(next); setError(''); mirror.current?.setLanguage(next); sendCommand({ type: 'language', language: next }); }}>{Object.entries(languages).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          <button className="primary-button" type="submit" disabled={opening}>{opening ? '正在打开…' : '打开并翻译'}<ArrowRight size={17} /></button>
        </form>
        {shownError && <div className="url-error web-recovery" id="url-error" role="alert"><span>{shownError}</span>{sessionId && <button onClick={() => navigation('reload')}>重新载入网页</button>}</div>}
        <div className="sample-picker"><span>试试公开网页</span>{examples.map(([label, address]) => <button key={label} disabled={opening} onClick={() => void open(address)}>{label}</button>)}<span id="web-scope" className="demo-scope">支持公开文章、文档和产品页</span></div>
      </section>
      <div id="web-notices" className={`web-notices ${showNotices?'is-open':''}`}>
      {fullscreen&&shownError&&<div className="web-service-note web-recovery" role="alert"><span>{shownError}</span>{sessionId&&<button onClick={()=>navigation('reload')}>重新载入网页</button>}</div>}
      {offline && <div className="web-service-note" role="alert">网页服务尚未启动。<span>在项目终端运行 <code>npm run web:backend</code>，然后打开网址。</span></div>}
      {status?.translationError && <div className="web-service-note web-translation-warning" role="alert"><span>{status.translationError} 未完成的内容保留原文。</span><button onClick={() => sendCommand({ type: 'retry' })}>重试翻译</button></div>}
      {sessionId && !connected && <div className="web-service-note web-recovery" role="alert"><span>连接已断开，正在恢复。页面操作暂时暂停。</span><button onClick={() => reconnect.current?.()}>重新连接</button><button onClick={() => void open(url)}>重新打开网址</button></div>}
      {!!status?.resourceFailures && <div className="web-service-note web-recovery" role="alert"><span>{status.resourceFailures} 项图片、字体或样式未加载，页面可能显示不完整。</span><button onClick={() => sendCommand({ type: 'resources' })}>重试资源</button></div>}
      </div>
      <div className="comparison-controls">
        <div className="sync-controls"><div className="web-history">{[['back','网页后退',ArrowLeft],['forward','网页前进',ArrowRight],['reload','重新载入网页',ArrowsClockwise]].map(([action,label,Icon]) => { const Glyph = Icon as typeof ArrowLeft; return <button key={action as string} className="icon-button" aria-label={label as string} disabled={!sessionId || !connected || opening} onClick={() => navigation(action as string)}><Glyph size={16} /></button>; })}</div><button className={`sync-toggle ${linked ? 'is-linked' : ''}`} role="switch" aria-checked={linked} onClick={() => setLinked(value => !value)}>{linked ? <LinkSimple size={17} /> : <LinkSimpleBreak size={17} />}<span>滚动联动{linked ? '开启' : '关闭'}</span><i aria-hidden="true" /></button></div>
        <div className="zoom-controls"><label className="viewport-mode"><span>网页视口</span><select aria-label="网页视口" value={mode} onChange={event=>setMode(event.target.value as typeof mode)}><option value="desktop">桌面网页</option><option value="adaptive">自适应视口</option></select></label><button className="reading-tool" aria-pressed={fit} onClick={()=>setFit(value=>!value)}>适应宽度</button><button className="icon-button" aria-label="缩小两侧页面" disabled={!fit&&zoom<=.25} onClick={()=>bumpZoom(-.25)}><Minus size={15} /></button><select aria-label="两侧缩放比例" value={fit?'fit':zoom} onChange={event=>{setFit(false);setZoom(Number(event.target.value));}}>{fit&&<option value="fit">{Math.round(scale*100)}%（适应）</option>}{[.25,.5,.75,1,1.25,1.5,1.75,2].map(value => <option key={value} value={value}>{Math.round(value * 100)}%</option>)}</select><button className="icon-button" aria-label="放大两侧页面" disabled={!fit&&zoom>=2} onClick={()=>bumpZoom(.25)}><Plus size={15} /></button><button className="icon-button" aria-label="重置缩放为 100%" disabled={!fit&&zoom===1} onClick={()=>{setFit(false);setZoom(1);}}><ArrowCounterClockwise size={17} /></button></div>
      </div>
      <div className="reading-controls"><button className="reading-tool" disabled={!connected} aria-pressed={inspectMode} onClick={()=>setInspectMode(value=>!value)}>查看段落原文</button><button className="reading-tool" disabled={!connected||!status?.blocks.some(block=>block.state!=='translated')} onClick={()=>mirror.current?.locateUntranslated()}>定位未译段落</button><span role="status">{inspectMode?'点击任意一侧的段落查看原文；关闭后继续网页交互。':readingNote||'阅读位置自动保存在此浏览器。'}</span><button ref={fullscreenButton} className="reading-tool fullscreen-reading-toggle" aria-pressed={fullscreen} onClick={()=>{setFullscreen(value=>!value);setShowNotices(false);}}>{fullscreen?<ArrowsIn size={15}/>:<ArrowsOut size={15}/>} {fullscreen?'退出全屏':'全屏阅读'}</button></div>
      {inspection&&<aside className="paragraph-inspector" aria-label="段落对照"><div className="inspector-heading"><strong>{inspection.block.attribute?`${inspection.block.attribute} 文案`:'段落对照'}</strong><span>{{pending:'等待翻译',translating:'正在翻译',translated:'已翻译',failed:'翻译未完成'}[inspection.block.state]}</span><button disabled={!connected||inspection.block.state==='translating'} onClick={()=>sendCommand({type:'retry',epoch:mirror.current?.epoch,id:inspection.block.id,key:inspection.block.key})}>重译这一段</button><button aria-label="关闭段落对照" onClick={()=>{mirror.current?.closeInspection();setInspectMode(false);}}>关闭</button></div><div className="inspector-text"><div><small>原文</small><p>{inspection.source}</p></div><div><small>译文</small><p>{inspection.block.state==='translated'?inspection.translated:inspection.block.state==='failed'?'该段未完成，可单独重试。':'译文完成后会显示在这里。'}</p></div></div></aside>}
      <section className="web-comparison" aria-label="网页翻译对照">
        {([0,1] as const).map(side => <section className={`web-pane ${side === 0 ? 'web-source' : 'web-target'}`} aria-label={side === 0 ? '左侧原文页面' : '右侧译文页面'} key={side}>
          <header className="web-pane-heading"><div><span className="pane-language-mark">{side === 0 ? 'A' : '文'}</span><strong>{side === 0 ? '原文页面' : '译文页面'}</strong><span>{side === 0 ? '自动检测语言' : languages[language]}</span></div><span>{sessionId ? side === 0 ? '原站结构' : status?.translating ? '逐段翻译中' : '对照阅读' : ''}</span></header>
          <div className={`web-viewport mirror-host ${(!connected || renderBroken) && sessionId ? 'is-disconnected' : ''}`}><div className="mirror-root" ref={node => { roots.current[side] = node; }} />
            {!sessionId && <div className="web-empty"><GlobeHemisphereWest size={32} weight="light" /><h2>{side === 0 ? '从一个网址开始' : '在原有排版里阅读译文'}</h2><p>{side === 0 ? '粘贴地址，或选择上方公开网页。' : '两侧共享页面状态，滚动、缩放和常见交互同步。'}</p></div>}
            {renderBroken && <div className="mirror-loading" role="alert">页面还原失败，请使用上方按钮重新载入。</div>}
            {sessionId && !renderBroken && (!connected || status?.loading) && <div className="mirror-loading" role="status">{!connected ? '正在连接网页…' : '正在加载网页…'}</div>}
          </div>
        </section>)}
      </section>
      <footer className="web-demo-footer"><span>双侧可操作 · Ctrl / Cmd + 滚轮缩放</span><span>{status?.metrics.firstTranslationMs != null ? `首段 ${(status.metrics.firstTranslationMs / 1000).toFixed(1)}s · 视口 ${status.viewportCompleted}/${status.viewport} 段 · ${status.metrics.requests} 次请求 · ${status.metrics.usageReports ? `${status.metrics.inputTokens + status.metrics.outputTokens} tokens` : '用量待返回'}${status.metrics.estimatedCostUsd !== null ? ` · 约 $${status.metrics.estimatedCostUsd.toFixed(4)}` : ''}` : ''}</span><span>{status?.limited ? '当前页面超过 3000 段，仅翻译前 3000 段可见文本' : '图片内文字、视频、登录与复杂表单暂不支持'}</span></footer>
    </div>
  </main>;
}
