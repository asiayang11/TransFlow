export const READING_KEY = 'transflow.web.reading.v1';
const languages = new Set(['zh-CN','en','ja','ko','fr','de','es']);
export function parseReading(raw) {
  try {
    const value = JSON.parse(raw);
    const url = new URL(value.url);
    if (value.version !== 1 || !['http:','https:'].includes(url.protocol) || url.username || url.password || !languages.has(value.language)) return null;
    const position = value.position;
    const validPosition = position && typeof position.tag === 'string' && typeof position.text === 'string' && position.text.length <= 300 && typeof position.domId === 'string' && position.domId.length <= 200 && ['fraction','before','ratio','left'].every(key => Number.isFinite(position[key])) && position.fraction >= 0 && position.fraction <= 10000 && position.before >= 0 && position.before <= 100000 && position.ratio >= 0 && position.ratio <= 1;
    return { version:1, url:url.href, language:value.language, mode:value.mode === 'adaptive' ? 'adaptive' : 'desktop', fit:value.fit !== false, zoom:Number.isFinite(value.zoom) ? Math.max(.25,Math.min(2,value.zoom)) : 1, position:validPosition ? position : null, panX:Number.isFinite(value.panX) ? Math.max(0,Math.min(100000,value.panX)) : 0 };
  } catch { return null; }
}
export function viewportLayout({paneWidth,paneHeight,mode,zoom,fit}) {
  const available = Math.max(320,Math.floor(paneWidth));
  const width = mode === 'desktop' ? 1280 : Math.min(1600,available);
  const scale = fit ? Math.min(1,available/width) : Math.max(.25,Math.min(2,zoom));
  const height = Math.max(120,Math.min(2400,Math.floor(paneHeight/scale)));
  return {width,height,scale};
}
