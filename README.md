# chrome-devtools-ui

The latest **Chrome DevTools**, prebuilt and ready to serve, with a zero-config CLI for inspecting Chrome tabs and Node.js processes from any browser.

```sh
npx chrome-devtools-ui --launch https://example.com --open
```

Google's [`chrome-devtools-frontend`](https://www.npmjs.com/package/chrome-devtools-frontend) package is the raw TypeScript source tree; using it means a Chromium toolchain (`depot_tools`, `gn`, `ninja`) and a long build. This package is the built output from Chromium's own builders, republished daily, plus a small server that makes it usable on its own:

- **Ready to serve.** `front_end/` is the compiled frontend: open `devtools_app.html` and go.
- **Target list.** A landing page that finds debuggable Chrome tabs and Node.js processes and opens DevTools for any of them in one click.
- **No `--remote-allow-origins`.** Chrome refuses DevTools WebSocket connections from origins it hasn't been told about. The built-in proxy connects for you, so any Chrome or Node started with a debugging port just works.
- **No dependencies.** Plain Node.js, 18.3 or newer.

## Usage

### Debug a Chrome tab

```sh
npx chrome-devtools-ui --launch https://example.com --open
```

`--launch` starts Chrome with remote debugging on a throwaway profile (Chrome no longer allows remote debugging on your everyday profile) and removes it on exit. To use a Chrome you started yourself:

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 --user-data-dir=/tmp/devtools-profile
npx chrome-devtools-ui --open
```

### Debug a Node.js process

```sh
node --inspect app.js
npx chrome-devtools-ui --open
```

### Remote machines, Android, other ports

```sh
npx chrome-devtools-ui -t 192.168.1.20:9222 -t 127.0.0.1:9230
```

Endpoints can also be added from the landing page. For Android, forward the port first: `adb forward tcp:9222 localabstract:chrome_devtools_remote`.

### Options

| Option | Default | |
| --- | --- | --- |
| `-p, --port <n>` | `8090` | Port to serve on |
| `-H, --host <addr>` | `127.0.0.1` | Interface to bind |
| `-t, --target <host:port>` | `127.0.0.1:9222`, `127.0.0.1:9229` | Debug endpoints to discover targets on (repeatable) |
| `-l, --launch [url]` | | Launch Chrome with remote debugging |
| `--chrome <path>` | auto-detected | Chrome executable for `--launch` |
| `-o, --open` | | Open the target list in your browser |

### Without the CLI

`front_end/` is a static site. Serve it with anything and point DevTools at a target:

```
http://localhost:8000/devtools_app.html?ws=127.0.0.1:9222/devtools/page/<id>
http://localhost:8000/js_app.html?ws=127.0.0.1:9229/<id>          # Node.js
```

Chrome must then be started with `--remote-allow-origins=http://localhost:8000`.

The server is also usable as a library:

```js
const {createServer, parseEndpoint} = require('chrome-devtools-ui');
await createServer({port: 8090, host: '127.0.0.1', endpoints: [parseEndpoint('127.0.0.1:9222')]});
```

## How it works

| Path | What |
| --- | --- |
| `/` | Target list |
| `/devtools_app.html`, `/js_app.html`, … | The DevTools frontend |
| `/api/targets` | Targets from every endpoint (`/json/list` + `/json/version`) |
| `/ws/<host:port>/<path>` | WebSocket proxy to the debugger |

The proxy only accepts connections whose `Origin` is the server itself, and the server rejects requests for any `Host` other than itself (blocking DNS rebinding). A page on another website cannot reach your debugger through it. It binds to `127.0.0.1` by default. Only use `--host 0.0.0.0` on a network you trust, since anyone who can reach the port can control the browsers it is connected to.

## Versions and updates

The version is `1.0.<Chromium revision>`, so `chrome-devtools-ui@1.0.1738649` is DevTools as built in [Chromium r1738649](https://crrev.com/1738649). Builds come from Chromium's continuous-build snapshots (`gs://chromium-browser-snapshots/<platform>/<rev>/devtools-frontend.zip`), which track Chromium `main` (roughly Canary). The landing page and `front_end/devtools-build.json` show the exact revision.

## Development

```sh
git clone https://github.com/vsych/chrome-devtools-ui && cd chrome-devtools-ui
npm run update   # download the newest frontend into front_end/ (not committed to git)
npm test
npm start
```

`node scripts/update.mjs --rev <n>` pins a specific Chromium revision.

**Publishing** is automated by [`.github/workflows/publish.yml`](.github/workflows/publish.yml) using npm trusted publishing (no stored token). Run it manually, or set the repository variable `AUTO_PUBLISH=true` to publish the newest build daily.

## License

The DevTools frontend in `front_end/` is © The Chromium Authors, BSD-3-Clause (see [LICENSE](LICENSE)). The CLI, server and landing page are released under the same license. Not affiliated with or endorsed by Google.
