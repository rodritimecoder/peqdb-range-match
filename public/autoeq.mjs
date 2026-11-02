import { FREQS, N } from './core.mjs';

const FS = 48_000;

export function filterResponse(type, f0, gain, Q, hz) {
  const A = Math.pow(10, gain / 40);
  const w0 = 2 * Math.PI / FS * f0;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * Q);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'PK') {
    const rA = 1 / A;
    b0 = A * alpha + 1;
    b1 = -2 * cos;
    b2 = -A * alpha + 1;
    a0 = (A + alpha) * rA;
    a1 = -2 * cos;
    a2 = (A - alpha) * rA;
  } else if (type === 'LSC' || type === 'HSC') {
    const p1 = A + 1;
    const m1 = A - 1;
    const sqrtA = Math.sqrt(A);
    const k = 2 * sqrtA * alpha;
    if (type === 'LSC') {
      b0 = A * (-cos * m1 + k + p1);
      b1 = 2 * A * (-cos * p1 + m1);
      b2 = A * (-cos * m1 - k + p1);
      a0 = cos * m1 + k + p1;
      a1 = -2 * cos * p1 - 2 * m1;
      a2 = cos * m1 - k + p1;
    } else {
      b0 = A * (cos * m1 + k + p1);
      b1 = -2 * A * (cos * p1 + m1);
      b2 = A * (cos * m1 - k + p1);
      a0 = -cos * m1 + k + p1;
      a1 = -2 * cos * p1 + 2 * m1;
      a2 = -cos * m1 - k + p1;
    }
  } else {
    return 0;
  }
  const phi = Math.sin(Math.PI / FS * hz) ** 2;
  const b = (b0 + b1 + b2) ** 2 + phi * (-4 * (b0 * b1 + 4 * b0 * b2 + b1 * b2) + phi * 16 * b0 * b2);
  const a = (a0 + a1 + a2) ** 2 + phi * (-4 * (a0 * a1 + 4 * a0 * a2 + a1 * a2) + phi * 16 * a0 * a2);
  return 10 * Math.log10(b / a);
}

export function correctedCurve(src, filters, amp) {
  const out = Float32Array.from(src);
  for (const filter of filters) {
    for (let k = 0; k < N; k++) out[k] += filterResponse(filter.type, filter.f0, filter.gain, filter.q, FREQS[k]);
  }
  for (let k = 0; k < N; k++) out[k] += amp;
  return out;
}

export function residualStats(ref, corrected, from, to) {
  const n = to - from + 1;
  let sse = 0;
  let maxDev = 0;
  let over1 = 0;
  const abs = new Float64Array(n);
  for (let k = from; k <= to; k++) {
    const d = corrected[k] - ref[k];
    const v = Math.abs(d);
    abs[k - from] = v;
    sse += d * d;
    if (v > maxDev) maxDev = v;
    if (v > 1) over1++;
  }
  const sorted = Array.from(abs).sort((x, y) => x - y);
  return {
    rms: Math.sqrt(sse / n),
    p90: sorted[Math.floor(n * 0.9)],
    frac1: over1 / n,
    maxDev,
  };
}
