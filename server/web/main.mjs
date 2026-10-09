import http from 'node:http';
import { loadWebConfig } from './config.mjs';
import { pathToFileURL } from 'node:url';
import { BrowserSessions } from './sessions.mjs';

export async function startWebServer({ port, config, origins, prepareContext } = {}) {
  const sessions = new BrowserSessions(config, { prepareContext });
  const allowedOrigins = new Set(origins || ['http://127.0.0.1:5173', 'http://localhost:5173', 'http://127.0.0.1:4173']);
  const sendJson = (response, status, data) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(JSON.stringify(data)); };
  const server = http.createServer(async (request, response) => {
    const host = request.headers.host || '';
    if (!/^(?:127\.0\.0\.1|localhost):\d+$/.test(host)) return sendJson(response, 403, { error: '请求来源无效。' });
    const origin = request.headers.origin;
    if (origin && !allowedOrigins.has(origin)) return sendJson(response, 403, { error: '请求来源无效。' });
    try {
      const url = new URL(request.url, `http://${host}`);
      if (url.pathname === '/api/web/health' && request.method === 'GET') return sendJson(response, 200, { ok: true, configured: !!config.key && config.key !== 'sk-your-key-here', mode: config.mode });
      const mutation = !['GET', 'HEAD'].includes(request.method);
      if (mutation && request.headers['x-transflow-web'] !== '1') return sendJson(response, 403, { error: '请求校验失败。' });
      let body = {};
      if (mutation) {
        const chunks = []; let size = 0;
        for await (const chunk of request) { size += chunk.length; if (size > 16000) throw new Error('请求过大。'); chunks.push(chunk); }
        const raw = Buffer.concat(chunks).toString('utf8');
        body = raw ? JSON.parse(raw) : {};
      }
      if (url.pathname === '/api/web/sessions' && request.method === 'POST') {
        const session = await sessions.create(body);
        return sendJson(response, 201, { id: session.id });
      }
      const match = url.pathname.match(/^\/api\/web\/sessions\/([a-f0-9]{48})(?:\/(stream|commands|assets)(?:\/([a-f0-9]{64}))?)?$/);
      const session = match && sessions.sessions.get(match[1]);
      if (!session) return sendJson(response, 404, { error: '网页会话已结束，请重新打开网址。' });
      session.lastSeen = Date.now();
      if (!match[2] && request.method === 'GET') return sendJson(response, 200, sessions.status(session));
      if (!match[2] && request.method === 'DELETE') { await sessions.close(session); return sendJson(response, 200, { ok: true }); }
      if (match[2] === 'stream' && request.method === 'GET') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        sessions.attach(session, response); return;
      }
      if (match[2] === 'commands' && request.method === 'POST') {
        await sessions.command(session, body); return sendJson(response, 200, { ok: true });
      }
      if (match[2] === 'assets' && request.method === 'GET') {
        let asset;
        try { asset = await sessions.asset(session, match[3]); } catch (error) { session.resourceFailures.set(match[3], true); sessions.status(session); throw error; }
        response.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Referrer-Policy': 'no-referrer' });
        response.end(asset.body); return;
      }
      sendJson(response, 404, { error: '接口不存在。' });
    } catch (error) {
      if (!response.headersSent) sendJson(response, 400, { error: String(error.message).includes('ENOTFOUND') ? '无法解析网址，请检查拼写和网络。' : String(error.message).slice(0, 250) });
      else response.end();
    }
  });
  server.requestTimeout = 45000;
  const cleanup = setInterval(() => {
    for (const session of sessions.sessions.values()) if (!session.clients.size && Date.now() - session.lastSeen > 120000) sessions.close(session);
  }, 30000);
  await new Promise(resolve => server.listen(port ?? 8788, '127.0.0.1', resolve));
  return { server, sessions, close: async () => { clearInterval(cleanup); await sessions.shutdown(); await new Promise(resolve => server.close(resolve)); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = await loadWebConfig();
  const app = await startWebServer({ port: Number(process.env.TRANSFLOW_WEB_PORT || 8788), config,
    origins: process.env.TRANSFLOW_FRONTEND_ORIGIN ? [process.env.TRANSFLOW_FRONTEND_ORIGIN, 'http://127.0.0.1:4173'] : undefined });
  console.log(`TransFlow 网页服务 http://127.0.0.1:${app.server.address().port} · 模型${config.key ? '已配置' : '未配置'}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.close().finally(() => process.exit(0)));
}
