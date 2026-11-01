import { readFile, writeFile, stat, mkdir, appendFile, open, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { N, F_MIN, F_MAX, parseCurveText } from './public/core.mjs';
import { extractTargets } from './lib/targets.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA = join(ROOT, 'data');
const SQUIG = join(DATA, 'squig');
const CACHE = join(SQUIG, 'cache');
const PROBES = join(SQUIG, 'probes.json');
const RECORD_BYTES = 776;
const UA = 'peqdb-range-match-builder/1.0 (+https://github.com/rodritimecoder/peqdb-range-match)';
const DATA_DIRS = ['data/', 'data/phones/', 'data/measurements/', 'data/iems/', 'data/headphones/', 'data/earbuds/'];

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const siteFilterRaw = flag('sites', 'all');
const concurrency = Number(flag('concurrency', 10));
const maxSamples = Math.max(1, Math.min(10, Number(flag('samples', 3)) || 3));
const maxLatencyMs = Number(flag('max-latency', 0)) || 0;
const retryMisses = args.includes('--retry-misses');
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
  console.error('concurrency must be 1..32');
  process.exit(2);
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function fetchStatus(url) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20_000) });
    await res.arrayBuffer().catch(() => {});
    return res.status;
  } catch {
    return -1;
  }
}

async function cachedFetch(url, file) {
  try {
    const info = await stat(file);
    if (Date.now() - info.mtimeMs < 24 * 3600 * 1000) return JSON.parse(await readFile(file, 'utf8'));
  } catch { /* not cached or unreadable; refetch */ }
  const body = await fetchText(url);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, body);
  return JSON.parse(body);
}

function siteBase(site) {
  if (site.urlType === 'root') return 'https://squig.link';
  if (site.urlType === 'subdomain') return `https://${site.username}.squig.link`;
  if (site.urlType === 'altDomain') return site.altDomain;
  return `https://squig.link/lab/${site.username}`;
}

async function ensureSites() {
  const sites = await cachedFetch('https://squig.link/squigsites.json', join(CACHE, 'squigsites.json'));
  if (!Array.isArray(sites) || sites.length < 10) throw new Error('squigsites.json looks wrong');
  return sites;
}

async function loadPhoneBooks(sites) {
  const out = [];
  for (const site of sites) {
    for (const db of site.dbs ?? []) {
      const folder = db.folder.endsWith('/') ? db.folder : `${db.folder}/`;
      const path = join(CACHE, 'phonebooks', `${site.username}${folder}`.replace(/[^a-z0-9._-]/gi, '_') + '.json');
      try {
        const book = await cachedFetch(`${siteBase(site)}${folder}data/phone_book.json`, path);
        if (!Array.isArray(book)) throw new Error('phone book is not an array');
        out.push({ site, siteKey: `${site.username}|${folder}`, url: siteBase(site), folder, dbType: db.type, book, probe: null });
      } catch (err) {
        console.log(`skip ${site.name} ${folder}: ${err.message}`);
      }
    }
  }
  return out;
}

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function phoneStems(phone) {
  const raw = phone.file ?? phone.name;
  if (raw === undefined) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const stem = arr[i];
    if (typeof stem !== 'string' || !stem.trim()) continue;
    let name;
    if (!Array.isArray(raw)) {
      name = phone.name ?? stem;
    } else if (Array.isArray(phone.suffix)) {
      const suffix = phone.suffix[i] ? ` ${phone.suffix[i]}` : '';
      name = `${phone.name ?? stem}${suffix}`;
    } else if (typeof phone.prefix === 'string' && phone.prefix) {
      const rest = stem.replace(new RegExp(`^${escapeRe(phone.prefix)}\\s*`, 'i'), '');
      name = `${phone.name ?? stem}${rest ? ` ${rest}` : ''}`;
    } else {
      name = stem;
    }
    out.push({ stem: stem.trim(), name: name.trim() });
  }
  return out;
}

function probeStems(book) {
  const stems = [];
  const seen = new Set();
  for (const brand of book) {
    for (const phone of brand.phones ?? []) {
      for (const { stem } of phoneStems(phone)) {
        if (seen.has(stem)) continue;
        seen.add(stem);
        stems.push(stem);
        if (stems.length >= 8) return stems;
      }
    }
  }
  return stems;
}

