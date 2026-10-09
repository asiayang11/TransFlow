import { readScrollAnchor } from '../../shared/web-scroll.mjs';
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { parsePublicUrl, publicAddress, publicFetch, createPublicProxy } from './network.mjs';
import { LANGUAGES, sourceKey, translateBatch } from './translation.mjs';

const recorder = await readFile(new URL('../../node_modules/@rrweb/record/dist/record.umd.cjs', import.meta.url), 'utf8');
const scrollInstrumentation = `window.__transflowReadAnchor = ${readScrollAnchor.toString()};\n`;
const instrumentation = await readFile(new URL('./recorder.js', import.meta.url), 'utf8');
const digest = text => createHash('sha256').update(text).digest('hex');
const allowedAsset = type => /^(image\/|font\/|text\/css|application\/(?:font|x-font|vnd.ms-fontobject|octet-stream))/.test(type);

export class BrowserSessions {
  constructor(config, { prepareContext = async () => {} } = {}) { this.config = config; this.sessions = new Map(); this.prepareContext = prepareContext; }
  async browser() {
    if (!this.browserPromise) this.browserPromise = (async () => {
      this.proxy = await createPublicProxy();
      try {
        return await chromium.launch({ headless: true, chromiumSandbox: true, proxy: { server: this.proxy.url },
          args: ['--proxy-bypass-list=<-loopback>', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--disable-quic'] });
      } catch { this.proxy.close(); this.browserPromise = null; throw new Error('Chromium 启动失败，请先运行 npm run web:install。'); }
    })();
    return this.browserPromise;
  }
  async create({ url, language = 'zh-CN', width = 680, height = 700 }) {
    parsePublicUrl(url); await publicAddress(new URL(url).hostname);
    if (!LANGUAGES[language]) throw new Error('不支持该目标语言。');
    if (this.sessions.size + (this.creating || 0) >= 3) throw new Error('最多同时打开三个网页会话，请先关闭其他工作区。');
    this.creating = (this.creating || 0) + 1;
    let context, session;
    try {
    const browser = await this.browser();
    context = await browser.newContext({ viewport: { width: Math.max(320, Math.min(1600, Math.round(Number(width) || 680))), height: Math.max(360, Math.min(1200, Math.round(Number(height) || 700))) },
      serviceWorkers: 'block', acceptDownloads: false, reducedMotion: 'reduce' });
    const page = await context.newPage();
    session = { id: randomBytes(24).toString('hex'), context, page, language, epoch: '', sequence: 0,
      events: [], meta: null, clients: new Set(), translations: new Map(), cache: new Map(), failed: new Map(),
      assets: new Map(), assetBytes: 0, assetPending: new Map(), assetUrls: new Map(), blockedNodes: new Set(), blocks: [], pending: new Set(),
      queue: Promise.resolve(), commands: new Map(), closed: false, lastSeen: Date.now(), loading: true, translationError: '', workers: 0, url, metrics: this.newMetrics(), resourceFailures: new Map() };
    this.sessions.set(session.id, session);
    page.setDefaultTimeout(8000);
    await context.route('**/*', async route => {
      const request = route.request();
      try {
        if (request.url().startsWith('data:') || request.url().startsWith('blob:')) return await route.continue();
        parsePublicUrl(request.url()); // Actual DNS checks/pinning happen on every proxy connection.
        if (request.resourceType() === 'media') return await route.abort();
        await route.continue();
      } catch { await route.abort().catch(() => {}); }
    });
    await context.routeWebSocket('**/*', socket => socket.close());
    page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
    page.on('download', download => download.cancel().catch(() => {}));
    context.on('page', popup => { if (popup !== page) popup.close().catch(() => {}); });
    page.on('response', response => {
      const type = response.headers()['content-type'] || '';
      if (response.ok() && allowedAsset(type)) response.body().then(body => this.cacheAsset(session, response.url(), { type, body, status: 200 })).catch(() => {});
    });
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame() && frame.url() !== 'about:blank') { session.url = frame.url(); this.status(session); }
    });
    await page.exposeBinding('__transflowEmit', ({ frame }, payload) => {
      if (frame !== page.mainFrame() || session.closed || !payload?.event) return;
      if (payload.epoch !== session.epoch) {
        for (const controller of session.controllers || []) controller.abort();
        session.epoch = payload.epoch; session.events = []; session.meta = null;
        session.translations.clear(); session.failed.clear(); session.blocks = []; session.priorityBlocks?.clear();
        session.translationError = ''; session.translationPaused = false; session.error = ''; session.metrics = this.newMetrics(); session.metrics.started = session.navigationStarted || Date.now(); session.navigationStarted = null; session.resourceFailures.clear();
        this.send(session, 'reset', { epoch: session.epoch });
      }
      const event = this.sanitizeEvent(session, payload.event);
      if (!event) return;
      if (event.type === 4) session.meta = event;
      if (event.type === 2 && session.metrics.captureMs === null) { session.metrics.captureMs = Date.now() - session.metrics.started; setTimeout(() => this.scan(session), 0); }
      if (event.type === 2) session.events = session.meta ? [session.meta, event] : [event];
      else session.events.push(event);
      this.send(session, 'record', { epoch: session.epoch, event });
      if (session.events.length > 3000 && !session.snapshotPending) {
        session.snapshotPending = true;
        page.evaluate(() => window.__transflow?.record.takeFullSnapshot()).catch(() => {}).finally(() => { session.snapshotPending = false; });
      }
    });
    await context.addInitScript({ content: `${recorder}\n;\n${scrollInstrumentation}${instrumentation}` });
    await this.prepareContext(context);
    session.timer = setInterval(() => this.scan(session), 900);
    // Return a session immediately so the UI can show actual navigation progress.
    session.queue = this.navigate(session, { url }).catch(error => { session.error = this.navigationError(error); this.status(session); });
    return session;
    } catch (error) {
      if (session) await this.close(session); else await context?.close().catch(() => {});
      throw error;
    } finally { this.creating--; }
  }
  navigationError(error) {
    const message = String(error?.message || '');
    if (message.includes('Timeout')) return '网页加载超时，可重试或换一个网址。';
    if (message.includes('ERR_')) return '网页无法访问，可能是网络限制、证书问题或站点阻止自动浏览。';
    return message.slice(0, 200) || '网页加载失败。';
  }
  send(session, type, data) {
    if (session.closed) return;
    const message = `data: ${JSON.stringify({ type, sequence: ++session.sequence, ...data })}\n\n`;
    for (const client of session.clients) {
      if (client.writableLength > 8 * 1024 * 1024) { client.destroy(); session.clients.delete(client); }
      else client.write(message);
    }
  }
  newMetrics() { return { started: Date.now(), captureMs: null, firstTranslationMs: null, viewportMs: null, requests: 0, failures: 0, failedRequests: 0, usageReports: 0, inputTokens: 0, outputTokens: 0, cacheHits: 0, durations: [] }; }
  entry(block, cached) {
    return { id: block.id, nodeId: block.nodeId, attribute: block.attribute, source: block.source, key: sourceKey(block), text: cached.text,
      parts: block.segments?.filter(part => !part.protected).map((part, index) => ({ ...part, text: cached.parts[index] })),
      guards: block.segments?.map(({ id, source }) => ({ id, source })) };
  }
  status(session) {
    const completed = session.blocks.filter(block => session.translations.get(block.id)?.key === sourceKey(block)).length;
    const failed = session.blocks.filter(block => session.failed.get(block.id) === sourceKey(block)).length;
    const data = { url: session.url, language: session.language, epoch: session.epoch, loading: session.loading,
      total: session.blocks.length, completed, failed, error: session.error || '', translationError: session.translationError,
      blocks: session.blocks.map(block => ({ id:block.id, elementId:block.elementId, nodeId:block.nodeId, attribute:block.attribute, key:sourceKey(block), state:session.translations.get(block.id)?.key === sourceKey(block) ? 'translated' : session.failed.get(block.id) === sourceKey(block) ? 'failed' : session.pending.has(`${session.epoch}:${session.language}:${sourceKey(block)}`) ? 'translating' : 'pending' })),
      resourceFailures: session.resourceFailures.size, metrics: { ...session.metrics, started: undefined, estimatedCostUsd: session.metrics.usageReports && this.config.inputPrice != null && this.config.outputPrice != null ? (session.metrics.inputTokens * this.config.inputPrice + session.metrics.outputTokens * this.config.outputPrice) / 1000000 : null }, viewport: session.blocks.filter(block => block.viewport).length, viewportCompleted: session.blocks.filter(block => block.viewport && session.translations.has(block.id)).length,
      translating: session.pending.size > 0, title: session.title || '', limited: session.blocks.length >= 3000 };
    this.send(session, 'status', data); return data;
  }
  attach(session, response) {
    session.lastSeen = Date.now();
    response.write(`data: ${JSON.stringify({ type: 'bootstrap', sequence: session.sequence, epoch: session.epoch,
      events: session.events, translations: [...session.translations.values()], language: session.language })}\n\n`);
    session.clients.add(response); this.status(session);
    const heartbeat = setInterval(() => { session.lastSeen = Date.now(); response.write(': heartbeat\n\n'); }, 15000);
    response.on('close', () => { clearInterval(heartbeat); session.clients.delete(response); });
  }
  assetUrl(session, value, base = session.url) {
    if (!value || value.startsWith('#') || /^data:(?:image|font)\//i.test(value)) return value;
    try {
      const url = new URL(value, base).href;
      parsePublicUrl(url);
      const key = digest(url);
      if (session.assetUrls.size > 4000 && !session.assetUrls.has(key)) return 'data:,';
      session.assetUrls.set(key, url);
      return `/api/web/sessions/${session.id}/assets/${key}`;
    } catch { return 'data:,'; }
  }
  css(session, text, base) {
    return text.replace(/:focus-visible(?![\w-])/g, ':is(:focus-visible,.transflow-focus-visible)').replace(/:focus-within(?![\w-])/g, ':is(:focus-within,.transflow-focus-within)').replace(/:focus(?![\w-])/g, ':is(:focus,.transflow-focus)').replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_all, _quote, url) => `url("${this.assetUrl(session, url, base)}")`)
      .replace(/@import\s+(['"])(.*?)\1/gi, (_all, _quote, url) => `@import "${this.assetUrl(session, url, base)}"`);
  }
  sanitizeEvent(session, input) {
    const event = structuredClone(input);
    session.blockedNodes ||= new Set();
    session.nodeTags ||= new Map(); session.styleTexts ||= new Set();
    const blocked = session.blockedNodes;
    const blockTree = node => { blocked.add(node.id); for (const child of node.childNodes || []) blockTree(child); };
    const sanitizeAttrs = (attributes, tag = '') => {
      for (const [key, value] of Object.entries(attributes)) {
        if (/^on/i.test(key) || ['srcdoc', 'action', 'formaction', 'ping', 'nonce', 'integrity', 'srcset', 'imagesrcset', 'http-equiv', 'content', 'target'].includes(key)) { delete attributes[key]; continue; }
        if (key === '_cssText' || key === 'style') attributes[key] = this.css(session, String(value), session.url);
        else if (['src', 'poster', 'background', 'xlink:href'].includes(key) || (key === 'href' && tag !== 'a')) attributes[key] = this.assetUrl(session, String(value));
        else if (key === 'href') attributes[key] = '#'; // Navigation goes through authoritative click only.
      }
    };
    const walk = node => {
      if (node.tagName) session.nodeTags.set(node.id, node.tagName);
      if (node.type === 3 && node.isStyle) session.styleTexts.add(node.id);
      if (node.tagName === 'script' || ['base', 'meta', 'iframe', 'object', 'embed', 'audio', 'video'].includes(node.tagName)) {
        blockTree(node);
        const embed = ['iframe','object','embed'].includes(node.tagName);
        const size = value => /^\d+(?:\.\d+)?px$/.test(value || '') ? `${Math.min(20000, parseFloat(value))}px` : '0px';
        const width = size(node.attributes?.rr_width), height = size(node.attributes?.rr_height);
        node.tagName = embed ? 'div' : 'noscript';
        node.attributes = embed ? { class: 'rr-block', rr_width: width, rr_height: height, style: `display:inline-block;vertical-align:baseline;box-sizing:border-box;width:${width};height:${height};max-width:100%;` } : {}; node.childNodes = [];
      }
      if (node.attributes) sanitizeAttrs(node.attributes, node.tagName);
      if (node.type === 3 && node.isStyle) node.textContent = this.css(session, node.textContent, session.url);
      for (const child of node.childNodes || []) walk(child);
      if (node.tagName === 'head') {
        // Placed before all original resources. Site scripts are also disabled by
        // rrweb's iframe sandbox; this CSP limits CSS and resource side effects.
        node.childNodes.unshift({ type: 2, tagName: 'meta', id: -1000001, attributes: {
          'http-equiv': 'Content-Security-Policy', content: "default-src 'none'; script-src 'none'; connect-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; media-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'",
        }, childNodes: [] });
      }
    };
    // Walk original nodes before adding the CSP meta (which must not be stripped).
    const addCsp = node => {
      if (node.tagName === 'head') node.childNodes = node.childNodes.filter(child => child.id !== -1000001);
      for (const child of node.childNodes || []) addCsp(child);
    };
    // Mutation attributes have no tag; href is inert even for links updated later.
    if (event.type === 2) { blocked.clear(); session.nodeTags.clear(); session.styleTexts.clear(); addCsp(event.data.node); walk(event.data.node); }
    if (event.type === 3 && event.data.source === 0) {
      event.data.adds = (event.data.adds || []).filter(add => {
        // rrweb may continue recording iframe documents after a blocked iframe
        // placeholder. Replaying that document into a renamed element clears the
        // main mirror document. Drop its entire subtree and future mutations.
        if (blocked.has(add.parentId) || add.node.type === 0) { blockTree(add.node); return false; }
        walk(add.node); return true;
      });
      event.data.removes = (event.data.removes || []).filter(remove => !blocked.has(remove.parentId) && !blocked.has(remove.id));
      event.data.attributes = (event.data.attributes || []).filter(attr => !blocked.has(attr.id));
      event.data.texts = (event.data.texts || []).filter(text => !blocked.has(text.id));
      for (const attr of event.data.attributes) sanitizeAttrs(attr.attributes, session.nodeTags.get(attr.id) || 'a');
      for (const text of event.data.texts || []) {
        if (session.styleTexts.has(text.id)) text.value = this.css(session, text.value, session.url);
      }
    }
    if (event.type === 3 && blocked.has(event.data.id)) return null;
    if (event.type === 3 && event.data.source === 8) {
      for (const add of event.data.adds || []) add.rule = this.css(session, add.rule, session.url);
    }
    if (event.type === 3 && event.data.source === 15) {
      for (const style of event.data.styles || []) for (const rule of style.rules || []) rule.rule = this.css(session, rule.rule, session.url);
    }
    if (event.type === 3 && event.data.source === 13 && event.data.set?.value) event.data.set.value = this.css(session, event.data.set.value, session.url);
    if (event.transflowAnchor) {
      const anchor = event.transflowAnchor;
      if (!['id','containerId','fraction','before','ratio','left'].every(key => Number.isFinite(anchor[key])) || anchor.id < 0 || anchor.containerId < 0 || anchor.fraction < 0 || anchor.fraction > 10000 || anchor.before < 0 || anchor.before > 100000 || anchor.ratio < 0 || anchor.ratio > 1 || blocked.has(anchor.id) || blocked.has(anchor.containerId)) delete event.transflowAnchor;
    }
    return event;
  }
  cacheAsset(session, url, asset) {
    if (session.closed || !allowedAsset(asset.type) || asset.body.length > 8 * 1024 * 1024 || session.assets.has(url)) return;
    if (session.assetBytes + asset.body.length > 64 * 1024 * 1024) return;
    session.assets.set(url, asset); session.assetBytes += asset.body.length;
  }
  async asset(session, key) {
    const url = session.assetUrls.get(key);
    if (!url) throw new Error('资源不存在。');
    let asset = session.assets.get(url);
    if (!asset) {
      if (!session.assetPending.has(url)) session.assetPending.set(url, publicFetch(url).then(result => {
        if (!allowedAsset(result.type) || result.status !== 200) throw new Error('资源不可用。');
        this.cacheAsset(session, url, result); return result;
      }).finally(() => session.assetPending.delete(url)));
      asset = await session.assetPending.get(url);
    }
    session.resourceFailures.delete(key);
    return asset.type.startsWith('text/css') ? { ...asset, body: Buffer.from(this.css(session, asset.body.toString(), url)) } : asset;
  }
  async scan(session) {
    if (session.closed || session.scanning || !session.epoch) return;
    session.scanning = true;
    try {
      const captured = await session.page.evaluate(() => ({ epoch: window.__transflow?.epoch, blocks: window.__transflow?.blocks(), title: document.title, visual: !!document.body && (!!document.body.innerText.trim() || !!document.body.querySelector('img,svg,canvas,video')) }));
      if (captured.epoch !== session.epoch || !captured.blocks) return;
      if (!session.loading && !captured.blocks.length && !session.events.some(event => event.type === 2)) session.error = '网页未能生成可显示的内容，请重新载入或尝试其他网址。';
      if (!session.loading && !captured.visual) session.error = '该网页没有可显示的内容，请重新载入或尝试其他网址。';
      else if (session.error === '该网页没有可显示的内容，请重新载入或尝试其他网址。') session.error = '';
      session.blocks = captured.blocks; session.title = captured.title;
      const current = new Map(session.blocks.map(block => [block.id, sourceKey(block)]));
      for(const id of session.priorityBlocks || []) if(!current.has(id)||session.translations.has(id)||session.failed.has(id)) session.priorityBlocks.delete(id);
      for (const [id, entry] of session.translations) if (current.get(id) !== entry.key) session.translations.delete(id);
      for (const [id, key] of session.failed) if (current.get(id) !== key) session.failed.delete(id);
      if (!session.failed.size && !session.translationPaused) session.translationError = '';
      for (const block of session.blocks) {
        const key = sourceKey(block), cached = session.cache.get(`${session.language}:${key}`);
        if (cached && !session.translations.has(block.id)) {
          const entry = this.entry(block, cached); session.metrics.cacheHits++;
          if (session.metrics.firstTranslationMs === null) session.metrics.firstTranslationMs = Date.now() - session.metrics.started;
          session.translations.set(block.id, entry);
          this.send(session, 'translations', { epoch: session.epoch, language: session.language, entries: [entry] });
        }
      }
      const todo = session.blocks.filter(block => {
        const key = sourceKey(block);
        return session.translations.get(block.id)?.key !== key && !session.pending.has(`${session.epoch}:${session.language}:${key}`) && session.failed.get(block.id) !== key;
      }).sort((a,b) => Number(session.priorityBlocks?.has(b.id) || false) - Number(session.priorityBlocks?.has(a.id) || false));
      // Small first response, then bounded paragraph batches. Deduplicate both
      // within a batch and between workers by source structure, not DOM ID.
      const seen = new Set();
      const unique = todo.filter(block => { const key = sourceKey(block); if (seen.has(key)) return false; seen.add(key); return true; });
      while (!session.translationPaused && session.workers < 2 && unique.length) {
        const first = session.metrics.firstTranslationMs === null;
        const batch = []; let size = 0;
        while (unique.length && batch.length < (first ? 2 : 4)) {
          const block = unique[0], length = block.source.length + block.context.length;
          if (batch.length && size + length > (first ? 1200 : 2400)) break;
          unique.shift(); size += length; batch.push(block);
        }
        this.translate(session, batch);
      }
      if (session.metrics.viewportMs === null && session.blocks.some(block => block.viewport) && session.blocks.filter(block => block.viewport).every(block => session.translations.has(block.id))) session.metrics.viewportMs = Date.now() - session.metrics.started;
      this.status(session);
    } catch { /* Navigations invalidate the old execution context naturally. */ }
    finally { session.scanning = false; }
  }
  async translate(session, blocks) {
    const epoch = session.epoch, language = session.language, generation = session.generation || 0;
    session.workers = (session.workers || 0) + 1;
    const identities = blocks.map(block => `${epoch}:${language}:${sourceKey(block)}`);
    identities.forEach(key => session.pending.add(key));
    const controller = new AbortController();
    session.controllers ||= new Set(); session.controllers.add(controller);
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, this.config.timeoutMs ?? 60000);
    try {
      let entries;
      for (let attempt = 0; attempt < 2; attempt++) {
        const started = Date.now(); session.metrics.requests++;
        try {
          entries = await translateBatch(blocks, language, this.config, controller.signal, usage => {
            if (epoch === session.epoch && generation === (session.generation || 0)) { if (usage.reported) session.metrics.usageReports++; session.metrics.inputTokens += usage.input; session.metrics.outputTokens += usage.output; }
          });
          break;
        }
        catch (error) {
          if (!session.closed && epoch === session.epoch && generation === (session.generation || 0) && (!controller.signal.aborted || timedOut)) session.metrics.failedRequests++;
          if (attempt || controller.signal.aborted || /鉴权|配置|mock/.test(error.message)) throw error;
          if (/限流|HTTP 5/.test(error.message)) await new Promise(resolve => { const timer = setTimeout(resolve, 1000); controller.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });
        } finally {
          if (!session.closed && epoch === session.epoch && generation === (session.generation || 0)) session.metrics.durations.push(Date.now() - started);
        }
      }
      if (session.closed || epoch !== session.epoch || language !== session.language || generation !== (session.generation || 0)) return;
      const current = new Map(session.blocks.map(block => [block.id, sourceKey(block)]));
      const valid = [];
      if (entries.failures?.length) {
        session.metrics.failedRequests++; session.metrics.failures++;
        for (const failure of entries.failures) { const block = blocks.find(block => block.id === failure.id); session.failed.set(block.id, sourceKey(block)); }
        session.translationError = '部分段落未完成，可点击重试。';
      }
      for (const entry of entries) {
        const key = sourceKey(entry);
        const cached = { text: entry.text, parts: entry.parts?.map(part => part.text) };
        session.cache.set(`${language}:${key}`, cached);
        if (session.cache.size > 6000) session.cache.delete(session.cache.keys().next().value);
        if (current.get(entry.id) !== key) continue;
        const translated = this.entry(entry, cached);
        session.translations.set(entry.id, translated); session.failed.delete(entry.id); valid.push(translated);
      }
      if (valid.length && session.metrics.firstTranslationMs === null) session.metrics.firstTranslationMs = Date.now() - session.metrics.started;
      if (valid.length) this.send(session, 'translations', { epoch, language, entries: valid });
      if (!session.failed.size) session.translationError = '';
    } catch (error) {
      if (!session.closed && epoch === session.epoch && language === session.language && generation === (session.generation || 0)) {
        session.metrics.failures++; session.translationPaused = error.code !== 'TRANSLATION_FORMAT';
        session.translationError = controller.signal.aborted ? '翻译请求超时，可点击重试。' : error.message.includes('模型') || error.message.includes('翻译') || error.message.includes('.env') || error.message.includes('mock') ? error.message : '无法连接翻译服务，请检查模型配置和网络后重试。';
        for (const block of blocks) session.failed.set(block.id, sourceKey(block));
      }
    } finally {
      clearTimeout(timeout); session.controllers.delete(controller);
      identities.forEach(key => session.pending.delete(key)); session.workers--; this.status(session);
      if (!session.closed) setTimeout(() => this.scan(session), 50);
    }
  }
  async navigate(session, command) {
    session.metrics = this.newMetrics(); session.navigationStarted = session.metrics.started;
    session.loading = true; session.error = ''; session.translationPaused = false; session.translationError = ''; this.status(session);
    try {
      let response;
      if (command.action === 'back') response = await session.page.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 });
      else if (command.action === 'forward') response = await session.page.goForward({ waitUntil: 'domcontentloaded', timeout: 30000 });
      else if (command.action === 'reload') response = await session.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      else {
        parsePublicUrl(command.url); await publicAddress(new URL(command.url).hostname);
        response = await session.page.goto(command.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      }
      if (response && response.status() >= 400) session.error = `网站返回 HTTP ${response.status()}，部分内容可能无法访问。`;
    } finally { session.loading = false; session.url = session.page.url(); this.status(session); }
  }
  command(session, command) {
    session.lastSeen = Date.now();
    if (typeof command.requestId !== 'string' || command.requestId.length > 100) throw new Error('操作缺少唯一标识。');
    if (session.commands.has(command.requestId)) return session.commands.get(command.requestId);
    const result = session.queue.catch(() => {}).then(async () => {
      if (session.closed) throw new Error('网页会话已结束。');
      if (command.type === 'navigate') return this.navigate(session, command).catch(error => { session.error = this.navigationError(error); this.status(session); throw new Error(session.error); });
      if (command.type === 'language') {
        if (!LANGUAGES[command.language]) throw new Error('不支持该目标语言。');
        session.language = command.language; session.metrics = this.newMetrics(); session.generation = (session.generation || 0) + 1;
        for (const controller of session.controllers || []) controller.abort();
        session.translations.clear(); session.failed.clear(); session.translationError = ''; session.translationPaused = false;
        this.send(session, 'language', { language: session.language }); this.scan(session); return;
      }
      if (command.type === 'resources') { session.resourceFailures.clear(); await session.page.evaluate(() => window.__transflow?.record.takeFullSnapshot()); this.status(session); return; }
      if (command.type === 'retry') {
        if (command.id !== undefined) {
          const block = session.blocks.find(block => block.id === command.id);
          if (command.epoch !== session.epoch || !block || sourceKey(block) !== command.key) throw new Error('段落已变化，请重新选择。');
          if (session.pending.has(`${session.epoch}:${session.language}:${command.key}`)) throw new Error('该段正在翻译，请稍候。');
          session.failed.delete(block.id); session.translations.delete(block.id); session.cache.delete(`${session.language}:${command.key}`);
          session.priorityBlocks ||= new Set(); session.priorityBlocks.add(block.id);
          this.send(session,'translation-reset',{epoch:session.epoch,language:session.language,id:block.id});
        } else session.failed.clear();
        session.translationError = session.failed.size ? '部分段落未完成，可点击重试。' : ''; session.translationPaused = false; this.scan(session); return;
      }
      if (command.type === 'resize') {
        await session.page.setViewportSize({ width: Math.max(320, Math.min(1600, Math.round(command.width) || 680)), height: Math.max(120, Math.min(2400, Math.round(command.height) || 700)) }); return;
      }
      if (command.epoch !== session.epoch) throw new Error('页面已变化，请在更新后的页面重新操作。');
      const handle = await session.page.evaluateHandle(({ id, epoch }) => window.__transflow?.epoch === epoch ? window.__transflow.record.mirror.getNode(id) : null, command);
      const element = handle.asElement();
      try {
        if (!element) throw new Error('目标已变化，请重新操作。');
        if (command.type === 'click') {
          await element.evaluate(node => { const link = node.closest('a'); if (link) link.removeAttribute('target'); });
          await element.click({ timeout: 5000 });
        } else if (command.type === 'unhover') await session.page.mouse.move(0, 0);
        else if (command.type === 'hover') await element.hover({ timeout: 1500 });
        else if (command.type === 'focus') await element.focus();
        else if (command.type === 'blur') await element.evaluate(node => node.blur());
        else if (command.type === 'input') {
          const permitted = await element.evaluate(node => (node.tagName === 'INPUT' && ['text', 'search', ''].includes(node.type) || node.tagName === 'TEXTAREA') && !node.closest('[contenteditable="true"]'));
          if (!permitted || typeof command.value !== 'string' || command.value.length > 2000) throw new Error('首版仅支持普通文字搜索输入。');
          await element.fill(command.value, { timeout: 3000 });
        } else if (command.type === 'key') {
          if (!['Enter', 'Escape', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab'].includes(command.key)) throw new Error('不支持该按键。');
          await element.press(command.key);
        } else if (command.type === 'scroll') {
          await element.evaluate((node, { offset, ratio, containerId, left }) => {
            const container = containerId > 0 ? window.__transflow.record.mirror.getNode(containerId) : document.scrollingElement;
            if (!container) return;
            const bounds = node.getBoundingClientRect();
            const containerTop = container === document.scrollingElement ? 0 : container.getBoundingClientRect().top;
            const range = container.scrollHeight - container.clientHeight;
            const top = ratio === 0 ? 0 : ratio >= 1 ? range : Number.isFinite(offset) ? container.scrollTop + bounds.top - containerTop + Math.max(-2000, Math.min(2000, offset)) : ratio * range;
            container.scrollTo({ top, left: Math.max(0, Math.min(100000, left || 0)), behavior: 'instant' });
          }, command);
        } else throw new Error('不支持该操作。');
      } finally { await handle.dispose(); }
    });
    session.queue = result;
    session.commands.set(command.requestId, result);
    if (session.commands.size > 500) session.commands.delete(session.commands.keys().next().value);
    return result;
  }
  async close(session) {
    if (session.closed) return;
    session.closed = true; clearInterval(session.timer);
    for (const controller of session.controllers || []) controller.abort();
    for (const client of session.clients) client.end();
    this.sessions.delete(session.id); await session.context.close().catch(() => {});
  }
  async shutdown() {
    await Promise.all([...this.sessions.values()].map(session => this.close(session)));
    if (this.browserPromise) await (await this.browserPromise).close();
    this.proxy?.close();
  }
}
