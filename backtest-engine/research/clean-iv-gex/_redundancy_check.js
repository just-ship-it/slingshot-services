/**
 * p01 / p04 redundancy check.
 *
 * Both promoted as vol predictors:
 *   p01:  total_gex_z    (n=16205, r=-0.296 vs realized_vol_30m)
 *   p04:  iv_term_ratio  (n=4463,  r=+0.295 vs abs_fwd_ret_60m)
 *
 * Question: are they two costumes for one signal, or independent edges?
 *
 * Tests:
 *  1. Pairwise Spearman correlation between the two predictors on the
 *     overlapping subsample.
 *  2. Bivariate regression of |fwd_ret_60m| ~ a*z + b*ratio + c.  Compare
 *     each marginal coefficient's t-stat to the univariate t-stat.  If
 *     adding the other predictor wipes out one's coefficient, they are
 *     redundant; otherwise both contribute.
 *  3. Decile cross-tab: bucket samples by (term_ratio_decile, gex_z_decile)
 *     and look at mean |fwd_ret_60m| in each cell.  If the heatmap is
 *     dominated by a diagonal, the two are aligned; if the corners differ
 *     independently, they are independent.
 */

import { buildAlignedSample, loadAtmIv1m, loadShortDteIv15m, spearman } from './_lib.js';

function lstsq2(xs, zs, ys) {
  // Multiple regression y = a*x + b*z + c (normal equations).
  const n = xs.length;
  let sx = 0, sz = 0, sy = 0;
  let sxx = 0, szz = 0, sxz = 0, sxy = 0, szy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i]; sz += zs[i]; sy += ys[i];
    sxx += xs[i] * xs[i]; szz += zs[i] * zs[i]; sxz += xs[i] * zs[i];
    sxy += xs[i] * ys[i]; szy += zs[i] * ys[i];
  }
  const mx = sx / n, mz = sz / n, my = sy / n;
  const Sxx = sxx - n * mx * mx;
  const Szz = szz - n * mz * mz;
  const Sxz = sxz - n * mx * mz;
  const Sxy = sxy - n * mx * my;
  const Szy = szy - n * mz * my;
  const det = Sxx * Szz - Sxz * Sxz;
  if (Math.abs(det) < 1e-12) return null;
  const a = (Szz * Sxy - Sxz * Szy) / det;
  const b = (Sxx * Szy - Sxz * Sxy) / det;
  const c = my - a * mx - b * mz;

  // Residual stats for t-stats
  let rss = 0;
  for (let i = 0; i < n; i++) {
    const yhat = a * xs[i] + b * zs[i] + c;
    rss += (ys[i] - yhat) ** 2;
  }
  const sigma2 = rss / (n - 3);
  // covariance matrix of (a,b): sigma2 * [[Szz/det, -Sxz/det],...]
  const seA = Math.sqrt(sigma2 * Szz / det);
  const seB = Math.sqrt(sigma2 * Sxx / det);
  return { a, b, c, ta: a / seA, tb: b / seB, n };
}

function univariate(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  const a = sxy / sxx;
  const c = my - a * mx;
  let rss = 0;
  for (let i = 0; i < n; i++) {
    const yhat = a * xs[i] + c;
    rss += (ys[i] - yhat) ** 2;
  }
  const sigma2 = rss / (n - 2);
  const seA = Math.sqrt(sigma2 / sxx);
  return { a, c, ta: a / seA, n };
}

