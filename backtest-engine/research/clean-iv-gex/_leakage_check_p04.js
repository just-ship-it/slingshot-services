/**
 * Leakage spot-check for p04 (term_ratio → abs_fwd_ret_60m, r=0.295).
 *
 * Per brief §239-241: "If you find a very strong signal (r > 0.25, large
 * effects): triple-check for data leakage. Stronger than expected almost
 * always means a bug."
 *
 * Test: re-run with entry lagged by an additional 15 minutes (entryLagMinutes
 * = 16 instead of 1 — i.e., enter at T+16m so the response window cannot
 * possibly overlap with the IV bucket that ends at T).  Strong correlation
 * should weaken (some signal decays after 15 min) but should not collapse to
 * zero — if it collapses, the bucket overlaps the response window.
 */

import { buildAlignedSample, loadAtmIv1m, loadShortDteIv15m, spearman, decileAnalysis } from './_lib.js';

async function runWithLag(lagMinutes) {
  const atm = await loadAtmIv1m();
  const sdiv = await loadShortDteIv15m();
  const { samples } = await buildAlignedSample({ entryLagMinutes: lagMinutes });

  for (const s of samples) {
    const front = sdiv.get(s.iso);
    const back = atm.get(s.iso);
    if (!front || !back) { s.term_ratio = null; continue; }
    if (!Number.isFinite(front.dte0_avg_iv) || !Number.isFinite(back.iv) || back.iv <= 0) {
      s.term_ratio = null; continue;
    }
    s.term_ratio = front.dte0_avg_iv / back.iv;
  }

  const valid = samples.filter(s => s.term_ratio != null && s.term_ratio > 0.1 && s.term_ratio < 5 && Number.isFinite(s.fwd_ret_60m));
  const xs = valid.map(s => s.term_ratio);
  const ys = valid.map(s => Math.abs(s.fwd_ret_60m));
  const sp = spearman(xs, ys);
  const dec = decileAnalysis(xs, ys);
  return { lagMinutes, n: sp.n, r: sp.r, top: dec.top, bottom: dec.bottom, diff: dec.diff };
}

console.log('p04 leakage spot-check — baseline lag=+1m vs +16m vs +31m');
const results = [];
for (const lag of [1, 16, 31, 46]) {
  const r = await runWithLag(lag);
  results.push(r);
  console.log(`lag=${String(lag).padStart(2)}m  n=${r.n}  r=${r.r.toFixed(3)}  decile-diff=${(r.diff*22000).toFixed(2)} NQ pts`);
}

console.log('');
console.log('Interpretation:');
console.log(`  If r at lag=+1m vs lag=+16m: ratio ${(results[1].r / results[0].r * 100).toFixed(0)}% — should be > 0 (signal decays gracefully).`);
console.log(`  If r at lag=+31m: ratio ${(results[2].r / results[0].r * 100).toFixed(0)}% — same.`);
console.log(`  If r collapses to ~0 between lag=+1m and lag=+16m: bucket-overlap leakage.`);
