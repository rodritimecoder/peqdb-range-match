import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FREQS, N } from './public/core.mjs';
import { encodeRecord } from './build-squig.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA = join(ROOT, 'data');

const curve = (phase, tilt) =>
  Float64Array.from({ length: N }, (_, k) => Math.sin(k / 17 + phase) * 6 + (tilt * k) / N);

const records = [curve(0, 0), curve(1.7, -4)];
await mkdir(DATA, { recursive: true });
const bin = Buffer.concat(records.map((ys) => encodeRecord(ys)));

await writeFile(join(DATA, 'graph-data.bin'), bin);
await writeFile(
  join(DATA, 'graph-data.index.json'),
  JSON.stringify({ IE: { Fixture: { 'Model A': { stock: [0, 1] }, 'Model B': { stock: [1, 1] } } } })
);
await writeFile(
  join(DATA, 'meta.json'),
  JSON.stringify({ url: 'fixture', bytes: bin.length, graphs: records.length, fetched: new Date().toISOString() }, null, 2)
);
await writeFile(
  join(DATA, 'targets.json'),
  JSON.stringify({
    source: 'fixture',
    extracted: new Date().toISOString(),
    targets: [
      {
        group: 'PEQdB Diamond',
        name: 'PEQdB Diamond',
        kind: 'IE',
        grid: Array.from(FREQS, (f, k) => ({ f: Number(f.toFixed(2)), v: Number((Math.sin(k / 19) * 5).toFixed(3)) })),
      },
      {
        group: 'Baseline',
        name: 'Flat Line',
        kind: 'BOTH',
        grid: Array.from(FREQS, (f) => ({ f: Number(f.toFixed(2)), v: 0 })),
      },
    ],
  }, null, 2)
);

console.log(`fixture: ${records.length} graphs, 2 targets, ${bin.length} bytes`);
