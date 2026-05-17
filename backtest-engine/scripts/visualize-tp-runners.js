#!/usr/bin/env node
/**
 * Pull TP-runner trades from a gold-standard JSON and print a per-minute
 * P&L journey using 1m OHLCV. Useful for seeing what "deep MFE → big
 * retrace → eventual TP" actually looks like on the tape.
 *
 * For each selected trade we print:
 *   - bar index (minute since entry)
 *   - timestamp ET
 *   - bar OHLC
 *   - running MFE / MAE from entry
 *   - high-watermark P&L since entry
 *   - low-watermark P&L since entry
 *
 * Trades selected: TP exits (pointsPnL >= 195) with mfePoints >= 140 and
 * maePoints >= 30 — the "ran +140 / retraced toward BE / continued to +200"
 * pattern.
 *
 *   node scripts/visualize-tp-runners.js [tradeId ...]
 */

import fs from 'fs';
import readline from 'readline';
import path from 'path';

const REPO_ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..');
const GOLD_PATH = path.join(REPO_ROOT, 'data', 'gold-standard', 'gex-flip-ivpct-tight-s60t200be70.json');
const OHLCV_PATH = path.join(REPO_ROOT, 'data', 'ohlcv', 'nq', 'NQ_ohlcv_1m.csv');

const gold = JSON.parse(fs.readFileSync(GOLD_PATH, 'utf8'));

const wanted = process.argv.slice(2).filter(s => /^T\d+$/.test(s));
let trades;
if (wanted.length > 0) {
  trades = gold.trades.filter(t => wanted.includes(t.id));
} else {
  // Default: pick 3 representative durations — short, medium, long
  const cands = gold.trades.filter(t =>
    t.pointsPnL >= 195 && t.mfePoints >= 140 && t.maePoints >= 30
  );
  if (cands.length === 0) {
    console.error('No TP-runner candidates found');
    process.exit(1);
  }
  cands.sort((a, b) => a.barsSinceEntry - b.barsSinceEntry);
  // Short, mid, long
  trades = [
    cands[0],
    cands[Math.floor(cands.length / 2)],
    cands[cands.length - 1],
  ];
}

console.log(`Loading 1m OHLCV (this takes ~5 seconds)…`);

async function loadRelevantBars() {
  // Pre-compute time bounds
  const tMin = Math.min(...trades.map(t => t.entryTime));
  const tMax = Math.max(...trades.map(t => t.exitTime));
  const lowerMs = tMin - 60_000;     // 1 min margin
  const upperMs = tMax + 60_000;
  const lower = new Date(lowerMs).toISOString();
  const upper = new Date(upperMs).toISOString();

  const tradeBuckets = new Map(); // tradeId -> Map<hourKey, Set<symbol>>
  // We'll do two passes over the CSV: pass 1 builds per-hour volume map to
  // resolve primary contract per hour; pass 2 collects bars belonging to
  // the primary contract within each trade's window.

  // Pass 1: hour volumes, scoped to candidate time window
  const hourVolumes = new Map();
  const allBars = [];
  await new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: fs.createReadStream(OHLCV_PATH), crlfDelay: Infinity });
    let header = null;
    rl.on('line', (line) => {
      if (!header) { header = line.split(','); return; }
      const parts = line.split(',');
      if (parts.length < 10) return;
      const symbol = parts[9];
      if (symbol.includes('-')) return; // spread row
      const ts = Date.parse(parts[0]);
      if (Number.isNaN(ts) || ts < lowerMs || ts > upperMs) return;
      const open = +parts[4], high = +parts[5], low = +parts[6], close = +parts[7], volume = +parts[8];
      allBars.push({ ts, open, high, low, close, volume, symbol });
      const hk = Math.floor(ts / 3_600_000);
      if (!hourVolumes.has(hk)) hourVolumes.set(hk, new Map());
      const m = hourVolumes.get(hk);
      m.set(symbol, (m.get(symbol) || 0) + (volume || 0));
    });
    rl.on('error', reject);
    rl.on('close', resolve);
  });

  // Resolve primary per hour
  const primary = new Map();
  for (const [hk, m] of hourVolumes.entries()) {
    let best = '', bv = -1;
    for (const [s, v] of m.entries()) if (v > bv) { bv = v; best = s; }
    primary.set(hk, best);
  }

  // Pass 2: keep only primary bars; sort
  const primaryBars = allBars.filter(b => primary.get(Math.floor(b.ts / 3_600_000)) === b.symbol);
  primaryBars.sort((a, b) => a.ts - b.ts);
  return primaryBars;
}

function formatTimeET(ms) {
  const d = new Date(ms);
  // Show in ET (America/New_York). Rough offset: ET = UTC - 5 (EST) or UTC - 4 (EDT).
  // Use toLocaleString with the timezone for accuracy.
  return d.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
}

