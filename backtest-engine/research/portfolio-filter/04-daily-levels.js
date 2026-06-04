#!/usr/bin/env node
/**
 * Portfolio-filter step 04 — daily key-level context (Drew idea #3).
 * Computes per ET-date (raw primary contract, matches signal entryPrice space):
 *   PDH/PDL/PDC (prior RTH day), dailyOpen (today's 9:30 ET), ONH/ONL (00:00-09:30 ET).
 * For each signal: signed distance to each, nearest level + |dist|, "near key level" flag.
 * Then per-strategy performance by near-vs-far and by which level — does isolating trades
 * to daily structure improve win/loss? Causal (levels known at/before entry). Discovery.
 *
 * node research/portfolio-filter/04-daily-levels.js [--near 10]
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { fmtET } from '../multi-strategy-rules/lib/et-time.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(__dirname, 'output');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const NEAR = +arg('near', 10);

// ── build per-date primary-contract daily levels from raw 1m ──
const perDaySym = new Map();   // `${date}|${sym}` -> {vol, rthHi, rthLo, rthOpen, rthOpenMin, onHi, onLo, close}
function key(d, s) { return d + '|' + s; }
{
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(ROOT, 'data/ohlcv/nq/NQ_ohlcv_1m.csv')), crlfDelay: Infinity });
  let ci = null;
  for await (const line of rl) {
    if (!ci) { ci = {}; line.split(',').forEach((h, i) => ci[h] = i); continue; }
    const f = line.split(',');
    const sym = f[ci.symbol]; if (!sym || sym.includes('-')) continue;
    const dp = line.slice(0, 4); if (dp < '2024') continue;     // we only need 2025+ (+ late 2024 for prior-day)
    const ts = new Date(f[ci.ts_event]).getTime(); if (isNaN(ts)) continue;
    const et = fmtET(ts); const date = et.slice(0, 10); const minOfDay = parseInt(et.slice(11, 13)) * 60 + parseInt(et.slice(14, 16));
    const o = +f[ci.open], h = +f[ci.high], l = +f[ci.low], c = +f[ci.close], v = +f[ci.volume] || 0;
    const k = key(date, sym); let e = perDaySym.get(k);
    if (!e) { e = { vol: 0, rthHi: -Infinity, rthLo: Infinity, rthOpen: null, rthOpenMin: 1e9, onHi: -Infinity, onLo: Infinity, lastC: null, lastMin: -1 }; perDaySym.set(k, e); }
    e.vol += v;
    if (minOfDay >= 570 && minOfDay < 960) { if (h > e.rthHi) e.rthHi = h; if (l < e.rthLo) e.rthLo = l; if (minOfDay < e.rthOpenMin) { e.rthOpenMin = minOfDay; e.rthOpen = o; } if (minOfDay > e.lastMin) { e.lastMin = minOfDay; e.lastC = c; } }
    if (minOfDay < 570) { if (h > e.onHi) e.onHi = h; if (l < e.onLo) e.onLo = l; }
  }
}
// primary symbol per date = highest vol
const primaryByDate = new Map();   // date -> {sym, levels}
{
  const byDate = new Map();
  for (const [k, e] of perDaySym) { const [date, sym] = k.split('|'); if (!byDate.has(date)) byDate.set(date, []); byDate.get(date).push({ sym, e }); }
  for (const [date, arr] of byDate) { arr.sort((a, b) => b.e.vol - a.e.vol); primaryByDate.set(date, arr[0]); }
}
const dates = [...primaryByDate.keys()].sort();
const dateIdx = new Map(dates.map((d, i) => [d, i]));
function levelsFor(date) {
  const i = dateIdx.get(date); if (i == null) return null;
  const today = primaryByDate.get(date).e;
  const prev = i > 0 ? primaryByDate.get(dates[i - 1]).e : null;
  return {
    dailyOpen: today.rthOpen, ONH: today.onHi > -Infinity ? today.onHi : null, ONL: today.onLo < Infinity ? today.onLo : null,
    PDH: prev && prev.rthHi > -Infinity ? prev.rthHi : null, PDL: prev && prev.rthLo < Infinity ? prev.rthLo : null, PDC: prev ? prev.lastC : null,
  };
}

// ── join to signals ──
const lines = fs.readFileSync(path.join(OUT, 'signals.csv'), 'utf8').trim().split('\n');
const H = lines[0].split(','); const sig = lines.slice(1).map(l => { const f = l.split(','); const o = {}; H.forEach((h, j) => o[h] = f[j]); o.entryPrice = +o.entryPrice; o.netPnL = +o.netPnL; return o; });
let nearCount = 0;
for (const r of sig) {
  const lv = levelsFor(r.etDate); r.near = null; r.nearLvl = null; r.nearDist = null;
  if (!lv || !Number.isFinite(r.entryPrice)) continue;
  let best = Infinity, bestName = null;
  for (const [name, px] of Object.entries(lv)) { if (!Number.isFinite(px)) continue; const d = Math.abs(r.entryPrice - px); if (d < best) { best = d; bestName = name; } }
  r.nearDist = best; r.nearLvl = bestName; r.near = best <= NEAR ? 1 : 0; if (r.near) nearCount++;
}
console.log(`daily-level join: ${nearCount}/${sig.length} signals within ${NEAR}pt of a key level\n`);

function stats(arr) { if (!arr.length) return null; let w = 0, gp = 0, gl = 0, pnl = 0; for (const t of arr) { if (t.netPnL > 0) { w++; gp += t.netPnL; } else gl += -t.netPnL; pnl += t.netPnL; } return { n: arr.length, wr: 100 * w / arr.length, pf: gl > 0 ? gp / gl : Infinity, pnl, avg: pnl / arr.length }; }
function row(label, arr) { const s = stats(arr); if (!s || s.n < 15) { console.log('  ' + label.padEnd(34) + (s ? `n=${s.n} (few)` : 'n=0')); return; } console.log('  ' + label.padEnd(34) + `n=${String(s.n).padStart(5)}  WR ${s.wr.toFixed(1).padStart(5)}%  PF ${(s.pf===Infinity?'inf':s.pf.toFixed(2)).padStart(5)}  avg $${String(Math.round(s.avg)).padStart(5)}  PnL $${Math.round(s.pnl).toLocaleString()}`); }

for (const strat of ['lstb', 'gex-lt-3m', 'gex-flip-ivpct', 'gex-level-fade']) {
  const S = sig.filter(r => r.strategy === strat && r.near != null);
  console.log(`\n═══ ${strat} (n with levels = ${S.length}) ═══`);
  row(`near key level (<=${NEAR}pt)`, S.filter(r => r.near === 1));
  row(`far from key level (>${NEAR}pt)`, S.filter(r => r.near === 0));
  console.log('  -- by nearest level type (near only) --');
  for (const lv of ['dailyOpen', 'PDH', 'PDL', 'PDC', 'ONH', 'ONL']) row(`  near ${lv}`, S.filter(r => r.near === 1 && r.nearLvl === lv));
}
console.log('\n(stacked discovery; near-level proximity to daily structure as a filter feature → step 05 FCFS+OOS)');