function probeUrl(book, dir, stem, ch, num) {
  const name = `${stem} ${ch}${num === null ? '' : num}.txt`;
  return `${book.url}${book.folder}${dir}${encodeURIComponent(name)}`;
}

async function probeDb(book) {
  const stems = probeStems(book.book);
  if (!stems.length) return { error: 'empty phone book' };
  let networkErrors = 0;
  for (const dir of DATA_DIRS) {
    for (const numbered of [false, true]) {
      for (const stem of stems) {
        for (const ch of ['L', 'R']) {
          const url = probeUrl(book, dir, stem, ch, numbered ? 1 : null);
          const status = await fetchStatus(url);
          if (status === 200) {
            let samples = 1;
            if (numbered) {
              for (const candidate of stems) {
                let count = 0;
                for (let n = 1; n <= 10; n++) {
                  if (await fetchStatus(probeUrl(book, dir, candidate, ch, n)) !== 200) break;
                  count = n;
                }
                if (count > samples) samples = count;
                if (samples >= 10) break;
              }
            }
            return { dir, numbered, samples, probeStem: stem, probeChannel: ch, probedAt: new Date().toISOString() };
          }
          if (status === 401 || status === 403) return { error: `HTTP ${status} (blocked)`, probedAt: new Date().toISOString() };
          if (status === -1) {
            networkErrors++;
            if (networkErrors >= 3) return { error: 'network unreachable', probedAt: new Date().toISOString() };
          }
        }
      }
    }
  }
  return { error: 'no reachable data file', probedAt: new Date().toISOString() };
}

async function applyProbes(books) {
  let cache = { version: 3, dbs: {} };
  try {
    const parsed = JSON.parse(await readFile(PROBES, 'utf8'));
    if (parsed?.dbs && parsed.version === 3) cache = parsed;
  } catch { /* first run */ }

  const pending = books.filter((b) => !cache.dbs[b.siteKey]);
  if (pending.length) {
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(6, pending.length) }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= pending.length) return;
        const book = pending[i];
        const probe = await probeDb(book);
        if (probe.error) console.log(`dead db ${book.site.name}${book.folder}: ${probe.error}`);
        cache.dbs[book.siteKey] = probe;
        await writeFile(PROBES, JSON.stringify(cache, null, 2));
      }
    }));
  }

  const live = [];
  const dead = [];
  for (const book of books) {
    const probe = cache.dbs[book.siteKey];
    book.probe = probe;
    if (probe && !probe.error) live.push(book);
    else dead.push({ name: book.site.name, url: book.url, folder: book.folder, dbType: book.dbType, error: probe?.error ?? 'not probed' });
  }
  return { live, dead, cache };
}

async function ensureDoneState() {
  const path = join(SQUIG, 'done.jsonl');
  const done = new Map();
  const missed = new Set();
  try {
    for (const line of (await readFile(path, 'utf8')).split('\n').filter(Boolean)) {
      try {
        const rec = JSON.parse(line);
        if (!rec.key) continue;
        if (rec.status === 'ok') {
          done.set(rec.key, rec);
          missed.delete(rec.key);
        } else if (rec.status === 'miss' && !done.has(rec.key)) {
          missed.add(rec.key);
        }
      } catch { /* skip malformed line */ }
    }
  } catch { /* first run */ }
  return { path, done, missed };
}

function encodeRecord(grid) {
  let min = Infinity;
  let max = -Infinity;
  for (const v of grid) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!(max > min)) max = min + 0.001;
  const scale = (max - min) / 65_535;
  const offset = -scale * 32_768 - min;
  const out = Buffer.alloc(RECORD_BYTES);
  out.writeFloatLE(scale, 0);
  out.writeFloatLE(offset, 4);
  for (let k = 0; k < N; k++) {
    const s = Math.round((grid[k] + offset) / scale);
    out.writeInt16LE(Math.max(-32_768, Math.min(32_767, s)), 8 + 2 * k);
  }
  return out;
}

function channelList(book, stem, ch) {
  const urls = [];
  for (let n = 1; n <= book.probe.samples; n++)
    urls.push(`${book.url}${book.folder}${book.probe.dir}${encodeURIComponent(`${stem} ${ch}${book.probe.numbered ? n : ''}.txt`)}`);
  return { ch, urls };
}

