/**
 * Analyze high-IV (>30%) trades from the IV-SKEW-GEX baseline to find
 * differentiating factors between winners and losers.
 */
import fs from 'fs';

const results = JSON.parse(fs.readFileSync('results/iv-skew-gex-iv1m.json', 'utf8'));
const rawTrades = results.trades;

// Flatten signal fields up for easier access
const trades = rawTrades.map(t => ({
  ...t,
  ivValue: t.signal?.ivValue,
  ivSkew: t.signal?.ivSkew,
  callIV: t.signal?.callIV,
  putIV: t.signal?.putIV,
  levelType: t.signal?.levelType,
  levelDistance: t.signal?.levelDistance,
  levelCategory: t.signal?.levelCategory,
  entryTimeStr: new Date(t.entryTime).toISOString(),
}));

// Filter to high-IV trades (>0.30)
const highIV = trades.filter(t => t.ivValue > 0.30);
const winners = highIV.filter(t => t.netPnL > 0);
const losers = highIV.filter(t => t.netPnL <= 0);

console.log(`\n=== HIGH IV (>30%) TRADE ANALYSIS ===`);
console.log(`Total high-IV trades: ${highIV.length}`);
console.log(`Winners: ${winners.length} (${(winners.length/highIV.length*100).toFixed(1)}%)`);
console.log(`Losers: ${losers.length} (${(losers.length/highIV.length*100).toFixed(1)}%)`);
console.log(`Total P&L: $${highIV.reduce((s,t) => s + t.netPnL, 0).toFixed(0)}`);
console.log(`Winners P&L: $${winners.reduce((s,t) => s + t.netPnL, 0).toFixed(0)}`);
console.log(`Losers P&L: $${losers.reduce((s,t) => s + t.netPnL, 0).toFixed(0)}`);

// Helper
const avg = (arr) => arr.length ? arr.reduce((s,v) => s+v, 0) / arr.length : 0;
const median = (arr) => {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a,b) => a-b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid-1] + sorted[mid]) / 2;
};

// 1. Side (long vs short)
console.log(`\n--- BY SIDE ---`);
for (const side of ['long', 'short']) {
  const subset = highIV.filter(t => t.side === side);
  const w = subset.filter(t => t.netPnL > 0);
  console.log(`${side.toUpperCase()}: ${subset.length} trades, WR=${(w.length/subset.length*100).toFixed(1)}%, ` +
    `P&L=$${subset.reduce((s,t) => s+t.netPnL, 0).toFixed(0)}, ` +
    `Avg=$${avg(subset.map(t=>t.netPnL)).toFixed(0)}`);
}

// 2. IV level (binned)
console.log(`\n--- BY IV BUCKET ---`);
const ivBuckets = [
  { label: '30-32%', min: 0.30, max: 0.32 },
  { label: '32-35%', min: 0.32, max: 0.35 },
  { label: '35-40%', min: 0.35, max: 0.40 },
  { label: '40%+', min: 0.40, max: 1.0 },
];
for (const b of ivBuckets) {
  const subset = highIV.filter(t => t.ivValue >= b.min && t.ivValue < b.max);
  if (!subset.length) continue;
  const w = subset.filter(t => t.netPnL > 0);
  const stops = subset.filter(t => t.exitReason === 'stop_loss');
  console.log(`${b.label}: ${subset.length} trades, WR=${(w.length/subset.length*100).toFixed(1)}%, ` +
    `StopRate=${(stops.length/subset.length*100).toFixed(1)}%, ` +
    `P&L=$${subset.reduce((s,t) => s+t.netPnL, 0).toFixed(0)}, ` +
    `Avg=$${avg(subset.map(t=>t.netPnL)).toFixed(0)}`);
}

// 3. Skew magnitude
console.log(`\n--- BY SKEW MAGNITUDE (absolute) ---`);
const skewBuckets = [
  { label: '1-2%', min: 0.01, max: 0.02 },
  { label: '2-3%', min: 0.02, max: 0.03 },
  { label: '3-5%', min: 0.03, max: 0.05 },
  { label: '5%+', min: 0.05, max: 1.0 },
];
for (const b of skewBuckets) {
  const subset = highIV.filter(t => Math.abs(t.ivSkew) >= b.min && Math.abs(t.ivSkew) < b.max);
  if (!subset.length) continue;
  const w = subset.filter(t => t.netPnL > 0);
  console.log(`|skew| ${b.label}: ${subset.length} trades, WR=${(w.length/subset.length*100).toFixed(1)}%, ` +
    `P&L=$${subset.reduce((s,t) => s+t.netPnL, 0).toFixed(0)}, ` +
    `Avg=$${avg(subset.map(t=>t.netPnL)).toFixed(0)}`);
}

