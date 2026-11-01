import { readFile } from 'node:fs/promises';
import { anchor, averageChannels, bandIndices, decodeCurve, parseCurveText, scoreBand, FREQS, N } from './public/core.mjs';
import { eqResidual, makeEqBank, roughness } from './public/eq.mjs';
import { encodeRecord, phoneStems } from './build-squig.mjs';

const read = async (name) => {
  try {
    return await readFile(new URL(`./data/${name}`, import.meta.url));
  } catch {
    console.error(`data/${name} is missing — run "node server.mjs" once to download the catalogue, then re-run this test`);
    process.exit(1);
  }
};

const bin = await read('graph-data.bin');
const buf = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
const index = JSON.parse((await read('graph-data.index.json')).toString('utf8'));

const catalog = [];
for (const [cat, sources] of Object.entries(index))
  for (const [source, models] of Object.entries(sources))
    for (const [model, variants] of Object.entries(models))
      for (const [variant, [start, count]] of Object.entries(variants))
        catalog.push({ cat, source, model, variant, start, count });

const records = catalog.reduce((n, e) => n + e.count, 0);
console.log(`catalog ${catalog.length} variants / ${records} curves, ${buf.byteLength} bytes, ${buf.byteLength / 776} records`);
if (buf.byteLength !== records * 776) throw new Error('catalogue/record mismatch');

const curveOf = (e) => averageChannels(buf, Array.from({ length: e.count }, (_, i) => ({ idx: e.start + i })));
const ref = catalog.find((e) => e.model === 'SAMSUNG EO-IA500' && e.variant === '(Stock Tips)') ?? catalog.find((e) => e.cat === 'IE');

const r = anchor(curveOf(ref), 1000);
const self = scoreBand(r, r, 1000, 20000);
console.log('self-match rmse =', self.rmse, 'points =', self.points, '(must be 0)');
if (self.rmse !== 0) throw new Error('self match is not zero — decode/normalise is broken');

const [a, b] = bandIndices(1000, 20000);
console.log(`band 1k–20k -> indices ${a}..${b} (${b - a + 1} pts), ${FREQS[a].toFixed(1)}–${FREQS[b].toFixed(0)} Hz`);
if (FREQS[a] < 1000 || FREQS[b] < 20000) throw new Error('band index maths wrong');

const t0 = performance.now();
const scored = catalog
  .filter((e) => e.cat === 'IE' && !(e.model === ref.model && e.start === ref.start))
  .map((e) => ({ e, ...scoreBand(r, anchor(curveOf(e), 1000), 1000, 20000) }))
  .filter((s) => Number.isFinite(s.rmse))
  .sort((x, y) => x.rmse - y.rmse);
const ms = performance.now() - t0;

for (let i = 1; i < scored.length; i++)
  if (scored[i].rmse < scored[i - 1].rmse) throw new Error('not sorted');
if (!scored.every((s) => s.points === b - a + 1)) throw new Error('point count drift');

console.log(`scored ${scored.length} IE graphs in ${ms.toFixed(0)} ms`);
console.log(`reference: ${ref.model} ${ref.variant} [${ref.source}]`);
console.log('\n  rank   rmse    mean     max  model');
scored.slice(0, 10).forEach((s, i) =>
  console.log(`  ${String(i + 1).padStart(4)}  ${s.rmse.toFixed(3)}  ${(s.meanDev >= 0 ? '+' : '') + s.meanDev.toFixed(2)}  ${s.maxDev.toFixed(1).padStart(5)}  ${s.e.model} ${s.e.variant} [${s.e.source}]`));

const targetsRaw = await readFile(new URL('./data/targets.json', import.meta.url), 'utf8')
  .catch(() => readFile(new URL('./data/squig/targets.json', import.meta.url), 'utf8'))
  .catch(() => {
    console.error('no target curves in data/ — run "node server.mjs" once, then re-run this test');
    process.exit(1);
  });
const targets = JSON.parse(targetsRaw);
const diamond = targets.targets.find((t) => t.name === 'PEQdB Diamond');
if (!diamond) throw new Error('PEQdB Diamond target missing — the peqdb default reference would fall back');
const flatLine = targets.targets.find((t) => t.name === 'Flat Line');
if (!flatLine || flatLine.grid.length !== N) throw new Error('Flat Line target missing');
const flatGrid = anchor(parseCurveText(flatLine.grid.map((row) => `${row.f} ${row.v}`).join('\n')).grid, 1000);
if (flatGrid.some((v) => Math.abs(v) > 1e-6)) throw new Error('Flat Line is not flat');
console.log(`Flat Line target: ${flatLine.grid.length} points, max |dB| ${Math.max(...flatGrid.map(Math.abs)).toFixed(6)}`);
const diamondText = diamond.grid.map((row) => `${row.f} ${row.v}`).join('\n');
const diamondRef = anchor(parseCurveText(diamondText).grid, 1000);
const vsDiamond = catalog
  .filter((e) => e.cat === 'IE')
  .map((e) => ({ e, ...scoreBand(diamondRef, anchor(curveOf(e), 1000), 1000, 20000) }))
  .filter((s) => Number.isFinite(s.rmse))
  .sort((x, y) => x.rmse - y.rmse);
if (!vsDiamond.length) throw new Error('no IE graph scored against the Diamond target');
for (let i = 1; i < vsDiamond.length; i++)
  if (vsDiamond[i].rmse < vsDiamond[i - 1].rmse) throw new Error('Diamond ranking not sorted');
