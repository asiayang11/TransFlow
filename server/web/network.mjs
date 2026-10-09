import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';

export function parsePublicUrl(input) {
  let url;
  try { url = new URL(input); } catch { throw new Error('请输入有效的完整网址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.port && !['80', '443'].includes(url.port))) {
    throw new Error('仅支持无账号密码的 HTTP / HTTPS 公开网页及标准端口。');
  }
  return url;
}

export function isPublicAddress(address) {
  try {
    let parsed = ipaddr.parse(address.replace(/^\[|\]$/g, ''));
    if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) parsed = parsed.toIPv4Address();
    return parsed.range() === 'unicast';
  } catch { return false; }
}

export async function publicAddress(host, resolver = lookup) {
  const hostname = host.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(hostname) ? [{ address: hostname, family: net.isIP(hostname) }] :
    await resolver(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error('为保护本机，仅允许访问公网地址；不支持本机、内网或保留地址。');
  }
  return addresses.find(({ family }) => family === 4) || addresses[0];
}

export function pinnedLookup({ address, family }) {
  return (_host, options, done) => {
    if (options?.all) done(null, [{ address, family }]);
    else done(null, address, family);
  };
}

// Resolve once and connect to that exact IP. A validation followed by normal DNS
// resolution would still permit DNS rebinding, including on redirects/resources.
export async function publicFetch(input, redirects = 0) {
  const url = parsePublicUrl(input);
  const pinned = await publicAddress(url.hostname);
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      lookup: pinnedLookup(pinned),
      headers: { 'User-Agent': 'Mozilla/5.0 TransFlow/1.0', 'Accept-Encoding': 'identity' },
    }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        if (redirects >= 5) return reject(new Error('资源重定向次数过多。'));
        publicFetch(new URL(response.headers.location, url).href, redirects + 1).then(resolve, reject);
        return;
      }
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) { response.destroy(new Error('资源超过 8 MB 限制。')); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, type: response.headers['content-type'] || '', body: Buffer.concat(chunks), url: url.href }));
    });
    request.setTimeout(15000, () => request.destroy(new Error('资源加载超时。')));
    request.on('error', reject); request.end();
  });
}

// Chromium must use this proxy for every request, including loopback. CONNECT
// pins the destination too; original TLS and certificate checks stay in Chrome.
export async function createPublicProxy() {
  const sockets = new Set();
  const server = http.createServer(async (incoming, outgoing) => {
    try {
      const url = parsePublicUrl(incoming.url);
      const pinned = await publicAddress(url.hostname);
      const headers = { ...incoming.headers, host: url.host };
      delete headers['proxy-authorization']; delete headers['proxy-connection'];
      const upstream = (url.protocol === 'https:' ? https : http).request(url, {
        method: incoming.method, headers,
        lookup: pinnedLookup(pinned),
      }, response => { outgoing.writeHead(response.statusCode, response.headers); response.pipe(outgoing); });
      upstream.setTimeout(30000, () => upstream.destroy());
      upstream.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
      incoming.pipe(upstream);
    } catch { outgoing.writeHead(403); outgoing.end('Public network only'); }
  });
  server.on('connect', async (request, client, head) => {
    try {
      const url = parsePublicUrl(`https://${request.url}`);
      if (url.port && url.port !== '443') throw new Error('Invalid CONNECT port');
      const pinned = await publicAddress(url.hostname);
      const upstream = net.connect(443, pinned.address);
      sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream));
      upstream.setTimeout(120000, () => upstream.destroy());
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client);
      });
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
      client.on('close', () => upstream.destroy());
    } catch { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); }
  });
  server.on('connection', socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => { for (const socket of sockets) socket.destroy(); server.close(); } };
}