// 4. GEX Level Type
console.log(`\n--- BY GEX LEVEL TYPE ---`);
const levelTypes = {};
for (const t of highIV) {
  const lt = t.levelType || 'unknown';
  if (!levelTypes[lt]) levelTypes[lt] = [];
  levelTypes[lt].push(t);
}
for (const [lt, subset] of Object.entries(levelTypes).sort((a,b) => b[1].length - a[1].length)) {
  const w = subset.filter(t => t.netPnL > 0);
  console.log(`${lt}: ${subset.length} trades, WR=${(w.length/subset.length*100).toFixed(1)}%, ` +
    `P&L=$${subset.reduce((s,t) => s+t.netPnL, 0).toFixed(0)}, ` +
    `Avg=$${avg(subset.map(t=>t.netPnL)).toFixed(0)}`);
}

// 5. Level distance
console.log(`\n--- BY LEVEL DISTANCE ---`);
const distBuckets = [
  { label: '0-5 pts', min: 0, max: 5 },
  { label: '5-10 pts', min: 5, max: 10 },
  { label: '10-15 pts', min: 10, max: 15 },
  { label: '15-25 pts', min: 15, max: 25 },
];
for (const b of distBuckets) {
  const subset = highIV.filter(t => t.levelDistance >= b.min && t.levelDistance < b.max);
  if (!subset.length) continue;
  const w = subset.filter(t => t.netPnL > 0);
  console.log(`Dist ${b.label}: ${subset.length} trades, WR=${(w.length/subset.length*100).toFixed(1)}%, ` +
    `P&L=$${subset.reduce((s,t) => s+t.netPnL, 0).toFixed(0)}, ` +
    `Avg=$${avg(subset.map(t=>t.netPnL)).toFixed(0)}`);
}

// 6. GEX regime
console.log(`\n--- BY GEX REGIME ---`);
const regimes = {};
for (const t of highIV) {
  const r = t.gexRegime || 'unknown';
  if (!regimes[r]) regimes[r] = [];
  regimes[r].push(t);
}
for (const [r, subset] of Object.entries(regimes).sort((a,b) => b[1].length - a[1].length)) {
  const w = subset.filter(t => t.netPnL > 0);
  console.log(`${r}: ${subset.length} trades, WR=${(w.length/subset.length*100).toFixed(1)}%, ` +
    `P&L=$${subset.reduce((s,t) => s+t.netPnL, 0).toFixed(0)}, ` +
    `Avg=$${avg(subset.map(t=>t.netPnL)).toFixed(0)}`);
}

