#!/usr/bin/env node
/**
 * Overlap analysis between IV-SKEW-GEX and SHORT-DTE-IV strategies.
 * Finds trades that overlap in time and analyzes agreement vs disagreement outcomes.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, '..', 'results', 'strategy-comparison');

// Load trade data
const isgData = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, 'iv-skew-gex.json'), 'utf8'));
const sdivData = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, 'short-dte-iv.json'), 'utf8'));

const isgTrades = isgData.trades;
const sdivTrades = sdivData.trades;

// ── Helpers ─────────────────────────────────────────────────────────────────
function normSide(s) {
  if (!s) return 'unknown';
  const l = s.toLowerCase();
  return (l === 'buy' || l === 'long') ? 'long' : 'short';
}
function isWin(t) { return t.netPnL > 0; }
function winRate(trades) { return trades.length === 0 ? 'N/A' : (trades.filter(isWin).length / trades.length * 100).toFixed(1) + '%'; }
function totalPnL(trades) { return trades.reduce((s, t) => s + t.netPnL, 0); }
function avgPnL(trades) { return trades.length === 0 ? 0 : totalPnL(trades) / trades.length; }
function dollar(n) { return (n >= 0 ? '$' : '-$') + Math.abs(n).toFixed(0); }
function profitFactor(trades) {
  let gp = 0, gl = 0;
  for (const t of trades) { if (t.netPnL > 0) gp += t.netPnL; else gl += Math.abs(t.netPnL); }
  return gl === 0 ? 'Inf' : (gp / gl).toFixed(2);
}

// ── Find overlapping trades ─────────────────────────────────────────────────
// Two trades "overlap" if their active periods [entry, exit] intersect.
// Also check proximity: trades within WINDOW_MS of each other's entry.
const WINDOW_MS = 15 * 60 * 1000; // 15 minute proximity window

const pairs = [];

for (const isg of isgTrades) {
  for (const sdiv of sdivTrades) {
    // Check temporal overlap (active at the same time)
    const isgEntry = isg.entryTime;
    const isgExit = isg.exitTime || isg.entryTime + (isg.duration || 0);
    const sdivEntry = sdiv.entryTime;
    const sdivExit = sdiv.exitTime || sdiv.entryTime + (sdiv.duration || 0);

    const activeOverlap = isgEntry < sdivExit && sdivEntry < isgExit;

    // Check proximity (entries within window)
    const entryProximity = Math.abs(isgEntry - sdivEntry) <= WINDOW_MS;

    if (activeOverlap || entryProximity) {
      pairs.push({
        isg,
        sdiv,
        isgSide: normSide(isg.side),
        sdivSide: normSide(sdiv.side),
        agree: normSide(isg.side) === normSide(sdiv.side),
        gapMs: Math.abs(isgEntry - sdivEntry),
      });
    }
  }
}

// Deduplicate: each ISG trade should pair with at most one SDIV trade (closest)
const isgPaired = new Map();
const sdivPaired = new Map();
const uniquePairs = [];

// Sort by gap so closest pairs are matched first
pairs.sort((a, b) => a.gapMs - b.gapMs);
for (const p of pairs) {
  const isgId = p.isg.tradeId || p.isg.entryTime;
  const sdivId = p.sdiv.tradeId || p.sdiv.entryTime;
  if (!isgPaired.has(isgId) && !sdivPaired.has(sdivId)) {
    isgPaired.set(isgId, true);
    sdivPaired.set(sdivId, true);
    uniquePairs.push(p);
  }
}

// ── Categorize pairs ────────────────────────────────────────────────────────
const agreePairs = uniquePairs.filter(p => p.agree);
const disagreePairs = uniquePairs.filter(p => !p.agree);

// Subcategories of disagreement
const isgLongSdivShort = disagreePairs.filter(p => p.isgSide === 'long' && p.sdivSide === 'short');
const isgShortSdivLong = disagreePairs.filter(p => p.isgSide === 'short' && p.sdivSide === 'long');

// ── Print results ───────────────────────────────────────────────────────────
console.log('═══════════════════════════════════════════════════════════════');
console.log('  ISG vs SDIV Overlap Analysis');
console.log('═══════════════════════════════════════════════════════════════');
console.log(`  ISG total trades:  ${isgTrades.length}`);
console.log(`  SDIV total trades: ${sdivTrades.length}`);
console.log(`  Overlapping pairs: ${uniquePairs.length}`);
console.log(`  Window:            ${WINDOW_MS / 60000} min proximity OR active overlap`);
console.log('');

function printGroup(label, pairs) {
  const isgGroup = pairs.map(p => p.isg);
  const sdivGroup = pairs.map(p => p.sdiv);
  const isgWins = isgGroup.filter(isWin).length;
  const sdivWins = sdivGroup.filter(isWin).length;
  const bothWin = pairs.filter(p => isWin(p.isg) && isWin(p.sdiv)).length;
  const bothLose = pairs.filter(p => !isWin(p.isg) && !isWin(p.sdiv)).length;

  console.log(`── ${label} (${pairs.length} pairs) ──`);
  if (pairs.length === 0) { console.log('  (none)\n'); return; }

  console.log(`  ISG:  WR ${winRate(isgGroup)}  (${isgWins}/${isgGroup.length})  PnL ${dollar(totalPnL(isgGroup))}  Avg ${dollar(avgPnL(isgGroup))}  PF ${profitFactor(isgGroup)}`);
  console.log(`  SDIV: WR ${winRate(sdivGroup)} (${sdivWins}/${sdivGroup.length})  PnL ${dollar(totalPnL(sdivGroup))}  Avg ${dollar(avgPnL(sdivGroup))}  PF ${profitFactor(sdivGroup)}`);
  console.log(`  Both win:  ${bothWin}/${pairs.length} (${(bothWin/pairs.length*100).toFixed(1)}%)`);
  console.log(`  Both lose: ${bothLose}/${pairs.length} (${(bothLose/pairs.length*100).toFixed(1)}%)`);

  // Avg entry gap
  const avgGap = pairs.reduce((s, p) => s + p.gapMs, 0) / pairs.length;
  console.log(`  Avg entry gap: ${(avgGap / 60000).toFixed(1)} min`);
  console.log('');
}

printGroup('ALL OVERLAPPING', uniquePairs);
printGroup('AGREEMENT (same direction)', agreePairs);
printGroup('DISAGREEMENT (opposite direction)', disagreePairs);
printGroup('ISG LONG / SDIV SHORT', isgLongSdivShort);
printGroup('ISG SHORT / SDIV LONG', isgShortSdivLong);

// ── Breakdown: Agreement by direction ───────────────────────────────────────
const agreeLong = agreePairs.filter(p => p.isgSide === 'long');
const agreeShort = agreePairs.filter(p => p.isgSide === 'short');

console.log('── AGREEMENT BY DIRECTION ──');
if (agreeLong.length > 0) {
  console.log(`  Both LONG  (${agreeLong.length}):  ISG WR ${winRate(agreeLong.map(p=>p.isg))}  SDIV WR ${winRate(agreeLong.map(p=>p.sdiv))}`);
}
if (agreeShort.length > 0) {
  console.log(`  Both SHORT (${agreeShort.length}): ISG WR ${winRate(agreeShort.map(p=>p.isg))}  SDIV WR ${winRate(agreeShort.map(p=>p.sdiv))}`);
}
console.log('');

// ── Baseline comparison ─────────────────────────────────────────────────────
console.log('── BASELINE (all trades, no overlap filter) ──');
console.log(`  ISG:  WR ${winRate(isgTrades)}  (${isgTrades.filter(isWin).length}/${isgTrades.length})  PnL ${dollar(totalPnL(isgTrades))}`);
console.log(`  SDIV: WR ${winRate(sdivTrades)} (${sdivTrades.filter(isWin).length}/${sdivTrades.length})  PnL ${dollar(totalPnL(sdivTrades))}`);
console.log('');

// ── Time-of-day analysis for agreement ──────────────────────────────────────
console.log('── AGREEMENT BY HOUR (ET) ──');
const hourBuckets = {};
for (const p of agreePairs) {
  const et = new Date(p.isg.entryTime);
  const etHour = (et.getUTCHours() - 5 + 24) % 24; // rough ET
  if (!hourBuckets[etHour]) hourBuckets[etHour] = [];
  hourBuckets[etHour].push(p);
}
for (const hour of Object.keys(hourBuckets).sort((a,b) => a - b)) {
  const hp = hourBuckets[hour];
  console.log(`  ${String(hour).padStart(2)}:00  ${hp.length} pairs  ISG WR ${winRate(hp.map(p=>p.isg))}  SDIV WR ${winRate(hp.map(p=>p.sdiv))}`);
}
console.log('');

// ── Individual pair detail for small groups ─────────────────────────────────
if (disagreePairs.length <= 30) {
  console.log('── DISAGREEMENT DETAIL ──');
  for (const p of disagreePairs) {
    const isgTime = new Date(p.isg.entryTime).toISOString().slice(0, 16);
    const isgResult = isWin(p.isg) ? 'W' : 'L';
    const sdivResult = isWin(p.sdiv) ? 'W' : 'L';
    console.log(`  ${isgTime}  ISG:${p.isgSide.toUpperCase()}(${isgResult} ${dollar(p.isg.netPnL)})  SDIV:${p.sdivSide.toUpperCase()}(${sdivResult} ${dollar(p.sdiv.netPnL)})  gap:${(p.gapMs/60000).toFixed(0)}m`);
  }
  console.log('');
}

// ── Any 100% WR subsets? ────────────────────────────────────────────────────
console.log('── PERFECT (100%) WIN RATE SUBSETS ──');
const subsets = [
  ['Agreement ALL', agreePairs],
  ['Agreement LONG', agreeLong],
  ['Agreement SHORT', agreeShort],
  ['ISG long / SDIV short', isgLongSdivShort],
  ['ISG short / SDIV long', isgShortSdivLong],
];
for (const [label, subset] of subsets) {
  if (subset.length === 0) continue;
  const isgWR = subset.filter(p => isWin(p.isg)).length / subset.length * 100;
  const sdivWR = subset.filter(p => isWin(p.sdiv)).length / subset.length * 100;
  if (isgWR === 100 || sdivWR === 100) {
    console.log(`  ✅ ${label}: ISG ${isgWR.toFixed(0)}% WR, SDIV ${sdivWR.toFixed(0)}% WR (n=${subset.length})`);
  }
}
console.log('  (checked all directional subsets)');
console.log('');
