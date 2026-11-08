'use strict';

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');
const FRONTEND_DIR = path.join(ROOT, 'front_end');
const APP_DIR = path.join(ROOT, 'app');
const PKG = require(path.join(ROOT, 'package.json'));

/** Metadata written by scripts/update.mjs: which Chromium build the frontend came from. */
function buildInfo() {
  try {
    return JSON.parse(fs.readFileSync(path.join(FRONTEND_DIR, 'devtools-build.json'), 'utf8'));
  } catch {
    return null;
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.map', '.md', '.txt', '.svg']);

/** Pick the right DevTools entrypoint for a target type. */
function frontendFor(type) {
  return type === 'node' ? 'js_app.html' : 'devtools_app.html';
}

/** "host:port" -> {host, port}, accepting bare ports and ws:// / http:// URLs. */
function parseEndpoint(value) {
  let v = String(value).trim().replace(/^(wss?|https?):\/\//, '').replace(/\/.*$/, '');
  if (/^\d+$/.test(v)) v = `127.0.0.1:${v}`;
  const m = v.match(/^(\[[^\]]+\]|[^:]+):(\d{1,5})$/);
  if (!m) return null;
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return null;
  return {host: m[1], port, id: `${m[1]}:${port}`};
}

function getJSON(endpoint, pathname, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: endpoint.host.replace(/^\[|\]$/g, ''),
      port: endpoint.port,
      path: pathname,
      headers: {Host: endpoint.id},
      timeout: timeoutMs,
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function describeEndpoint(endpoint) {
  try {
    const [version, list] = await Promise.all([
      getJSON(endpoint, '/json/version').catch(() => ({})),
      getJSON(endpoint, '/json/list'),
    ]);
    const targets = list.filter(t => t.webSocketDebuggerUrl).map(t => {
      const wsPath = new URL(t.webSocketDebuggerUrl).pathname;
      return {
        id: t.id,
        type: t.type,
        title: t.title || t.url || t.id,
        url: t.url,
        faviconUrl: t.faviconUrl,
        description: t.description,
        attached: Boolean(t.attached),
        frontend: frontendFor(t.type),
        wsPath: `/ws/${endpoint.id}${wsPath}`,
      };
    });
    return {
      endpoint: endpoint.id,
      online: true,
      browser: version.Browser || version.Product || null,
      protocolVersion: version['Protocol-Version'] || null,
      targets,
    };
  } catch (e) {
    return {endpoint: endpoint.id, online: false, error: e.message, targets: []};
  }
}

function isLoopback(hostname) {
  return hostname === 'localhost' || hostname === '::1' || hostname === '[::1]' || /^127\./.test(hostname);
}

function createServer(options) {
  const {port, host, endpoints} = options;
  const fileCache = new Map();

  // A page on some other website must not be able to reach the debugger through us:
  // only accept requests whose Host is us and (for WebSockets) whose Origin is us.
  function allowedHost(req) {
    const h = (req.headers.host || '').replace(/:\d+$/, '');
    return isLoopback(h) || h === host || (options.allowedHosts || []).includes(h);
  }
  function allowedOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;  // non-browser clients (CLI tools) send no Origin
    try {
      const u = new URL(origin);
      return u.host === req.headers.host;
    } catch {
      return false;
    }
  }

  function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
    res.writeHead(status, {'Content-Type': type, 'Content-Length': Buffer.byteLength(body), ...extra});
    res.end(body);
  }

  function serveFile(req, res, baseDir, relPath, cacheControl) {
    const filePath = path.join(baseDir, relPath);
    if (!filePath.startsWith(baseDir + path.sep)) return send(res, 403, 'Forbidden');
    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) return send(res, 404, 'Not found');
      const ext = path.extname(filePath).toLowerCase();
      const type = MIME[ext] || 'application/octet-stream';
      const gzip = COMPRESSIBLE.has(ext) && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
      const key = `${filePath}|${gzip}|${stat.mtimeMs}`;
      const headers = {'Content-Type': type, 'Cache-Control': cacheControl, 'Vary': 'Accept-Encoding'};
      const finish = buf => {
        if (gzip) headers['Content-Encoding'] = 'gzip';
        headers['Content-Length'] = buf.length;
        res.writeHead(200, headers);
        res.end(req.method === 'HEAD' ? undefined : buf);
      };
      if (fileCache.has(key)) return finish(fileCache.get(key));
      fs.readFile(filePath, (err, data) => {
        if (err) return send(res, 500, 'Read error');
        const buf = gzip ? zlib.gzipSync(data) : data;
        if (buf.length < 4 * 1024 * 1024) fileCache.set(key, buf);
        finish(buf);
      });
    });
  }

  async function handleApi(req, res, url) {
    if (url.pathname === '/api/info') {
      return send(res, 200, JSON.stringify({
        name: PKG.name,
        version: PKG.version,
        devtools: buildInfo(),
        endpoints: endpoints.map(e => e.id),
      }), MIME['.json']);
    }
    if (url.pathname === '/api/targets') {
      const extra = url.searchParams.getAll('endpoint').map(parseEndpoint).filter(Boolean);
      const all = [...endpoints];
      for (const e of extra) if (!all.some(x => x.id === e.id)) all.push(e);
      const results = await Promise.all(all.map(describeEndpoint));
      return send(res, 200, JSON.stringify(results), MIME['.json'], {'Cache-Control': 'no-store'});
    }
    return send(res, 404, 'Not found');
  }

  const server = http.createServer((req, res) => {
    if (!allowedHost(req)) return send(res, 403, 'Forbidden host');
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return send(res, 400, 'Bad request');
    }
    if (url.pathname.startsWith('/api/')) {
      handleApi(req, res, url).catch(e => send(res, 500, String(e && e.message)));
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return serveFile(req, res, APP_DIR, 'index.html', 'no-cache');
    }
    let rel;
    try {
      rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    } catch {
      return send(res, 400, 'Bad request');
    }
    serveFile(req, res, FRONTEND_DIR, rel, 'public, max-age=3600');
  });

  // WebSocket proxy: /ws/<host:port>/<debugger path>. Chrome rejects WebSocket connections
  // from origins it hasn't been told about (--remote-allow-origins); the proxy connects
  // without an Origin header, so any Chrome or Node started with a debugging port just works.
  server.on('upgrade', (req, socket, head) => {
    const reject = (code, msg) => {
      socket.end(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`);
    };
    if (!allowedHost(req) || !allowedOrigin(req)) return reject(403, 'Forbidden');
    const m = (req.url || '').match(/^\/ws\/([^/]+)(\/.*)$/);
    const endpoint = m && parseEndpoint(m[1]);
    if (!endpoint) return reject(404, 'Not Found');

    const upstream = net.connect({host: endpoint.host.replace(/^\[|\]$/g, ''), port: endpoint.port});
    const cleanup = () => {
      socket.destroy();
      upstream.destroy();
    };
    upstream.on('error', () => {
      if (!socket.destroyed && socket.writable && !upstream.connecting) cleanup();
      else reject(502, 'Bad Gateway');
    });
    socket.on('error', cleanup);
    upstream.on('connect', () => {
      const lines = [`GET ${m[2]} HTTP/1.1`, `Host: ${endpoint.id}`, 'Upgrade: websocket', 'Connection: Upgrade'];
      for (const [k, v] of Object.entries(req.headers)) {
        if (k.startsWith('sec-websocket-')) lines.push(`${k}: ${v}`);
      }
      upstream.write(lines.join('\r\n') + '\r\n\r\n');
      if (head && head.length) upstream.write(head);
      socket.setNoDelay(true);
      upstream.setNoDelay(true);
      upstream.pipe(socket);
      socket.pipe(upstream);
      upstream.on('close', cleanup);
      socket.on('close', cleanup);
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

module.exports = {createServer, parseEndpoint, describeEndpoint, frontendFor, buildInfo, FRONTEND_DIR};
