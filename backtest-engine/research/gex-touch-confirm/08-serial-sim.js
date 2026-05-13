/**
 * Phase 8: Serial backtest simulator on the 1s-honest dataset.
 *
 * Phase 7 counts every touch outcome independently. That's not what the live/
 * backtest engine does — the engine enforces:
 *   • One position at a time (no new entries while position open)
 *   • One limit order at a time (no new signal until prior limit fills or times out)
 *   • Entry window (RTH 9:30-16:00 by default)
 *   • EOD cutoff
 *
 * This script applies those constraints in time order so research counts match
 * what the engine will actually produce. Output is per-config metrics.
 *
 * Usage:
 *   node research/gex-touch-confirm/08-serial-sim.js \
 *     --in research/output/gex-touch-confirm-v3-base-<TS>.enriched.json \
 *     --filter pinbar+lowSkew+positive --stop 12
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
const STOP_DEFAULT = Number(arg('stop', '12'));
const LIMIT_TIMEOUT_MS = Number(arg('limit-timeout-min', '5')) * 60_000;
const ENTRY_START_ET = arg('entry-start-et', '09:30');
const ENTRY_END_ET = arg('entry-end-et', '16:00');
const EOD_CUTOFF_ET = arg('eod-cutoff-et', '16:40');

const TARGET_POINTS = 20;

const payload = JSON.parse(fs.readFileSync(inPath, 'utf-8'));
const { touches } = payload;

// Percentile cuts (replicated from Phase 7)
function pctile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}
function feat(name) {
  return touches.map(t => t.features?.[name]).filter(x => x != null && !isNaN(x));
}
const C = {
  iv_skew_p10: pctile(feat('qqq_iv_skew'), 0.10),
  iv_skew_p20: pctile(feat('qqq_iv_skew'), 0.20),
  iv_skew_p30: pctile(feat('qqq_iv_skew'), 0.30),
  iv_skew_p40: pctile(feat('qqq_iv_skew'), 0.40),
  iv_skew_p50: pctile(feat('qqq_iv_skew'), 0.50),
  iv_level_p10: pctile(feat('qqq_iv_level'), 0.10),
  iv_level_p20: pctile(feat('qqq_iv_level'), 0.20),
  iv_level_p80: pctile(feat('qqq_iv_level'), 0.80),
  iv_level_p90: pctile(feat('qqq_iv_level'), 0.90),
  bodyRatio_p10: pctile(feat('touch_body_range_ratio'), 0.10),
  bodyRatio_p20: pctile(feat('touch_body_range_ratio'), 0.20),
  bodyRatio_p30: pctile(feat('touch_body_range_ratio'), 0.30),
  rejWick_p70: pctile(feat('touch_rej_wick_pts'), 0.70),
  rejWick_p80: pctile(feat('touch_rej_wick_pts'), 0.80),
  rejWick_p90: pctile(feat('touch_rej_wick_pts'), 0.90),
  range_p10: pctile(feat('touch_range_pts'), 0.10),
  range_p20: pctile(feat('touch_range_pts'), 0.20),
  vol5_p20: pctile(feat('vol_ratio_5m'), 0.20),
  vol5_p80: pctile(feat('vol_ratio_5m'), 0.80),
  compression_p10: pctile(feat('prior_3bar_range_compression'), 0.10),
  compression_p20: pctile(feat('prior_3bar_range_compression'), 0.20),
  vwap_p70: pctile(feat('s1_vwap_close_diff'), 0.70),
  vwap_p80: pctile(feat('s1_vwap_close_diff'), 0.80),
};

// Filter predicates
const F = {
  pinbar: (t) => t.features?.touch_pinbar === 1,
  doji: (t) => t.features?.touch_doji === 1,
  smallBody: (t) => t.features?.touch_body_range_ratio < C.bodyRatio_p20,
  tinyBody: (t) => t.features?.touch_body_range_ratio < C.bodyRatio_p10,
  bigRejWick: (t) => t.features?.touch_rej_wick_pts >= C.rejWick_p90,
  bigRejWick80: (t) => t.features?.touch_rej_wick_pts >= C.rejWick_p80,
  lowIvSkew: (t) => t.features?.qqq_iv_skew < C.iv_skew_p10,
  lowIvSkew20: (t) => t.features?.qqq_iv_skew < C.iv_skew_p20,
  lowIvSkew30: (t) => t.features?.qqq_iv_skew < C.iv_skew_p30,
  lowIvSkew50: (t) => t.features?.qqq_iv_skew < C.iv_skew_p50,
  lowIv: (t) => t.features?.qqq_iv_level < C.iv_level_p20,
  highIv: (t) => t.features?.qqq_iv_level > C.iv_level_p80,
  positiveRegime: (t) => t.regime === 'positive' || t.regime === 'strong_positive',
  negativeRegime: (t) => t.regime === 'negative' || t.regime === 'strong_negative',
  strongPos: (t) => t.regime === 'strong_positive',
  morningTod: (t) => t.tod === 'morning',
  afternoonTod: (t) => t.tod === 'afternoon',
  open30: (t) => t.tod === 'open_30',
  notLunch: (t) => t.tod !== 'lunch',
  lowVol: (t) => t.features?.vol_ratio_5m < C.vol5_p20,
  highVol: (t) => t.features?.vol_ratio_5m > C.vol5_p80,
  compressed: (t) => t.features?.prior_3bar_range_compression < C.compression_p20,
  notWall: (t) => t.level_type !== 'call_wall' && t.level_type !== 'put_wall',
  isWall: (t) => t.level_type === 'call_wall' || t.level_type === 'put_wall',
  isGammaFlip: (t) => t.level_type === 'gamma_flip',
  isS: (t) => /^S[1-5]$/.test(t.level_type),
  isR: (t) => /^R[1-5]$/.test(t.level_type),
  s1Strong: (t) => t.features?.s1_vwap_close_diff != null
    && (t.approach === 'from_above' ? t.features.s1_vwap_close_diff : -t.features.s1_vwap_close_diff) >= C.vwap_p70,
};

// Parse HH:MM -> minutes
function hmm(s) { const [h, m] = s.split(':').map(Number); return h * 60 + m; }
const ENTRY_START_MIN = hmm(ENTRY_START_ET);
const ENTRY_END_MIN = hmm(ENTRY_END_ET);
const EOD_CUTOFF_MIN = hmm(EOD_CUTOFF_ET);

// ET conversion (lightweight; uses Intl)
function toEt(ts) {
  const d = new Date(ts);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
  }).formatToParts(d);
  const get = (t) => parts.find(p => p.type === t)?.value;
  const hour = parseInt(get('hour') || '0', 10) % 24;
  const minute = parseInt(get('minute') || '0', 10);
  return {
    hour, minute, timeInMinutes: hour * 60 + minute,
    weekday: get('weekday'),
    date: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

function inEntryWindow(et) {
  if (et.weekday === 'Sat' || et.weekday === 'Sun') return false;
  return et.timeInMinutes >= ENTRY_START_MIN && et.timeInMinutes < ENTRY_END_MIN;
}

// Serial simulator
// Walk touches in time order. Skip touches that are filtered or outside entry window.
// When a signal is accepted, treat it as a LIMIT order placed at touch ts + 60s (the
// engine fires at candle close = ts+60s actually — but the v3 outcome's fill_ts already
// reflects the limit fill walk, so we just use that). If outcome is 'no_fill', that's
// a limit timeout (still consumes time until ts + LIMIT_TIMEOUT_MS, then strategy is
// free again). Otherwise, strategy is busy until exit_ts.
function simulate(predicate, stop) {
  // Build a flat list of (ts, touch, outcome_at_stop) sorted by ts
  const items = [];
  for (const t of touches) {
    if (!predicate(t)) continue;
    const o = t.outcomes[0];
    const s = o.stops.find(x => x.stop === stop);
    if (!s) continue;
    items.push({ ts: t.ts, touch: t, outcome: s });
  }
  items.sort((a, b) => a.ts - b.ts);

  let busyUntil = 0;  // ms — strategy can't accept a new signal until this ts
  const accepted = [];
  for (const it of items) {
    if (it.ts < busyUntil) continue;  // skip — strategy is busy

    const et = toEt(it.ts);
    if (!inEntryWindow(et)) continue;

    // Accept signal
    accepted.push(it);

    // Determine when strategy becomes free again
    const o = it.outcome;
    if (o.outcome === 'no_fill') {
      busyUntil = it.ts + LIMIT_TIMEOUT_MS;
    } else if (o.exit_ts) {
      busyUntil = o.exit_ts;
    } else {
      // No exit_ts (shouldn't happen for non-no_fill) — assume LIMIT timeout
      busyUntil = it.ts + LIMIT_TIMEOUT_MS;
    }
  }

  // Compute metrics
  let wins = 0, losses = 0, no_fill = 0, timeouts = 0, eod = 0, rollover = 0;
  let mfe_sum = 0, mae_sum = 0;
  for (const it of accepted) {
    const o = it.outcome;
    if (o.outcome === 'win') wins++;
    else if (o.outcome === 'loss') losses++;
    else if (o.outcome === 'no_fill') no_fill++;
    else if (o.outcome === 'timeout') timeouts++;
    else if (o.outcome === 'eod') eod++;
    else if (o.outcome === 'rollover' || o.outcome === 'rollover_pre_fill') rollover++;
    mfe_sum += o.mfe || 0;
    mae_sum += o.mae || 0;
  }
  const filled = wins + losses + timeouts + eod + rollover;
  const decided = wins + losses;
  const wr = decided > 0 ? wins / decided : null;
  const total_pts = wins * TARGET_POINTS - losses * stop;
  const pf = losses > 0 ? (wins * TARGET_POINTS) / (losses * stop) : (wins > 0 ? Infinity : 0);
  const ev = filled > 0 ? total_pts / filled : 0;

  return {
    n_signals: accepted.length,
    n_filled: filled,
    decided, wins, losses,
    no_fill, timeouts, eod, rollover,
    wr, pf, total_pts, ev,
  };
}

// Run scenarios
const stopValues = (arg('stops') || `${STOP_DEFAULT}`).split(',').map(Number);

const combos = [
  ['pinbar+lowSkew+positive', ['pinbar', 'lowIvSkew', 'positiveRegime']],
  ['pinbar+lowSkew', ['pinbar', 'lowIvSkew']],
  ['pinbar+positive', ['pinbar', 'positiveRegime']],
  ['pinbar+lowSkew+positive+notWall', ['pinbar', 'lowIvSkew', 'positiveRegime', 'notWall']],
  ['pinbar+lowSkew+positive+notWall+notLunch', ['pinbar', 'lowIvSkew', 'positiveRegime', 'notWall', 'notLunch']],
  ['pinbar+lowSkew20+positive', ['pinbar', 'lowIvSkew20', 'positiveRegime']],
  ['pinbar+lowSkew30+positive', ['pinbar', 'lowIvSkew30', 'positiveRegime']],
  ['pinbar+positive+notWall', ['pinbar', 'positiveRegime', 'notWall']],
  ['pinbar+positive+notLunch', ['pinbar', 'positiveRegime', 'notLunch']],
  ['pinbar+strongPos', ['pinbar', 'strongPos']],
  ['pinbar+lowSkew+strongPos', ['pinbar', 'lowIvSkew', 'strongPos']],
  ['pinbar+lowSkew+positive+isGammaFlip', ['pinbar', 'lowIvSkew', 'positiveRegime', 'isGammaFlip']],
  ['pinbar+lowSkew+positive+isS', ['pinbar', 'lowIvSkew', 'positiveRegime', 'isS']],
  ['pinbar+lowSkew+positive+isR', ['pinbar', 'lowIvSkew', 'positiveRegime', 'isR']],
  ['pinbar+lowSkew+positive+notLunch', ['pinbar', 'lowIvSkew', 'positiveRegime', 'notLunch']],
  ['pinbar+lowSkew+positive+afternoon', ['pinbar', 'lowIvSkew', 'positiveRegime', 'afternoonTod']],
  ['pinbar+lowSkew+positive+morning', ['pinbar', 'lowIvSkew', 'positiveRegime', 'morningTod']],
  ['bigRejWick+lowSkew+positive', ['bigRejWick', 'lowIvSkew', 'positiveRegime']],
  ['bigRejWick80+lowSkew+positive', ['bigRejWick80', 'lowIvSkew', 'positiveRegime']],
  ['smallBody+lowSkew+positive', ['smallBody', 'lowIvSkew', 'positiveRegime']],
  ['pinbar+highIv+positive', ['pinbar', 'highIv', 'positiveRegime']],
  ['pinbar+lowIv+positive', ['pinbar', 'lowIv', 'positiveRegime']],
];

console.log(`\n=== Phase 8: Serial sim (engine-equivalent) ===`);
console.log(`Input: ${inPath}`);
console.log(`Touches: ${touches.length.toLocaleString()}`);
console.log(`Entry window: ${ENTRY_START_ET}-${ENTRY_END_ET}, EOD cutoff ${EOD_CUTOFF_ET}, limit timeout ${LIMIT_TIMEOUT_MS/60000}m\n`);

console.log('Percentile cuts:', Object.fromEntries(Object.entries(C).map(([k, v]) => [k, v?.toFixed(3)])));

const results = [];
for (const [name, predNames] of combos) {
  const preds = predNames.map(n => F[n]);
  const pred = (t) => preds.every(p => p(t));
  for (const stop of stopValues) {
    const m = simulate(pred, stop);
    results.push({ name, stop, ...m });
  }
}

// Sort by total_pts desc within each stop
results.sort((a, b) => b.total_pts - a.total_pts);

console.log('\n=== Serial-sim results (engine-equivalent) ===');
console.log('config'.padEnd(48), 'stop'.padStart(5), 'sig'.padStart(5), 'fill'.padStart(5), 'WR'.padStart(7),
  'PF'.padStart(6), 'EV'.padStart(7), 'pts'.padStart(8));
for (const r of results) {
  console.log(
    r.name.padEnd(48),
    String(r.stop).padStart(5),
    String(r.n_signals).padStart(5),
    String(r.n_filled).padStart(5),
    (r.wr != null ? (r.wr * 100).toFixed(1) + '%' : '-').padStart(7),
    (r.pf != null && isFinite(r.pf) ? r.pf.toFixed(2) : '-').padStart(6),
    r.ev.toFixed(2).padStart(7),
    String(Math.round(r.total_pts)).padStart(8),
  );
}

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = path.join(ROOT, 'research', 'output', `gex-touch-confirm-serial-${ts}.json`);
fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
console.log(`\nWritten: ${outPath}`);