async function main() {
  console.log('[redundancy] p01 / p04 — are they independent vol forecasters?');

  const atm = await loadAtmIv1m();
  const sdiv = await loadShortDteIv15m();
  const { samples } = await buildAlignedSample();

  // Compute total_gex_z (rolling 30d)
  const MS_PER_DAY = 86_400_000;
  for (let i = 0; i < samples.length; i++) {
    const cutoff = samples[i].ts - 30 * MS_PER_DAY;
    let n = 0, s = 0, s2 = 0;
    for (let j = i - 1; j >= 0 && samples[j].ts >= cutoff; j--) {
      const v = samples[j].snapshot.total_gex;
      n++; s += v; s2 += v * v;
    }
    if (n < 100) { samples[i].total_gex_z = null; continue; }
    const mean = s / n;
    const sd = Math.sqrt(Math.max(s2 / n - mean * mean, 0));
    samples[i].total_gex_z = sd > 0 ? (samples[i].snapshot.total_gex - mean) / sd : 0;
  }

  // Compute term_ratio
  for (const s of samples) {
    const front = sdiv.get(s.iso);
    const back = atm.get(s.iso);
    if (!front || !back) { s.term_ratio = null; continue; }
    if (!Number.isFinite(front.dte0_avg_iv) || !Number.isFinite(back.iv) || back.iv <= 0) {
      s.term_ratio = null; continue;
    }
    s.term_ratio = front.dte0_avg_iv / back.iv;
  }

  // Filter to overlap
  const both = samples.filter(s =>
    s.total_gex_z != null &&
    s.term_ratio != null &&
    s.term_ratio > 0.1 && s.term_ratio < 5 &&
    Number.isFinite(s.fwd_ret_60m));

  console.log(`[redundancy] overlapping n=${both.length}`);

  // Test 1: pairwise spearman between predictors
  const sp = spearman(both.map(s => s.total_gex_z), both.map(s => s.term_ratio));
  console.log(`\n[1] Spearman(total_gex_z, term_ratio) = ${sp.r.toFixed(3)}, p=${sp.p?.toExponential(2)}, n=${sp.n}`);
  console.log(`    |r| = ${Math.abs(sp.r).toFixed(3)} — anything > 0.5 indicates strong overlap`);

  // Test 2: regression — y = abs_fwd_ret_60m
  const xs = both.map(s => s.total_gex_z);
  const zs = both.map(s => s.term_ratio);
  const ys = both.map(s => Math.abs(s.fwd_ret_60m));

  const u_x = univariate(xs, ys);
  const u_z = univariate(zs, ys);
  const biv = lstsq2(xs, zs, ys);
  console.log(`\n[2] Univariate slopes (|fwd_ret_60m| ~ predictor):`);
  console.log(`    total_gex_z   : β=${u_x.a.toExponential(2)}  t=${u_x.ta.toFixed(2)}`);
  console.log(`    term_ratio    : β=${u_z.a.toExponential(2)}  t=${u_z.ta.toFixed(2)}`);
  console.log(`[2] Bivariate slopes (|fwd_ret_60m| ~ z + ratio):`);
  console.log(`    total_gex_z   : β=${biv.a.toExponential(2)}  t=${biv.ta.toFixed(2)}`);
  console.log(`    term_ratio    : β=${biv.b.toExponential(2)}  t=${biv.tb.toFixed(2)}`);

  // Test 3: cross-tab decile heatmap
  console.log(`\n[3] 5×5 quintile heatmap of mean |fwd_ret_60m| in NQ pts:`);
  // Sort and assign quintiles
  function quintiles(arr) {
    const idx = arr.map((v, i) => [v, i]);
    idx.sort((a, b) => a[0] - b[0]);
    const out = new Array(arr.length);
    for (let r = 0; r < idx.length; r++) {
      const q = Math.min(4, Math.floor(r / arr.length * 5));
      out[idx[r][1]] = q;
    }
    return out;
  }
  const qz = quintiles(xs);
  const qr = quintiles(zs);
  const grid = Array.from({ length: 5 }, () => Array.from({ length: 5 }, () => []));
  for (let i = 0; i < both.length; i++) grid[qz[i]][qr[i]].push(ys[i] * 22000);

  console.log('              term_ratio Q ───>');
  console.log('              Q0       Q1       Q2       Q3       Q4');
  for (let i = 4; i >= 0; i--) {
    const cells = grid[i].map(arr => arr.length === 0 ? '   .   ' : (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1).padStart(7));
    console.log(`gex_z Q${i} (high vol→low vol)  ${cells.join('  ')}`);
  }

  console.log('\n[interpret]');
  console.log('  - If both bivariate β t-stats remain ≥ 2 with same sign as univariate, both are independent edges.');
  console.log('  - If one drops to t < 1 in bivariate, that one is redundant given the other.');
  console.log('  - Heatmap diagonal dominance = aligned; corner-asymmetry = independent.');
}

main().catch(e => { console.error(e); process.exit(1); });
