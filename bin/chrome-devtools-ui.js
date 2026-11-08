#!/usr/bin/env node
'use strict';

const {parseArgs} = require('node:util');
const {spawn, execFileSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createServer, parseEndpoint, buildInfo, FRONTEND_DIR} = require('../lib/server.js');
const PKG = require('../package.json');

const HELP = `
${PKG.name} ${PKG.version} — Chrome DevTools, prebuilt and ready to serve.

Usage
  npx chrome-devtools-ui [options]

Options
  -p, --port <n>       Port to serve on (default 8090)
  -H, --host <addr>    Interface to bind (default 127.0.0.1)
  -t, --target <h:p>   Debug endpoint to discover targets on. Repeatable.
                       (default 127.0.0.1:9222 for Chrome, 127.0.0.1:9229 for Node)
  -l, --launch [url]   Launch Chrome with remote debugging on a throwaway profile
      --chrome <path>  Chrome executable to use with --launch
  -o, --open           Open the target list in your default browser
  -v, --version        Print version
  -h, --help           Show this help

Examples
  npx chrome-devtools-ui --launch https://example.com --open
  node --inspect app.js & npx chrome-devtools-ui --open
  npx chrome-devtools-ui -t 192.168.1.20:9222
`;

function findChrome() {
  const candidates = {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ],
    win32: [
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    ],
    linux: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'],
  }[process.platform] || [];
  for (const c of candidates) {
    if (path.isAbsolute(c)) {
      if (fs.existsSync(c)) return c;
    } else {
      try {
        return execFileSync('which', [c], {encoding: 'utf8'}).trim();
      } catch {}
    }
  }
  return null;
}

function openInBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(cmd, args, {stdio: 'ignore', detached: true}).on('error', () => {}).unref();
}

async function main() {
  let values;
  try {
    ({values} = parseArgs({
      allowPositionals: false,
      options: {
        port: {type: 'string', short: 'p', default: '8090'},
        host: {type: 'string', short: 'H', default: '127.0.0.1'},
        target: {type: 'string', short: 't', multiple: true},
        launch: {type: 'string', short: 'l'},
        chrome: {type: 'string'},
        open: {type: 'boolean', short: 'o', default: false},
        version: {type: 'boolean', short: 'v', default: false},
        help: {type: 'boolean', short: 'h', default: false},
      },
      // allow bare `--launch` with no URL
      args: process.argv.slice(2).flatMap((a, i, all) =>
        (a === '--launch' || a === '-l') && (i === all.length - 1 || all[i + 1].startsWith('-')) ? [a, ''] : [a]),
    }));
  } catch (e) {
    console.error(e.message + '\n' + HELP);
    process.exit(2);
  }
  if (values.help) return console.log(HELP);
  if (values.version) return console.log(PKG.version);

  if (!fs.existsSync(path.join(FRONTEND_DIR, 'devtools_app.html'))) {
    console.error('The DevTools frontend is not downloaded yet. Run `npm run update` first.');
    process.exit(1);
  }

  const port = Number(values.port);
  const endpoints = (values.target && values.target.length ? values.target : ['127.0.0.1:9222', '127.0.0.1:9229'])
    .map(t => {
      const e = parseEndpoint(t);
      if (!e) {
        console.error(`Invalid --target "${t}", expected host:port`);
        process.exit(2);
      }
      return e;
    });

  let chromeProc = null;
  if (values.launch !== undefined) {
    const exe = values.chrome || findChrome();
    if (!exe) {
      console.error('Could not find Chrome. Pass --chrome <path>.');
      process.exit(1);
    }
    const debugPort = endpoints[0].port;
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-devtools-ui-'));
    const args = [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      values.launch || 'about:blank',
    ];
    chromeProc = spawn(exe, args, {stdio: 'ignore'});
    chromeProc.on('exit', () => {
      chromeProc = null;
      try {
        fs.rmSync(profile, {recursive: true, force: true, maxRetries: 3});
      } catch {}
    });
    console.log(`  Launched Chrome with remote debugging on port ${debugPort}`);
  }

  let server;
  try {
    server = await createServer({port, host: values.host, endpoints});
  } catch (e) {
    console.error(e.code === 'EADDRINUSE' ? `Port ${port} is already in use. Try --port <n>.` : e.message);
    process.exit(1);
  }

  const shownHost = values.host === '0.0.0.0' || values.host === '::' ? 'localhost' : values.host;
  const url = `http://${shownHost.includes(':') ? `[${shownHost}]` : shownHost}:${port}/`;
  const rev = (buildInfo() || {}).chromiumRevision;
  console.log(`
  Chrome DevTools ${rev ? `(Chromium r${rev}) ` : ''}is ready at ${url}
  Watching for targets on ${endpoints.map(e => e.id).join(', ')}
  Press Ctrl+C to stop.
`);
  if (values.open) openInBrowser(url);

  const shutdown = () => {
    server.close();
    if (!chromeProc) return process.exit(0);
    // Wait for Chrome to exit so its throwaway profile can be removed.
    chromeProc.once('exit', () => setImmediate(() => process.exit(0)));
    chromeProc.kill();
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
