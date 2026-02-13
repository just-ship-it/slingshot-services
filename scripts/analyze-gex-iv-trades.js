import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// ─── Paths ───────────────────────────────────────────────────────────────────
const RESULTS_PATH = join(import.meta.dirname, '..', 'backtest-engine', 'results', 'iv-skew-gex-90.json');
const GEX_DIR = join(import.meta.dirname, '..', 'backtest-engine', 'data', 'gex', 'nq');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtB(v) {
  if (v == null || isNaN(v)) return 'N/A';
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  return `${sign}$${abs.toFixed(0)}`;
}

function fmtPct(v, decimals = 2) {
  if (v == null || isNaN(v)) return 'N/A';
  return `${(v * 100).toFixed(decimals)}%`;
}

function fmtDollar(v) {
  if (v == null || isNaN(v)) return 'N/A';
  return `$${v.toFixed(2)}`;
}

function fmtNum(v, decimals = 2) {
  if (v == null || isNaN(v)) return 'N/A';
  return v.toFixed(decimals);
}

function median(arr) {
  if (!arr.length) return NaN;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(arr) {
  if (!arr.length) return NaN;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stddev(arr) {
  if (arr.length < 2) return NaN;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}

function pad(str, len, align = 'right') {
  str = String(str);
  if (align === 'right') return str.padStart(len);
  return str.padEnd(len);
}

function hr(char = '-', len = 100) {
  console.log(char.repeat(len));
}

function section(title) {
  console.log('');
  hr('=');
  console.log(`  ${title}`);
  hr('=');
}

// Convert ms timestamp to Eastern date string YYYY-MM-DD
function toEasternDate(timestampMs) {
  const d = new Date(timestampMs);
  // Format in America/New_York timezone
  const parts = d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // en-CA gives YYYY-MM-DD
  return parts;
}

function toEasternDateTime(timestampMs) {
  const d = new Date(timestampMs);
  return d.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
}

// ─── Load GEX data for a date ────────────────────────────────────────────────

const gexCache = new Map();

function loadGexForDate(dateStr) {
  if (gexCache.has(dateStr)) return gexCache.get(dateStr);

  const filePath = join(GEX_DIR, `nq_gex_${dateStr}.json`);
  if (!existsSync(filePath)) {
    gexCache.set(dateStr, null);
    return null;
  }

  const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
  const snapshots = (raw.data || []).map(s => ({
    timestamp: new Date(s.timestamp).getTime(),
    total_gex: s.total_gex,
    regime: s.regime,
  }));
  // Sort ascending by timestamp
  snapshots.sort((a, b) => a.timestamp - b.timestamp);
  gexCache.set(dateStr, snapshots);
  return snapshots;
}

// Find the snapshot closest to but not after entryTimeMs
function findGexSnapshot(entryTimeMs) {
  const dateStr = toEasternDate(entryTimeMs);
  const snapshots = loadGexForDate(dateStr);
  if (!snapshots || !snapshots.length) return null;

  let best = null;
  for (const snap of snapshots) {
    if (snap.timestamp <= entryTimeMs) {
      best = snap;
    } else {
      break; // sorted ascending, no point continuing
    }
  }
  return best;
}

// ─── Main ────────────────────────────────────────────────────────────────────

const results = JSON.parse(readFileSync(RESULTS_PATH, 'utf-8'));
const trades = results.trades;

// Enrich each trade with GEX data at entry
let gexMissCount = 0;
const enriched = [];

for (const trade of trades) {
  const snap = findGexSnapshot(trade.entryTime);
  const entry = {
    ...trade,
    gexAtEntry: snap ? snap.total_gex : null,
    gexRegime: snap ? snap.regime : null,
  };
  if (!snap) gexMissCount++;
  enriched.push(entry);
}

const winners = enriched.filter(t => t.netPnL > 0);
const losers = enriched.filter(t => t.netPnL <= 0);

// ─── SECTION 1: Overall Stats ────────────────────────────────────────────────

section('SECTION 1: Overall Stats');
console.log(`  Total trades:     ${enriched.length}`);
console.log(`  Winners:          ${winners.length}  (${fmtPct(winners.length / enriched.length)})`);
console.log(`  Losers:           ${losers.length}  (${fmtPct(losers.length / enriched.length)})`);
console.log(`  Win rate:         ${fmtPct(winners.length / enriched.length)}`);
console.log(`  Avg PnL (all):    ${fmtDollar(mean(enriched.map(t => t.netPnL)))}`);
console.log(`  Avg PnL (win):    ${fmtDollar(mean(winners.map(t => t.netPnL)))}`);
console.log(`  Avg PnL (loss):   ${fmtDollar(mean(losers.map(t => t.netPnL)))}`);
console.log(`  Total PnL:        ${fmtDollar(enriched.reduce((s, t) => s + t.netPnL, 0))}`);
console.log(`  GEX data missing: ${gexMissCount} trades`);

// ─── SECTION 2: GEX Distribution ────────────────────────────────────────────

section('SECTION 2: GEX Distribution (Winners vs Losers)');

function gexStats(label, arr) {
  const vals = arr.map(t => t.gexAtEntry).filter(v => v != null);
  if (!vals.length) {
    console.log(`  ${label}: No GEX data available`);
    return;
  }
  console.log(`  ${label} (n=${vals.length}):`);
  console.log(`    Min:     ${fmtB(Math.min(...vals))}`);
  console.log(`    Max:     ${fmtB(Math.max(...vals))}`);
  console.log(`    Median:  ${fmtB(median(vals))}`);
  console.log(`    Mean:    ${fmtB(mean(vals))}`);
  console.log(`    Std Dev: ${fmtB(stddev(vals))}`);
}

gexStats('Winners', winners);
console.log('');
gexStats('Losers', losers);

// GEX Buckets
const gexBuckets = [
  { label: '< -4B', min: -Infinity, max: -4e9 },
  { label: '-4B to -3B', min: -4e9, max: -3e9 },
  { label: '-3B to -2B', min: -3e9, max: -2e9 },
  { label: '-2B to -1B', min: -2e9, max: -1e9 },
  { label: '-1B to 0', min: -1e9, max: 0 },
  { label: '0 to 1B', min: 0, max: 1e9 },
  { label: '1B to 2B', min: 1e9, max: 2e9 },
  { label: '2B to 3B', min: 2e9, max: 3e9 },
  { label: '3B to 4B', min: 3e9, max: 4e9 },
  { label: '> 4B', min: 4e9, max: Infinity },
];

console.log('');
console.log('  GEX Bucket Analysis:');
console.log(`  ${'Bucket'.padEnd(16)} ${'Trades'.padStart(7)} ${'Wins'.padStart(6)} ${'Losses'.padStart(7)} ${'WinRate'.padStart(8)} ${'AvgPnL'.padStart(10)} ${'TotalPnL'.padStart(12)}`);
hr('-', 70);

const withGex = enriched.filter(t => t.gexAtEntry != null);

for (const bucket of gexBuckets) {
  const inBucket = withGex.filter(t => t.gexAtEntry >= bucket.min && t.gexAtEntry < bucket.max);
  if (!inBucket.length) {
    console.log(`  ${bucket.label.padEnd(16)} ${pad('0', 7)}`);
    continue;
  }
  const bWins = inBucket.filter(t => t.netPnL > 0).length;
  const bLosses = inBucket.length - bWins;
  const winRate = bWins / inBucket.length;
  const avgPnl = mean(inBucket.map(t => t.netPnL));
  const totalPnl = inBucket.reduce((s, t) => s + t.netPnL, 0);
  console.log(`  ${bucket.label.padEnd(16)} ${pad(inBucket.length, 7)} ${pad(bWins, 6)} ${pad(bLosses, 7)} ${pad(fmtPct(winRate), 8)} ${pad(fmtDollar(avgPnl), 10)} ${pad(fmtDollar(totalPnl), 12)}`);
}

// ─── SECTION 3: IV Skew Distribution ────────────────────────────────────────

section('SECTION 3: IV Skew Distribution (Winners vs Losers)');

function skewStats(label, arr) {
  const vals = arr.map(t => t.signal?.ivSkew).filter(v => v != null);
  if (!vals.length) {
    console.log(`  ${label}: No IV skew data available`);
    return;
  }
  console.log(`  ${label} (n=${vals.length}):`);
  console.log(`    Min:     ${fmtPct(Math.min(...vals))}`);
  console.log(`    Max:     ${fmtPct(Math.max(...vals))}`);
  console.log(`    Median:  ${fmtPct(median(vals))}`);
  console.log(`    Mean:    ${fmtPct(mean(vals))}`);
}

skewStats('Winners', winners);
console.log('');
skewStats('Losers', losers);

// Skew Buckets (by absolute value)
const skewBuckets = [
  { label: '0-1%', min: 0, max: 0.01 },
  { label: '1-2%', min: 0.01, max: 0.02 },
  { label: '2-3%', min: 0.02, max: 0.03 },
  { label: '3-5%', min: 0.03, max: 0.05 },
  { label: '5-10%', min: 0.05, max: 0.10 },
  { label: '>10%', min: 0.10, max: Infinity },
];

console.log('');
console.log('  Absolute IV Skew Bucket Analysis:');
console.log(`  ${'Bucket'.padEnd(10)} ${'Trades'.padStart(7)} ${'Wins'.padStart(6)} ${'Losses'.padStart(7)} ${'WinRate'.padStart(8)} ${'AvgPnL'.padStart(10)} ${'TotalPnL'.padStart(12)} ${'AvgSkew'.padStart(10)}`);
hr('-', 74);

for (const bucket of skewBuckets) {
  const inBucket = enriched.filter(t => {
    const absSkew = Math.abs(t.signal?.ivSkew ?? NaN);
    return absSkew >= bucket.min && absSkew < bucket.max;
  });
  if (!inBucket.length) {
    console.log(`  ${bucket.label.padEnd(10)} ${pad('0', 7)}`);
    continue;
  }
  const bWins = inBucket.filter(t => t.netPnL > 0).length;
  const bLosses = inBucket.length - bWins;
  const winRate = bWins / inBucket.length;
  const avgPnl = mean(inBucket.map(t => t.netPnL));
  const totalPnl = inBucket.reduce((s, t) => s + t.netPnL, 0);
  const avgSkew = mean(inBucket.map(t => Math.abs(t.signal.ivSkew)));
  console.log(`  ${bucket.label.padEnd(10)} ${pad(inBucket.length, 7)} ${pad(bWins, 6)} ${pad(bLosses, 7)} ${pad(fmtPct(winRate), 8)} ${pad(fmtDollar(avgPnl), 10)} ${pad(fmtDollar(totalPnl), 12)} ${pad(fmtPct(avgSkew), 10)}`);
}

// Also break down by skew direction
console.log('');
console.log('  By Skew Direction:');
const negSkew = enriched.filter(t => (t.signal?.ivSkew ?? 0) < 0);
const posSkew = enriched.filter(t => (t.signal?.ivSkew ?? 0) >= 0);
const negWins = negSkew.filter(t => t.netPnL > 0).length;
const posWins = posSkew.filter(t => t.netPnL > 0).length;
console.log(`    Negative skew (puts > calls): ${negSkew.length} trades, WinRate ${fmtPct(negSkew.length ? negWins / negSkew.length : 0)}, AvgPnL ${fmtDollar(mean(negSkew.map(t => t.netPnL)))}`);
console.log(`    Positive skew (calls > puts): ${posSkew.length} trades, WinRate ${fmtPct(posSkew.length ? posWins / posSkew.length : 0)}, AvgPnL ${fmtDollar(mean(posSkew.map(t => t.netPnL)))}`);

// ─── SECTION 4: Combined GEX + Skew Analysis ───────────────────────────────

section('SECTION 4: Combined GEX + Skew Analysis');

function crossTab(label, filterFn) {
  const matching = withGex.filter(filterFn);
  const rest = withGex.filter(t => !filterFn(t));

  if (!matching.length) {
    console.log(`  ${label}: No matching trades`);
    return;
  }

  const mWins = matching.filter(t => t.netPnL > 0).length;
  const rWins = rest.filter(t => t.netPnL > 0).length;

  console.log(`  ${label}:`);
  console.log(`    Matching:  ${matching.length} trades, WinRate ${fmtPct(matching.length ? mWins / matching.length : 0)}, AvgPnL ${fmtDollar(mean(matching.map(t => t.netPnL)))}, TotalPnL ${fmtDollar(matching.reduce((s, t) => s + t.netPnL, 0))}`);
  console.log(`    Rest:      ${rest.length} trades, WinRate ${fmtPct(rest.length ? rWins / rest.length : 0)}, AvgPnL ${fmtDollar(mean(rest.map(t => t.netPnL)))}, TotalPnL ${fmtDollar(rest.reduce((s, t) => s + t.netPnL, 0))}`);
  console.log('');
}

crossTab('|skew| > 5% AND GEX < -2B', t =>
  Math.abs(t.signal?.ivSkew ?? 0) > 0.05 && t.gexAtEntry < -2e9);

crossTab('|skew| > 5% AND GEX < -3B', t =>
  Math.abs(t.signal?.ivSkew ?? 0) > 0.05 && t.gexAtEntry < -3e9);

crossTab('|skew| > 3% AND GEX < -2B', t =>
  Math.abs(t.signal?.ivSkew ?? 0) > 0.03 && t.gexAtEntry < -2e9);

crossTab('|skew| > 3% AND GEX < -3B', t =>
  Math.abs(t.signal?.ivSkew ?? 0) > 0.03 && t.gexAtEntry < -3e9);

crossTab('|skew| > 3% AND GEX < -1B', t =>
  Math.abs(t.signal?.ivSkew ?? 0) > 0.03 && t.gexAtEntry < -1e9);

crossTab('|skew| > 5% AND GEX < 0', t =>
  Math.abs(t.signal?.ivSkew ?? 0) > 0.05 && t.gexAtEntry < 0);

crossTab('|skew| > 3% AND GEX < 0', t =>
  Math.abs(t.signal?.ivSkew ?? 0) > 0.03 && t.gexAtEntry < 0);

crossTab('|skew| > 3% AND GEX > 0 (positive regime)', t =>
  Math.abs(t.signal?.ivSkew ?? 0) > 0.03 && t.gexAtEntry >= 0);

// ─── SECTION 5: Losing Trade Deep Dive ──────────────────────────────────────

section('SECTION 5: Losing Trade Deep Dive');

const sortedLosers = [...losers].sort((a, b) => a.netPnL - b.netPnL); // worst first

console.log(`  Total losing trades: ${sortedLosers.length}`);
console.log('');

// Table header
const cols = [
  { label: '#', w: 4 },
  { label: 'Date/Time (ET)', w: 22 },
  { label: 'Side', w: 6 },
  { label: 'Entry', w: 10 },
  { label: 'PnL', w: 10 },
  { label: 'Pts', w: 7 },
  { label: 'Exit Reason', w: 18 },
  { label: 'ivSkew', w: 9 },
  { label: 'ivValue', w: 9 },
  { label: 'GEX@Entry', w: 12 },
  { label: 'Level', w: 12 },
];

const headerLine = cols.map(c => c.label.padStart(c.w)).join(' ');
console.log(`  ${headerLine}`);
hr('-', headerLine.length + 4);

sortedLosers.forEach((t, i) => {
  const dateET = toEasternDateTime(t.entryTime);
  const gexStr = t.gexAtEntry != null ? fmtB(t.gexAtEntry) : 'N/A';
  const skewStr = t.signal?.ivSkew != null ? fmtPct(t.signal.ivSkew) : 'N/A';
  const ivStr = t.signal?.ivValue != null ? fmtPct(t.signal.ivValue) : 'N/A';
  const levelStr = `${t.signal?.levelType || 'N/A'}`;

  const row = [
    pad(i + 1, cols[0].w),
    pad(dateET, cols[1].w, 'left'),
    pad(t.side, cols[2].w, 'left'),
    pad(fmtNum(t.entryPrice || t.actualEntry, 2), cols[3].w),
    pad(fmtDollar(t.netPnL), cols[4].w),
    pad(fmtNum(t.pointsPnL, 1), cols[5].w),
    pad(t.exitReason || 'N/A', cols[6].w, 'left'),
    pad(skewStr, cols[7].w),
    pad(ivStr, cols[8].w),
    pad(gexStr, cols[9].w),
    pad(levelStr, cols[10].w, 'left'),
  ];
  console.log(`  ${row.join(' ')}`);
});

// Summary of losing trades by exit reason
console.log('');
console.log('  Losing trades by exit reason:');
const exitReasonCounts = {};
for (const t of sortedLosers) {
  const reason = t.exitReason || 'unknown';
  if (!exitReasonCounts[reason]) exitReasonCounts[reason] = { count: 0, totalPnL: 0 };
  exitReasonCounts[reason].count++;
  exitReasonCounts[reason].totalPnL += t.netPnL;
}
for (const [reason, data] of Object.entries(exitReasonCounts).sort((a, b) => a[1].totalPnL - b[1].totalPnL)) {
  console.log(`    ${reason.padEnd(20)} ${pad(data.count, 5)} trades, TotalPnL ${fmtDollar(data.totalPnL)}, AvgPnL ${fmtDollar(data.totalPnL / data.count)}`);
}

// ─── SECTION 6: GEX Regime Analysis ─────────────────────────────────────────

section('SECTION 6: GEX Regime Analysis');

const regimeGroups = {};
for (const t of enriched) {
  const regime = t.gexRegime || 'unknown';
  if (!regimeGroups[regime]) regimeGroups[regime] = [];
  regimeGroups[regime].push(t);
}

console.log(`  ${'Regime'.padEnd(12)} ${'Trades'.padStart(7)} ${'Wins'.padStart(6)} ${'Losses'.padStart(7)} ${'WinRate'.padStart(8)} ${'AvgPnL'.padStart(10)} ${'TotalPnL'.padStart(12)} ${'AvgGEX'.padStart(12)}`);
hr('-', 78);

for (const [regime, trades] of Object.entries(regimeGroups).sort((a, b) => a[0].localeCompare(b[0]))) {
  const rWins = trades.filter(t => t.netPnL > 0).length;
  const rLosses = trades.length - rWins;
  const winRate = rWins / trades.length;
  const avgPnl = mean(trades.map(t => t.netPnL));
  const totalPnl = trades.reduce((s, t) => s + t.netPnL, 0);
  const avgGex = mean(trades.map(t => t.gexAtEntry).filter(v => v != null));
  console.log(`  ${regime.padEnd(12)} ${pad(trades.length, 7)} ${pad(rWins, 6)} ${pad(rLosses, 7)} ${pad(fmtPct(winRate), 8)} ${pad(fmtDollar(avgPnl), 10)} ${pad(fmtDollar(totalPnl), 12)} ${pad(fmtB(avgGex), 12)}`);
}

// Additional regime breakdown by side
console.log('');
console.log('  Regime + Side breakdown:');
console.log(`  ${'Regime'.padEnd(12)} ${'Side'.padEnd(6)} ${'Trades'.padStart(7)} ${'WinRate'.padStart(8)} ${'AvgPnL'.padStart(10)} ${'TotalPnL'.padStart(12)}`);
hr('-', 60);

for (const [regime, trades] of Object.entries(regimeGroups).sort((a, b) => a[0].localeCompare(b[0]))) {
  for (const side of ['long', 'short']) {
    const sideTrades = trades.filter(t => t.side === side);
    if (!sideTrades.length) continue;
    const sWins = sideTrades.filter(t => t.netPnL > 0).length;
    const winRate = sWins / sideTrades.length;
    const avgPnl = mean(sideTrades.map(t => t.netPnL));
    const totalPnl = sideTrades.reduce((s, t) => s + t.netPnL, 0);
    console.log(`  ${regime.padEnd(12)} ${side.padEnd(6)} ${pad(sideTrades.length, 7)} ${pad(fmtPct(winRate), 8)} ${pad(fmtDollar(avgPnl), 10)} ${pad(fmtDollar(totalPnl), 12)}`);
  }
}

console.log('');
hr('=');
console.log('  Analysis complete.');
hr('=');
console.log('');
