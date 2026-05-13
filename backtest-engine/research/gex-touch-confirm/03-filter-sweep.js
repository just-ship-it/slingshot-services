/**
 * Phase 3: Single-filter sweep
 *
 * Reads the Phase 2 enriched touches JSON. For each candidate feature and each
 * (setup × stop_distance) cell, sweeps thresholds and reports how much the
 * filter shifts win rate, PF, and trade count relative to the unfiltered
 * baseline.
 *
 * Output: a JSON of {baseline, filters: [...]} and a Markdown summary with
 * the top filters per cell ranked by PF lift.
 *
 * Usage:
 *   node research/gex-touch-confirm/03-filter-sweep.js \
 *     --in research/output/gex-touch-confirm-base-<TS>.enriched.json
 *     [--min-n 100]
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
const MIN_N = Number(arg('min-n', 100));
if (!IN) { console.error('Missing --in'); process.exit(1); }
const inPath = path.isAbsolute(IN) ? IN : path.join(ROOT, IN);

console.log(`\n=== Phase 3: Single-filter sweep ===`);
console.log(`Input: ${inPath}`);
console.log(`Min trade count per filter: ${MIN_N}\n`);

const payload = JSON.parse(fs.readFileSync(inPath, 'utf-8'));
const { touches, config } = payload;
const TARGET = config.TARGET_POINTS;
const STOPS = config.STOP_DISTANCES;

// --- Flatten to row-per-outcome view ---
// Each "row" is a candidate trade keyed by (touch.id, setup, stop)
const rows = []; // {tid, setup, stop, direction, outcome, features, level_type, regime, tod, approach, ...}
for (const t of touches) {
  for (const o of t.outcomes) {
    for (const s of o.stops) {
      rows.push({
        tid: t.id, setup: o.setup, stop: s.stop, direction: o.direction,
        outcome: s.outcome,
        level_type: t.level_type, approach: t.approach, regime: t.regime,
        tod: t.tod, gex_mag_bucket: t.gex_mag_bucket,
        features: t.features || {},
      });
    }
  }
}
console.log(`Outcome rows: ${rows.length.toLocaleString()}`);

// --- Metric computation for a set of rows ---
// Returns metrics computed on FILLED trades only (no_fill outcomes excluded).
// `n_candidates` is the raw row count (filter+cell match); `n_filled` is the
// subset that resulted in actual trades. fill_rate = n_filled / n_candidates.
function metrics(arr, stopPts) {
  let wins = 0, losses = 0, timeouts = 0, ambiguous = 0, rollover = 0, no_fill = 0;
  for (const r of arr) {
    if (r.outcome === 'win') wins++;
    else if (r.outcome === 'loss') losses++;
    else if (r.outcome === 'timeout') timeouts++;
    else if (r.outcome === 'ambiguous') ambiguous++;
    else if (r.outcome === 'rollover') rollover++;
    else if (r.outcome === 'no_fill') no_fill++;
  }
  const n_candidates = arr.length;
  const n_filled = wins + losses + timeouts + ambiguous + rollover;
  const fill_rate = n_candidates > 0 ? n_filled / n_candidates : null;
  const decided = wins + losses;
  const wr = decided > 0 ? wins / decided : null;
  const grossWin = wins * TARGET;
  const grossLoss = losses * stopPts;
  const pf = grossLoss > 0 ? grossWin / grossLoss : (wins > 0 ? Infinity : null);
  const ev_per_filled = n_filled > 0 ? (wins * TARGET - losses * stopPts) / n_filled : null;
  const ev_per_candidate = n_candidates > 0 ? (wins * TARGET - losses * stopPts) / n_candidates : null;
  // Expected total points if all candidates were taken
  const total_pts = wins * TARGET - losses * stopPts;
  return { n: n_filled, n_candidates, n_filled, fill_rate, wins, losses, timeouts, ambiguous, rollover, no_fill, wr, pf, ev: ev_per_filled, ev_per_candidate, total_pts };
}

// --- Categorical features ---
const categoricalFeatures = ['level_type', 'approach', 'regime', 'tod', 'gex_mag_bucket'];

// --- Numeric features (from row.features) ---
const numericFeatures = [
  'vol_ratio_5m', 'vol_ratio_15m', 'vol_ratio_30m',
  'qqq_iv_level', 'qqq_iv_delta_5m', 'qqq_iv_delta_15m', 'qqq_iv_skew',
  'touch_rej_wick_pts', 'touch_body_pts', 'touch_range_pts',
  'touch_body_range_ratio', 'touch_close_position',
  'atr14', 'touch_atr_pct', 'prior_3bar_range_compression',
  's1_min_dist_to_level', 's1_max_rej_wick_pts', 's1_seconds_at_level',
  's1_first_rejection_t_sec', 's1_vwap_close_diff',
  'level_gex_rank_in_snap', 'snap_n_levels',
  'dist_to_nearest_above', 'dist_to_nearest_below',
  'regime_strength', 'gamma_flip_rel_spot',
  'minutes_into_rth',
];

// Discrete signed features (e.g., vol_trend_15m ∈ {-1, 0, 1})
const discreteSignedFeatures = ['vol_trend_15m', 'total_gex_sign'];

// Boolean features (0/1)
const booleanFeatures = ['touch_doji', 'touch_pinbar', 'touch_engulfing'];

// --- Compute deciles for a numeric feature ---
function quantiles(values, qs) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const out = {};
  for (const q of qs) {
    const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
    out[q] = sorted[idx];
  }
  return out;
}

// --- Run sweep ---
const results = []; // {cell, filter_kind, feature, threshold, side, base, filt, lift}

for (const setup of ['bounce', 'break']) {
  for (const stop of STOPS) {
    const cellRows = rows.filter(r => r.setup === setup && r.stop === stop);
    if (cellRows.length < MIN_N) continue;
    const base = metrics(cellRows, stop);

    // --- Categorical sweeps ---
    for (const feat of categoricalFeatures) {
      const buckets = new Map();
      for (const r of cellRows) {
        const v = r[feat];
        if (v == null) continue;
        if (!buckets.has(v)) buckets.set(v, []);
        buckets.get(v).push(r);
      }
      for (const [val, group] of buckets.entries()) {
        if (group.length < MIN_N) continue;
        const m = metrics(group, stop);
        results.push({
          setup, stop, base_n: base.n, base_wr: base.wr, base_pf: base.pf, base_ev: base.ev,
          feature: feat, filter_kind: 'categorical', threshold: String(val), side: '=',
          n: m.n, wr: m.wr, pf: m.pf, ev: m.ev,
          wr_lift: m.wr != null && base.wr != null ? m.wr - base.wr : null,
          pf_lift: m.pf != null && base.pf != null ? m.pf - base.pf : null,
          ev_lift: m.ev != null && base.ev != null ? m.ev - base.ev : null,
        });
      }
    }

    // --- Numeric sweeps ---
    for (const feat of numericFeatures) {
      const values = cellRows.map(r => r.features?.[feat])
        .filter(v => v != null && !isNaN(v));
      if (values.length < MIN_N) continue;
      const qs = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
      const cuts = quantiles(values, qs);
      for (const q of qs) {
        const cut = cuts[q];
        // Above cut
        const above = cellRows.filter(r => {
          const v = r.features?.[feat]; return v != null && !isNaN(v) && v >= cut;
        });
        if (above.length >= MIN_N) {
          const m = metrics(above, stop);
          results.push({
            setup, stop, base_n: base.n, base_wr: base.wr, base_pf: base.pf, base_ev: base.ev,
            feature: feat, filter_kind: 'numeric_q', threshold: cut, side: `>=p${Math.round(q * 100)}`,
            n: m.n, wr: m.wr, pf: m.pf, ev: m.ev,
            wr_lift: m.wr != null && base.wr != null ? m.wr - base.wr : null,
            pf_lift: m.pf != null && base.pf != null ? m.pf - base.pf : null,
            ev_lift: m.ev != null && base.ev != null ? m.ev - base.ev : null,
          });
        }
        // Below cut
        const below = cellRows.filter(r => {
          const v = r.features?.[feat]; return v != null && !isNaN(v) && v < cut;
        });
        if (below.length >= MIN_N) {
          const m = metrics(below, stop);
          results.push({
            setup, stop, base_n: base.n, base_wr: base.wr, base_pf: base.pf, base_ev: base.ev,
            feature: feat, filter_kind: 'numeric_q', threshold: cut, side: `<p${Math.round(q * 100)}`,
            n: m.n, wr: m.wr, pf: m.pf, ev: m.ev,
            wr_lift: m.wr != null && base.wr != null ? m.wr - base.wr : null,
            pf_lift: m.pf != null && base.pf != null ? m.pf - base.pf : null,
            ev_lift: m.ev != null && base.ev != null ? m.ev - base.ev : null,
          });
        }
      }
    }

    // --- Discrete signed features ---
    for (const feat of discreteSignedFeatures) {
      const buckets = new Map();
      for (const r of cellRows) {
        const v = r.features?.[feat];
        if (v == null) continue;
        const key = String(v);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(r);
      }
      for (const [val, group] of buckets.entries()) {
        if (group.length < MIN_N) continue;
        const m = metrics(group, stop);
        results.push({
          setup, stop, base_n: base.n, base_wr: base.wr, base_pf: base.pf, base_ev: base.ev,
          feature: feat, filter_kind: 'discrete_signed', threshold: val, side: '=',
          n: m.n, wr: m.wr, pf: m.pf, ev: m.ev,
          wr_lift: m.wr != null && base.wr != null ? m.wr - base.wr : null,
          pf_lift: m.pf != null && base.pf != null ? m.pf - base.pf : null,
          ev_lift: m.ev != null && base.ev != null ? m.ev - base.ev : null,
        });
      }
    }

    // --- Booleans ---
    for (const feat of booleanFeatures) {
      for (const val of [0, 1]) {
        const group = cellRows.filter(r => r.features?.[feat] === val);
        if (group.length < MIN_N) continue;
        const m = metrics(group, stop);
        results.push({
          setup, stop, base_n: base.n, base_wr: base.wr, base_pf: base.pf, base_ev: base.ev,
          feature: feat, filter_kind: 'boolean', threshold: String(val), side: '=',
          n: m.n, wr: m.wr, pf: m.pf, ev: m.ev,
          wr_lift: m.wr != null && base.wr != null ? m.wr - base.wr : null,
          pf_lift: m.pf != null && base.pf != null ? m.pf - base.pf : null,
          ev_lift: m.ev != null && base.ev != null ? m.ev - base.ev : null,
        });
      }
    }
  }
}

console.log(`Computed ${results.length.toLocaleString()} (filter × cell) combinations`);

// --- Output ---
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const OUT_DIR = path.join(ROOT, 'research', 'output');
const outPath = path.join(OUT_DIR, `gex-touch-confirm-filter-sweep-${ts}.json`);
fs.writeFileSync(outPath, JSON.stringify(results));
console.log(`Written: ${outPath}`);
console.log(`File size: ${(fs.statSync(outPath).size / 1024 / 1024).toFixed(1)} MB`);

// --- Markdown summary ---
const mdPath = path.join(ROOT, 'research', 'gex-touch-confirm', `RESULTS-PHASE3-${ts}.md`);

let md = `# Phase 3 Filter Sweep — ${new Date().toISOString().slice(0, 10)}\n\n`;
md += `Input: \`${path.relative(ROOT, inPath)}\`\n\n`;
md += `Target = ${TARGET}pts. Stop tiers: ${STOPS.join(', ')}pts. Min trade count per filter: ${MIN_N}.\n\n`;
md += `## Baseline (no filter)\n\n`;
md += `| setup | stop | n | wins | losses | WR | PF | EV (pts) |\n|---|---|---|---|---|---|---|---|\n`;
for (const setup of ['bounce', 'break']) {
  for (const stop of STOPS) {
    const cellRows = rows.filter(r => r.setup === setup && r.stop === stop);
    const m = metrics(cellRows, stop);
    md += `| ${setup} | ${stop} | ${m.n} | ${m.wins} | ${m.losses} | `
      + `${m.wr != null ? (m.wr * 100).toFixed(1) + '%' : '-'} | `
      + `${m.pf != null && isFinite(m.pf) ? m.pf.toFixed(2) : '-'} | `
      + `${m.ev != null ? m.ev.toFixed(2) : '-'} |\n`;
  }
}
md += `\n## Top filters per (setup × stop) — ranked by PF lift\n\n`;

// Group results by (setup, stop)
const groups = new Map();
for (const r of results) {
  const k = `${r.setup}|${r.stop}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(r);
}
for (const [k, group] of groups.entries()) {
  const [setup, stop] = k.split('|');
  group.sort((a, b) => (b.pf_lift ?? -Infinity) - (a.pf_lift ?? -Infinity));
  md += `\n### ${setup} stop=${stop}pts\n\n`;
  md += `| feature | threshold | side | n | WR | PF | WR lift | PF lift | EV lift |\n|---|---|---|---|---|---|---|---|---|\n`;
  for (const r of group.slice(0, 15)) {
    md += `| ${r.feature} | ${typeof r.threshold === 'number' ? r.threshold.toFixed(3) : r.threshold} | ${r.side} | ${r.n} | `
      + `${r.wr != null ? (r.wr * 100).toFixed(1) + '%' : '-'} | `
      + `${r.pf != null && isFinite(r.pf) ? r.pf.toFixed(2) : '-'} | `
      + `${r.wr_lift != null ? ((r.wr_lift) * 100).toFixed(1) + 'pp' : '-'} | `
      + `${r.pf_lift != null && isFinite(r.pf_lift) ? r.pf_lift.toFixed(2) : '-'} | `
      + `${r.ev_lift != null ? r.ev_lift.toFixed(2) : '-'} |\n`;
  }
}

fs.writeFileSync(mdPath, md);
console.log(`Markdown summary: ${mdPath}`);

// --- Console: best PF lift per cell ---
console.log(`\n=== Top-3 filter per (setup × stop), ranked by PF lift ===`);
console.log('setup'.padEnd(7), 'stop'.padStart(4), 'feature'.padEnd(28),
  'threshold'.padStart(11), 'side'.padEnd(8), 'n'.padStart(6),
  'WR'.padStart(7), 'PF'.padStart(6), 'WR+'.padStart(7), 'PF+'.padStart(6));
for (const [k, group] of groups.entries()) {
  const [setup, stop] = k.split('|');
  group.sort((a, b) => (b.pf_lift ?? -Infinity) - (a.pf_lift ?? -Infinity));
  for (const r of group.slice(0, 3)) {
    console.log(
      setup.padEnd(7), String(stop).padStart(4),
      r.feature.padEnd(28),
      (typeof r.threshold === 'number' ? r.threshold.toFixed(3) : String(r.threshold)).padStart(11),
      r.side.padEnd(8),
      String(r.n).padStart(6),
      (r.wr != null ? (r.wr * 100).toFixed(1) + '%' : '-').padStart(7),
      (r.pf != null && isFinite(r.pf) ? r.pf.toFixed(2) : '-').padStart(6),
      (r.wr_lift != null ? (r.wr_lift * 100).toFixed(1) + 'pp' : '-').padStart(7),
      (r.pf_lift != null && isFinite(r.pf_lift) ? r.pf_lift.toFixed(2) : '-').padStart(6),
    );
  }
}
