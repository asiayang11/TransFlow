// Runs ONLY inside the authoritative browser. Mirrors never run site scripts.
(() => {
  if (window.top !== window || location.protocol === 'about:') return;
  const epoch = crypto.randomUUID();
  const record = window.rrwebRecord.record;
  window.__transflow = { epoch, record };
  const anchor = id => {
    const node = record.mirror.getNode(id);
    const container = !node || node.nodeType === 9 ? document.scrollingElement : node;
    if (!container || container.nodeType !== 1) return null;
    return window.__transflowReadAnchor(container, record.mirror, container === document.scrollingElement ? 0 : id);
  };
  record({
    emit: event => {
      if (event.type === 2 || (event.type === 3 && event.data.source === 3)) event.transflowAnchor = anchor(event.type === 2 ? record.mirror.getId(document) : event.data.id);
      window.__transflowEmit({ epoch, event }).catch(() => {});
    },
    inlineStylesheet: true,
    recordCanvas: false,
    collectFonts: false,
    recordAfter: 'DOMContentLoaded',
    blockSelector: 'iframe, object, embed, input[type="password"], input[type="file"]',
    maskInputOptions: { password: true },
    sampling: { mousemove: false, mouseInteraction: false, scroll: 100 },
  });
  window.__transflow.blocks = () => {
    if (!document.body) return [];
    const semantic = 'p,li,h1,h2,h3,h4,h5,h6,button,label,td,th,summary,figcaption,blockquote,dt,dd';
    const excluded = 'script,style,noscript,pre,svg,math,textarea,input,select,[translate="no"],.notranslate,[contenteditable="true"]';
    const groups = new Map();
    // A paragraph is one translation request item; inline nodes remain slots.
    // Protected code participates in sentence context but is never overwritten.
    const visit = root => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode()) && groups.size < 3000) {
        const element = node.parentElement, source = node.textContent;
        if (!element || !source || (!source.trim() && /[\r\n]/.test(source)) || element.closest(excluded)) continue;
        const elementCss = getComputedStyle(element);
        if (elementCss.visibility === 'hidden' || elementCss.display === 'none' || (!element.getClientRects().length && elementCss.display !== 'contents')) continue;
        let group = element.closest(semantic);
        if (!group) { group = element; while (group.parentElement && /^(inline|contents)/.test(getComputedStyle(group).display)) group = group.parentElement; }
        const rect = group.getBoundingClientRect(), css = getComputedStyle(group);
        if (!rect.width || !rect.height || css.visibility === 'hidden' || css.display === 'none') continue;
        const id = record.mirror.getId(node); if (id < 0) continue;
        const protectedText = !!element.closest('code,kbd,samp');
        if (!groups.has(group)) groups.set(group, { segments: [], rect });
        groups.get(group).segments.push({ id, source, protected: protectedText || !source.trim() || !/[\p{L}]/u.test(source) });
      }
      for (const element of root.querySelectorAll('*')) if (element.shadowRoot) visit(element.shadowRoot);
    };
    visit(document.body);
    const blocks = [];
    for (const [group, { segments, rect }] of groups) {
      const editable = segments.filter(segment => !segment.protected);
      if (!editable.length) continue;
      const source = segments.map(segment => segment.source).join('');
      // Bound individual requests without splitting a sentence across workers.
      if (source.length > 6000 || segments.length > 80) continue;
      blocks.push({ id: editable[0].id, elementId: record.mirror.getId(group), source, context: '', segments,
        viewport: rect.bottom > 0 && rect.top < innerHeight,
        priority: Math.abs(rect.top - innerHeight / 2) });
    }
    const attributes = ['title', 'placeholder', 'alt', 'aria-label'];
    for (const element of document.body.querySelectorAll('[title],[placeholder],[alt],[aria-label]')) {
      if (blocks.length >= 3000) break;
      if (element.closest('pre,code,svg,math,[translate="no"],.notranslate,[contenteditable="true"]') || element.matches('input[type="password"],input[type="file"]')) continue;
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height || getComputedStyle(element).visibility === 'hidden') continue;
      const nodeId = record.mirror.getId(element);
      if (nodeId < 0) continue;
      attributes.forEach((attribute, index) => {
        const source = element.getAttribute(attribute);
        if (source?.trim() && source.length < 1000 && /[\p{L}]/u.test(source)) blocks.push({
          id: -(nodeId * 8 + index + 1), nodeId, attribute, source,
          context: `${attribute}: ${element.textContent?.trim().slice(0, 300) || element.tagName}`,
          viewport: false, priority: Math.abs(rect.top - innerHeight / 2) + (attribute === 'placeholder' ? 0 : innerHeight * 2),
        });
      });
    }
    return blocks.sort((a, b) => a.priority - b.priority);
  };
})();
