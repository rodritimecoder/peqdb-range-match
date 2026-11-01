import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { phoneStems } from './build-squig.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA = join(ROOT, 'data');
const SQUIG = join(DATA, 'squig');
const CACHE = join(SQUIG, 'cache');
const TIMEOUT = Number(process.env.TIMEOUT_MS ?? 8000);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 8);
const PROBES_PER_DB = 4;
const DB_LIMIT = Number(process.env.LIMIT ?? 0);
const UA = 'peqdb-range-match-speedtest/1.0 (+https://github.com/rodritimecoder/my-agent-skills)';

const sites = JSON.parse(await readFile(join(CACHE, 'squigsites.json'), 'utf8'));
const probes = JSON.parse(await readFile(join(SQUIG, 'probes.json'), 'utf8')).dbs;

function siteBase(site) {
  if (site.urlType === 'root') return 'https://squig.link';
  if (site.urlType === 'subdomain') return `https://${site.username}.squig.link`;
  if (site.urlType === 'altDomain') return site.altDomain;
  return `https://squig.link/lab/${site.username}`;
}

function cacheName(site, folder) {
  return `${site.username}${[...folder].map((ch) => (/[a-z0-9]/i.test(ch) ? ch : '_')).join('')}.json`;
}

function fileCount(book) {
  const seen = new Set();
  for (const brand of book) for (const phone of brand.phones ?? []) for (const { stem } of phoneStems(phone)) seen.add(stem);
  return seen.size;
}

function stemsOf(book) {
  const stems = [];
  const seen = new Set();
  for (const brand of book) {
    for (const phone of brand.phones ?? []) {
      for (const { stem } of phoneStems(phone)) {
        if (seen.has(stem)) continue;
        seen.add(stem);
        stems.push(stem);
        if (stems.length >= 10) return stems;
      }
    }
  }
  return stems;
}

async function timed(url) {
  const started = performance.now();
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(TIMEOUT) });
    await res.arrayBuffer().catch(() => {});
    return { ms: performance.now() - started, status: res.status };
  } catch {
    return { ms: performance.now() - started, status: -1 };
  }
}

const allDbs = [];
for (const site of sites) {
  for (const db of site.dbs ?? []) {
    const folder = db.folder.endsWith('/') ? db.folder : `${db.folder}/`;
    const siteKey = `${site.username}|${folder}`;
    const probe = probes[siteKey];
    if (!probe || probe.error) continue;
    let book;
    try {
      book = JSON.parse(await readFile(join(CACHE, 'phonebooks', cacheName(site, folder)), 'utf8'));
    } catch { continue; }
    allDbs.push({ siteKey, name: site.name, folder, url: siteBase(site), probe, stems: stemsOf(book), files: fileCount(book) });
  }
}

const dbs = DB_LIMIT > 0 ? allDbs.slice(0, DB_LIMIT) : allDbs;
let cursor = 0;
const results = new Array(dbs.length);
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  for (;;) {
    const i = cursor++;
    if (i >= dbs.length) return;
    const db = dbs[i];
    const times = [];
    let ok = 0;
    let failed = 0;
    for (const stem of db.stems) {
      if (ok >= PROBES_PER_DB) break;
      for (const ch of ['L', 'R']) {
        const name = `${stem} ${ch}${db.probe.numbered ? 1 : ''}.txt`;
        const url = `${db.url}${db.folder}${db.probe.dir}${encodeURIComponent(name)}`;
        const { ms, status } = await timed(url);
        if (status === 200) {
          times.push(ms);
          ok++;
          break;
        }
        failed++;
      }
    }
    times.sort((a, b) => a - b);
    const median = times.length ? times[Math.floor(times.length / 2)] : null;
    const p90 = times.length ? times[Math.min(times.length - 1, Math.floor(times.length * 0.9))] : null;
    results[i] = {
      siteKey: db.siteKey,
      name: db.name,
      folder: db.folder,
      files: db.files,
      dir: db.probe.dir,
      numbered: db.probe.numbered,
      samples: db.probe.samples,
      ok,
      failed,
      medianMs: median === null ? null : Math.round(median),
      p90Ms: p90 === null ? null : Math.round(p90),
    };
    console.log(`${resultLabel(results[i])}`);
  }
}));

function resultLabel(r) {
  const speed = r.medianMs === null ? 'DEAD ' : `${String(r.medianMs).padStart(5)}ms`;
  return `${speed} p90 ${String(r.p90Ms ?? '-').padStart(5)}ms  files ${String(r.files).padStart(5)}  ok ${r.ok}/${r.ok + r.failed}  ${r.name}${r.folder}`;
}

const ranked = results.filter(Boolean).sort((a, b) => (a.medianMs ?? 1e9) - (b.medianMs ?? 1e9));
if (DB_LIMIT === 0) await writeFile(join(SQUIG, 'speeds.json'), JSON.stringify({ testedAt: new Date().toISOString(), timeoutMs: TIMEOUT, dbs: ranked }, null, 2));
else console.log(`LIMIT=${DB_LIMIT}: test mode, speeds.json left untouched`);

console.log('\n=== ranked ===');
for (const r of ranked) console.log(resultLabel(r));

const totalFiles = ranked.reduce((n, r) => n + r.files, 0);
console.log(`\ntotal files across tested dbs: ${totalFiles}`);
for (const threshold of [200, 300, 400, 500, 750, 1000, 1500, 2000, 3000]) {
  const kept = ranked.filter((r) => r.medianMs !== null && r.medianMs <= threshold);
  const files = kept.reduce((n, r) => n + r.files, 0);
  console.log(`<= ${String(threshold).padStart(4)}ms: ${String(kept.length).padStart(3)} dbs  ${String(files).padStart(6)} files (${((files / totalFiles) * 100).toFixed(1)}%)`);
}
