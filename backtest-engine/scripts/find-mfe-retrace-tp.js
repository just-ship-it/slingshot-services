#!/usr/bin/env node
/**
 * Find TP-runner trades that match the EXACT pattern Drew wants to see:
 *   1. price reaches >= +140 pt MFE
 *   2. then retraces to <= +X pt (default 20) — near BE but not under
 *   3. then continues to TP at +200
 *
 * Walks 1m bars between entry and exit, tracking the running MFE and
 * detecting the post-MFE retrace.
 *
 *   node scripts/find-mfe-retrace-tp.js [maxRetracePts]
 */

import fs from 'fs';
import readline from 'readline';
import path from 'path';

const REPO_ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..');
const GOLD_PATH = path.join(REPO_ROOT, 'data', 'gold-standard', 'gex-flip-ivpct-tight-s60t200be70.json');
const OHLCV_PATH = path.join(REPO_ROOT, 'data', 'ohlcv', 'nq', 'NQ_ohlcv_1m.csv');

const MAX_RETRACE = Number(process.argv[2] ?? 20);  // pts above entry (or below for short)
const MFE_TRIGGER = 140;
const TP_FLOOR = 195;   // pointsPnL threshold for TP hit

const gold = JSON.parse(fs.readFileSync(GOLD_PATH, 'utf8'));

// Pre-filter: TP exits with MFE >= 140
const candidates = gold.trades.filter(t =>
  t.pointsPnL >= TP_FLOOR && t.mfePoints >= MFE_TRIGGER
);
console.log(`Pre-filter (TP + MFE>=140): ${candidates.length} candidates`);

if (candidates.length === 0) process.exit(0);

const tMin = Math.min(...candidates.map(t => t.entryTime));
const tMax = Math.max(...candidates.map(t => t.exitTime));
const lowerMs = tMin - 60_000;
const upperMs = tMax + 60_000;

console.log(`Loading 1m OHLCV from ${new Date(lowerMs).toISOString()} → ${new Date(upperMs).toISOString()}…`);

async function loadPrimaryBars() {
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
      if (symbol.includes('-')) return;
      const ts = Date.parse(parts[0]);
      if (Number.isNaN(ts) || ts < lowerMs || ts > upperMs) return;
      allBars.push({
        ts,
        open: +parts[4], high: +parts[5], low: +parts[6], close: +parts[7],
        volume: +parts[8], symbol,
      });
      const hk = Math.floor(ts / 3_600_000);
      if (!hourVolumes.has(hk)) hourVolumes.set(hk, new Map());
      const m = hourVolumes.get(hk);
      m.set(symbol, (m.get(symbol) || 0) + (+parts[8] || 0));
    });
    rl.on('error', reject);
    rl.on('close', resolve);
  });

  const primary = new Map();
  for (const [hk, m] of hourVolumes.entries()) {
    let best = '', bv = -1;
    for (const [s, v] of m.entries()) if (v > bv) { bv = v; best = s; }
    primary.set(hk, best);
  }
  return allBars
    .filter(b => primary.get(Math.floor(b.ts / 3_600_000)) === b.symbol)
    .sort((a, b) => a.ts - b.ts);
}

function classifyTrade(trade, bars) {
  const entry = trade.actualEntry;
  const isShort = trade.side === 'short';
  // Best favorable P&L in this bar (use bar.low for short, bar.high for long)
  const barMFE = (b) => isShort ? entry - b.low : b.high - entry;
  // Worst favorable P&L in this bar (closest to entry — bar.high for short, bar.low for long)
  const barFavMin = (b) => isShort ? entry - b.high : b.low - entry;

  const tradeBars = bars.filter(b => b.ts >= trade.entryTime && b.ts <= trade.exitTime + 60_000);
  if (tradeBars.length === 0) return null;

  let mfe140BarIdx = -1;
  for (let i = 0; i < tradeBars.length; i++) {
    if (barMFE(tradeBars[i]) >= MFE_TRIGGER) { mfe140BarIdx = i; break; }
  }
  if (mfe140BarIdx < 0) return null; // Never actually reached MFE 140 (rare — mfePoints aggregate could mismatch)

  // After mfe140BarIdx, find the worst favorable P&L (closest to entry)
  let postRetraceMin = Infinity;
  let postRetraceMinBarIdx = -1;
  for (let i = mfe140BarIdx + 1; i < tradeBars.length; i++) {
    const m = barFavMin(tradeBars[i]);
    if (m < postRetraceMin) { postRetraceMin = m; postRetraceMinBarIdx = i; }
  }
  if (postRetraceMinBarIdx < 0) return null; // MFE happened on the last bar

  // True MFE peak across the whole trade
  let truePeak = 0, truePeakBarIdx = -1;
  for (let i = 0; i < tradeBars.length; i++) {
    const m = barMFE(tradeBars[i]);
    if (m > truePeak) { truePeak = m; truePeakBarIdx = i; }
  }

  return {
    bars: tradeBars,
    mfe140BarIdx,
    truePeak,
    truePeakBarIdx,
    postRetraceMin,
    postRetraceMinBarIdx,
    barMinutes: tradeBars.length,
  };
}

(async () => {
  const bars = await loadPrimaryBars();
  console.log(`Loaded ${bars.length} primary 1m bars`);

  const matches = [];
  for (const t of candidates) {
    const c = classifyTrade(t, bars);
    if (!c) continue;
    // Filter: post-MFE retrace got within MAX_RETRACE pts of entry
    if (c.postRetraceMin <= MAX_RETRACE && c.postRetraceMin >= -10) {
      matches.push({ trade: t, ...c });
    }
  }

  console.log(`\n${matches.length} trades match: MFE>=${MFE_TRIGGER}pt → retraced to within +${MAX_RETRACE}pt → TP`);
  console.log('');
  console.log('id      side  entry      MFE-peak   retrace-min  giveback   bars  retrace-bar/peak-bar');
  console.log('-'.repeat(96));
  for (const m of matches.sort((a, b) => a.postRetraceMin - b.postRetraceMin).slice(0, 40)) {
    const t = m.trade;
    const giveback = (m.truePeak - m.postRetraceMin).toFixed(1);
    console.log(
      `${t.id.padEnd(8)}${t.side.padEnd(6)}${String(t.actualEntry).padStart(10)}` +
      `   +${m.truePeak.toFixed(1).padStart(6)}      +${m.postRetraceMin.toFixed(1).padStart(5)}        ${giveback.padStart(6)}` +
      `   ${String(m.barMinutes).padStart(4)}  ${m.postRetraceMinBarIdx}/${m.truePeakBarIdx}`
    );
  }
})().catch(err => { console.error(err); process.exit(1); });
