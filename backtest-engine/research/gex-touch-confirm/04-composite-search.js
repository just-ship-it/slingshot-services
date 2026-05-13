/**
 * Phase 4: Composite (pair/triple) filter search.
 *
 * Phase 3 surfaces the strongest individual features per (setup × stop) cell,
 * but many of the top single filters (s1_vwap_close_diff, touch_rej_wick_pts,
 * touch_doji, touch_body_range_ratio, s1_min_dist_to_level) are likely
 * correlated — they all describe "quality of the rejection." Orthogonal
 * filters (e.g., IV regime, distance to next level, time of day) should
 * compound when combined.
 *
 * This phase builds compound filters from the candidate features and ranks
 * them by win rate and PF on filled trades, focusing on the bounce setup at
 * the tight-stop tiers the user requested (8 and 10 pts past the level).
 *
 * Usage:
 *   node research/gex-touch-confirm/04-composite-search.js \
 *     --in research/output/gex-touch-confirm-v2-base-<TS>.enriched.json \
 *     [--setup bounce] [--stop 10] [--min-n 50]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  return process.argv[i + 1];
}
const IN = arg('in');
if (!IN) { console.error('Missing --in'); process.exit(1); }
const inPath = path.isAbsolute(IN) ? IN : path.join(ROOT, IN);
const SETUP = arg('setup', 'bounce');
const STOP = Number(arg('stop', 10));
const MIN_N = Number(arg('min-n', 50));
const TARGET = 20;

console.log(`\n=== Phase 4: Composite Filter Search ===`);
console.log(`Input: ${inPath}`);
console.log(`Setup: ${SETUP} | Stop: ${STOP}pts | Min n_filled: ${MIN_N}\n`);

const payload = JSON.parse(fs.readFileSync(inPath, 'utf-8'));
const { touches } = payload;

// Flatten to outcome rows for the chosen (setup, stop)
const rows = [];
for (const t of touches) {
  for (const o of t.outcomes) {
    if (o.setup !== SETUP) continue;
    for (const s of o.stops) {
      if (s.stop !== STOP) continue;
      rows.push({
        outcome: s.outcome,
        level_type: t.level_type, approach: t.approach, regime: t.regime,
        tod: t.tod, gex_mag_bucket: t.gex_mag_bucket,
        features: t.features || {},
      });
    }
  }
}
console.log(`Outcome rows for ${SETUP}|${STOP}: ${rows.length.toLocaleString()}`);

function metrics(arr) {
  let wins = 0, losses = 0, timeouts = 0, ambiguous = 0, no_fill = 0;
  for (const r of arr) {
    if (r.outcome === 'win') wins++;
    else if (r.outcome === 'loss') losses++;
    else if (r.outcome === 'timeout') timeouts++;
    else if (r.outcome === 'ambiguous') ambiguous++;
    else if (r.outcome === 'no_fill') no_fill++;
  }
  const n_candidates = arr.length;
  const n_filled = wins + losses + timeouts + ambiguous;
  const fill_rate = n_candidates > 0 ? n_filled / n_candidates : 0;
  const decided = wins + losses;
  const wr = decided > 0 ? wins / decided : null;
  const grossWin = wins * TARGET;
  const grossLoss = losses * STOP;
  const pf = grossLoss > 0 ? grossWin / grossLoss : (wins > 0 ? Infinity : null);
  const ev = n_filled > 0 ? (wins * TARGET - losses * STOP) / n_filled : null;
  const total_pts = wins * TARGET - losses * STOP;
  return { n_candidates, n_filled, fill_rate, wins, losses, wr, pf, ev, total_pts };
}

// Baseline (no filter)
const base = metrics(rows);
console.log(`Baseline: n_filled=${base.n_filled}, fill_rate=${(base.fill_rate*100).toFixed(1)}%, WR=${(base.wr*100).toFixed(1)}%, PF=${base.pf.toFixed(2)}, EV=${base.ev.toFixed(2)}pts/filled, total=${base.total_pts.toLocaleString()}pts`);

// --- Candidate filters (curated from Phase 3 top results) ---
// Each filter is {name, predicate: (row) => bool}
function pctileCut(name, side, q) {
  // Compute the quantile cut on the FILTERED population of valid values.
  const vals = rows.map(r => r.features?.[name]).filter(v => v != null && !isNaN(v))
    .sort((a, b) => a - b);
  if (!vals.length) return null;
  const idx = Math.min(vals.length - 1, Math.floor(q * vals.length));
  return vals[idx];
}

const candidates = [];

// Rejection-quality (likely correlated cluster — keep one canonical representative + a few)
const cutVwap90 = pctileCut('s1_vwap_close_diff', 'ge', 0.90);
const cutVwap80 = pctileCut('s1_vwap_close_diff', 'ge', 0.80);
const cutVwap70 = pctileCut('s1_vwap_close_diff', 'ge', 0.70);
const cutVwap60 = pctileCut('s1_vwap_close_diff', 'ge', 0.60);
const cutVwap50 = pctileCut('s1_vwap_close_diff', 'ge', 0.50);
candidates.push({ name: `s1_vwap_close_diff>=${cutVwap90?.toFixed(2)} (p90)`, pred: r => (r.features?.s1_vwap_close_diff ?? -Infinity) >= cutVwap90 });
candidates.push({ name: `s1_vwap_close_diff>=${cutVwap80?.toFixed(2)} (p80)`, pred: r => (r.features?.s1_vwap_close_diff ?? -Infinity) >= cutVwap80 });
candidates.push({ name: `s1_vwap_close_diff>=${cutVwap70?.toFixed(2)} (p70)`, pred: r => (r.features?.s1_vwap_close_diff ?? -Infinity) >= cutVwap70 });
candidates.push({ name: `s1_vwap_close_diff>=${cutVwap60?.toFixed(2)} (p60)`, pred: r => (r.features?.s1_vwap_close_diff ?? -Infinity) >= cutVwap60 });
candidates.push({ name: `s1_vwap_close_diff>=${cutVwap50?.toFixed(2)} (p50)`, pred: r => (r.features?.s1_vwap_close_diff ?? -Infinity) >= cutVwap50 });

const cutMinDist90 = pctileCut('s1_min_dist_to_level', 'ge', 0.90);
const cutMinDist80 = pctileCut('s1_min_dist_to_level', 'ge', 0.80);
candidates.push({ name: `s1_min_dist_to_level>=${cutMinDist90?.toFixed(2)} (p90)`, pred: r => (r.features?.s1_min_dist_to_level ?? -Infinity) >= cutMinDist90 });
candidates.push({ name: `s1_min_dist_to_level>=${cutMinDist80?.toFixed(2)} (p80)`, pred: r => (r.features?.s1_min_dist_to_level ?? -Infinity) >= cutMinDist80 });

const cutRejWick90 = pctileCut('touch_rej_wick_pts', 'ge', 0.90);
candidates.push({ name: `touch_rej_wick_pts>=${cutRejWick90?.toFixed(2)} (p90)`, pred: r => (r.features?.touch_rej_wick_pts ?? -Infinity) >= cutRejWick90 });

candidates.push({ name: `touch_pinbar=1`, pred: r => r.features?.touch_pinbar === 1 });
candidates.push({ name: `touch_doji=1`, pred: r => r.features?.touch_doji === 1 });

const cutBR20 = pctileCut('touch_body_range_ratio', 'le', 0.20);
candidates.push({ name: `touch_body_range_ratio<${cutBR20?.toFixed(2)} (p20)`, pred: r => (r.features?.touch_body_range_ratio ?? Infinity) < cutBR20 });

// IV/regime
const cutSkew10 = pctileCut('qqq_iv_skew', 'le', 0.10);
const cutSkew20 = pctileCut('qqq_iv_skew', 'le', 0.20);
candidates.push({ name: `qqq_iv_skew<${cutSkew10?.toFixed(3)} (p10)`, pred: r => (r.features?.qqq_iv_skew ?? Infinity) < cutSkew10 });
candidates.push({ name: `qqq_iv_skew<${cutSkew20?.toFixed(3)} (p20)`, pred: r => (r.features?.qqq_iv_skew ?? Infinity) < cutSkew20 });

const cutAtr90 = pctileCut('atr14', 'ge', 0.90);
const cutAtr80 = pctileCut('atr14', 'ge', 0.80);
candidates.push({ name: `atr14>=${cutAtr90?.toFixed(2)} (p90)`, pred: r => (r.features?.atr14 ?? -Infinity) >= cutAtr90 });
candidates.push({ name: `atr14>=${cutAtr80?.toFixed(2)} (p80)`, pred: r => (r.features?.atr14 ?? -Infinity) >= cutAtr80 });

const cutTouchAtr90 = pctileCut('touch_atr_pct', 'ge', 0.90);
candidates.push({ name: `touch_atr_pct>=${cutTouchAtr90?.toFixed(2)} (p90)`, pred: r => (r.features?.touch_atr_pct ?? -Infinity) >= cutTouchAtr90 });

// Volume
const cutVol5_80 = pctileCut('vol_ratio_5m', 'ge', 0.80);
candidates.push({ name: `vol_ratio_5m>=${cutVol5_80?.toFixed(2)} (p80)`, pred: r => (r.features?.vol_ratio_5m ?? -Infinity) >= cutVol5_80 });
const cutVol5_20 = pctileCut('vol_ratio_5m', 'le', 0.20);
candidates.push({ name: `vol_ratio_5m<${cutVol5_20?.toFixed(2)} (p20)`, pred: r => (r.features?.vol_ratio_5m ?? Infinity) < cutVol5_20 });

// Structural
const cutDistAbove80 = pctileCut('dist_to_nearest_above', 'ge', 0.80);
candidates.push({ name: `dist_to_nearest_above>=${cutDistAbove80?.toFixed(0)} (p80)`, pred: r => (r.features?.dist_to_nearest_above ?? -Infinity) >= cutDistAbove80 });
const cutDistBelow80 = pctileCut('dist_to_nearest_below', 'ge', 0.80);
candidates.push({ name: `dist_to_nearest_below>=${cutDistBelow80?.toFixed(0)} (p80)`, pred: r => (r.features?.dist_to_nearest_below ?? -Infinity) >= cutDistBelow80 });

const cutGexRank3 = 3;
candidates.push({ name: `level_gex_rank_in_snap<=3 (top-3)`, pred: r => (r.features?.level_gex_rank_in_snap ?? Infinity) <= cutGexRank3 });
const cutGexRank5 = 5;
candidates.push({ name: `level_gex_rank_in_snap<=5 (top-5)`, pred: r => (r.features?.level_gex_rank_in_snap ?? Infinity) <= cutGexRank5 });

// Compression
const cutComp20 = pctileCut('prior_3bar_range_compression', 'le', 0.20);
candidates.push({ name: `prior_3bar_range_compression<${cutComp20?.toFixed(2)} (p20)`, pred: r => (r.features?.prior_3bar_range_compression ?? Infinity) < cutComp20 });

// Regime categorical: prefer "negative" / "neutral" / etc.
for (const reg of ['negative', 'neutral', 'positive', 'strong_negative', 'strong_positive']) {
  candidates.push({ name: `regime=${reg}`, pred: r => r.regime === reg });
}

// TOD
for (const tod of ['open_30', 'morning', 'lunch', 'afternoon', 'close_30']) {
  candidates.push({ name: `tod=${tod}`, pred: r => r.tod === tod });
}

// Level type families
candidates.push({ name: `level_type in S1..S5`, pred: r => /^S[1-5]$/.test(r.level_type) });
candidates.push({ name: `level_type in R1..R5`, pred: r => /^R[1-5]$/.test(r.level_type) });
candidates.push({ name: `level_type=gamma_flip`, pred: r => r.level_type === 'gamma_flip' });
candidates.push({ name: `level_type in {call_wall,put_wall}`, pred: r => r.level_type === 'call_wall' || r.level_type === 'put_wall' });

// Approach
candidates.push({ name: `approach=from_above`, pred: r => r.approach === 'from_above' });
candidates.push({ name: `approach=from_below`, pred: r => r.approach === 'from_below' });

console.log(`Candidate single filters: ${candidates.length}`);

// --- Step 1: Single-filter ranking ---
const singles = [];
for (const f of candidates) {
  const filt = rows.filter(f.pred);
  const m = metrics(filt);
  if (m.n_filled < MIN_N) continue;
  singles.push({
    name: f.name,
    n_filled: m.n_filled,
    n_candidates: m.n_candidates,
    fill_rate: m.fill_rate,
    wr: m.wr,
    pf: m.pf,
    ev: m.ev,
    total_pts: m.total_pts,
    wr_lift: m.wr - base.wr,
    pf_lift: m.pf - base.pf,
  });
}
singles.sort((a, b) => (b.wr ?? 0) - (a.wr ?? 0));

console.log(`\n=== Top 20 single filters (by WR), n_filled >= ${MIN_N} ===`);
console.log('filter'.padEnd(48), 'n'.padStart(6), 'fill%'.padStart(7),
  'WR'.padStart(7), 'PF'.padStart(6), 'EV'.padStart(7), 'pts'.padStart(8),
  'WR+'.padStart(7), 'PF+'.padStart(6));
for (const r of singles.slice(0, 20)) {
  console.log(
    r.name.padEnd(48).slice(0, 48),
    String(r.n_filled).padStart(6),
    (r.fill_rate * 100).toFixed(1).padStart(7),
    (r.wr != null ? (r.wr * 100).toFixed(1) + '%' : '-').padStart(7),
    (r.pf != null && isFinite(r.pf) ? r.pf.toFixed(2) : '-').padStart(6),
    (r.ev != null ? r.ev.toFixed(2) : '-').padStart(7),
    String(Math.round(r.total_pts)).padStart(8),
    (r.wr_lift != null ? (r.wr_lift * 100).toFixed(1) + 'pp' : '-').padStart(7),
    (r.pf_lift != null ? r.pf_lift.toFixed(2) : '-').padStart(6),
  );
}

// --- Step 2: Pair search ---
// Take top-K singles by WR lift and try all pairs.
const TOP_K = 18;
const topNames = new Set(singles.slice(0, TOP_K).map(s => s.name));
const topCandidates = candidates.filter(f => topNames.has(f.name));
console.log(`\nSearching pairs among ${topCandidates.length} top-K candidates...`);

const pairs = [];
for (let i = 0; i < topCandidates.length; i++) {
  for (let j = i + 1; j < topCandidates.length; j++) {
    const a = topCandidates[i], b = topCandidates[j];
    const filt = rows.filter(r => a.pred(r) && b.pred(r));
    const m = metrics(filt);
    if (m.n_filled < MIN_N) continue;
    pairs.push({
      name: `${a.name} AND ${b.name}`,
      n_filled: m.n_filled, n_candidates: m.n_candidates, fill_rate: m.fill_rate,
      wr: m.wr, pf: m.pf, ev: m.ev, total_pts: m.total_pts,
      wr_lift: m.wr - base.wr, pf_lift: m.pf - base.pf,
    });
  }
}
pairs.sort((a, b) => (b.wr ?? 0) - (a.wr ?? 0));

console.log(`\n=== Top 25 pair filters (by WR), n_filled >= ${MIN_N} ===`);
console.log('filter'.padEnd(80), 'n'.padStart(5),
  'WR'.padStart(7), 'PF'.padStart(6), 'EV'.padStart(7), 'pts'.padStart(8));
for (const r of pairs.slice(0, 25)) {
  console.log(
    r.name.padEnd(80).slice(0, 80),
    String(r.n_filled).padStart(5),
    (r.wr != null ? (r.wr * 100).toFixed(1) + '%' : '-').padStart(7),
    (r.pf != null && isFinite(r.pf) ? r.pf.toFixed(2) : '-').padStart(6),
    (r.ev != null ? r.ev.toFixed(2) : '-').padStart(7),
    String(Math.round(r.total_pts)).padStart(8),
  );
}

// --- Step 3: Triple search (only on top-K pairs) ---
const TRIPLE_TOP_K = 8;
const tripleSeedNames = new Set();
for (const p of pairs.slice(0, 12)) {
  for (const part of p.name.split(' AND ')) tripleSeedNames.add(part);
}
const tripleSeeds = candidates.filter(f => tripleSeedNames.has(f.name));
console.log(`\nSearching triples among ${tripleSeeds.length} top-pair-derived candidates...`);

const triples = [];
for (let i = 0; i < tripleSeeds.length; i++) {
  for (let j = i + 1; j < tripleSeeds.length; j++) {
    for (let k = j + 1; k < tripleSeeds.length; k++) {
      const a = tripleSeeds[i], b = tripleSeeds[j], c = tripleSeeds[k];
      const filt = rows.filter(r => a.pred(r) && b.pred(r) && c.pred(r));
      const m = metrics(filt);
      if (m.n_filled < MIN_N) continue;
      triples.push({
        name: `${a.name} AND ${b.name} AND ${c.name}`,
        n_filled: m.n_filled, n_candidates: m.n_candidates, fill_rate: m.fill_rate,
        wr: m.wr, pf: m.pf, ev: m.ev, total_pts: m.total_pts,
      });
    }
  }
}
triples.sort((a, b) => (b.wr ?? 0) - (a.wr ?? 0));

console.log(`\n=== Top 25 triples (by WR), n_filled >= ${MIN_N} ===`);
console.log('filter'.padEnd(110), 'n'.padStart(5),
  'WR'.padStart(7), 'PF'.padStart(6), 'EV'.padStart(7), 'pts'.padStart(8));
for (const r of triples.slice(0, 25)) {
  console.log(
    r.name.padEnd(110).slice(0, 110),
    String(r.n_filled).padStart(5),
    (r.wr != null ? (r.wr * 100).toFixed(1) + '%' : '-').padStart(7),
    (r.pf != null && isFinite(r.pf) ? r.pf.toFixed(2) : '-').padStart(6),
    (r.ev != null ? r.ev.toFixed(2) : '-').padStart(7),
    String(Math.round(r.total_pts)).padStart(8),
  );
}

// Write JSON
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = path.join(ROOT, 'research', 'output', `gex-touch-confirm-composite-${SETUP}-${STOP}-${ts}.json`);
fs.writeFileSync(outPath, JSON.stringify({
  setup: SETUP, stop: STOP, baseline: base,
  singles: singles.slice(0, 50),
  pairs: pairs.slice(0, 200),
  triples: triples.slice(0, 200),
}, null, 2));
console.log(`\nWritten: ${outPath}`);
