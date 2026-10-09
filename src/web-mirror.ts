import { readScrollAnchor, type ScrollAnchor } from '../shared/web-scroll.mjs';
import type { ReadingPosition } from '../shared/web-reading.mjs';
import { Replayer } from '@rrweb/replay';
import type { eventWithTime } from '@rrweb/types';

export type TranslationEntry = { id: number; nodeId?: number; attribute?: string; source: string; text: string; key: string; parts?: { id: number; source: string; text: string }[]; guards?: { id: number; source: string }[] };
export type WebStatus = { url: string; language: string; epoch: string; loading: boolean; total: number; completed: number; failed: number; error: string; translationError: string; translating: boolean; title: string; limited: boolean; resourceFailures: number; blocks:ReadingBlock[]; viewport: number; viewportCompleted: number; metrics: { captureMs: number | null; firstTranslationMs: number | null; viewportMs: number | null; requests: number; failures: number; usageReports: number; estimatedCostUsd: number | null; inputTokens: number; outputTokens: number; cacheHits: number; durations: number[] } };
export type WebCommand = { type: string; [key: string]: unknown };
export type ReadingBlock = { id:number; elementId?:number; nodeId?:number; attribute?:string; key:string; state:'pending'|'translating'|'translated'|'failed' };
export type ParagraphInspection = { block:ReadingBlock; source:string; translated:string };
type Side = 0 | 1;
type Anchor = ScrollAnchor;

export class WebMirror {
  players: Replayer[] = [];
  epoch = '';
  language = 'zh-CN';
  entries = new Map<number, TranslationEntry>();
  linked = true;
  zoom = 1;
  width = 680;
  height = 500;
  lastSide: Side = 0;
  inspectMode = false;
  private blocks: ReadingBlock[] = [];
  private selected: number | null = null;
  private bindings = new Map<Side, (() => void)[]>();
  private expected = new WeakMap<Element, { top: number; left: number }>();
  private lastUserScroll = 0;
  private scrollTimer?: ReturnType<typeof setTimeout>;
  private hoverTimer?: ReturnType<typeof setTimeout>;
  private paintFrame = 0;
  private disposed = false;
  private lastHover = -1;

