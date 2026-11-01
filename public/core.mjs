export const N = 384;
export const F_MIN = 20;
export const F_MAX = 20000;
export const RECORD_BYTES = 776;

const Jt = Math.log(F_MIN);
const Yt = Math.log(F_MAX);
const Zt = (Yt - Jt) / (N - 1);

export const FREQS = Float64Array.from({ length: N }, (_, k) => Math.exp(Jt + k * Zt));
FREQS[0] = F_MIN;
FREQS[N - 1] = F_MAX;

export function indexOfFreq(hz) {
  return Math.min(Math.max(Math.floor((Math.log(hz) - Jt) / Zt), 0), N - 1);
}

export function levelAt(ys, hz) {
  const x = (Math.log(Math.min(Math.max(hz, F_MIN), F_MAX)) - Jt) / Zt;
  const k = Math.min(Math.max(Math.floor(x), 0), N - 2);
  const t = x - k;
  return ys[k] + (ys[k + 1] - ys[k]) * t;
}

export function decodeCurve(buf, idx) {
  const o = idx * RECORD_BYTES;
  if (o + RECORD_BYTES > buf.byteLength) throw new Error(`record ${idx} out of range`);
  const dv = buf instanceof DataView ? buf : new DataView(buf);
  const scale = dv.getFloat32(o, true);
  const offset = dv.getFloat32(o + 4, true);
  const out = new Float32Array(N);
  for (let k = 0; k < N; k++) out[k] = scale * dv.getInt16(o + 8 + 2 * k, true) - offset;
  return out;
}

export function averageChannels(buf, dataEntries) {
  if (!dataEntries.length) throw new Error('graph has no channels');
  const acc = new Float32Array(N);
  for (const entry of dataEntries) {
    const c = decodeCurve(buf, entry.idx);
    for (let k = 0; k < N; k++) acc[k] += c[k];
  }
  const inv = 1 / dataEntries.length;
  for (let k = 0; k < N; k++) acc[k] *= inv;
  return acc;
}

export function anchor(ys, hz) {
  const d = levelAt(ys, hz);
  const out = new Float32Array(N);
  for (let k = 0; k < N; k++) out[k] = ys[k] - d;
  return out;
}

export function parseCurveText(text) {
  const rows = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//') || line === '*') continue;
    const parts = line.split(/[;,\s]+/).filter(Boolean);
    const f = Number.parseFloat(parts[0]);
    const v = Number.parseFloat(parts[1]);
    if (!Number.isFinite(f) || !Number.isFinite(v)) continue;
    if (f <= 0 || f > 24000) continue;
    rows.push([f, v]);
  }
  if (rows.length < 4) throw new Error(`need at least 4 numeric "freq value" rows, found ${rows.length}`);
  rows.sort((a, b) => a[0] - b[0]);
  const xs = [];
  const ys = [];
  for (const [f, v] of rows) {
    if (xs.length && f === xs[xs.length - 1]) ys[ys.length - 1] = v;
    else {
      xs.push(f);
      ys.push(v);
    }
  }
  const coverage = [xs[0], xs[xs.length - 1]];
  const grid = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    const f = FREQS[k];
    if (f <= xs[0]) grid[k] = ys[0];
    else if (f >= xs[xs.length - 1]) grid[k] = ys[ys.length - 1];
    else {
      let lo = 0;
      let hi = xs.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (xs[mid] <= f) lo = mid;
        else hi = mid;
      }
      const t = (Math.log(f) - Math.log(xs[lo])) / (Math.log(xs[hi]) - Math.log(xs[lo]));
      grid[k] = ys[lo] + (ys[hi] - ys[lo]) * t;
    }
  }
  return { grid, coverage, points: xs.length };
}

export function bandIndices(loHz, hiHz) {
  if (!(loHz > 0) || !(hiHz > loHz)) throw new Error('bad band');
  const step = (hz) => (Math.log(Math.min(Math.max(hz, F_MIN), F_MAX)) - Jt) / Zt;
  let a = Math.min(Math.max(Math.ceil(step(loHz)), 0), N - 1);
  let b = Math.min(Math.max(Math.floor(step(hiHz)), 0), N - 1);
  if (b < a) b = a;
  return [a, b];
}

export function scoreBand(ref, cand, loHz, hiHz) {
  const [a, b] = bandIndices(loHz, hiHz);
  let sse = 0;
  let sum = 0;
  let maxAbs = 0;
  const n = b - a + 1;
  for (let k = a; k <= b; k++) {
    const d = cand[k] - ref[k];
    sse += d * d;
    sum += d;
    if (Math.abs(d) > maxAbs) maxAbs = Math.abs(d);
  }
  return { rmse: Math.sqrt(sse / n), meanDev: sum / n, maxDev: maxAbs, points: n, from: a, to: b };
}
