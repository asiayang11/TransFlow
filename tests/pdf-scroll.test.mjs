import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';

test('PDF comparison scrolls continuously and only mounts nearby previews', { timeout: 20000 }, async t => {
  const id = 'a'.repeat(32);
  const count = 30;
  const bundle = await build({
    stdin: {
      contents: `import {createRoot} from 'react-dom/client'; import PdfWorkspace from './src/PdfWorkspace';
        import './src/styles.css'; import './src/workbench.css';
        createRoot(document.getElementById('root')).render(<PdfWorkspace/>);`,
      resolveDir: process.cwd(), loader: 'tsx',
    },
    bundle: true, write: false, outfile: 'fixture.js', format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'preview-fixture', setup(builder) {
      builder.onResolve({ filter: /^\.\/PdfPreview$/ }, () => ({ path: 'preview', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
        contents: 'export default function Preview() { return <canvas data-rendered="true"/>; }',
        loader: 'tsx', resolveDir: process.cwd(),
      }));
    } }],
  });
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(5000);
  const pages = Array.from({ length: count }, (_, i) => ({
    page_number: i + 1, status: 'ready', stage_label: '翻译完成', progress: 100, attempt: 1,
    quality: i === 1 ? { status: 'needs_review', warnings: ['本页需要复核'] } : null,
  }));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://localhost:5173') return route.abort();
    const path = url.pathname;
    if (path.endsWith('/health') || path.endsWith('/prefetch')) return route.fulfill({ json: {} });
    if (path === `/api/v1/documents/${id}`) return route.fulfill({ json: {
      id, execution_mode: 'openai', filename: 'fixture.pdf', size_bytes: 4096, page_count: count,
      target_language: 'zh-CN', prefetch_pages: 5, translation_mode: 'reading', pages,
    } });
    if (path === '/fixture.js' || path === '/fixture.css') return route.fulfill({
      contentType: path.endsWith('.js') ? 'text/javascript' : 'text/css',
      body: bundle.outputFiles.find(file => file.path.endsWith(path)).text,
    });
    return route.fulfill({ contentType: 'text/html', body: '<meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>' });
  });

  const row = n => page.locator(`[data-pdf-page="${n}"]`);
  const active = n => page.getByRole('heading', { name: `第 ${n} 页`, exact: true });
  await page.goto(`http://localhost:5173/tasks/${id}?page=2`);
  await row(2).locator('canvas').last().waitFor();
  await row(3).locator('canvas').last().waitFor();
  assert.equal(await row(30).locator('canvas').count(), 0);
  const aligned = () => row(2).locator('.pdf-page-surface').evaluateAll(
    nodes => nodes.length === 2 && nodes[0].getBoundingClientRect().top === nodes[1].getBoundingClientRect().top,
  );
  assert.equal(await aligned(), true);
  await row(2).getByRole('button', { name: '关闭提示：需复核' }).click();
  assert.equal(await aligned(), true);
  assert.equal(await row(2).getByText('本页需要复核').count(), 0);

  const third = await row(3).locator('canvas').first().elementHandle();
  const initial = await page.evaluate(() => window.scrollY);
  await page.mouse.move(850, 650);
  for (let i = 0; i < 12 && !page.url().endsWith('?page=3'); i++) await page.mouse.wheel(0, 100);
  await active(3).waitFor();
  await page.waitForURL('**?page=3');
  assert.ok(await page.evaluate(() => window.scrollY) > initial, 'crossing a page advances the native scroll position');
  assert.equal(await third.evaluate(canvas => canvas.isConnected), true, 'the next preview is not remounted');

  await page.getByRole('button', { name: '上一页', exact: true }).click();
  await active(2).waitFor();
  await page.locator('.pdf-reader-controls h2').click();
  await page.keyboard.press('ArrowRight');
  await active(3).waitFor();
  await page.locator('.page-item').last().click();
  await page.waitForURL('**?page=30');
  await row(30).locator('canvas').last().waitFor();
  assert.equal(await row(2).locator('canvas').count(), 0, 'offscreen canvases are released after a distant jump');
});
