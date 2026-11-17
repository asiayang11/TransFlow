import { WebTranslationError } from './diagnostics.mjs';

export const TERM_POLICY_VERSION = 3;

const defaultTerms = [
  'Apache Kafka', 'Kafka', 'Apache Samza', 'Samza', 'Apache Hadoop', 'Hadoop',
  'Apache Avro', 'Avro', 'Apache ZooKeeper', 'ZooKeeper', 'MirrorMaker',
  'LinkedIn', 'TrackerProducer', 'TrackerConsumer', 'Mammad Zadeh',
];
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordCharacter = '\\p{Script=Latin}\\p{N}_';

export function createTermMatcher(extraTerms = []) {
  const alternatives = [...defaultTerms, ...extraTerms]
    .sort((left, right) => right.length - left.length)
    .map(escapeRegex).join('|');
  return new RegExp(`(?<![${wordCharacter}])(?:${alternatives})(?![${wordCharacter}])`, 'giu');
}

export function parseExtraTerms(value) {
  if (!value?.trim()) return [];
  let terms;
  try { terms = JSON.parse(value); } catch { /* Report the configuration name only. */ }
  if (!Array.isArray(terms) || terms.some(term => typeof term !== 'string' || !term.trim())) {
    throw new Error('TRANSFLOW_WEB_KEEP_TERMS 必须是由非空字符串组成的 JSON 数组。');
  }
  return [...new Set(terms.map(term => term.trim()))];
}

const termError = (code, message) => new WebTranslationError(code, message, { format: true });

export function protectedTermSpans(block, matcher) {
  const matches = [...block.source.matchAll(matcher)].map(match => ({
    start: match.index, end: match.index + match[0].length,
  }));
  // Explicit rules win when automatic candidates overlap them.
  for (const span of block.termSpans ?? []) {
    if (!matches.some(match => match.start < span.end && span.start < match.end)) matches.push(span);
  }
  return matches.sort((left, right) => left.start - right.start);
}

export function protectTerms(block, matcher) {
  const matches = protectedTermSpans(block, matcher);
  if (!matches.length) return { input: block, restore: entry => entry };

  let prefix = '[[TF_TERM_';
  while (block.source.includes(prefix) || block.context?.includes(prefix)) prefix += 'X_';
  const markerPattern = new RegExp(`${escapeRegex(prefix)}\\d+\\]\\]`, 'g');
  const slots = new Map();
  let nextMarker = 0;
  let offset = 0;
  let matchIndex = 0;
  const maskSlot = (slot, id) => {
    const start = offset;
    offset += slot.source.length;
    if (slot.protected) return slot;

    let cursor = 0;
    let masked = '';
    const markers = new Map();
    while (matchIndex < matches.length) {
      const match = matches[matchIndex];
      const { start: matchStart, end } = match;
      if (matchStart >= offset) break;
      if (end > start) {
        const from = Math.max(matchStart - start, 0);
        const to = Math.min(end - start, slot.source.length);
        const marker = `${prefix}${++nextMarker}]]`;
        markers.set(marker, {
          original: slot.source.slice(from, to),
          atStart: matchStart < start,
          atEnd: end > offset,
        });
        masked += slot.source.slice(cursor, from) + marker;
        cursor = to;
      }
      if (end > offset) break;
      matchIndex++;
    }
    slots.set(id, markers);
    return { ...slot, source: masked + slot.source.slice(cursor) };
  };

  // Match against the whole paragraph so names split by inline markup also
  // stay protected. Each fragment is restored to its original text node.
  const segments = block.segments?.map(slot => maskSlot(slot, slot.id));
  const source = segments ? segments.map(slot => slot.source).join('') : maskSlot(block, block.id).source;
  if (!nextMarker) return { input: block, restore: entry => entry };

  function restoreSlot(text, id) {
    const markers = slots.get(id);
    const used = new Set();
    if (text.replace(markerPattern, '').includes(prefix)) throw termError('TERM_INVALID_MARKER', '模型返回了格式无效的专名占位符。');
    const restored = text.replace(markerPattern, (marker, index) => {
      const term = markers.get(marker);
      if (!term) throw termError('TERM_UNEXPECTED_MARKER', '模型在此节点返回了不属于该节点的专名占位符。');
      if (used.has(marker)) throw termError('TERM_DUPLICATE_MARKER', '模型重复返回了同一个专名占位符。');
      if ((term.atStart && index !== 0) || (term.atEnd && index + marker.length !== text.length)) {
        throw termError('TERM_MOVED_MARKER', '模型移动了跨行内节点的专名占位符。');
      }
      used.add(marker);
      return term.original;
    });
    if (used.size !== markers.size) throw termError('TERM_MISSING_MARKER', '模型遗漏了必须保留的专名占位符。');
    return restored;
  }

  return {
    input: { ...block, source, segments },
    restore(entry) {
      if (!entry.parts) return { ...block, text: restoreSlot(entry.text, block.id) };
      const originals = block.segments.filter(slot => !slot.protected);
      const parts = entry.parts.map((part, index) => ({
        ...part, source: originals[index].source, text: restoreSlot(part.text, part.id),
      }));
      return { ...block, parts, text: parts.map(part => part.text).join('') };
    },
  };
}
