import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractTargets } from './lib/targets.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, 'public');
const DATA = join(ROOT, 'data');
const BIN = join(DATA, 'graph-data.bin');
const INDEX = join(DATA, 'graph-data.index.json');
const META = join(DATA, 'meta.json');
const PORT = Number(process.env.PORT ?? 7319);
const ORIGIN = 'https://peqdb.com';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const SQUIG_INDEX = join(DATA, 'squig-index.json');
const SQUIG_META = join(DATA, 'squig', 'meta.json');
const SQUIG_TARGETS = join(DATA, 'squig', 'targets.json');
const SQUIG_BIN = join(DATA, 'squig', 'records.bin');
const TARGETS = join(DATA, 'targets.json');
const AUTO_EQ = join(ROOT, 'bin', process.platform === 'win32' ? 'autoeq.exe' : 'autoeq');

async function targetsFile() {
  for (const file of [TARGETS, SQUIG_TARGETS]) if (await exists(file)) return file;
  return null;
}

async function squigAvailable() {
  return (await exists(SQUIG_INDEX)) && (await exists(SQUIG_BIN));
}

function extractIndex(html) {
  const marker = 'window.__INDEX__ = ';
  const at = html.indexOf(marker);
  if (at < 0) throw new Error('__INDEX__ not found in studio html');
  const start = at + marker.length;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return JSON.parse(html.slice(start, i + 1));
    }
  }
  throw new Error('unterminated __INDEX__');
}