// 7. Hour of day
console.log(`\n--- BY HOUR (EST) ---`);
const hourBuckets = {};
for (const t of highIV) {
  const d = new Date(t.entryTime);
  const h = parseInt(d.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
  if (!hourBuckets[h]) hourBuckets[h] = [];
  hourBuckets[h].push(t);
}
for (const [h, subset] of Object.entries(hourBuckets).sort((a,b) => a[0]-b[0])) {
  const w = subset.filter(t => t.netPnL > 0);
  console.log(`${h}:00: ${subset.length} trades, WR=${(w.length/subset.length*100).toFixed(1)}%, ` +
    `P&L=$${subset.reduce((s,t) => s+t.netPnL, 0).toFixed(0)}, ` +
    `Avg=$${avg(subset.map(t=>t.netPnL)).toFixed(0)}`);
}

// 8. MFE/MAE ratio
console.log(`\n--- MFE/MAE COMPARISON ---`);
console.log(`Winners: avg MFE=${avg(winners.map(t=>t.mfePoints)).toFixed(1)}, avg MAE=${avg(winners.map(t=>t.maePoints)).toFixed(1)}`);
console.log(`Losers:  avg MFE=${avg(losers.map(t=>t.mfePoints)).toFixed(1)}, avg MAE=${avg(losers.map(t=>t.maePoints)).toFixed(1)}`);

// 9. Exit reason breakdown
console.log(`\n--- BY EXIT REASON ---`);
const exits = {};
for (const t of highIV) {
  const r = t.exitReason;
  if (!exits[r]) exits[r] = [];
  exits[r].push(t);
}
for (const [r, subset] of Object.entries(exits).sort((a,b) => b[1].length - a[1].length)) {
  console.log(`${r}: ${subset.length} trades, P&L=$${subset.reduce((s,t) => s+t.netPnL, 0).toFixed(0)}, ` +
    `Avg=$${avg(subset.map(t=>t.netPnL)).toFixed(0)}`);
}

// 10. Skew direction match (does skew direction match side?)
console.log(`\n--- SKEW/SIDE ALIGNMENT ---`);
const aligned = highIV.filter(t =>
  (t.side === 'long' && t.ivSkew < 0) || (t.side === 'short' && t.ivSkew > 0)
);
const misaligned = highIV.filter(t => !aligned.includes(t));
for (const [label, subset] of [['Aligned', aligned], ['Misaligned', misaligned]]) {
  const w = subset.filter(t => t.netPnL > 0);
  console.log(`${label}: ${subset.length} trades, WR=${(w.length/subset.length*100).toFixed(1)}%, ` +
    `P&L=$${subset.reduce((s,t) => s+t.netPnL, 0).toFixed(0)}`);
}

// 11. Combined: side + IV bucket
console.log(`\n--- SIDE x IV BUCKET ---`);
for (const side of ['long', 'short']) {
  for (const b of ivBuckets) {
    const subset = highIV.filter(t => t.side === side && t.ivValue >= b.min && t.ivValue < b.max);
    if (!subset.length) continue;
    const w = subset.filter(t => t.netPnL > 0);
    const stops = subset.filter(t => t.exitReason === 'stop_loss');
    console.log(`${side.toUpperCase()} ${b.label}: ${subset.length} trades, WR=${(w.length/subset.length*100).toFixed(1)}%, ` +
      `StopRate=${(stops.length/subset.length*100).toFixed(1)}%, ` +
      `P&L=$${subset.reduce((s,t) => s+t.netPnL, 0).toFixed(0)}, ` +
      `Avg=$${avg(subset.map(t=>t.netPnL)).toFixed(0)}`);
  }
}

// 12. Duration analysis
console.log(`\n--- DURATION ---`);
const durWin = winners.map(t => t.duration / 60000);
const durLose = losers.map(t => t.duration / 60000);
console.log(`Winners: avg duration=${avg(durWin).toFixed(1)}min, median=${median(durWin).toFixed(1)}min`);
console.log(`Losers:  avg duration=${avg(durLose).toFixed(1)}min, median=${median(durLose).toFixed(1)}min`);

// 13. Profit give-back
console.log(`\n--- PROFIT GIVEBACK ---`);
console.log(`Winners: avg giveback=${avg(winners.map(t=>t.profitGiveBack||0)).toFixed(1)} pts`);
console.log(`Losers:  avg giveback=${avg(losers.map(t=>t.profitGiveBack||0)).toFixed(1)} pts`);

// 14. Date clustering — are high-IV losers clustered in specific periods?
console.log(`\n--- DATE CLUSTERING (losers) ---`);
const loserDates = {};
for (const t of losers) {
  const d = new Date(t.entryTime).toISOString().slice(0, 10);
  if (!loserDates[d]) loserDates[d] = [];
  loserDates[d].push(t);
}
const sortedDates = Object.entries(loserDates).sort((a,b) => b[1].length - a[1].length);
console.log(`Loser trades spread across ${Object.keys(loserDates).length} unique dates`);
console.log(`Top loss-concentrated dates:`);
for (const [date, trades] of sortedDates.slice(0, 10)) {
  const dayAll = highIV.filter(t => new Date(t.entryTime).toISOString().startsWith(date));
  console.log(`  ${date}: ${trades.length} losers / ${dayAll.length} total, ` +
    `day P&L=$${dayAll.reduce((s,t) => s+t.netPnL, 0).toFixed(0)}`);
}

// 15. Winner details — what makes high-IV winners special?
console.log(`\n--- WINNER CHARACTERISTICS ---`);
console.log(`IV range: ${Math.min(...winners.map(t=>t.ivValue)).toFixed(3)} - ${Math.max(...winners.map(t=>t.ivValue)).toFixed(3)}`);
console.log(`Avg IV: ${avg(winners.map(t=>t.ivValue)).toFixed(3)}`);
console.log(`Avg |skew|: ${avg(winners.map(t=>Math.abs(t.ivSkew))).toFixed(4)}`);
console.log(`Avg level dist: ${avg(winners.map(t=>t.levelDistance)).toFixed(1)}`);

console.log(`\n--- LOSER CHARACTERISTICS ---`);
console.log(`IV range: ${Math.min(...losers.map(t=>t.ivValue)).toFixed(3)} - ${Math.max(...losers.map(t=>t.ivValue)).toFixed(3)}`);
console.log(`Avg IV: ${avg(losers.map(t=>t.ivValue)).toFixed(3)}`);
console.log(`Avg |skew|: ${avg(losers.map(t=>Math.abs(t.ivSkew))).toFixed(4)}`);
console.log(`Avg level dist: ${avg(losers.map(t=>t.levelDistance)).toFixed(1)}`);
