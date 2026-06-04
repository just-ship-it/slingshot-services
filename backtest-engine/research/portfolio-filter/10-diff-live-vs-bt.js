#!/usr/bin/env node
/**
 * Diff backtest-GEX vs live-Schwab-GEX strategy runs over the 11 overlap days.
 * Answers Drew's question: do live signals + PnL meaningfully differ from backtest?
 * Matches trades by (side, entryTime within TOL). Restricts to days where Schwab GEX exists.
 * node research/portfolio-filter/10-diff-live-vs-bt.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOL = 5 * 60000;
// VALID full-chain Schwab days only (options_count ~10k). March + 4/27-4/28 were PARTIAL chains
// (~900-5300 contracts) → invalid GEX → excluded. Valid ∩ cbbo(≤5/01) = 4/29,4/30,5/01.
const COVERED = new Set(['2026-04-29','2026-04-30','2026-05-01']);
const etDate = ms => { const d = new Date(ms - 4 * 3600000); return d.toISOString().slice(0, 10); }; // EDT window

function loadTrades(f) {
  if (!fs.existsSync(f)) return null;
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  return (j.trades || []).filter(t => t.status === 'completed' && t.entryTime != null)
    .filter(t => COVERED.has(etDate(t.entryTime)))
    .map(t => ({ ts: t.entryTime, side: String(t.side).toLowerCase(), pnl: t.netPnL }))
    .sort((a, b) => a.ts - b.ts);
}
function diff(bt, live) {
  const usedLive = new Array(live.length).fill(false);
  let matched = 0, mPnlBt = 0, mPnlLive = 0;
  for (const b of bt) {
    let j = -1; for (let i = 0; i < live.length; i++) { if (usedLive[i]) continue; if (live[i].side === b.side && Math.abs(live[i].ts - b.ts) <= TOL) { j = i; break; } }
    if (j >= 0) { usedLive[j] = true; matched++; mPnlBt += b.pnl; mPnlLive += live[j].pnl; }
  }
  const btOnly = bt.length - matched, liveOnly = live.length - matched;
  return { matched, btOnly, liveOnly, mPnlBt, mPnlLive };
}
const sum = a => a.reduce((s, t) => s + t.pnl, 0);

console.log('Live(Schwab GEX) vs Backtest(CBBO/stats GEX) — 11 overlap days, 3 GEX strategies\n');
console.log('  strategy          BT trades  LIVE trades  matched  BT-only  LIVE-only  | BT PnL    LIVE PnL   ΔPnL    signal-overlap%');
let any = false;
for (const [name, btf, lf] of [['gex-flip-ivpct','gfi_bt.json','gfi_live.json'],['gex-lt-3m','glx_bt.json','glx_live.json'],['gex-level-fade','glf_bt.json','glf_live.json']]) {
  const bt = loadTrades(`/tmp/cmp/${btf}`), live = loadTrades(`/tmp/cmp/${lf}`);
  if (!bt || !live) { console.log(`  ${name.padEnd(16)} (missing output ${!bt?btf:lf})`); continue; }
  any = true;
  const d = diff(bt, live);
  const btPnl = sum(bt), livePnl = sum(live);
  const denom = bt.length + live.length - d.matched;
  const overlap = denom > 0 ? 100 * d.matched / denom : 100;
  console.log(`  ${name.padEnd(16)} ${String(bt.length).padStart(8)}  ${String(live.length).padStart(11)}  ${String(d.matched).padStart(7)}  ${String(d.btOnly).padStart(7)}  ${String(d.liveOnly).padStart(9)}  | ${('$'+Math.round(btPnl)).padStart(8)}  ${('$'+Math.round(livePnl)).padStart(8)}  ${(livePnl>=btPnl?'+':'')+Math.round(livePnl-btPnl)}   ${overlap.toFixed(0)}%`);
}
if (any) {
  console.log('\n  Read: high signal-overlap% + small ΔPnL → live≈backtest, GEX-source gap is benign.');
  console.log('  Low overlap or large ΔPnL → live diverges from backtest = real fidelity problem to address.');
}
