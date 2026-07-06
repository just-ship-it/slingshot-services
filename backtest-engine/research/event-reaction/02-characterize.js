/**
 * Phase 1 — Characterize the post-release move (go/no-go gate).
 *
 * Reads output/event-windows-1s.csv (Phase 0) and builds a per-event feature
 * table, then reports aggregate base rates per event type:
 *   - typical |move| at each horizon (is there enough range to trade past cost?)
 *   - MFE / MAE from the release instant
 *   - first-minute direction, and whether it CONTINUES or REVERSES into later
 *     horizons (knee-jerk-fade vs follow-through)
 *   - pre-event drift vs post-event move (does positioning-into predict?)
 *
 * All measurements are anchored to the release instant on 1s bars — honest by
 * construction (Phase 0 already restricted to the primary contract).
 *
 * P_ref (release price) = close of the last 1s bar with rel_sec < 0.
 * Move at horizon h = close(last bar with rel_sec <= h) - P_ref.
 *
 * Output:
 *   output/event-features.csv   (one row per event; consumed by Phases 2 & 3)
 *   stdout report
 *
 * Usage: node research/event-reaction/02-characterize.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'output');
const BARS = path.join(OUT_DIR, 'event-windows-1s.csv');
const OUT_FEATURES = path.join(OUT_DIR, 'event-features.csv');

const NQ_POINT_VALUE = 20; // $/point, NQ big contract
const HORIZONS = [15, 30, 60, 120, 300, 600, 900, 1800, 3600, 5400]; // seconds post-release
const PRE_WINDOWS = [1800, 600, 300, 120]; // seconds pre-release for drift/range

// --- load bars grouped by event ---
function loadEvents() {
  const lines = fs.readFileSync(BARS, 'utf8').trim().split('\n');
  const header = lines[0].split(',');
  const col = {};
  header.forEach((h, i) => (col[h] = i));
  const events = new Map();
  for (let k = 1; k < lines.length; k++) {
    const c = lines[k].split(',');
    const id = c[col.event_id];
    if (!events.has(id)) {
      events.set(id, {
        id,
        type: c[col.event_type],
        date: id.split('_')[0],
        symbol: c[col.symbol],
        bars: [],
      });
    }
    events.get(id).bars.push({
      rel: +c[col.rel_sec],
      o: +c[col.open], h: +c[col.high], l: +c[col.low], c: +c[col.close], v: +c[col.volume],
    });
  }
  for (const ev of events.values()) ev.bars.sort((a, b) => a.rel - b.rel);
  return [...events.values()];
}

// price at horizon: close of last bar with rel <= h (null if none in range)
function priceAt(bars, h) {
  let p = null;
  for (const b of bars) { if (b.rel <= h) p = b.c; else break; }
  return p;
}
// MFE/MAE (high/low extremes) over rel in [lo, hi]
function extremes(bars, lo, hi) {
  let hiP = -Infinity, loP = Infinity, n = 0;
  for (const b of bars) {
    if (b.rel >= lo && b.rel <= hi) { if (b.h > hiP) hiP = b.h; if (b.l < loP) loP = b.l; n++; }
  }
  return n ? { hi: hiP, lo: loP } : null;
}

function pctl(arr, p) {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.floor(p * s.length));
  return s[i];
}
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

function buildFeatures(events) {
  const rows = [];
  for (const ev of events) {
    const preBars = ev.bars.filter((b) => b.rel < 0);
    const pRef = preBars.length ? preBars[preBars.length - 1].c : null;
    if (pRef == null) continue; // no pre-release price → can't anchor
    const f = { id: ev.id, type: ev.type, date: ev.date, symbol: ev.symbol, p_ref: pRef };

    // pre-event drift & range (causal features for Phase 2)
    for (const w of PRE_WINDOWS) {
      const seg = ev.bars.filter((b) => b.rel >= -w && b.rel < 0);
      const first = seg.length ? seg[0].c : pRef;
      f[`pre_drift_${w}`] = +(pRef - first).toFixed(2);
      const ext = extremes(ev.bars, -w, -1);
      f[`pre_range_${w}`] = ext ? +(ext.hi - ext.lo).toFixed(2) : 0;
    }

    // post-event move at each horizon
    for (const h of HORIZONS) {
      const p = priceAt(ev.bars, h);
      f[`move_${h}`] = p == null ? '' : +(p - pRef).toFixed(2);
    }

    // MFE/MAE from release to +90min (full post window)
    const postExt = extremes(ev.bars, 0, 5400);
    f.mfe = postExt ? +(postExt.hi - pRef).toFixed(2) : '';
    f.mae = postExt ? +(postExt.lo - pRef).toFixed(2) : '';

    // impulse: first-minute move & its extremes (Phase 3 entry-window features)
    f.impulse_60 = f.move_60;
    const imp = extremes(ev.bars, 0, 60);
    f.impulse_mfe = imp ? +(imp.hi - pRef).toFixed(2) : '';
    f.impulse_mae = imp ? +(imp.lo - pRef).toFixed(2) : '';
    // 2-min impulse (alternative entry point)
    f.impulse_120 = f.move_120;

    rows.push(f);
  }
  return rows;
}

function writeFeatures(rows) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const out = [cols.join(',')];
  for (const r of rows) out.push(cols.map((c) => r[c]).join(','));
  fs.writeFileSync(OUT_FEATURES, out.join('\n') + '\n');
  console.log(`Wrote ${OUT_FEATURES} (${rows.length} events)\n`);
}

function report(rows) {
  const types = [...new Set(rows.map((r) => r.type))].sort();
  const groups = { ALL: rows };
  for (const t of types) groups[t] = rows.filter((r) => r.type === t);

  console.log('=== MAGNITUDE: median |move| (points) by horizon ===');
  const hs = [30, 60, 120, 300, 600, 1800];
  console.log(['group', 'n', ...hs.map((h) => `${h}s`)].join('\t'));
  for (const [g, rs] of Object.entries(groups)) {
    const cells = hs.map((h) => {
      const v = rs.map((r) => Math.abs(+r[`move_${h}`])).filter((x) => !isNaN(x));
      return pctl(v, 0.5).toFixed(1);
    });
    console.log([g, rs.length, ...cells].join('\t'));
  }

  console.log('\n=== MFE / MAE from release (median points, full +90m window) ===');
  console.log(['group', 'n', 'medMFE', 'medMAE', 'med|MFE|+|MAE|'].join('\t'));
  for (const [g, rs] of Object.entries(groups)) {
    const mfe = rs.map((r) => +r.mfe).filter((x) => !isNaN(x));
    const mae = rs.map((r) => +r.mae).filter((x) => !isNaN(x));
    const rng = rs.map((r) => +r.mfe - +r.mae).filter((x) => !isNaN(x));
    console.log([g, rs.length, pctl(mfe, 0.5).toFixed(1), pctl(mae, 0.5).toFixed(1), pctl(rng, 0.5).toFixed(1)].join('\t'));
  }

  console.log('\n=== CONTINUATION vs REVERSAL ===');
  console.log('P(sign at later horizon == sign of first-minute move), by first-min |move| threshold');
  console.log(['group', 'n', 'firstMin>0%', 'cont@300s', 'cont@600s', 'cont@1800s', 'corr(imp60,move600)'].join('\t'));
  for (const [g, rs] of Object.entries(groups)) {
    const valid = rs.filter((r) => r.move_60 !== '' && !isNaN(+r.move_60) && +r.move_60 !== 0);
    const up = valid.filter((r) => +r.move_60 > 0).length / (valid.length || 1);
    const cont = (hz) => {
      const v = valid.filter((r) => r[`move_${hz}`] !== '' && !isNaN(+r[`move_${hz}`]));
      if (!v.length) return 'NA';
      return (v.filter((r) => Math.sign(+r[`move_${hz}`]) === Math.sign(+r.move_60)).length / v.length * 100).toFixed(0);
    };
    // pearson corr(impulse_60, move_600)
    const pair = valid.filter((r) => r.move_600 !== '' && !isNaN(+r.move_600)).map((r) => [+r.move_60, +r.move_600]);
    let corr = 'NA';
    if (pair.length > 3) {
      const mx = mean(pair.map((p) => p[0])), my = mean(pair.map((p) => p[1]));
      let sxy = 0, sxx = 0, syy = 0;
      for (const [x, y] of pair) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
      corr = (sxx && syy) ? (sxy / Math.sqrt(sxx * syy)).toFixed(2) : 'NA';
    }
    console.log([g, valid.length, (up * 100).toFixed(0), cont(300), cont(600), cont(1800), corr].join('\t'));
  }

  console.log('\n=== PRE-EVENT DRIFT vs POST MOVE (does positioning-into predict?) ===');
  console.log('corr(pre_drift_1800, move_600) and P(post continues pre-drift direction)');
  console.log(['group', 'n', 'corr(preDrift30m,move600)', 'P(post==preSign)%'].join('\t'));
  for (const [g, rs] of Object.entries(groups)) {
    const v = rs.filter((r) => r.pre_drift_1800 !== undefined && r.move_600 !== '' && !isNaN(+r.move_600) && +r.pre_drift_1800 !== 0);
    const pair = v.map((r) => [+r.pre_drift_1800, +r.move_600]);
    let corr = 'NA';
    if (pair.length > 3) {
      const mx = mean(pair.map((p) => p[0])), my = mean(pair.map((p) => p[1]));
      let sxy = 0, sxx = 0, syy = 0;
      for (const [x, y] of pair) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
      corr = (sxx && syy) ? (sxy / Math.sqrt(sxx * syy)).toFixed(2) : 'NA';
    }
    const pcont = v.length ? (v.filter((r) => Math.sign(+r.move_600) === Math.sign(+r.pre_drift_1800)).length / v.length * 100).toFixed(0) : 'NA';
    console.log([g, v.length, corr, pcont].join('\t'));
  }

  console.log(`\n(NQ point value = $${NQ_POINT_VALUE}. Roundtrip cost ~1.5-2 pts incl slippage+fees as a rule of thumb.)`);
}

const events = loadEvents();
console.log(`Loaded ${events.length} event windows.\n`);
const rows = buildFeatures(events);
writeFeatures(rows);
report(rows);
