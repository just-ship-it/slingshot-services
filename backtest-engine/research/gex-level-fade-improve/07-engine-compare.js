/**
 * Phase 7 — Compare engine validation outputs to in-memory sim and saved gold.
 *
 * Reads /tmp/glf-validate/*.json and data/gold-standard/gex-level-fade.json and
 * prints a unified comparison table.
 */

import fs from 'fs';
import path from 'path';

const runs = [
  { label: 'saved gold (May 17, no EOD)',  path: '/home/drew/projects/slingshot-services/backtest-engine/data/gold-standard/gex-level-fade.json' },
  { label: 'engine gold (EOD 16:40)',       path: '/tmp/glf-validate/baseline.json' },
  { label: 'engine gold (no EOD)',          path: '/tmp/glf-validate/baseline-noeod.json' },
  { label: 'engine v2 (EOD 16:40)',         path: '/tmp/glf-validate/v2.json' },
  { label: 'engine v2-max (EOD 16:40)',     path: '/tmp/glf-validate/v2-max.json' },
  { label: 'engine v2-low-dd (EOD 16:40)',  path: '/tmp/glf-validate/v2-low-dd.json' },
];

const SPLIT_TS = new Date('2025-09-01T00:00:00Z').getTime();

function splitStats(trades) {
  function netStats(arr) {
    if (!arr.length) return { n: 0, pnl: 0, wins: 0, losses: 0, wr: 0, pf: 0, maxDD: 0, sharpe: 0 };
    let pnl = 0, wins = 0, losses = 0, sumW = 0, sumL = 0;
    const equity = []; let cum = 0;
    for (const t of arr) {
      const d = t.netPnL;
      pnl += d; cum += d; equity.push(cum);
      if (d > 0) { wins++; sumW += d; }
      else if (d < 0) { losses++; sumL += d; }
    }
    const n = arr.length;
    const wr = (wins + losses) ? wins / (wins + losses) * 100 : 0;
    const pf = sumL !== 0 ? Math.abs(sumW / sumL) : (sumW > 0 ? Infinity : 0);
    let peak = -Infinity, maxDD = 0;
    for (const v of equity) { if (v > peak) peak = v; if (peak - v > maxDD) maxDD = peak - v; }
    const mean = n ? pnl / n : 0;
    let varSum = 0;
    for (const t of arr) varSum += (t.netPnL - mean) ** 2;
    const sd = n ? Math.sqrt(varSum / n) : 0;
    const perT = sd > 0 ? mean / sd : 0;
    return { n, pnl, wins, losses, wr, pf, maxDD, sharpe: perT * Math.sqrt(n / (16/12)) };
  }
  return {
    all: netStats(trades),
    h1: netStats(trades.filter(t => t.entryTime < SPLIT_TS)),
    h2: netStats(trades.filter(t => t.entryTime >= SPLIT_TS)),
  };
}

function fmt(s) {
  if (!s.n) return 'n/a';
  return `n=${String(s.n).padStart(4)} $${s.pnl.toFixed(0).padStart(7)} WR=${s.wr.toFixed(0).padStart(2)}% PF=${s.pf.toFixed(2)} Sh=${s.sharpe.toFixed(2)} DD=$${s.maxDD.toFixed(0).padStart(6)}`;
}

console.log('=== Engine validation comparison ===\n');
for (const r of runs) {
  let data;
  try { data = JSON.parse(fs.readFileSync(r.path, 'utf-8')); }
  catch (e) { console.log(`${r.label}: NOT YET RUN (${e.message})\n`); continue; }
  const trades = data.trades.filter(t => t.status === 'completed');
  const split = splitStats(trades);
  const eng = data.performance?.summary;
  console.log(`${r.label}`);
  console.log(`  ALL: ${fmt(split.all)}`);
  console.log(`  H1 : ${fmt(split.h1)}`);
  console.log(`  H2 : ${fmt(split.h2)}`);
  if (eng) console.log(`  engine.summary: $${eng.totalPnL.toFixed(0).padStart(7)}, Sharpe=${eng.sharpeRatio?.toFixed(2)}, DD=${eng.maxDrawdown?.toFixed(2)}%, WR=${eng.winRate?.toFixed(2)}%`);
  console.log('');
}