async function ensureData(log) {
  await mkdir(DATA, { recursive: true });

  if (!(await exists(BIN)) || !(await exists(INDEX))) {
    const page = await fetch(`${ORIGIN}/studio/`, { headers: { 'user-agent': 'peqdb-range-match/1.0' } });
    if (!page.ok) throw new Error(`studio html ${page.status}`);
    const html = await page.text();
    const index = extractIndex(html);

    const href = /id="graph-data-preload"\s+href="([^"]+)"/.exec(html)?.[1];
    const url = href ? new URL(href, ORIGIN).href : `${ORIGIN}/data/graph-data.bin`;

    const t0 = Date.now();
    const bin = await fetch(url, { headers: { 'user-agent': 'peqdb-range-match/1.0' } });
    if (!bin.ok) throw new Error(`graph-data ${bin.status}`);
    const buf = Buffer.from(await bin.arrayBuffer());

    let graphs = 0;
    for (const cat of Object.values(index))
      for (const src of Object.values(cat))
        for (const model of Object.values(src))
          for (const [, count] of Object.values(model)) graphs += count;

    if (buf.length !== graphs * 776) throw new Error(`size mismatch: ${buf.length} bytes for ${graphs} graphs`);

    await writeFile(BIN, buf);
    await writeFile(INDEX, JSON.stringify(index));
    await writeFile(META, JSON.stringify({ url, bytes: buf.length, graphs, fetched: new Date().toISOString() }, null, 2));
    log(`downloaded ${(buf.length / 1e6).toFixed(1)} MB, ${graphs} graphs in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  if (!(await targetsFile())) {
    try {
      const { targets, path } = await extractTargets({ dataDir: DATA });
      log(`extracted ${targets.length} target curves -> ${path}`);
    } catch (err) {
      log(`targets unavailable (${err.message}); peqdb mode opens without a default reference`);
    }
  }
}

async function readBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function runAutoEq(input, smooth, filters, steps) {
  return new Promise((resolve, reject) => {
    const child = spawn(AUTO_EQ, [smooth, String(filters), String(steps)], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('autoeq timed out'));
    }, 10_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`autoeq exited ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`));
        return;
      }
      const lines = out.trim().split('\n');
      const [amp, max] = lines[0].trim().split(/\s+/).map(Number);
      if (!Number.isFinite(amp)) {
        reject(new Error('autoeq returned an invalid amp'));
        return;
      }
      const parsed = lines.slice(1).map((line) => {
        const [type, f0, gain, q] = line.trim().split(/\s+/);
        return { type, f0: Number(f0), gain: Number(gain), q: Number(q) };
      }).filter((f) => ['PK', 'LSC', 'HSC'].includes(f.type) && Number.isFinite(f.f0) && Number.isFinite(f.gain) && Number.isFinite(f.q));
      if (!parsed.length) {
        reject(new Error('autoeq returned no filters'));
        return;
      }
      resolve({ amp, max, filters: parsed });
    });
    child.stdin.end(input);
  });
}

function json(res, value, code = 200) {
  const body = JSON.stringify(value);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  try {
    if (path === '/api/health') {
      return json(res, { ok: true, data: await exists(BIN), targets: Boolean(await targetsFile()), squig: await squigAvailable(), autoeq: await exists(AUTO_EQ), port: PORT });
    }
    if (path === '/api/meta') {
      return json(res, JSON.parse(await readFile(META, 'utf8')));
    }
    if (path === '/api/catalog') {
      const index = JSON.parse(await readFile(INDEX, 'utf8'));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(index));
    }
    if (path === '/api/data') {
      const { size } = await stat(BIN);
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': size,
        'cache-control': 'public, max-age=31536000, immutable',
      });
      return createReadStream(BIN).pipe(res);
    }

    if (path === '/api/autoeq') {
      if (req.method !== 'POST') return json(res, { error: 'POST required' }, 405);
      if (!(await exists(AUTO_EQ))) return json(res, { error: 'autoeq not built', build: 'npm run build:autoeq' }, 503);
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const dst = body.dst;
      const src = body.src;
      if (!Array.isArray(dst) || !Array.isArray(src) || dst.length !== 384 || src.length !== 384)
        return json(res, { error: 'dst and src must be 384-point arrays' }, 400);
      if (![...dst, ...src].every(Number.isFinite))
        return json(res, { error: 'dst and src must be finite numbers' }, 400);
      const smooth = ['i', 'o', 'x'].includes(body.smooth) ? body.smooth : 'i';
      const filters = Math.max(2, Math.min(32, Number(body.filters) || 10));
      const steps = Math.max(1, Math.min(20_000, Number(body.steps) || 3000));
      const input = Buffer.alloc(384 * 4 * 2);
      for (let k = 0; k < 384; k++) {
        input.writeFloatLE(dst[k], k * 4);
        input.writeFloatLE(src[k], 384 * 4 + k * 4);
      }
      const t0 = Date.now();
      const result = await runAutoEq(input, smooth, filters, steps);
      return json(res, { ...result, ms: Date.now() - t0 });
    }

    if (path === '/api/squig-status') {
      const ready = await squigAvailable();
      const meta = await exists(SQUIG_META) ? JSON.parse(await readFile(SQUIG_META, 'utf8')) : null;
      return json(res, { ok: ready, meta, build: ready ? undefined : 'node build-squig.mjs' });
    }
    if (path === '/api/targets' || path === '/api/squig-targets') {
      const file = await targetsFile();
      if (!file)
        return json(res, { error: 'targets not extracted', retry: 'restart with network access, or run: node build-squig.mjs' }, 503);
      return json(res, JSON.parse(await readFile(file, 'utf8')));
    }
    if (path === '/api/squig' || path === '/api/squig-meta') {
      if (!(await squigAvailable()))
        return json(res, { error: 'squig cache not built', build: 'node build-squig.mjs' }, 503);
      if (path === '/api/squig') return json(res, JSON.parse(await readFile(SQUIG_INDEX, 'utf8')));
      return json(res, JSON.parse(await readFile(SQUIG_META, 'utf8')));
    }
    if (path === '/api/squig-data') {
      if (!(await squigAvailable())) return json(res, { error: 'squig cache not built', build: 'node build-squig.mjs' }, 503);
      const { size } = await stat(SQUIG_BIN);
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': size,
        'cache-control': 'public, max-age=31536000, immutable',
      });
      return createReadStream(SQUIG_BIN).pipe(res);
    }

    const rel = normalize(decodeURIComponent(path === '/' ? '/index.html' : path)).replace(/^(\.\.[/\\])+/, '');
    const file = join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC)) return json(res, { error: 'forbidden' }, 403);
    if (!(await exists(file))) return json(res, { error: 'not found' }, 404);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    return createReadStream(file).pipe(res);
  } catch (err) {
    json(res, { error: String(err.message ?? err) }, 500);
  }
});

const log = (msg) => process.stdout.write(`[peqdb-range-match] ${msg}\n`);

await ensureData(log);
server.listen(PORT, '127.0.0.1', () => log(`listening on http://127.0.0.1:${PORT}`));
