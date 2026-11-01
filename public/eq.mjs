import { FREQS, F_MAX, F_MIN, N } from './core.mjs';

const LOG2 = Float64Array.from(FREQS, Math.log2);
const FILTERS = [];
for (let f = 20; f <= 20000; f *= 2 ** 0.5) {
  for (const q of [0.7, 1.4]) {
    const sigma = 0.5 / q;
    FILTERS.push(Float64Array.from(LOG2, (lf) => Math.exp(-0.5 * ((lf - Math.log2(f)) / sigma) ** 2)));
  }
}

export function makeEqBank(from, to) {
  const n = to - from + 1;
  return FILTERS.map((shape) => {
    const g = new Float64Array(n);
    let norm = 0;
    for (let i = 0; i < n; i++) {
      g[i] = shape[from + i];
      norm += g[i] * g[i];
    }
    return { g, norm };
  });
}

export function eqResidual(dev, bank, { bands = 5, boost = 3, cut = 9 } = {}) {
  const n = dev.length;
  const r = Float64Array.from(dev);
  let maxGain = 0;
  let used = 0;
  for (let iter = 0; iter < bands; iter++) {
    let best = null;
    let bestGain = 0;
    let bestRed = 0;
    for (const f of bank) {
      if (f.norm <= 1e-12) continue;
      let dot = 0;
      for (let i = 0; i < n; i++) dot += r[i] * f.g[i];
      const gain = Math.max(-cut, Math.min(boost, dot / f.norm));
      const red = 2 * gain * dot - gain * gain * f.norm;
      if (red > bestRed) {
        bestRed = red;
        best = f;
        bestGain = gain;
      }
    }
    if (!best || bestRed <= 1e-9) break;
    maxGain = Math.max(maxGain, Math.abs(bestGain));
    used++;
    for (let i = 0; i < n; i++) r[i] -= bestGain * best.g[i];
  }
  let sse = 0;
  let maxDev = 0;
  for (let i = 0; i < n; i++) {
    sse += r[i] * r[i];
    if (Math.abs(r[i]) > maxDev) maxDev = Math.abs(r[i]);
  }
  return { rms: Math.sqrt(sse / n), maxGain, bands: used, maxDev };
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
