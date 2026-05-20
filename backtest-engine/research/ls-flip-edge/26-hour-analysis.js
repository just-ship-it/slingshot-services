/**
 * Phase I-6 — Per-ET-hour breakdown of ls-flip-trigger-bar trades.
 *
 * Goal: find which session hours are negative-expectancy so we can set an
 * earlier entry cutoff. Broker constraint: no positions held 16:45-17:59 ET;
 * new positions only after 18:00 ET. The current backtest has
 * `forceCloseAtMarketClose=true` which closes positions at 17:00 ET — those
 * "MARKET CLOSE" exits likely include marginal late-day setups.
 *
 * For each entry hour (ET) and exit hour (ET) print:
 *   n, contracts, WR, PF, sum PnL, avg PnL
 * Also bucket by exitReason within each entry hour to expose where market_close
 * concentrates and whether those are losers we'd be better off skipping.
 *
 * Finally: cumulative-PnL surface that drops each hour from the entry universe
 * to find the best entry cutoff.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GOLD = path.join(__dirname, '..', '..', 'data', 'gold-standard', 'ls-flip-trigger-bar.json');
const OUT = path.join(__dirname, 'output', '26-hour-analysis.txt');

const data = JSON.parse(fs.readFileSync(GOLD, 'utf-8'));
const trades = data.trades;
console.log(`Loaded ${trades.length} trades`);

const POINT = 20; // $/pt for NQ

// ET = UTC - 5h standard / -4h DST. Use simple Date.toLocaleString with timeZone.
function etHour(ms) {
  const d = new Date(ms);
  // Use Intl to get ET hour reliably (handles DST).
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false, hour: 'numeric'
  });
  return parseInt(fmt.format(d), 10);
}
function etHalf(ms) {
  const d = new Date(ms);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false, hour: 'numeric', minute: 'numeric'
  });
  const [h, m] = fmt.format(d).split(':').map(s => parseInt(s, 10));
  return h + (m >= 30 ? 0.5 : 0);
}

function summarize(arr) {
  if (!arr.length) return { n: 0, wr: 0, pf: 0, avg: 0, sum: 0, dollar: 0 };
  let n = 0, w = 0, l = 0, sumW = 0, sumL = 0, sum = 0;
  for (const t of arr) {
    if (t.status !== 'completed') continue;
    const p = t.pointsPnL ?? (t.netPnL != null ? t.netPnL / POINT : 0);
    n++; sum += p;
    if (p > 0) { w++; sumW += p; }
    else if (p < 0) { l++; sumL += -p; }
  }
  return {
    n, w, l, sum, dollar: sum * POINT,
    wr: n ? w / n * 100 : 0,
    pf: sumL > 0 ? sumW / sumL : (sumW > 0 ? Infinity : 0),
    avg: n ? sum / n : 0,
  };
}

const out = [];
function emit(s) { console.log(s); out.push(s); }

emit(`\n=== Phase I-6 — Per-ET-hour analysis of ls-flip-trigger-bar ===`);
emit(`Universe: ${trades.length} trades, Jan 2025 → Apr 2026`);
emit(``);

// ----- By entry hour -----
const byEntryHour = new Map();
for (const t of trades) {
  if (t.status !== 'completed' || t.entryTime == null) continue;
  const h = etHour(t.entryTime);
  if (!byEntryHour.has(h)) byEntryHour.set(h, []);
  byEntryHour.get(h).push(t);
}

emit(`--- By ENTRY hour (ET) ---`);
emit(`  ${'hr'.padStart(3)}  ${'n'.padStart(5)}  ${'WR'.padStart(5)}  ${'PF'.padStart(6)}  ${'sum pts'.padStart(9)}  ${'$'.padStart(9)}  ${'avg pts'.padStart(8)}`);
const hours = [...byEntryHour.keys()].sort((a, b) => a - b);
let total = { n: 0, sum: 0 };
for (const h of hours) {
  const s = summarize(byEntryHour.get(h));
  emit(`  ${String(h).padStart(3)}  ${String(s.n).padStart(5)}  ${s.wr.toFixed(1).padStart(5)}  ${s.pf.toFixed(2).padStart(6)}  ${s.sum.toFixed(0).padStart(9)}  $${(s.dollar / 1000).toFixed(1).padStart(7)}k  ${s.avg.toFixed(2).padStart(8)}`);
  total.n += s.n; total.sum += s.sum;
}
emit(`  ${'all'.padStart(3)}  ${String(total.n).padStart(5)}  ${''.padStart(5)}  ${''.padStart(6)}  ${total.sum.toFixed(0).padStart(9)}  $${(total.sum * POINT / 1000).toFixed(1).padStart(7)}k`);

// ----- By half-hour -----
emit(`\n--- By ENTRY half-hour (ET, RTH+late session) ---`);
const byHalf = new Map();
for (const t of trades) {
  if (t.status !== 'completed' || t.entryTime == null) continue;
  const h = etHalf(t.entryTime);
  if (!byHalf.has(h)) byHalf.set(h, []);
  byHalf.get(h).push(t);
}
const halves = [...byHalf.keys()].sort((a, b) => a - b);
emit(`  ${'slot'.padStart(5)}  ${'n'.padStart(5)}  ${'WR'.padStart(5)}  ${'PF'.padStart(6)}  ${'sum pts'.padStart(9)}  ${'$'.padStart(9)}`);
for (const h of halves) {
  const s = summarize(byHalf.get(h));
  const slot = `${Math.floor(h).toString().padStart(2, '0')}:${(h % 1 ? '30' : '00')}`;
  emit(`  ${slot.padStart(5)}  ${String(s.n).padStart(5)}  ${s.wr.toFixed(1).padStart(5)}  ${s.pf.toFixed(2).padStart(6)}  ${s.sum.toFixed(0).padStart(9)}  $${(s.dollar / 1000).toFixed(1).padStart(7)}k`);
}

// ----- Exit-reason × entry-hour -----
emit(`\n--- Exit-reason × entry hour (sum points) ---`);
const reasons = new Set();
for (const t of trades) if (t.exitReason) reasons.add(t.exitReason);
const reasonList = [...reasons].sort();
const hd = `  ${'hr'.padStart(3)}  ` + reasonList.map(r => r.padStart(13)).join('  ');
emit(hd);
for (const h of hours) {
  const arr = byEntryHour.get(h);
  const cells = reasonList.map(r => {
    const sub = arr.filter(t => t.exitReason === r);
    const s = summarize(sub);
    return `${s.n}/${s.sum.toFixed(0)}`.padStart(13);
  });
  emit(`  ${String(h).padStart(3)}  ${cells.join('  ')}`);
}

// ----- MARKET CLOSE deep-dive -----
emit(`\n--- MARKET_CLOSE exit deep-dive ---`);
const mc = trades.filter(t => t.exitReason === 'market_close');
const mcS = summarize(mc);
emit(`  Total MC trades: ${mcS.n}  sum=${mcS.sum.toFixed(0)} pts  $${(mcS.dollar / 1000).toFixed(1)}k  WR=${mcS.wr.toFixed(1)}%`);
const mcByHour = new Map();
for (const t of mc) {
  const h = etHour(t.entryTime);
  if (!mcByHour.has(h)) mcByHour.set(h, []);
  mcByHour.get(h).push(t);
}
emit(`  Entry hour breakdown:`);
emit(`    ${'hr'.padStart(3)}  ${'n'.padStart(5)}  ${'sum pts'.padStart(9)}  ${'$'.padStart(9)}  ${'avg pts'.padStart(8)}`);
for (const h of [...mcByHour.keys()].sort((a, b) => a - b)) {
  const s = summarize(mcByHour.get(h));
  emit(`    ${String(h).padStart(3)}  ${String(s.n).padStart(5)}  ${s.sum.toFixed(0).padStart(9)}  $${(s.dollar / 1000).toFixed(1).padStart(7)}k  ${s.avg.toFixed(2).padStart(8)}`);
}

// ----- Cutoff surface: PnL if we drop entries at hour >= X -----
emit(`\n--- Entry-cutoff surface (drop entries at ET hour >= X) ---`);
emit(`  Broker constraint: no positions 16:45-17:59 ET; new positions only after 18:00 ET.`);
emit(`  Engine currently force-closes at session "market close" (default 17:00 ET).`);
emit(`  ${'cutoff'.padStart(7)}  ${'n kept'.padStart(7)}  ${'sum pts'.padStart(9)}  ${'$'.padStart(9)}  ${'PF'.padStart(6)}  ${'WR'.padStart(5)}  ${'avg'.padStart(7)}`);
for (let cutoff = 11; cutoff <= 18; cutoff++) {
  const kept = trades.filter(t => {
    if (t.status !== 'completed' || t.entryTime == null) return false;
    return etHour(t.entryTime) < cutoff;
  });
  const s = summarize(kept);
  emit(`  ${String(cutoff).padStart(5)}:00  ${String(s.n).padStart(7)}  ${s.sum.toFixed(0).padStart(9)}  $${(s.dollar / 1000).toFixed(1).padStart(7)}k  ${s.pf.toFixed(2).padStart(6)}  ${s.wr.toFixed(1).padStart(5)}  ${s.avg.toFixed(2).padStart(7)}`);
}

// Also test asymmetric blocks: keep evening session but drop bad hours
emit(`\n--- Block specific entry hours (and keep all others) ---`);
function noBlock(t) { return true; }
function blockHours(hrs) {
  return t => !hrs.includes(etHour(t.entryTime));
}
const blocks = [
  { name: 'baseline (none blocked)', fn: noBlock },
  { name: 'block 16 (4-5 PM ET)', fn: blockHours([16]) },
  { name: 'block 15,16 (3-5 PM ET)', fn: blockHours([15, 16]) },
  { name: 'block 14,15,16 (2-5 PM ET)', fn: blockHours([14, 15, 16]) },
  { name: 'block 16,17 (4-6 PM ET)', fn: blockHours([16, 17]) },
];
emit(`  ${'block'.padEnd(32)}  ${'n'.padStart(5)}  ${'sum pts'.padStart(9)}  ${'$'.padStart(9)}  ${'PF'.padStart(6)}  ${'WR'.padStart(5)}`);
for (const b of blocks) {
  const kept = trades.filter(t => t.status === 'completed' && t.entryTime != null && b.fn(t));
  const s = summarize(kept);
  emit(`  ${b.name.padEnd(32)}  ${String(s.n).padStart(5)}  ${s.sum.toFixed(0).padStart(9)}  $${(s.dollar / 1000).toFixed(1).padStart(7)}k  ${s.pf.toFixed(2).padStart(6)}  ${s.wr.toFixed(1).padStart(5)}`);
}

// ----- H1/H2 stability -----
const SPLIT_TS = new Date('2025-09-15T00:00:00Z').getTime();
emit(`\n--- H1/H2 stability by entry hour (split at 2025-09-15) ---`);
emit(`  ${'hr'.padStart(3)}  ${'H1 n'.padStart(5)}  ${'H1 sum'.padStart(7)}  ${'H1 PF'.padStart(6)}   ${'H2 n'.padStart(5)}  ${'H2 sum'.padStart(7)}  ${'H2 PF'.padStart(6)}`);
for (const h of hours) {
  const arr = byEntryHour.get(h);
  const h1 = summarize(arr.filter(t => t.entryTime < SPLIT_TS));
  const h2 = summarize(arr.filter(t => t.entryTime >= SPLIT_TS));
  emit(`  ${String(h).padStart(3)}  ${String(h1.n).padStart(5)}  ${h1.sum.toFixed(0).padStart(7)}  ${h1.pf.toFixed(2).padStart(6)}   ${String(h2.n).padStart(5)}  ${h2.sum.toFixed(0).padStart(7)}  ${h2.pf.toFixed(2).padStart(6)}`);
}

// ----- Curated entry windows -----
emit(`\n--- Curated entry-window proposals (broker-aware) ---`);
emit(`  All assume no positions held 16:45-17:59 ET (broker constraint).`);
const windows = [
  { name: '09:00-15:00 (RTH peak)',   fn: t => { const h = etHour(t.entryTime); return h >= 9 && h < 15; } },
  { name: '09:00-15:30 (RTH+30m)',    fn: t => { const h = etHalf(t.entryTime); return h >= 9 && h < 15.5; } },
  { name: '09:00-16:00 (RTH full)',   fn: t => { const h = etHour(t.entryTime); return h >= 9 && h < 16; } },
  { name: '08:00-15:30',              fn: t => { const h = etHalf(t.entryTime); return h >= 8 && h < 15.5; } },
  { name: '03:00-15:30 (EU+RTH)',     fn: t => { const h = etHalf(t.entryTime); return h >= 3 && h < 15.5; } },
  { name: '03:00-15:30 + 18-20 ET',   fn: t => { const h = etHalf(t.entryTime); return (h >= 3 && h < 15.5) || (h >= 18 && h < 20); } },
  { name: '03:00-15:30, no 05 ET',    fn: t => { const h = etHalf(t.entryTime); return (h >= 3 && h < 5) || (h >= 6 && h < 15.5); } },
  { name: '09:30-15:30 (cash session)', fn: t => { const h = etHalf(t.entryTime); return h >= 9.5 && h < 15.5; } },
];
emit(`  ${'window'.padEnd(36)}  ${'n'.padStart(5)}  ${'sum pts'.padStart(9)}  ${'$'.padStart(9)}  ${'PF'.padStart(6)}  ${'WR'.padStart(5)}`);
for (const w of windows) {
  const kept = trades.filter(t => t.status === 'completed' && t.entryTime != null && w.fn(t));
  const s = summarize(kept);
  emit(`  ${w.name.padEnd(36)}  ${String(s.n).padStart(5)}  ${s.sum.toFixed(0).padStart(9)}  $${(s.dollar / 1000).toFixed(1).padStart(7)}k  ${s.pf.toFixed(2).padStart(6)}  ${s.wr.toFixed(1).padStart(5)}`);
}

fs.writeFileSync(OUT, out.join('\n'));
console.log(`\nWritten: ${OUT}`);
