/**
 * Phase 4 — Per-trade feature/edge analysis.
 *
 * For a given exit config, computes per-trade PnL and groups by features:
 *   - hour-of-day ET
 *   - cb_atr bucket
 *   - trigger-bar range bucket
 *   - direction (long/short)
 *   - day-of-week
 *   - rangeRatio (triggerBarRange / atr20)
 *
 * Outputs WR / PF / avgPnL per bucket so we can identify negative-expectancy
 * subsets to filter out.
 *
 * Usage:
 *   node 04-per-trade-features.js --target 8 --stop 4 --be-trigger 4 --be-offset 1
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function arg(name, def) { const i = process.argv.indexOf(`--${name}`); return i === -1 ? def : process.argv[i + 1]; }
const WALK_PATH = arg('walk', path.join(__dirname, 'output', '01-trades-walk.json'));
const TARGET_PTS = arg('target', null);
const STOP_PTS = arg('stop', null);
const BE_TRIGGER = arg('be-trigger', null);
const BE_OFFSET = +arg('be-offset', '0');
const TRAIL_TRIGGER = arg('trail-trigger', null);
const TRAIL_OFFSET = arg('trail-offset', null);
const MAX_HOLD_MIN = +arg('max-hold', '60');
const SLIP_PTS = +arg('slip', '0.25');
const POINT_VALUE = +arg('point-value', '20');
const COMMISSION = +arg('commission', '5');
const OUT_PATH = arg('out', null);

const cfg = {
  target: TARGET_PTS == null ? null : +TARGET_PTS,
  stop: STOP_PTS == null ? null : +STOP_PTS,
  beTrig: BE_TRIGGER == null ? null : +BE_TRIGGER,
  beOff: BE_OFFSET,
  trTrig: TRAIL_TRIGGER == null ? null : +TRAIL_TRIGGER,
  trOff: TRAIL_OFFSET == null ? null : +TRAIL_OFFSET,
};

const maxHoldMs = MAX_HOLD_MIN * 60_000;
console.log(`Loading ${WALK_PATH}...`);
const walks = JSON.parse(fs.readFileSync(WALK_PATH, 'utf-8'));
console.log(`Trades: ${walks.length}`);
console.log(`Policy: ${JSON.stringify(cfg)}\n`);

function simulate(e, cfg) {
  const origTgt = e.side === 'buy' ? (e.tp - e.entry) : (e.entry - e.tp);
  const origStp = e.side === 'buy' ? (e.entry - e.sl) : (e.sl - e.entry);
  const tgt = cfg.target == null ? origTgt : cfg.target;
  const stp = cfg.stop == null ? origStp : cfg.stop;
  let mfePeak = 0, mae = 0, beActive = false, trActive = false;
  const walk = e.walk;
  for (let i = 0; i < walk.length; i++) {
    const s = walk[i]; const t = s[0] * 1000;
    const hi = s[1], lo = s[2], c = s[3];
    if (hi > mfePeak) mfePeak = hi;
    if (lo < 0 && -lo > mae) mae = -lo;
    if (cfg.beTrig != null && !beActive && mfePeak >= cfg.beTrig) beActive = true;
    if (cfg.trTrig != null && !trActive && mfePeak >= cfg.trTrig) trActive = true;
    if (mae >= stp) return { exit: 'stop', pnl: -(stp + SLIP_PTS), duration: t, mfe: mfePeak };
    if (mfePeak >= tgt) return { exit: 'target', pnl: tgt, duration: t, mfe: mfePeak };
    if (beActive && lo <= cfg.beOff) return { exit: 'be', pnl: cfg.beOff, duration: t, mfe: mfePeak };
    if (trActive) {
      const lvl = mfePeak - cfg.trOff;
      if (lo <= lvl) return { exit: 'trail', pnl: lvl - SLIP_PTS, duration: t, mfe: mfePeak };
    }
    if (t > maxHoldMs) return { exit: 'maxhold', pnl: c, duration: maxHoldMs, mfe: mfePeak };
  }
  if (e.terminal === 'eod' && e.eodPrice != null) {
    const pnl = e.side === 'buy' ? (e.eodPrice - e.entry) : (e.entry - e.eodPrice);
    return { exit: 'eod', pnl, duration: e.finalTs - e.fillTs, mfe: mfePeak };
  }
  const last = walk[walk.length - 1];
  return { exit: e.terminal || 'final', pnl: last ? last[3] : 0, duration: last ? last[0]*1000 : 0, mfe: mfePeak };
}

const tradeResults = walks.map(w => {
  const r = simulate(w, cfg);
  const dollars = r.pnl * POINT_VALUE - COMMISSION;
  const dt = new Date(w.fillTs);
  const dayET = dt.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  const minETStr = dt.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' });
  return {
    id: w.id,
    side: w.side,
    direction: w.direction,
    pnl: dollars,
    exit: r.exit,
    duration: r.duration,
    mfe: r.mfe,
    hourEt: w.hourEt,
    minEt: minETStr,
    dayEt: dayET,
    triggerBarRange: w.triggerBarRange,
    rangeRatio: w.rangeRatio,
    cbAtr: w.cbAtr,
    atr20: w.atr20,
    fillTs: w.fillTs,
  };
});

function group(arr, fn) {
  const map = new Map();
  for (const r of arr) {
    const k = fn(r);
    if (k == null) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
}

function stats(arr) {
  let pnl = 0, w = 0, l = 0, sW = 0, sL = 0;
  for (const r of arr) {
    pnl += r.pnl;
    if (r.pnl > 0) { w++; sW += r.pnl; }
    else if (r.pnl < 0) { l++; sL += r.pnl; }
  }
  return {
    n: arr.length,
    pnl,
    wr: arr.length ? w / (w + l) * 100 : 0,
    pf: sL ? Math.abs(sW / sL) : (sW > 0 ? Infinity : 0),
    avgPnL: arr.length ? pnl / arr.length : 0,
  };
}

function printGroups(label, map, sortBy = 'key') {
  console.log(`\n=== ${label} ===`);
  console.log(`  bucket      n     pnl       wr%    pf     avg$`);
  const rows = [];
  for (const [k, arr] of map.entries()) {
    const s = stats(arr);
    rows.push({ k, ...s });
  }
  if (sortBy === 'pnl') rows.sort((a, b) => b.pnl - a.pnl);
  else if (sortBy === 'avg') rows.sort((a, b) => b.avgPnL - a.avgPnL);
  else rows.sort((a, b) => String(a.k).localeCompare(String(b.k), undefined, { numeric: true }));
  for (const r of rows) {
    console.log(`  ${String(r.k).padEnd(10)} ${String(r.n).padStart(5)}  ${String(r.pnl.toFixed(0)).padStart(8)}  ${r.wr.toFixed(1).padStart(5)}  ${r.pf.toFixed(2).padStart(5)}  ${r.avgPnL.toFixed(1).padStart(6)}`);
  }
}

// Baseline summary
const all = stats(tradeResults);
console.log(`\nBaseline (all ${all.n}): $${all.pnl.toFixed(0)}  WR ${all.wr.toFixed(1)}%  PF ${all.pf.toFixed(2)}`);

// 1. Hour ET
printGroups('Hour ET', group(tradeResults, r => String(r.hourEt).padStart(2, '0')));
// 2. Direction
printGroups('Direction', group(tradeResults, r => r.direction));
// 3. Day of week
printGroups('Day of week', group(tradeResults, r => r.dayEt));
// 4. cb_atr bucket
printGroups('cb_atr bucket', group(tradeResults, r => {
  if (r.cbAtr == null) return null;
  const b = Math.floor(r.cbAtr * 10) / 10;
  return `${b.toFixed(1)}-${(b+0.1).toFixed(1)}`;
}));
// 5. Trigger bar range bucket
printGroups('Trigger bar range', group(tradeResults, r => {
  if (r.triggerBarRange == null) return null;
  if (r.triggerBarRange <= 3) return '0-3';
  if (r.triggerBarRange <= 5) return '3-5';
  if (r.triggerBarRange <= 7) return '5-7';
  if (r.triggerBarRange <= 10) return '7-10';
  if (r.triggerBarRange <= 15) return '10-15';
  if (r.triggerBarRange <= 25) return '15-25';
  return '25+';
}));
// 6. rangeRatio bucket (trigger range / atr20)
printGroups('rangeRatio (trigger/atr20)', group(tradeResults, r => {
  if (r.rangeRatio == null) return null;
  if (r.rangeRatio <= 0.5) return '0-0.5';
  if (r.rangeRatio <= 1.0) return '0.5-1';
  if (r.rangeRatio <= 1.5) return '1-1.5';
  if (r.rangeRatio <= 2.0) return '1.5-2';
  if (r.rangeRatio <= 3.0) return '2-3';
  return '3+';
}));
// 7. Half-hour buckets
printGroups('Half-hour ET', group(tradeResults, r => {
  const [hh, mm] = r.minEt.split(':');
  const h = +hh, m = +mm;
  return `${String(h).padStart(2,'0')}:${m < 30 ? '00' : '30'}`;
}));

if (OUT_PATH) {
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(tradeResults));
  console.log(`\nWrote per-trade results: ${OUT_PATH}`);
}
