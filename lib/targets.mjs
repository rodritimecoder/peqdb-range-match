import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { N } from '../public/core.mjs';

const ORIGIN = 'https://peqdb.com';
const UA = 'peqdb-range-match/1.0 (+https://github.com/rodritimecoder/peqdb-range-match)';

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
}

async function studioApp(cacheDir) {
  const studio = await fetchText(`${ORIGIN}/studio/`);
  const asset = /\/studio\/assets\/index-[^"']+\.js/.exec(studio)?.[0];
  if (!asset) throw new Error('studio app asset not found in studio html');
  const cachePath = join(cacheDir, 'studio-app.js');
  try {
    const info = await stat(cachePath);
    if (Date.now() - info.mtimeMs < 24 * 3600 * 1000) return readFile(cachePath, 'utf8');
  } catch { /* cache miss */ }
  const appJs = await fetchText(new URL(asset, ORIGIN).href);
  await mkdir(cacheDir, { recursive: true });
  await writeFile(cachePath, appJs);
  return appJs;
}

function targetTable(appJs) {
  const at = appJs.indexOf('var gm={');
  if (at < 0) throw new Error('target table (var gm) not found in app bundle');
  let depth = 0;
  for (let i = at; i < appJs.length; i++) {
    if (appJs[i] === '{') depth++;
    else if (appJs[i] === '}') {
      depth--;
      if (depth === 0) return appJs.slice(at, i + 1);
    }
  }
  throw new Error('unterminated target table');
}

function groupOf(table, name) {
  let current = 'Reference';
  const cut = table.indexOf(`"${name}"`);
  for (const match of table.matchAll(/"((?:\\.|[^"\\])+)":\s*\{/g)) {
    if (match.index > cut) break;
    current = match[1];
  }
  return current;
}

export async function extractTargets({ dataDir, cacheDir = join(dataDir, 'squig', 'cache') }) {
  const appJs = await studioApp(cacheDir);
  const table = targetTable(appJs);

  const refs = [];
  for (const match of table.matchAll(/"((?:\\.|[^"\\])+)":\s*\{\s*csv\s*:\s*([A-Za-z$_][\w$]*)\s*\}/g))
    refs.push({ name: JSON.parse(`"${match[1]}"`), className: match[2] });
  if (!refs.length) throw new Error('no csv:<var> references parsed from target table');

  const targets = [];
  const seen = new Set();
  for (const ref of refs) {
    if (seen.has(ref.name)) continue;
    seen.add(ref.name);
    const def = new RegExp(`${ref.className.replace(/\$/g, '\\$')}=\`([^\`]*)\``, 's').exec(appJs);
    if (!def) continue;
    const rows = [];
    for (const line of def[1].trim().split(/\r?\n/)) {
      const [f, v] = line.trim().split(/[\t;, ]+/).map(Number.parseFloat);
      if (!Number.isFinite(f) || !Number.isFinite(v)) continue;
      rows.push([f, v]);
    }
    if (rows.length !== N) continue;
    rows.sort((a, b) => a[0] - b[0]);
    const group = groupOf(table, ref.name);
    let kind = /OE/i.test(group) ? 'OE' : 'IE';
    if (/^Δ|^∆|\bdelta\b/i.test(ref.name)) kind = 'delta';
    if (kind === 'delta') continue;
    targets.push({ group, name: ref.name, kind, grid: rows.map((row) => ({ f: row[0], v: row[1] })) });
  }
  if (!targets.some((t) => t.name === 'PEQdB Diamond')) throw new Error('PEQdB Diamond target missing after extraction');

  const out = join(dataDir, 'targets.json');
  await mkdir(dataDir, { recursive: true });
  await writeFile(out, JSON.stringify({ source: 'extracted from peqdb.com studio app bundle', extracted: new Date().toISOString(), targets }, null, 2));
  return { targets, path: out };
}