function renderTrade(trade, bars) {
  // Filter bars to this trade's window
  const tradeBars = bars.filter(b => b.ts >= trade.entryTime && b.ts <= trade.exitTime + 60_000);
  if (tradeBars.length === 0) {
    console.log(`(no bars found for trade ${trade.id})`);
    return;
  }

  const entry = trade.actualEntry;
  const isShort = trade.side === 'short';
  const pnlAt = (price) => isShort ? entry - price : price - entry;

  console.log(`\n${'='.repeat(72)}`);
  console.log(`Trade ${trade.id} ${trade.side.toUpperCase()} entry=${entry} TP target=${entry + (isShort ? -200 : 200)}`);
  console.log(`Reported MFE=${trade.mfePoints}pt MAE=${trade.maePoints}pt realized=${trade.pointsPnL}pt`);
  console.log(`Duration: ${tradeBars.length} bars (${((trade.exitTime - trade.entryTime) / 60000).toFixed(1)} min)`);
  console.log(`${'-'.repeat(72)}`);

  // Track running extremes for visual MFE/MAE markers
  let runningMFE = 0;
  let runningMAE = 0;
  let mfePeakBar = -1;
  let mfePeakValue = 0;

  // First pass: find MFE peak bar
  for (let i = 0; i < tradeBars.length; i++) {
    const b = tradeBars[i];
    const highPnL = pnlAt(isShort ? b.low : b.high);  // best favorable in this bar
    if (highPnL > mfePeakValue) { mfePeakValue = highPnL; mfePeakBar = i; }
  }

  // Header
  console.log(`bar  time (ET)              open      high      low       close     barMFE  barMAE  ==MFE==  ==MAE==  notes`);
  for (let i = 0; i < tradeBars.length; i++) {
    const b = tradeBars[i];
    const barMFE = pnlAt(isShort ? b.low : b.high);    // most favorable in bar
    const barMAE = pnlAt(isShort ? b.high : b.low);    // most adverse in bar
    if (barMFE > runningMFE) runningMFE = barMFE;
    if (barMAE < runningMAE) runningMAE = barMAE;

    // Visual cues
    const notes = [];
    if (i === mfePeakBar) notes.push(`◀── MFE PEAK +${barMFE.toFixed(1)}`);
    if (i > mfePeakBar && barMAE === runningMAE && i > 0) {
      // post-MFE worst retrace point
      // (true if this bar holds the running MAE and we're past peak)
    }
    if (i === tradeBars.length - 1) notes.push(`◀── EXIT at ${trade.actualExit} (${trade.exitReason})`);

    // Decide which P&L bands to highlight
    const flag = barMFE >= 140 && i <= mfePeakBar ? '★' : (i > mfePeakBar && barMAE <= 30 && barMAE > -10 ? '↩' : ' ');

    console.log(
      `${String(i).padStart(3)}  ${formatTimeET(b.ts).padEnd(22)}` +
      ` ${String(b.open).padStart(9)} ${String(b.high).padStart(9)} ${String(b.low).padStart(9)} ${String(b.close).padStart(9)}` +
      ` ${barMFE.toFixed(1).padStart(7)} ${barMAE.toFixed(1).padStart(7)}` +
      ` ${runningMFE.toFixed(1).padStart(8)} ${runningMAE.toFixed(1).padStart(8)}  ${flag} ${notes.join(' ')}`
    );
  }
  console.log(`${'-'.repeat(72)}`);
  console.log(`MFE peak occurred at bar ${mfePeakBar} (${((mfePeakBar / tradeBars.length) * 100).toFixed(0)}% through the trade)`);

  // Identify the post-MFE retrace pattern
  let postPeakMin = Infinity;
  let postPeakMinBar = -1;
  for (let i = mfePeakBar + 1; i < tradeBars.length; i++) {
    const b = tradeBars[i];
    const barFavorable = pnlAt(isShort ? b.high : b.low); // worst favorable (closest to entry / negative)
    if (barFavorable < postPeakMin) { postPeakMin = barFavorable; postPeakMinBar = i; }
  }
  if (postPeakMinBar >= 0) {
    console.log(`After MFE peak: lowest favorable P&L was +${postPeakMin.toFixed(1)}pt at bar ${postPeakMinBar} (${((postPeakMinBar - mfePeakBar))} bars later)`);
    console.log(`  i.e. price retraced from +${mfePeakValue.toFixed(1)}pt MFE down to +${postPeakMin.toFixed(1)}pt (giveback ${(mfePeakValue - postPeakMin).toFixed(1)}pt) before continuing.`);
  }
}

(async () => {
  const bars = await loadRelevantBars();
  console.log(`Loaded ${bars.length} primary-contract 1m bars across the trade windows.`);
  for (const t of trades) {
    renderTrade(t, bars);
  }
})().catch(err => { console.error(err); process.exit(1); });
