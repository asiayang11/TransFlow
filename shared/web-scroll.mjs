export function readScrollAnchor(container, mirror, containerId = 0) {
    const doc = container.ownerDocument;
    const origin = container === doc.scrollingElement ? 0 : container.getBoundingClientRect().top;
    const limit = origin + container.clientHeight;
    const candidates = [];
    const collect = (root) => {
      candidates.push(...root.querySelectorAll('h1,h2,h3,h4,p,li,summary,blockquote,td,article,section'));
      for (const node of root.querySelectorAll('*')) if (node.shadowRoot) collect(node.shadowRoot);
    };
    collect(container);
    const pinned = new WeakMap();
    const isPinned = (node) => {
      const cached = pinned.get(node); if (cached !== undefined) return cached;
      const style = getComputedStyle(node);
      const root = node.getRootNode();
      const parent = node.parentElement || (root.nodeType === 11 ? root.host : null);
      const result = ['fixed','sticky'].includes(style.position) || !!(parent && parent !== container && isPinned(parent));
      pinned.set(node, result); return result;
    };
    let chosen = null, distance = Infinity;
    for (const candidate of candidates) {
      const rect = candidate.getBoundingClientRect();
      if (isPinned(candidate) || !rect.width || rect.bottom <= origin || rect.top >= limit || mirror.getId(candidate) < 0) continue;
      const score = Math.abs(rect.top - origin);
      if (score < distance) { chosen = candidate; distance = score; }
    }
    const node = chosen || container;
    const rect = node.getBoundingClientRect();
    return { id: mirror.getId(node), containerId,
      fraction: Math.max(0, origin - rect.top) / Math.max(1, rect.height), before: Math.max(0, rect.top - origin),
      ratio: container.scrollTop / Math.max(1, container.scrollHeight - container.clientHeight), left: container.scrollLeft };
}
