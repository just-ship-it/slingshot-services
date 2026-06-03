/**
 * Phase 3 — Does fading exhausted pressure INTO a level lift directional hit-rate?
 *
 * Phase 2c showed flow alone gives ~50% directional P(target before stop). This tests
 * the lever the gold strategies already exploit: LT + GEX levels. Hypothesis — when
 * price is extended to a level (GEX call/put wall, gamma flip, or LT level) AND
 * pressure is exhausting, the rejection fade hits a 5-10pt target far more often than
 * coinflip.
 *
 * Joins:
 *   LT levels  (data/liquidity/nq/NQ_liquidity_levels.csv) — 15-min, level_1..5, raw px
 *   GEX levels (data/gex/nq/NQ_gex_levels.csv)             — daily walls + gamma flip
 * For each 1s bar: nearest level + signed distance. "At level" = within DIST pts.
 *
 * Fade-rejection direction at a level:
 *   price just BELOW a level (resistance) → expect rejection DOWN → SHORT
 *   price just ABOVE a level (support)    → expect rejection UP   → LONG
 *   dir = -sign(close - level) = sign(level - close)
 * Optionally require pressure pushing INTO the level (confirmation).
 *
 * Triple-barrier on close (understated; relative-structure scan — high/low-honest pass
 * is the follow-up if levels clearly lift the rate).
 *
 * Usage: node research/regime-flow/05-level-conditioned-target-scan.js \
 *          --in data/features/nq_flow_1s_2025Q4.csv --dist 3 --hold 900
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');
const DATA = path.join(ROOT, 'data');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const IN = arg('in', 'data/features/nq_flow_1s_2025Q4.csv');
const inPath = path.isAbsolute(IN) ? IN : path.join(ROOT, IN);
const DIST = +arg('dist', 3);        // "at level" proximity in points
const HOLD = +arg('hold', 900);
const DOWN = +arg('downsample', 3);
const CONFIGS = [[5, 5], [5, 3], [10, 10], [10, 5], [5, 8]];

console.log(`\n=== Level-conditioned 5-10pt target scan ===`);
console.log(`Input: ${inPath}\nat-level dist=${DIST}pt, hold=${HOLD}s, downsample 1/${DOWN}\n`);

// --- load LT levels (sorted by ts) ---
function loadLT() {
  const rows = fs.readFileSync(path.join(DATA, 'liquidity/nq/NQ_liquidity_levels.csv'), 'utf8').trim().split('\n');
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const f = rows[i].split(',');
    const ts = +f[1];
    const lv = [f[3], f[4], f[5], f[6], f[7]].map(Number).filter(Number.isFinite);
    if (Number.isFinite(ts)) out.push({ ts, lv });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}
// --- load GEX (date → wall prices) ---
function loadGEX() {
  const rows = fs.readFileSync(path.join(DATA, 'gex/nq/NQ_gex_levels.csv'), 'utf8').trim().split('\n');
  const m = new Map();
  for (let i = 1; i < rows.length; i++) {
    const f = rows[i].split(',');
    const date = f[0];
    const lv = [f[1], f[2], f[3], f[4], f[5], f[6], f[7]].map(Number).filter(Number.isFinite);
    m.set(date, lv);
  }
  return m;
}
const LT = loadLT();
const GEX = loadGEX();
console.log(`LT rows: ${LT.length.toLocaleString()} (${new Date(LT[0].ts).toISOString().slice(0,10)} → ${new Date(LT[LT.length-1].ts).toISOString().slice(0,10)})`);
console.log(`GEX days: ${GEX.size.toLocaleString()}\n`);

// binary search: last LT row with ts <= t
function ltAt(t) {
  let lo = 0, hi = LT.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (LT[m].ts <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans >= 0 ? LT[ans].lv : null;
}

// --- load features ---
const ts = [], close = [], sym = [], ofi = [];
const rl = readline.createInterface({ input: fs.createReadStream(inPath), crlfDelay: Infinity });
let header = null, idx = {};
for await (const line of rl) {
  if (!header) { header = line.split(','); header.forEach((h, i) => idx[h] = i); continue; }
  const f = line.split(',');
  ts.push(new Date(f[idx.ts]).getTime()); close.push(+f[idx.close]); sym.push(f[idx.symbol]); ofi.push(+f[idx.ofi_60s]);
}
const N = ts.length;
console.log(`${N.toLocaleString()} feature bars loaded\n`);

// nearest level + signed (level - close) for bar i; combines LT + GEX
let unmatchedDates = 0;
function nearestLevel(i) {
  const c = close[i];
  let best = null, bestAbs = Infinity;
  const lt = ltAt(ts[i]);
  if (lt) for (const L of lt) { const d = Math.abs(c - L); if (d < bestAbs) { bestAbs = d; best = L; } }
  const date = new Date(ts[i]).toISOString().slice(0, 10);
  const gx = GEX.get(date);
  if (gx) for (const L of gx) { const d = Math.abs(c - L); if (d < bestAbs) { bestAbs = d; best = L; } }
  else unmatchedDates++;
  return best === null ? null : { level: best, dist: bestAbs };
}

function barrier(i, dir, T, S) {
  const entry = close[i], holdMs = HOLD * 1000, s = sym[i];
  for (let j = i + 1; j < N; j++) {
    if (sym[j] !== s || ts[j] - ts[i] > holdMs) break;
    const move = close[j] - entry, fav = dir * move, adv = -dir * move;
    if (fav >= T) return 'tp';
    if (adv >= S) return 'sl';
  }
  return 'to';
}

// run a scan over candidate predicate + direction fn
function scan(pred, dirFn) {
  const res = CONFIGS.map(() => ({ tp: 0, sl: 0, to: 0, n: 0 }));
  let cand = 0;
  for (let i = 0; i < N; i += DOWN) {
    if (!pred(i)) continue;
    const dir = dirFn(i); if (dir === 0) continue;
    cand++;
    for (let c = 0; c < CONFIGS.length; c++) {
      const [T, S] = CONFIGS[c]; const o = barrier(i, dir, T, S); res[c][o]++; res[c].n++;
    }
  }
  return { res, cand };
}
function report(title, out) {
  console.log(`\n${title}  (candidates: ${out.cand.toLocaleString()})`);
  if (out.cand === 0) { console.log('  (none)'); return; }
  console.log(`  ${'T/S'.padEnd(8)} ${'n'.padStart(7)}  P(tp<sl)  expectancy(pt)`);
  for (let c = 0; c < CONFIGS.length; c++) {
    const [T, S] = CONFIGS[c], r = out.res[c];
    const pTp = r.tp / r.n, pSl = r.sl / r.n;
    const exp = pTp * T - pSl * S;
    console.log(`  ${(`+${T}/-${S}`).padEnd(8)} ${r.n.toLocaleString().padStart(7)}   ${(pTp * 100).toFixed(1)}%     ${exp >= 0 ? '+' : ''}${exp.toFixed(2)}`);
  }
}

// precompute nearest-level for sampled bars (cache)
const nl = new Array(N).fill(undefined);
function NL(i) { if (nl[i] === undefined) nl[i] = nearestLevel(i); return nl[i]; }

const atLevel = i => { const x = NL(i); return x && x.dist <= DIST; };
const notLevel = i => { const x = NL(i); return x && x.dist > 15; };
// rejection fade direction: price below level → short; above → long
const rejDir = i => { const x = NL(i); return x ? Math.sign(x.level - close[i]) : 0; };
// rejection fade WITH pressure pushing into the level (confirmation)
const rejConfirmed = i => {
  const x = NL(i); if (!x || x.dist > DIST) return false;
  const towardLevel = Math.sign(x.level - close[i]);   // +1 level above (price rising into it)
  // require recent pressure in the direction of the level (exhaustion setup)
  return Math.sign(ofi[i]) === towardLevel && Math.abs(ofi[i]) > 0.1;
};

console.log(`Scanning...`);
report('BASELINE — NOT near any level (>15pt), fade pressure:', scan(notLevel, i => -Math.sign(ofi[i])));
report('AT LEVEL — rejection fade (dir = toward-from level):', scan(atLevel, rejDir));
report('AT LEVEL + pressure INTO level (exhaustion confirm):', scan(rejConfirmed, rejDir));

if (unmatchedDates > 0) console.log(`\n(note: ${unmatchedDates.toLocaleString()} bar-lookups had no GEX for their date — LT-only there)`);
console.log(`\nRead: if AT-LEVEL P(tp<sl) >> baseline (and expectancy clears ~0.4pt cost), levels are`);
console.log(`the edge source — the regime model's job is to TIME the exhaustion fade at a level.\n`);