function buildFileList(books) {
  const files = [];
  const seen = new Set();
  for (const book of books) {
    for (const brand of book.book) {
      for (const phone of brand.phones ?? []) {
        for (const { stem, name } of phoneStems(phone)) {
          const key = `${book.siteKey}|${stem}`;
          if (seen.has(key)) continue;
          seen.add(key);
          files.push({
            key,
            channels: [channelList(book, stem, 'L'), channelList(book, stem, 'R')],
            meta: { bi: books.indexOf(book), dbType: book.dbType, brand: brand.name, name, file: stem },
          });
        }
      }
    }
  }
  return files;
}

function pool(items, worker, size = concurrency) {
  let cursor = 0;
  const n = Math.min(size, items.length);
  return Promise.all(Array.from({ length: n }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  }));
}

async function channelGrid(channel) {
  const urls = channel.urls.slice(0, maxSamples);
  const grids = (await Promise.all(urls.map(async (url) => {
    try {
      const text = await fetchText(url);
      return text.trim() ? parseCurveText(text).grid : null;
    } catch {
      return null;
    }
  }))).filter(Boolean);
  if (!grids.length) return null;
  if (grids.length === 1) return grids[0];
  const avg = new Float64Array(N);
  for (const grid of grids) for (let k = 0; k < N; k++) avg[k] += grid[k];
  for (let k = 0; k < N; k++) avg[k] /= grids.length;
  return avg;
}

