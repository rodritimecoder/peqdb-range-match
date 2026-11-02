import { FREQS, F_MAX, F_MIN, N } from './core.mjs';

const LOG2 = Float64Array.from(FREQS, Math.log2);
const FILTERS = [];
for (let f = 20; f <= 20000; f *= 2 ** 0.5) {
  for (const q of [0.7, 1.4]) {
    const sigma = 0.5 / q;
    FILTERS.push({
      f,
      q,
      shape: Float64Array.from(LOG2, (lf) => Math.exp(-0.5 * ((lf - Math.log2(f)) / sigma) ** 2)),
    });
  }
}

export function makeEqBank(from, to) {
  const n = to - from + 1;
  return FILTERS.map(({ f, q, shape }) => {
    const g = new Float64Array(n);
    let norm = 0;
    for (let i = 0; i < n; i++) {
      g[i] = shape[from + i];
      norm += g[i] * g[i];
    }
    return { g, norm, f, q };
  });
}

export function eqResidual(dev, bank, { bands = 5, boost = 3, cut = 9, from = 0 } = {}) {
  const n = dev.length;
  const r = Float64Array.from(dev);
  const chosen = [];
  const used = new Set();
  let maxGain = 0;
  let usedBands = 0;
  for (let iter = 0; iter < bands; iter++) {
    let best = -1;
    let bestGain = 0;
    let bestRed = 0;
    for (let fi = 0; fi < bank.length; fi++) {
      const f = bank[fi];
      if (f.norm <= 1e-12 || used.has(f.f)) continue;
      let dot = 0;
      for (let i = 0; i < n; i++) dot += r[i] * f.g[i];
      const gain = Math.max(-boost, Math.min(cut, dot / f.norm));
      const red = 2 * gain * dot - gain * gain * f.norm;
      if (red > bestRed) {
        bestRed = red;
        best = fi;
        bestGain = gain;
      }
    }
    if (best < 0 || bestRed <= 1e-9) break;
    const f = bank[best];
    maxGain = Math.max(maxGain, Math.abs(bestGain));
    usedBands++;
    used.add(f.f);
    chosen.push({ f: f.f, q: f.q, gain: bestGain });
    for (let i = 0; i < n; i++) r[i] -= bestGain * f.g[i];
  }
  let sse = 0;
  let maxDev = 0;
  const abs = new Float64Array(n);
  let over1 = 0;
  for (let i = 0; i < n; i++) {
    abs[i] = Math.abs(r[i]);
    sse += r[i] * r[i];
    if (abs[i] > maxDev) maxDev = abs[i];
    if (abs[i] > 1) over1++;
  }
  const sorted = Array.from(abs).sort((x, y) => x - y);
  const p90 = sorted[Math.floor(n * 0.9)];
  let maxBoost = 0;
  let maxCut = 0;
  for (const c of chosen) {
    if (c.gain < 0) maxBoost = Math.max(maxBoost, -c.gain);
    else maxCut = Math.max(maxCut, c.gain);
  }
  const padded = new Float64Array(N);
  padded.set(r, from);
  return {
    rms: Math.sqrt(sse / n),
    p90,
    frac1: over1 / n,
    maxGain,
    maxBoost,
    maxCut,
    maxDev,
    bands: usedBands,
    filters: chosen,
    rough: roughness(padded, from, from + n - 1),
  };
}

export function fitCurve(filters, from, to) {
  const out = new Float32Array(N);
  for (const { f, q, gain } of filters) {
    const centre = Math.log2(f);
    const sigma = 0.5 / q;
    for (let k = from; k <= to; k++) out[k] -= gain * Math.exp(-0.5 * ((LOG2[k] - centre) / sigma) ** 2);
  }
  return out;
}

const DZ = Math.log(F_MAX / F_MIN) / (N - 1);
const SIGMA = (Math.log(2) / 6) / 2 / DZ;
const RADIUS = Math.ceil(3 * SIGMA);
const KERNEL = Float64Array.from({ length: 2 * RADIUS + 1 }, (_, i) => Math.exp(-0.5 * ((i - RADIUS) / SIGMA) ** 2));

export function roughness(dev, from, to) {
  let sse = 0;
  for (let k = from; k <= to; k++) {
    let sum = 0;
    let wsum = 0;
    for (let j = -RADIUS; j <= RADIUS; j++) {
      const idx = k + j;
      if (idx < 0 || idx >= N) continue;
      const w = KERNEL[j + RADIUS];
      sum += dev[idx] * w;
      wsum += w;
    }
    const r = dev[k] - sum / wsum;
    sse += r * r;
  }
  return Math.sqrt(sse / (to - from + 1));
}