console.log(`Diamond default: ${vsDiamond.length} IE graphs scored, best ${vsDiamond[0].e.model} ${vsDiamond[0].e.variant} at ${vsDiamond[0].rmse.toFixed(3)} dB`);

const flatRef = new Float32Array(N);
const cand = anchor(curveOf(vsDiamond[0].e), 1000);
const shifted = Float32Array.from(cand, (v, k) => v - diamondRef[k]);
const plain = scoreBand(diamondRef, cand, 1000, 20000);
const relative = scoreBand(flatRef, shifted, 1000, 20000);
if (Math.abs(plain.rmse - relative.rmse) > 1e-6) throw new Error('Diamond-relative shift changed the score');
console.log(`Diamond-relative invariance: ${plain.rmse.toFixed(3)} dB -> ${relative.rmse.toFixed(3)} dB`);

const txt = ['20;0', '100;-2', '1000;0', '3000;4', '8000;-3', '20000;-9'].join('\n');
const parsed = parseCurveText(txt);
console.log(`\nparser: ${parsed.points} rows -> grid ${parsed.grid.length} pts, coverage ${parsed.coverage.join('–')} Hz`);
if (Math.abs(parsed.grid[0]) > 0.001) throw new Error('parser clamp wrong at 20 Hz');
if (parsed.grid.length !== N) throw new Error('parser grid size wrong');

const [ea, eb] = bandIndices(2000, 20000);
const eqBank = makeEqBank(ea, eb);
const eqN = eb - ea + 1;
const bump = (width) => Float64Array.from({ length: eqN }, (_, i) => 3 * Math.exp(-0.5 * ((i - eqN / 2) / width) ** 2));
const broadFit = eqResidual(bump(20), eqBank);
const combFit = eqResidual(Float64Array.from({ length: eqN }, (_, i) => (i % 8 < 2 ? 3 : 0)), eqBank);
const spikeFit = eqResidual(bump(1.2), eqBank);
const flatFit = eqResidual(new Float64Array(eqN), eqBank);
const hugeFit = eqResidual(Float64Array.from({ length: eqN }, () => 20), eqBank);
console.log(`EQ fit: broad ${broadFit.rms.toFixed(3)} dB, comb ${combFit.rms.toFixed(3)} dB, spike peak ${spikeFit.maxDev.toFixed(2)} dB, flat ${flatFit.rms}`);
if (flatFit.rms !== 0) throw new Error('flat deviation should fit to zero');
if (broadFit.rms > 0.5) throw new Error('broad bump should fit within 0.5 dB');
if (combFit.rms <= broadFit.rms + 0.2) throw new Error('comb should leave more residual than a broad bump');
if (spikeFit.maxDev < 2) throw new Error('narrow spike should leave a peak residual');
if (hugeFit.maxGain > 3.0001) throw new Error('boost limit not applied');

const smoothDev = Float64Array.from({ length: N }, (_, k) => Math.sin(k / 40) * 2);
const jaggedDev = Float64Array.from({ length: N }, (_, k) => (k % 2 ? 1 : -1) * 2);
const rSmooth = roughness(smoothDev, ea, eb);
const rJagged = roughness(jaggedDev, ea, eb);
console.log(`roughness: smooth ${rSmooth.toFixed(3)} dB, jagged ${rJagged.toFixed(3)} dB`);
if (!(rSmooth < rJagged)) throw new Error('roughness should rank smooth below jagged');

const synth = new Float64Array(N);
for (let k = 0; k < N; k++) synth[k] = Math.sin(k / 21) * 18 - Math.cos(k / 85) * 24;
const record = encodeRecord(Float64Array.from(synth, Number));
const view = record.buffer.slice(record.byteOffset, record.byteOffset + record.byteLength);
const roundTrip = decodeCurve(view, 0);
let worstEnc = 0;
for (let k = 0; k < N; k++) worstEnc = Math.max(worstEnc, Math.abs(roundTrip[k] - synth[k]));
console.log(`\nsquig record encode/decode roundtrip worst error = ${worstEnc.toFixed(4)} dB`);
if (worstEnc > 0.02) throw new Error('squig record quantisation exceeded 0.02 dB');

const stemCases = [
  { phone: { name: 'Timeless', file: 'Timeless' }, want: [['Timeless', 'Timeless']] },
  {
    phone: { name: 'ComfoBuds Mini', file: ['ANC', 'Norm'], suffix: ['(ANC on)', '(ANC off)'] },
    want: [['ANC', 'ComfoBuds Mini (ANC on)'], ['Norm', 'ComfoBuds Mini (ANC off)']],
  },
  {
    phone: { name: 'MADOO', file: ['MADOO 7k', 'MADOO 9k'], prefix: 'MADOO' },
    want: [['MADOO 7k', 'MADOO 7k'], ['MADOO 9k', 'MADOO 9k']],
  },
  { phone: { name: 'Martilo', file: ['Martilo', 'Martilo (Foam)'] }, want: [['Martilo', 'Martilo'], ['Martilo (Foam)', 'Martilo (Foam)']] },
];
for (const { phone, want } of stemCases) {
  const got = phoneStems(phone).map((s) => [s.stem, s.name]);
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`phoneStems mismatch: ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
}
console.log(`phoneStems: ${stemCases.length} schema shapes expanded correctly`);

console.log('\nOK — decode, normalise, band, scoring, EQ fit, sorting, parser, Diamond default, Flat Line, squig encoding and phone-book variants all verified');
