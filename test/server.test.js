'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const {createServer, parseEndpoint} = require('../lib/server.js');

test('parseEndpoint accepts host:port, bare ports and URLs', () => {
  assert.deepStrictEqual(parseEndpoint('localhost:9222'), {host: 'localhost', port: 9222, id: 'localhost:9222'});
  assert.strictEqual(parseEndpoint('9229').id, '127.0.0.1:9229');
  assert.strictEqual(parseEndpoint('ws://10.0.0.5:9222/devtools/page/X').id, '10.0.0.5:9222');
  assert.strictEqual(parseEndpoint('[::1]:9222').id, '[::1]:9222');
  assert.strictEqual(parseEndpoint('nope'), null);
  assert.strictEqual(parseEndpoint('host:70000'), null);
});

// A fake debugging endpoint that answers /json/* and echoes WebSocket upgrades back,
// reporting whether an Origin header reached it.
function fakeEndpoint() {
  const srv = http.createServer((req, res) => {
    const port = srv.address().port;
    const body = req.url === '/json/version' ? {Browser: 'FakeChrome/1.0'} : [
      {id: 'P1', type: 'page', title: 'Page <b>1</b>', url: 'https://example.com', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/P1`},
      {id: 'N1', type: 'node', title: 'app.js', url: 'file:///app.js', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/N1`},
    ];
    res.end(JSON.stringify(body));
  });
  srv.on('upgrade', (req, socket) => {
    socket.end(`HTTP/1.1 101 Switching Protocols\r\nX-Path: ${req.url}\r\nX-Origin: ${req.headers.origin || 'none'}\r\n\r\n`);
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
}

function get(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({host: '127.0.0.1', port, path: pathname, headers}, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body}));
    }).on('error', reject);
  });
}

function upgrade(port, pathname, origin) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => {
      s.write(`GET ${pathname} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n` +
        (origin ? `Origin: ${origin}\r\n` : '') + '\r\n');
    });
    let data = '';
    s.on('data', c => data += c);
    s.on('close', () => resolve(data));
    s.on('error', reject);
  });
}

test('serves frontend, lists targets and proxies WebSockets safely', async t => {
  const upstream = await fakeEndpoint();
  const up = parseEndpoint(`127.0.0.1:${upstream.address().port}`);
  const server = await createServer({port: 0, host: '127.0.0.1', endpoints: [up, parseEndpoint('127.0.0.1:1')]});
  const port = server.address().port;
  t.after(() => {
    server.close();
    upstream.close();
  });

  const landing = await get(port, '/');
  assert.strictEqual(landing.status, 200);
  assert.match(landing.body, /<title>Chrome DevTools<\/title>/);

  const app = await get(port, '/devtools_app.html');
  assert.strictEqual(app.status, 200);
  assert.match(app.headers['content-type'], /text\/html/);
  assert.strictEqual((await get(port, '/js_app.html')).status, 200);

  assert.strictEqual((await get(port, '/%2e%2e/package.json')).status, 404);
  assert.strictEqual((await get(port, '/api/targets', {Host: 'evil.example'})).status, 403);

  const targets = JSON.parse((await get(port, '/api/targets')).body);
  const live = targets.find(e => e.endpoint === up.id);
  assert.strictEqual(live.online, true);
  assert.strictEqual(live.browser, 'FakeChrome/1.0');
  assert.deepStrictEqual(live.targets.map(x => [x.type, x.frontend, x.wsPath]), [
    ['page', 'devtools_app.html', `/ws/${up.id}/devtools/page/P1`],
    ['node', 'js_app.html', `/ws/${up.id}/N1`],
  ]);
  assert.strictEqual(targets.find(e => e.endpoint === '127.0.0.1:1').online, false);

  const ok = await upgrade(port, `/ws/${up.id}/devtools/page/P1`, `http://127.0.0.1:${port}`);
  assert.match(ok, /^HTTP\/1.1 101/);
  assert.match(ok, /X-Path: \/devtools\/page\/P1/);
  assert.match(ok, /X-Origin: none/, 'Origin must be stripped before reaching the debugger');

  const blocked = await upgrade(port, `/ws/${up.id}/devtools/page/P1`, 'https://evil.example');
  assert.match(blocked, /^HTTP\/1.1 403/);
});
