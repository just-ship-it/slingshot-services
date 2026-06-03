/**
 * Phase 2 — Does the inferred-flow signal have predictive structure?
 *
 * This is the GO / NO-GO gate before investing in BOCPD/HMM. If cumulative-delta /
 * order-flow-imbalance / VPIN carry no short-horizon directional edge here, no model
 * built on them will either.
 *
 * Reads the Phase-1 feature CSV, builds CAUSAL forward returns at several horizons,
 * and measures:
 *   1. Information coefficient (Pearson) of each flow feature vs forward return.
 *   2. Decile-bucket analysis: mean forward POINT move + directional hit-rate per
 *      feature decile. Monotonic buckets + multi-point extremes = exploitable edge.
 *   3. A toxicity-conditioned read: directional pressure (ofi) gated by high VPIN.
 *
 * Forward returns are matched by TIMESTAMP (ts + horizon seconds, within tolerance),
 * never by row index — the 1s stream has gaps (thin overnight seconds, session
 * breaks), and they never cross a contract change (symbol must match).
 *
 * IMPORTANT on significance: 1s forward returns are massively autocorrelated, so
 * naive t-stats are meaningless (effective N ≪ row count). We report EFFECT SIZE
 * (points) and bucket MONOTONICITY, and subsample for a rough IC read. Trust the
 * shape and the point-edge vs cost (~1.5 NQ ticks = 0.375pt round-trip), not p-values.
 *
 * Usage:
 *   node research/regime-flow/02-validate-flow-signal.js \
 *     --in data/features/nq_flow_1s_2026Q1.csv \
 *     --horizons 30,60,120
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  return process.argv[i + 1];
}
const IN = arg('in', 'data/features/nq_flow_1s_2026Q1.csv');
const HORIZONS = arg('horizons', '30,60,120').split(',').map(Number); // seconds
const TOL_MS = 5000;            // forward-bar must land within ±5s of target time
const SUBSAMPLE = +arg('subsample', 30); // every Nth bar for the IC read (de-overlap)
const COST_PTS = 0.375;         // ~1.5 NQ ticks round-trip reference

const inPath = path.isAbsolute(IN) ? IN : path.join(ROOT, IN);

// flow features we care about (column name → label)
const FEATURES = [
  ['ofi_60s', 'OFI 60s (signed pressure)'],
  ['delta_60s', 'Δ 60s (cum-delta proxy)'],
  ['delta_30s', 'Δ 30s'],
  ['delta_10s', 'Δ 10s'],
  ['signed_vol', 'signed_vol (1 bar)'],
  ['vpin_60s', 'VPIN 60s (toxicity)'],
  ['run_len', 'run length'],
  ['ret_10s', 'ret 10s (momentum)'],
  ['vol_vel', 'volume velocity'],
];

console.log(`\n=== Flow-signal predictive-structure validation ===`);
console.log(`Input:    ${inPath}`);
console.log(`Horizons: ${HORIZONS.join('s, ')}s\n`);

// --- load columns we need into typed arrays ---
console.log(`Loading feature file ...`);
const tsArr = [];
const closeArr = [];
const symArr = [];
const feat = {}; for (const [k] of FEATURES) feat[k] = [];

const rl = readline.createInterface({ input: fs.createReadStream(inPath), crlfDelay: Infinity });
let header = null, idx = {};
for await (const line of rl) {
  if (!header) {
    header = line.split(',');
    header.forEach((h, i) => { idx[h] = i; });
    continue;
  }
  const f = line.split(',');
  tsArr.push(new Date(f[idx.ts]).getTime());
  closeArr.push(+f[idx.close]);
  symArr.push(f[idx.symbol]);
  for (const [k] of FEATURES) feat[k].push(+f[idx[k]]);
}
const N = tsArr.length;
console.log(`  ${N.toLocaleString()} feature rows loaded\n`);

// --- build forward returns by timestamp (two-pointer), per horizon ---
function buildForward(hSec) {
  const targetMs = hSec * 1000;
  const fwd = new Float64Array(N).fill(NaN);
  let j = 0;
  for (let i = 0; i < N; i++) {
    if (j < i) j = i;
    const want = tsArr[i] + targetMs;
    while (j < N && tsArr[j] < want) j++;
    if (j >= N) break;
    // j is first bar at/after target time; require same contract + within tolerance
    if (symArr[j] === symArr[i] && Math.abs(tsArr[j] - want) <= TOL_MS) {
      fwd[i] = closeArr[j] - closeArr[i];
    }
  }
  return fwd;
}

function pearson(xs, ys, mask) {
  let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < xs.length; i += SUBSAMPLE) {
    if (!mask[i]) continue;
    const x = xs[i], y = ys[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
  }
  if (n < 30) return { r: NaN, n };
  const cov = sxy / n - (sx / n) * (sy / n);
  const vx = sxx / n - (sx / n) ** 2;
  const vy = syy / n - (sy / n) ** 2;
  const r = cov / Math.sqrt(Math.max(1e-12, vx * vy));
  return { r, n };
}

// decile buckets by feature value → mean fwd point move + directional hit-rate
function decileAnalysis(xs, fwd) {
  const pairs = [];
  for (let i = 0; i < xs.length; i++) {
    if (Number.isFinite(xs[i]) && Number.isFinite(fwd[i])) pairs.push([xs[i], fwd[i]]);
  }
  pairs.sort((a, b) => a[0] - b[0]);
  const m = pairs.length;
  const buckets = [];
  for (let d = 0; d < 10; d++) {
    const lo = Math.floor((d * m) / 10), hi = Math.floor(((d + 1) * m) / 10);
    let sumF = 0, hits = 0, cnt = hi - lo, sumX = 0;
    for (let i = lo; i < hi; i++) {
      const x = pairs[i][0], y = pairs[i][1];
      sumX += x; sumF += y;
      // directional hit: does fwd move agree with the sign of the feature?
      if ((x > 0 && y > 0) || (x < 0 && y < 0)) hits++;
    }
    buckets.push({ d: d + 1, avgX: sumX / cnt, meanFwd: sumF / cnt, hit: hits / cnt, n: cnt });
  }
  return buckets;
}

for (const h of HORIZONS) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`HORIZON ${h}s forward return (points)`);
  console.log('='.repeat(70));
  const fwd = buildForward(h);
  const valid = fwd.map(Number.isFinite);
  const nValid = valid.reduce((a, b) => a + (b ? 1 : 0), 0);
  console.log(`labeled rows: ${nValid.toLocaleString()} / ${N.toLocaleString()}`);

  // 1. IC table
  console.log(`\n  Information coefficient (Pearson, subsample 1/${SUBSAMPLE}):`);
  for (const [k, label] of FEATURES) {
    const { r, n } = pearson(feat[k], fwd, valid);
    console.log(`    ${label.padEnd(26)} IC=${(r >= 0 ? ' ' : '') + r.toFixed(4)}  (n=${n.toLocaleString()})`);
  }

  // 2. decile analysis for the headline feature (ofi_60s)
  for (const headline of ['ofi_60s', 'delta_60s']) {
    console.log(`\n  Decile buckets by ${headline} → mean fwd move (pts) | dir hit-rate:`);
    const buckets = decileAnalysis(feat[headline], fwd);
    for (const b of buckets) {
      const edge = Math.abs(b.meanFwd) - COST_PTS;
      const flag = edge > 0 ? `  <-- beats cost by ${edge.toFixed(2)}pt` : '';
      console.log(`    D${String(b.d).padStart(2)} (x≈${b.avgX.toFixed(3).padStart(8)}): meanFwd=${(b.meanFwd >= 0 ? ' ' : '') + b.meanFwd.toFixed(3).padStart(6)}pt  hit=${(b.hit * 100).toFixed(1)}%${flag}`);
    }
  }
}

// 3. toxicity-conditioned read: does high-VPIN sharpen OFI's edge?
console.log(`\n${'='.repeat(70)}`);
console.log(`TOXICITY CONDITIONING — OFI edge in low vs high VPIN (60s horizon)`);
console.log('='.repeat(70));
{
  const fwd = buildForward(60);
  // VPIN median split
  const vp = feat.vpin_60s.filter((v, i) => Number.isFinite(fwd[i])).slice().sort((a, b) => a - b);
  const vpMed = vp[Math.floor(vp.length / 2)];
  console.log(`VPIN median = ${vpMed.toFixed(4)}`);
  for (const [name, test] of [['LOW VPIN', (v) => v < vpMed], ['HIGH VPIN', (v) => v >= vpMed]]) {
    // among strong directional pressure (|ofi|>0.2), measure directional hit-rate + mean signed-toward-pressure move
    let cnt = 0, hits = 0, sumToward = 0;
    for (let i = 0; i < N; i++) {
      if (!Number.isFinite(fwd[i])) continue;
      if (!test(feat.vpin_60s[i])) continue;
      const ofi = feat.ofi_60s[i];
      if (Math.abs(ofi) < 0.2) continue;
      cnt++;
      const toward = Math.sign(ofi) * fwd[i]; // move in the pressure direction
      sumToward += toward;
      if (toward > 0) hits++;
    }
    console.log(`  ${name.padEnd(10)} |ofi|>0.2: n=${cnt.toLocaleString()}  hit=${(hits / cnt * 100).toFixed(1)}%  mean move toward pressure=${(sumToward / cnt).toFixed(3)}pt`);
  }
}

console.log(`\nInterpretation:`);
console.log(`  • Monotonic decile ladder (D1 most negative → D10 most positive fwd move) = real signal.`);
console.log(`  • Extreme deciles whose |meanFwd| beats ${COST_PTS}pt cost = directly scalpable.`);
console.log(`  • If HIGH-VPIN hit-rate > LOW-VPIN, toxicity gates entries (jump on informed flow).`);
console.log(`  • Flat ICs + non-monotonic buckets + no cost-beating extreme = NO-GO on this feature set.\n`);