async function harvestCurves(files, state, writeBlock) {
  let okCurves = 0;
  let processed = 0;
  let missCount = 0;
  const misses = [];
  const entries = [];
  const t0 = Date.now();
  await pool(files, async (item) => {
    processed++;
    if (processed % 2500 === 0) {
      console.log(`progress ${processed}/${files.length} files · ${okCurves} curves this run · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
    const prior = state.done.get(item.key);
    if (prior) {
      entries.push({ ...item.meta, start: prior.idx, count: prior.count });
      return;
    }
    if (!retryMisses && state.missed.has(item.key)) return;
    const records = [];
    const grids = await Promise.all(item.channels.map(channelGrid));
    for (const grid of grids) {
      if (!grid) continue;
      records.push(encodeRecord(grid));
      okCurves++;
    }
    if (!records.length) {
      await appendFile(state.path, `${JSON.stringify({ key: item.key, status: 'miss' })}\n`);
      state.missed.add(item.key);
      missCount++;
      if (misses.length < 400) misses.push(item.channels[0].urls[0]);
      return;
    }
    const start = await writeBlock(records);
    if (start < 0) throw new Error('negative record index');
    entries.push({ ...item.meta, start, count: records.length });
    state.done.set(item.key, { key: item.key, idx: start, count: records.length });
    state.missed.delete(item.key);
    await appendFile(state.path, `${JSON.stringify({ key: item.key, status: 'ok', idx: start, count: records.length })}\n`);
  });
  return { okCurves, misses, missCount, entries };
}

async function acquireLock() {
  const path = join(SQUIG, 'build.lock');
  try {
    const fh = await open(path, 'wx');
    await fh.write(`${process.pid}\n`);
    await fh.close();
    return path;
  } catch (err) {
    if (err.code === 'EEXIST') {
      const stale = await stat(path).then((i) => Date.now() - i.mtimeMs > 3 * 60 * 60 * 1000).catch(() => false);
      if (!stale) throw new Error('another build-squig instance is running (data/squig/build.lock)');
    }
    try {
      await unlink(path);
    } catch { /* nothing to clean */ }
    const fh = await open(path, 'wx');
    await fh.write(`${process.pid}\n`);
    await fh.close();
    return path;
  }
}

let activeLock = null;

async function main() {
  await mkdir(SQUIG, { recursive: true });
  await mkdir(CACHE, { recursive: true });
  await mkdir(join(CACHE, 'phonebooks'), { recursive: true });
  const lockPath = await acquireLock();
  activeLock = lockPath;
  try {
    const t0 = Date.now();

    const allSites = await ensureSites();
    let sites = allSites;
    if (siteFilterRaw !== 'all') {
      const wanted = new Set(siteFilterRaw.split(',').map((s) => s.trim().toLowerCase()));
      sites = allSites.filter((s) => wanted.has(s.username.toLowerCase()) || wanted.has(s.name.toLowerCase()));
      if (!sites.length) throw new Error(`no sites matched --sites ${siteFilterRaw}`);
    }
    console.log(`sites: ${sites.length}/${allSites.length} (--sites ${siteFilterRaw})`);

    const targets = await extractTargets({ dataDir: DATA });
    console.log(`targets: ${targets.targets.length} parsed (PEQdB Diamond ok) -> ${targets.path}`);

    const loaded = await loadPhoneBooks(sites);
    console.log(`phone books: ${loaded.length} db folders`);
    const { live, dead } = await applyProbes(loaded);
    let chosen = live;
    const slow = [];
    if (maxLatencyMs > 0) {
      try {
        const speeds = JSON.parse(await readFile(join(SQUIG, 'speeds.json'), 'utf8')).dbs ?? [];
        const byKey = new Map(speeds.map((s) => [s.siteKey, s]));
        for (const book of live) {
          const speed = byKey.get(book.siteKey);
          if (speed && (speed.medianMs === null || speed.medianMs > maxLatencyMs)) slow.push({ ...book, speed });
        }
        const slowKeys = new Set(slow.map((b) => b.siteKey));
        chosen = live.filter((b) => !slowKeys.has(b.siteKey));
        console.log(`latency filter <= ${maxLatencyMs}ms: kept ${chosen.length}/${live.length} dbs (${slow.length} slow)`);
      } catch (err) {
        console.log(`latency filter skipped: ${err.message}`);
      }
    }
    console.log(`reachable dbs: ${chosen.length}, dead: ${dead.length}, slow: ${slow.length}`);
    const numbered = chosen.filter((b) => b.probe.numbered).length;
    console.log(`sample-numbered dbs: ${numbered}`);

    const files = buildFileList(chosen);
    console.log(`unique measurement files: ${files.length}`);

    const state = await ensureDoneState();
    const recordsPath = join(SQUIG, 'records.bin');
    const recordsInfo = await stat(recordsPath).catch(() => ({ size: 0 }));
    let binSize = recordsInfo.size;
    if (binSize % RECORD_BYTES) throw new Error(`records.bin misaligned: ${binSize}`);
    let writeChain = Promise.resolve();
    const writeBlock = (blocks) => {
      writeChain = writeChain.then(async () => {
        const start = binSize / RECORD_BYTES;
        await appendFile(recordsPath, Buffer.concat(blocks));
        binSize += blocks.length * RECORD_BYTES;
        return start;
      });
      return writeChain;
    };

    const { okCurves, misses, missCount, entries } = await harvestCurves(files, state, writeBlock);
    await writeChain;
    console.log(`curves fetched this run: ${okCurves}, no-data files this run: ${missCount}`);

    const index = {
      grid: { n: N, minHz: F_MIN, maxHz: F_MAX, recordBytes: RECORD_BYTES },
      sites: chosen.map((b) => ({
        name: b.site.name ?? b.siteKey,
        url: b.url,
        folder: b.folder,
        dbType: b.dbType,
        dataDir: b.probe.dir,
        numbered: b.probe.numbered,
        samples: Math.min(b.probe.samples, maxSamples),
      })),
      entries,
    };
    await writeFile(join(DATA, 'squig-index.json'), JSON.stringify(index));
    await writeFile(join(SQUIG, 'meta.json'), JSON.stringify({
      built: new Date().toISOString(),
      durationMs: Date.now() - t0,
      sites: index.sites.length,
      files: index.entries.length,
      curves: binSize / RECORD_BYTES,
      bytes: binSize,
      sampleNumberedDbs: numbered,
      deadDbs: dead,
      slowDbs: slow.map((b) => ({
        name: b.site.name,
        url: b.url,
        folder: b.folder,
        dbType: b.dbType,
        medianMs: b.speed.medianMs,
        files: b.speed.files,
      })),
      misses: { count: files.reduce((n, f) => n + (state.missed.has(f.key) ? 1 : 0), 0), sample: misses.slice(0, 400) },
    }, null, 2));
    console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${binSize} bytes, ${index.entries.length} entries`);
  } finally {
    await unlink(lockPath).catch(() => {});
    activeLock = null;
  }
}

const releaseOnSignal = async () => {
  if (activeLock) await unlink(activeLock).catch(() => {});
  process.exit(0);
};
process.once('SIGINT', releaseOnSignal);
process.once('SIGTERM', releaseOnSignal);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`build-squig: ${err.message}`);
    process.exitCode = 1;
  });
}

export { encodeRecord, phoneStems };