  constructor(private roots: HTMLElement[], private command: (value: WebCommand) => void, private changeZoom: (delta: number) => void, private renderError: () => void, private reading: { inspect?:(value:ParagraphInspection|null)=>void; interacted?:()=>void } = {}) { this.roots=[...roots]; this.createPlayers(); }
  private createPlayers() {
    this.players = this.roots.map((root, side) => {
      const player = new Replayer([], { root, liveMode: true, mouseTail: false, showWarning: true, useVirtualDom: false,
        logger: { log: () => {}, warn: (...args: unknown[]) => { if (args.some(arg => typeof arg === 'string' && arg.includes('Exception in mutation'))) this.renderError(); } },
        triggerFocus: false, insertStyleRules: ['html { scroll-behavior: auto !important; }','.transflow-selected-paragraph { outline: 2px solid #39785b !important; outline-offset: 3px !important; }'] });
      player.iframe.title = side === 0 ? '原文网页，可操作' : '译文网页，可操作';
      player.on('fullsnapshot-rebuilded', () => { this.bind(side as Side); this.dimensions(); this.repaint(); });
      player.on('event-cast', () => this.repaint());
      player.on('resize', () => this.dimensions());
      player.enableInteract(); player.startLive(Date.now() - 100);
      return player;
    });
    this.dimensions();
  }
  reset(epoch: string) {
    this.bindings.forEach(cleanups => cleanups.forEach(fn => fn())); this.bindings.clear();
    this.players.forEach(player => player.destroy());
    this.roots.forEach(root => root.replaceChildren());
    this.entries.clear(); this.blocks = []; this.selected = null; this.reading.inspect?.(null); this.epoch = epoch; this.lastHover = -1;
    this.createPlayers();
  }
  bootstrap(epoch: string, events: eventWithTime[], entries: TranslationEntry[], language: string) {
    this.reset(epoch); this.language = language;
    for (const event of events) this.record(event);
    for (const entry of entries) this.entries.set(entry.id, entry);
    this.repaint();
  }
  record(event: eventWithTime) {
    if (event.type === 3 && event.data.source === 3) {
      if (Date.now() - this.lastUserScroll > 800) {
        const scroll = event.data, anchor = (event as eventWithTime & { transflowAnchor?: Anchor }).transflowAnchor;
        requestAnimationFrame(() => { if (anchor) { this.follow(0, anchor); if (this.linked) this.follow(1, anchor); } else this.remoteScroll(scroll.id, scroll.x, scroll.y); });
      }
      return;
    }
    // Clock-independent live delivery. Buffered reconnect events cast immediately.
    const snapshotAnchor = event.type === 2 ? (event as eventWithTime & { transflowAnchor?: Anchor }).transflowAnchor : undefined;
    const immediate = { ...event, timestamp: Date.now() - 150 } as eventWithTime;
    if (event.type === 2 && snapshotAnchor && immediate.type === 2) immediate.data = { ...event.data, initialOffset: { left: 0, top: 0 } };
    this.players.forEach(player => player.addEvent(immediate));
    if (snapshotAnchor) requestAnimationFrame(() => { this.follow(0, snapshotAnchor); if (this.linked) this.follow(1, snapshotAnchor); });
  }
  translations(epoch: string, language: string, entries: TranslationEntry[]) {
    if (epoch !== this.epoch || language !== this.language) return;
    entries.forEach(entry => this.entries.set(entry.id, entry)); this.repaint();
  }
  setLanguage(language: string) {
    const source = this.players[0].getMirror(), target = this.players[1].getMirror();
    for (const { id, nodeId, attribute, parts } of this.entries.values()) {
      for (const part of parts || []) {
        const original = source.getNode(part.id), translated = target.getNode(part.id);
        if (original && translated?.nodeType === 3) translated.textContent = original.textContent;
      }
      if (parts) continue;
      const original = source.getNode(nodeId ?? id), translated = target.getNode(nodeId ?? id);
      if (attribute && original?.nodeType === 1 && translated?.nodeType === 1) {
        const value = (original as Element).getAttribute(attribute);
        if (value !== null) (translated as Element).setAttribute(attribute, value);
      } else if (original && translated?.nodeType === 3) translated.textContent = original.textContent;
    }
    this.entries.clear(); this.language = language;
  }
  private repaint() {
    if (this.paintFrame || this.disposed) return;
    this.paintFrame = requestAnimationFrame(() => {
      this.paintFrame = 0;
      const source = this.players[0].getMirror(), target = this.players[1].getMirror();
      if (this.entries.size && !this.players[0].iframe.contentDocument?.body) { this.renderError(); return; }
      const anchor = this.linked ? this.anchor(this.lastSide) : null;
      let changed = false;
      for (const [id, entry] of this.entries) {
        if (entry.parts) {
          if ((entry.guards || entry.parts).some(part => source.getNode(part.id)?.textContent !== part.source)) { this.entries.delete(id); continue; }
          // Validate the entire paragraph before applying any slot, avoiding a
          // mixture of stale/new fragments during live DOM updates.
          if (entry.parts.some(part => target.getNode(part.id)?.nodeType !== 3)) continue;
          for (const part of entry.parts) { const node = target.getNode(part.id)!; if (node.textContent !== part.text) { node.textContent = part.text; changed = true; } }
          continue;
        }
        const original = source.getNode(entry.nodeId ?? id), translated = target.getNode(entry.nodeId ?? id);
        const value = entry.attribute && original?.nodeType === 1 ? (original as Element).getAttribute(entry.attribute) : original?.textContent;
        if (value !== entry.source) { this.entries.delete(id); continue; }
        if (entry.attribute && translated?.nodeType === 1) {
          if ((translated as Element).getAttribute(entry.attribute) !== entry.text) (translated as Element).setAttribute(entry.attribute, entry.text);
        } else if (translated?.nodeType === 3 && translated.textContent !== entry.text) { translated.textContent = entry.text; changed = true; }
      }
      if (changed && anchor && this.linked) this.follow(this.lastSide === 0 ? 1 : 0, anchor);
      this.notifyInspection();
    });
  }
  dimensions(width = this.width, height = this.height, zoom = this.zoom) {
    this.width = width; this.height = height; this.zoom = zoom;
    const logicalHeight = Math.max(120, Math.min(2400, Math.floor(height / zoom)));
    this.players.forEach((player, side) => {
      this.roots[side].style.zoom = String(zoom);
      player.wrapper.style.width = `${width}px`;
      player.wrapper.style.height = `${logicalHeight}px`;
      player.iframe.width = String(width);
      player.iframe.height = String(logicalHeight);
      player.iframe.style.display = 'block';
    });
  }
  setLinked(value: boolean) {
    this.linked = value;
    const anchor = this.anchor(this.lastSide);
    if (value && anchor) this.follow(this.lastSide === 0 ? 1 : 0, anchor);
  }
  setBlocks(blocks:ReadingBlock[]) { this.blocks = blocks || []; this.notifyInspection(); }
  clearTranslation(id:number) {
    const entry = this.entries.get(id), source = this.players[0].getMirror(), target = this.players[1].getMirror();
    for (const part of entry?.parts || []) { const original=source.getNode(part.id), node=target.getNode(part.id); if(original && node) node.textContent=original.textContent; }
    if (entry?.attribute) { const original=source.getNode(entry.nodeId ?? id),node=target.getNode(entry.nodeId ?? id); if(original?.nodeType===1&&node?.nodeType===1) (node as Element).setAttribute(entry.attribute,(original as Element).getAttribute(entry.attribute)||''); }
    else if(entry&&!entry.parts) { const original=source.getNode(id),node=target.getNode(id);if(original&&node?.nodeType===3)node.textContent=original.textContent; }
    this.entries.delete(id); this.repaint();
  }
  private blockNode(block:ReadingBlock,side:Side):Element|null {
    const node=this.players[side].getMirror().getNode(block.elementId ?? block.nodeId ?? block.id);
    return node?.nodeType===1 ? node as Element : node?.parentElement || null;
  }
  private notifyInspection() {
    if(this.selected===null) return;
    const block=this.blocks.find(block=>block.id===this.selected),source=block&&this.blockNode(block,0),target=block&&this.blockNode(block,1);
    if(!block||!source||!target){ this.selected=null;this.reading.inspect?.(null);return; }
    source.classList.add('transflow-selected-paragraph');target.classList.add('transflow-selected-paragraph');
    this.reading.inspect?.({block,source:block.attribute?source.getAttribute(block.attribute)||'':source.textContent||'',translated:block.attribute?target.getAttribute(block.attribute)||'':target.textContent||''});
  }
  inspectParagraph(id:number) {
    this.closeInspection(); this.selected=id;
    const block=this.blocks.find(block=>block.id===id);
    if(block) for(const side of [0,1] as const) this.blockNode(block,side)?.classList.add('transflow-selected-paragraph');
    this.notifyInspection();
  }
  closeInspection() {
    const block=this.blocks.find(block=>block.id===this.selected);
    if(block) for(const side of [0,1] as const) this.blockNode(block,side)?.classList.remove('transflow-selected-paragraph');
    this.selected=null; this.reading.inspect?.(null);
  }
  locateUntranslated() {
    const candidates=this.blocks.filter(block=>block.state!=='translated'&&this.blockNode(block,0));
    candidates.sort((a,b)=>{const x=this.blockNode(a,0)!,y=this.blockNode(b,0)!;return x===y?0:x.compareDocumentPosition(y)&Node.DOCUMENT_POSITION_FOLLOWING?-1:1;});
    const block=candidates[(candidates.findIndex(block=>block.id===this.selected)+1)%candidates.length];
    if(!block) return false;
    const node=this.blockNode(block,0)!;
    node.scrollIntoView({block:'center',behavior:'instant'});
    const anchor=this.anchor(0); if(anchor&&this.linked) this.follow(1,anchor);
    this.inspectParagraph(block.id); return true;
  }
  getReadingPosition():ReadingPosition|null {
    const anchor=this.anchor(this.lastSide); if(!anchor) return null;
    const node=this.players[0].getMirror().getNode(anchor.id);
    if(node?.nodeType!==1) return null;
    return {domId:(node as Element).id.slice(0,200),tag:(node as Element).tagName,text:(node.textContent||'').replace(/\s+/g,' ').trim().slice(0,300),fraction:anchor.fraction,before:anchor.before,ratio:anchor.ratio,left:anchor.left};
  }
  restoreReadingPosition(position:ReadingPosition,fallback=false) {
    const doc=this.players[0].iframe.contentDocument; if(!doc?.body) return false;
    const nodes:Element[]=[];
    const collect=(root:Document|ShadowRoot)=>{for(const node of root.querySelectorAll('*')){nodes.push(node);if(node.shadowRoot)collect(node.shadowRoot);}};collect(doc);
    const matches=(node:Element)=>node.tagName===position.tag&&(node.textContent||'').replace(/\s+/g,' ').trim().slice(0,300)===position.text;
    const node=nodes.find(node=>position.domId&&node.id===position.domId&&matches(node))||nodes.find(matches);
    if(!node&&!fallback) return false;
    const anchor={...position,id:node?this.players[0].getMirror().getId(node):-1,containerId:0};
    this.follow(0,anchor);this.follow(1,anchor);
    if(node||fallback) this.command({type:'scroll',epoch:this.epoch,id:node?anchor.id:this.players[0].getMirror().getId(doc.documentElement),containerId:0,offset:node?position.fraction*node.getBoundingClientRect().height-position.before:undefined,ratio:position.ratio,left:position.left});
    return !!node;
  }
  private container(side: Side, id = 0): Element | null {
    const player = this.players[side], doc = player.iframe.contentDocument;
    if (!doc) return null;
    const node = id > 0 ? player.getMirror().getNode(id) : doc;
    return node?.nodeType === 9 ? doc.scrollingElement : node?.nodeType === 1 ? node as Element : doc.scrollingElement;
  }
  private anchor(side: Side, containerId = 0): Anchor | null {
    const player = this.players[side], doc = player.iframe.contentDocument, container = this.container(side, containerId);
    if (!doc || !container) return null;
    return readScrollAnchor(container, player.getMirror(), containerId);
  }
  private follow(side: Side, anchor: Anchor) {
    const container = this.container(side, anchor.containerId), player = this.players[side];
    if (!container) return;
    const node = player.getMirror().getNode(anchor.id);
    const doc = player.iframe.contentDocument;
    const origin = container === doc?.scrollingElement ? 0 : container.getBoundingClientRect().top;
    const rect = node?.nodeType === 1 ? (node as Element).getBoundingClientRect() : null;
    const range = container.scrollHeight - container.clientHeight;
    const top = anchor.ratio === 0 ? 0 : anchor.ratio >= 1 ? range : rect ? container.scrollTop + rect.top - origin + anchor.fraction * rect.height - anchor.before : anchor.ratio * range;
    const clamped = Math.max(0, Math.min(top, container.scrollHeight - container.clientHeight));
    this.expected.set(container, { top: clamped, left: anchor.left });
    container.scrollTo({ top: clamped, left: anchor.left, behavior: 'instant' });
  }
  private remoteScroll(id: number, left: number, top: number) {
    if (this.disposed) return;
    const container = this.container(0, id);
    if (!container) return;
    this.expected.set(container, { top, left }); container.scrollTo({ top, left, behavior: 'instant' });
    const anchor = this.anchor(0, id);
    if (anchor && this.linked) this.follow(1, anchor);
  }
  private scroll(side: Side, event: Event) {
    const doc = this.players[side].iframe.contentDocument;
    const target = event.target as Node;
    const container = target?.nodeType === 9 ? doc?.scrollingElement : target as Element;
    if (!container) return;
    const expected = this.expected.get(container);
    this.expected.delete(container);
    if (expected && Math.abs(container.scrollTop - expected.top) < 3 && Math.abs(container.scrollLeft - expected.left) < 3) return;
    this.lastUserScroll = Date.now(); this.lastSide = side;
    const containerId = container === doc?.scrollingElement ? 0 : this.players[side].getMirror().getId(container);
    const anchor = this.anchor(side, containerId);
    if (!anchor) return;
    if (this.linked) this.follow(side === 0 ? 1 : 0, anchor);
    clearTimeout(this.scrollTimer);
    this.scrollTimer = setTimeout(() => {
      const sourceNode = this.players[0].getMirror().getNode(anchor.id);
      const offset = sourceNode?.nodeType === 1 ? anchor.fraction * (sourceNode as Element).getBoundingClientRect().height - anchor.before : undefined;
      this.command({ type: 'scroll', epoch: this.epoch, id: anchor.id, containerId, offset, ratio: anchor.ratio, left: anchor.left });
    }, 140);
  }
  private bind(side: Side) {
    const player = this.players[side], doc = player.iframe.contentDocument;
    if (!doc) return;
    this.bindings.get(side)?.forEach(fn => fn());
    const cleanups: (() => void)[] = []; this.bindings.set(side, cleanups);
    const on = (type: string, listener: EventListener, options: AddEventListenerOptions | boolean = true) => {
      doc.addEventListener(type, listener, options); cleanups.push(() => doc.removeEventListener(type, listener, options));
    };
    const identify = (event: Event) => {
      const target = event.composedPath()[0] as Node;
      const node = target?.nodeType === 1 ? target as Element : target?.parentElement;
      return { node, id: node ? player.getMirror().getId(node) : -1 };
    };
    on('pointerdown',()=>this.reading.interacted?.());
    let composing = false;
    const sentInput = new WeakMap<Element, string>();
    const input = (event: Event) => {
      const { node, id } = identify(event);
      if (!node?.matches('textarea,input[type="text"],input[type="search"],input:not([type])') || id < 0) return;
      const value = (node as HTMLInputElement).value;
      if (sentInput.get(node) === value) return;
      sentInput.set(node, value); this.command({ type: 'input', epoch: this.epoch, id, value });
    };
    on('compositionstart', () => { composing = true; });
    on('compositionend', event => {
      composing = false;
      input(event);
    });
    const markFocus = (id: number) => {
      this.players.forEach(other => {
        other.iframe.contentDocument?.querySelectorAll('.transflow-focus,.transflow-focus-visible,.transflow-focus-within').forEach(node => node.classList.remove('transflow-focus','transflow-focus-visible','transflow-focus-within'));
        let node = other.getMirror().getNode(id);
        if (node?.nodeType === 1) (node as Element).classList.add('transflow-focus','transflow-focus-visible');
        while (node?.nodeType === 1) { (node as Element).classList.add('transflow-focus-within'); node = node.parentNode; }
      });
    };
    on('focusin', event => { const { id } = identify(event); if (id > 0) { markFocus(id); this.command({ type: 'focus', epoch: this.epoch, id }); } });
    on('focusout', event => { const { id } = identify(event); if (id > 0) { markFocus(-1); this.command({ type: 'blur', epoch: this.epoch, id }); } });
    on('click', event => {
      const { node, id } = identify(event);
      if (!node || id < 0) return;
      this.reading.interacted?.();
      if(this.inspectMode) {
        event.preventDefault();event.stopPropagation();
        let element:Element|null=node;
        while(element) {
          const block=this.blocks.find(block=>this.blockNode(block,side)===element);
          if(block){this.inspectParagraph(block.id);break;}
          const root=element.getRootNode();element=element.parentElement||(root.nodeType===11?(root as ShadowRoot).host:null);
        }
        return;
      }
      const input = node.closest('input,textarea');
      // Text focus/selection is local; all discrete site actions execute once.
      if (input && input.matches('textarea,input[type="text"],input[type="search"],input:not([type])')) return;
      event.preventDefault(); event.stopPropagation();
      this.command({ type: 'click', epoch: this.epoch, id });
    });
    on('submit', event => event.preventDefault());
    on('input', event => {
      if (composing || (event as InputEvent).isComposing) return;
      input(event);
    });
    on('keydown', event => {
      this.reading.interacted?.();
      const keyboard = event as KeyboardEvent, { node, id } = identify(event);
      if (!node || id < 0) return;
      if (node.matches('input,textarea') && [' ', 'ArrowLeft', 'ArrowRight'].includes(keyboard.key)) return;
      if (['Enter', 'Escape', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', ' '].includes(keyboard.key) && node.closest('input,textarea,button,a,summary,[role="tab"],[role="button"]')) {
        if (composing || keyboard.isComposing) return;
        event.preventDefault();
        this.command({ type: 'key', epoch: this.epoch, id, key: keyboard.key === ' ' ? 'Space' : keyboard.key });
      }
    });
    on('pointerover', event => {
      const { id } = identify(event);
      if (id === this.lastHover || id < 0) return;
      this.lastHover = id;
      this.players.forEach(other => {
        other.iframe.contentDocument?.querySelectorAll('.\\:hover').forEach(node => node.classList.remove(':hover'));
        let node = other.getMirror().getNode(id);
        while (node?.nodeType === 1) { (node as Element).classList.add(':hover'); node = node.parentNode; }
      });
      clearTimeout(this.hoverTimer);
      this.hoverTimer = setTimeout(() => this.command({ type: 'hover', epoch: this.epoch, id }), 180);
    });
    on('pointerout', event => {
      if ((event as PointerEvent).relatedTarget) return;
      const id = this.lastHover; this.lastHover = -1; clearTimeout(this.hoverTimer);
      this.players.forEach(other => other.iframe.contentDocument?.querySelectorAll('.\\:hover').forEach(node => node.classList.remove(':hover')));
      if (id >= 0) this.command({ type: 'unhover', epoch: this.epoch, id });
    });
    on('scroll', event => this.scroll(side, event));
    on('wheel', event => {
      this.reading.interacted?.();
      const wheel = event as WheelEvent;
      if (wheel.ctrlKey || wheel.metaKey) { event.preventDefault(); this.changeZoom(wheel.deltaY < 0 ? .25 : -.25); }
    }, { capture: true, passive: false });
  }
  destroy() {
    this.disposed = true; clearTimeout(this.scrollTimer); clearTimeout(this.hoverTimer); cancelAnimationFrame(this.paintFrame);
    this.bindings.forEach(cleanups => cleanups.forEach(fn => fn())); this.bindings.clear(); this.players.forEach(player => player.destroy());
    this.roots.forEach(root => root.replaceChildren());
  }
}
