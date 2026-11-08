#!/usr/bin/env node
// Pulls a prebuilt DevTools frontend from Chromium's continuous-build snapshot bucket
// (gs://chromium-browser-snapshots/<platform>/<revision>/devtools-frontend.zip) into ./front_end.
//
//   node scripts/update.mjs              # newest revision that has a frontend build
//   node scripts/update.mjs --rev 1738650
//   node scripts/update.mjs --force      # reinstall even if already at that revision
//   node scripts/update.mjs --set-version # also set package.json version to 1.0.<revision> (used when publishing)

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUCKET = 'https://storage.googleapis.com/chromium-browser-snapshots';
const API = 'https://www.googleapis.com/storage/v1/b/chromium-browser-snapshots/o';

const {values} = parseArgs({
  options: {
    rev: {type: 'string'},
    platform: {type: 'string', default: 'Linux_x64'},
    force: {type: 'boolean', default: false},
    'set-version': {type: 'boolean', default: false},
  },
});
const platform = values.platform;

async function fetchOk(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
  return res;
}

async function zipMeta(rev) {
  const name = encodeURIComponent(`${platform}/${rev}/devtools-frontend.zip`);
  const res = await fetch(`${API}/${name}?fields=name,size,timeCreated,md5Hash`);
  return res.ok ? res.json() : null;
}

// Not every snapshot revision finishes with a frontend zip. Walk back through
// revisions in the bucket (listed by shared prefix) until one does.
async function findRevision(startRev) {
  if (await zipMeta(startRev)) return startRev;
  let prefix = String(startRev).slice(0, -2);
  for (let i = 0; i < 5; i++) {
    const q = new URLSearchParams({prefix: `${platform}/${prefix}`, matchGlob: '**/devtools-frontend.zip', fields: 'items(name)'});
    const {items = []} = await (await fetchOk(`${API}?${q}`)).json();
    const revs = items.map(it => Number(it.name.split('/')[1])).filter(r => r <= startRev).sort((a, b) => b - a);
    if (revs.length) return revs[0];
    prefix = String(Number(prefix) - 1);
  }
  throw new Error(`No devtools-frontend.zip found near r${startRev} on ${platform}`);
}

const latest = Number(values.rev || (await (await fetchOk(`${BUCKET}/${platform}/LAST_CHANGE`)).text()).trim());
const rev = values.rev ? latest : await findRevision(latest);
const meta = await zipMeta(rev);
if (!meta) throw new Error(`r${rev} has no devtools-frontend.zip on ${platform}`);

const pkgPath = path.join(ROOT, 'package.json');
const buildInfoPath = path.join(ROOT, 'front_end', 'devtools-build.json');
const readJSON = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const current = readJSON(buildInfoPath)?.chromiumRevision ?? null;
const setVersion = () => {
  if (!values['set-version']) return;
  const pkg = readJSON(pkgPath);
  pkg.version = `1.0.${rev}`;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
};
const setOutput = (k, v) => process.env.GITHUB_OUTPUT && fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);

if (current === rev && !values.force && fs.existsSync(path.join(ROOT, 'front_end', 'devtools_app.html'))) {
  console.log(`Already at Chromium r${rev}.`);
  setVersion();
  setOutput('changed', 'false');
  setOutput('revision', String(rev));
  process.exit(0);
}

console.log(`Downloading DevTools frontend from Chromium r${rev} (${(meta.size / 1e6).toFixed(1)} MB)…`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devtools-frontend-'));
try {
  const zip = path.join(tmp, 'devtools-frontend.zip');
  fs.writeFileSync(zip, Buffer.from(await (await fetchOk(`${BUCKET}/${platform}/${rev}/devtools-frontend.zip`)).arrayBuffer()));
  const revisions = await (await fetchOk(`${BUCKET}/${platform}/${rev}/REVISIONS`)).json().catch(() => ({}));

  const out = path.join(tmp, 'x');
  execFileSync('unzip', ['-q', zip, '-d', out]);
  const built = path.join(out, 'devtools-frontend', 'front_end');
  for (const required of ['devtools_app.html', 'js_app.html', 'entrypoints']) {
    if (!fs.existsSync(path.join(built, required))) throw new Error(`Unexpected zip layout: missing front_end/${required}`);
  }

  const dest = path.join(ROOT, 'front_end');
  fs.rmSync(dest, {recursive: true, force: true});
  fs.cpSync(built, dest, {recursive: true});

  fs.writeFileSync(buildInfoPath, JSON.stringify({
    chromiumRevision: rev,
    chromiumCommit: revisions.got_revision || null,
    v8Version: (revisions.got_v8_revision_cp || '').replace(/^refs\/heads\/|@\{#.*$/g, '') || null,
    built: meta.timeCreated,
    source: `${BUCKET}/${platform}/${rev}/devtools-frontend.zip`,
  }, null, 2) + '\n');
  setVersion();

  const files = execFileSync('find', [dest, '-type', 'f'], {encoding: 'utf8'}).trim().split('\n').length;
  console.log(`Installed ${files} files into front_end/ (was r${current ?? 'none'}, now r${rev}).`);
  setOutput('changed', 'true');
  setOutput('revision', String(rev));
} finally {
  fs.rmSync(tmp, {recursive: true, force: true});
}
