#!/usr/bin/env node
/**
 * Validate cross-strike OI smoothing in the live GEX calculator against the
 * OPRA-sourced backtest GEX (data/gex/nq), across ALL overlapping Schwab days.
 *
 * For each Schwab snapshot we compute live GEX at several smoothing windows
 * (0 = off/baseline), convert QQQ levels to NQ using the backtest's stored
 * multiplier at the matched timestamp, and measure |diff| vs backtest walls
 * and support/resistance ladders. Per-day + aggregate so we can see whether a
 * window that helps one day generalizes (overfit guard).
 *
 * Usage: node scripts/reconcile-gex-smoothing.js [--windows 0,3,5,7] [--perday 24]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ExposureCalculator from '../../signal-generator/src/tradier/exposure-calculator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data');
const SNAP = path.join(DATA, 'schwab-snapshots');
const GEXDIR = path.join(DATA, 'gex', (process.argv.includes('--gexvariant') ? process.argv[process.argv.indexOf('--gexvariant')+1] : 'nq'));

const args = process.argv.slice(2);
const getArg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const WINDOWS = getArg('--windows', '0,3,5,7').split(',').map(Number);
const PERDAY = parseInt(getArg('--perday', '24'));
const METHOD = getArg('--method', 'median');
const EX0DTE = args.includes('--exclude0dte');
const MINDTE = parseInt(getArg('--mindte','0'));

function estimateSpot(chains) {
  const chain = chains[0];
  if (!chain?.options?.length) return null;
  const byStrike = new Map();
  for (const o of chain.options) {
    if (!o.strike || !o.bid || !o.ask || o.bid <= 0) continue;
    if (!byStrike.has(o.strike)) byStrike.set(o.strike, {});
    if (o.option_type === 'call') byStrike.get(o.strike).call = o;
    else byStrike.get(o.strike).put = o;
  }
  let best = null, bestDelta = Infinity;
  for (const [K, slot] of byStrike) {
    if (!slot.call || !slot.put) continue;
    const cMid = (slot.call.bid + slot.call.ask) / 2, pMid = (slot.put.bid + slot.put.ask) / 2;
    const s = K + Math.exp(0.05 / 365) * (cMid - pMid);
    const d = Math.abs(s - K);
    if (d < bestDelta) { bestDelta = d; best = s; }
  }
  return best;
}
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
// mean nearest-neighbor distance from each bt level to closest live level (NQ pts)
function ladderAlign(bt, live) {
  if (!bt?.length || !live?.length) return null;
  return mean(bt.map(b => Math.min(...live.map(l => Math.abs(l - b)))));
}

// discover overlap days that have both a snapshot dir and a backtest gex file
const days = fs.readdirSync(SNAP).filter(d => /^2026-\d\d-\d\d$/.test(d))
  .filter(d => fs.existsSync(path.join(GEXDIR, `nq_gex_${d}.json`))).sort();

// pre-build calculators per window
const calcs = new Map();
for (const w of WINDOWS) calcs.set(w, new ExposureCalculator({ riskFreeRate: 0.05, oiSmoothingWindow: w, oiSmoothingMethod: METHOD, excludeZeroDTE: EX0DTE }));

// accumulator: window -> {call:[],put:[],flip:[],sup:[],res:[]}
const agg = new Map();
for (const w of WINDOWS) agg.set(w, { call: [], put: [], flip: [], sup: [], res: [] });
const perDay = []; // {day, window -> metrics}

for (const day of days) {
  const bt = JSON.parse(fs.readFileSync(path.join(GEXDIR, `nq_gex_${day}.json`), 'utf8')).data
    .map(s => ({ ...s, ms: new Date(s.timestamp).getTime() }))
    .sort((a, b) => a.ms - b.ms);
  const files = fs.readdirSync(path.join(SNAP, day)).filter(f => f.startsWith('snapshot_') && f.endsWith('.json')).sort();
  if (MINDTE > 0 && files.length) { const _d=JSON.parse(fs.readFileSync(path.join(SNAP,day,files[Math.floor(files.length/2)]),'utf8')); const _e=_d.chains.QQQ.map(c=>c.expiration).sort(); const _m=(new Date(_e[_e.length-1])-new Date(day))/86400000; if(_m<MINDTE){continue;} }
  const step = Math.max(1, Math.ceil(files.length / PERDAY));
  const dayAgg = new Map(); for (const w of WINDOWS) dayAgg.set(w, { call: [], put: [], flip: [], sup: [], res: [] });

  for (let i = 0; i < files.length; i += step) {
    const data = JSON.parse(fs.readFileSync(path.join(SNAP, day, files[i]), 'utf8'));
    const chains = data.chains?.QQQ; if (!chains?.length) continue;
    const asOf = new Date(data.timestamp);
    const spot = estimateSpot(chains); if (!spot) continue;
    // nearest bt snapshot within 8 min
    let b = null, bd = Infinity;
    for (const snap of bt) { const d = Math.abs(snap.ms - asOf.getTime()); if (d < bd) { bd = d; b = snap; } }
    if (!b || bd > 8 * 60000) continue;
    const mult = b.multiplier || (b.nq_spot / b.qqq_spot);

    for (const w of WINDOWS) {
      const r = calcs.get(w).calculateExposures({ QQQ: chains }, { QQQ: spot }, { asOf }).QQQ;
      if (!r?.levels) continue;
      const cw = r.levels.callWall ? r.levels.callWall * mult : null;
      const pw = r.levels.putWall ? r.levels.putWall * mult : null;
      const gf = r.levels.gammaFlip ? r.levels.gammaFlip * mult : null;
      const sup = (r.levels.support || []).map(s => s * mult);
      const res = (r.levels.resistance || []).map(s => s * mult);
      const m = dayAgg.get(w);
      if (cw && b.call_wall) m.call.push(Math.abs(cw - b.call_wall));
      if (pw && b.put_wall) m.put.push(Math.abs(pw - b.put_wall));
      if (gf && b.gamma_flip) m.flip.push(Math.abs(gf - b.gamma_flip));
      const sa = ladderAlign(b.support, sup); if (sa != null) m.sup.push(sa);
      const ra = ladderAlign(b.resistance, res); if (ra != null) m.res.push(ra);
    }
  }
  const row = { day };
  for (const w of WINDOWS) {
    const m = dayAgg.get(w);
    row[w] = { call: mean(m.call), put: mean(m.put), flip: mean(m.flip), sup: mean(m.sup), res: mean(m.res), n: m.put.length };
    const A = agg.get(w);
    A.call.push(...m.call); A.put.push(...m.put); A.flip.push(...m.flip); A.sup.push(...m.sup); A.res.push(...m.res);
  }
  perDay.push(row);
}

const f = v => v == null ? '  -- ' : String(Math.round(v)).padStart(5);
console.log(`\nCross-strike OI smoothing validation (method=${METHOD}) — all NQ pts, lower=closer to OPRA backtest`);
console.log(`Days: ${days.join(', ')}   windows: ${WINDOWS.join(', ')} (0=baseline/off)\n`);
for (const metric of ['put', 'call', 'sup', 'res', 'flip']) {
  const label = { put: 'PUT WALL', call: 'CALL WALL', sup: 'SUPPORT ladder', res: 'RESIST ladder', flip: 'GAMMA FLIP' }[metric];
  console.log(`── ${label} |diff| ──`);
  console.log('  day        ' + WINDOWS.map(w => ('w=' + w).padStart(7)).join(''));
  for (const row of perDay) console.log('  ' + row.day + '  ' + WINDOWS.map(w => f(row[w][metric]).padStart(7)).join(''));
  console.log('  AGGREGATE  ' + WINDOWS.map(w => f(mean(agg.get(w)[metric])).padStart(7)).join(''));
  console.log('');
}
