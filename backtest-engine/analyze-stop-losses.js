#!/usr/bin/env node
/**
 * Analyze stop loss trades to find patterns in GEX levels, regime, and LT levels
 */

import fs from 'fs';

const filePath = process.argv[2] || './results/gex-pullback-with-trailing-level-filter.json';
const results = JSON.parse(fs.readFileSync(filePath, 'utf8'));

const losers = results.trades.filter(t => t.netPnL < 0);
const winners = results.trades.filter(t => t.netPnL > 0);

console.log('='.repeat(80));
console.log('STOP LOSS ANALYSIS - Finding Patterns in Losing Trades');
console.log('='.repeat(80));
console.log(`\nTotal trades: ${results.trades.length}`);
console.log(`Winners: ${winners.length} (${(winners.length/results.trades.length*100).toFixed(1)}%)`);
console.log(`Losers: ${losers.length} (${(losers.length/results.trades.length*100).toFixed(1)}%)`);

// ============================================================================
// By GEX Entry Level Type
// ============================================================================
console.log('\n' + '='.repeat(80));
console.log('PERFORMANCE BY GEX ENTRY LEVEL TYPE');
console.log('='.repeat(80));

const byLevelType = {};
for (const trade of results.trades) {
  const levelType = trade.signal?.metadata?.entryLevel?.type || trade.metadata?.entryLevel?.type || 'unknown';
  if (!byLevelType[levelType]) byLevelType[levelType] = { winners: [], losers: [] };
  if (trade.netPnL > 0) byLevelType[levelType].winners.push(trade);
  else byLevelType[levelType].losers.push(trade);
}

console.log('\nLevel Type'.padEnd(20) + 'Total'.padEnd(8) + 'Win%'.padEnd(10) + 'Losers'.padEnd(10) + 'Net PnL'.padEnd(14) + 'Avg PnL');
console.log('-'.repeat(75));
const sortedLevelTypes = Object.entries(byLevelType).sort((a, b) => {
  const aWinRate = a[1].winners.length / (a[1].winners.length + a[1].losers.length);
  const bWinRate = b[1].winners.length / (b[1].winners.length + b[1].losers.length);
  return aWinRate - bWinRate;
});

for (const [type, data] of sortedLevelTypes) {
  const total = data.winners.length + data.losers.length;
  const winRate = (data.winners.length / total * 100).toFixed(1);
  const netPnL = [...data.winners, ...data.losers].reduce((s, t) => s + t.netPnL, 0);
  const avgPnL = netPnL / total;
  console.log(
    type.padEnd(20) +
    `${total}`.padEnd(8) +
    `${winRate}%`.padEnd(10) +
    `${data.losers.length}`.padEnd(10) +
    `$${netPnL.toLocaleString()}`.padEnd(14) +
    `$${avgPnL.toFixed(0)}`
  );
}

// ============================================================================
// By GEX Regime at Entry
// ============================================================================
console.log('\n' + '='.repeat(80));
console.log('PERFORMANCE BY GEX REGIME AT ENTRY');
console.log('='.repeat(80));

const byRegime = {};
for (const trade of results.trades) {
  const regime = trade.signal?.metadata?.regime || trade.metadata?.regime || 'unknown';
  if (!byRegime[regime]) byRegime[regime] = { winners: [], losers: [] };
  if (trade.netPnL > 0) byRegime[regime].winners.push(trade);
  else byRegime[regime].losers.push(trade);
}

console.log('\nRegime'.padEnd(20) + 'Total'.padEnd(8) + 'Win%'.padEnd(10) + 'Losers'.padEnd(10) + 'Net PnL'.padEnd(14) + 'Avg PnL');
console.log('-'.repeat(75));
for (const [regime, data] of Object.entries(byRegime).sort((a, b) => {
  const aWinRate = a[1].winners.length / (a[1].winners.length + a[1].losers.length);
  const bWinRate = b[1].winners.length / (b[1].winners.length + b[1].losers.length);
  return aWinRate - bWinRate;
})) {
  const total = data.winners.length + data.losers.length;
  const winRate = (data.winners.length / total * 100).toFixed(1);
  const netPnL = [...data.winners, ...data.losers].reduce((s, t) => s + t.netPnL, 0);
  const avgPnL = netPnL / total;
  console.log(
    regime.padEnd(20) +
    `${total}`.padEnd(8) +
    `${winRate}%`.padEnd(10) +
    `${data.losers.length}`.padEnd(10) +
    `$${netPnL.toLocaleString()}`.padEnd(14) +
    `$${avgPnL.toFixed(0)}`
  );
}

// ============================================================================
// By Side + Regime Combination
// ============================================================================
console.log('\n' + '='.repeat(80));
console.log('PERFORMANCE BY SIDE + REGIME COMBINATION');
console.log('='.repeat(80));

const bySideRegime = {};
for (const trade of results.trades) {
  const side = trade.side?.toUpperCase() || 'UNKNOWN';
  const regime = trade.signal?.metadata?.regime || trade.metadata?.regime || 'unknown';
  const key = `${side} in ${regime}`;
  if (!bySideRegime[key]) bySideRegime[key] = { winners: [], losers: [] };
  if (trade.netPnL > 0) bySideRegime[key].winners.push(trade);
  else bySideRegime[key].losers.push(trade);
}

console.log('\nSide + Regime'.padEnd(30) + 'Total'.padEnd(8) + 'Win%'.padEnd(10) + 'Losers'.padEnd(10) + 'Net PnL'.padEnd(14) + 'Avg PnL');
console.log('-'.repeat(85));
for (const [key, data] of Object.entries(bySideRegime).sort((a, b) => {
  const aWinRate = a[1].winners.length / (a[1].winners.length + a[1].losers.length);
  const bWinRate = b[1].winners.length / (b[1].winners.length + b[1].losers.length);
  return aWinRate - bWinRate;
})) {
  const total = data.winners.length + data.losers.length;
  if (total < 3) continue;
  const winRate = (data.winners.length / total * 100).toFixed(1);
  const netPnL = [...data.winners, ...data.losers].reduce((s, t) => s + t.netPnL, 0);
  const avgPnL = netPnL / total;
  console.log(
    key.padEnd(30) +
    `${total}`.padEnd(8) +
    `${winRate}%`.padEnd(10) +
    `${data.losers.length}`.padEnd(10) +
    `$${netPnL.toLocaleString()}`.padEnd(14) +
    `$${avgPnL.toFixed(0)}`
  );
}

// ============================================================================
// By Side + Level Type Combination
// ============================================================================
console.log('\n' + '='.repeat(80));
console.log('PERFORMANCE BY SIDE + LEVEL TYPE COMBINATION');
console.log('='.repeat(80));

const bySideLevel = {};
for (const trade of results.trades) {
  const side = trade.side?.toUpperCase() || 'UNKNOWN';
  const levelType = trade.signal?.metadata?.entryLevel?.type || trade.metadata?.entryLevel?.type || 'unknown';
  const key = `${side} @ ${levelType}`;
  if (!bySideLevel[key]) bySideLevel[key] = { winners: [], losers: [] };
  if (trade.netPnL > 0) bySideLevel[key].winners.push(trade);
  else bySideLevel[key].losers.push(trade);
}

console.log('\nSide + Level'.padEnd(30) + 'Total'.padEnd(8) + 'Win%'.padEnd(10) + 'Losers'.padEnd(10) + 'Net PnL'.padEnd(14) + 'Avg PnL');
console.log('-'.repeat(85));
for (const [key, data] of Object.entries(bySideLevel).sort((a, b) => {
  const aWinRate = a[1].winners.length / (a[1].winners.length + a[1].losers.length);
  const bWinRate = b[1].winners.length / (b[1].winners.length + b[1].losers.length);
  return aWinRate - bWinRate;
})) {
  const total = data.winners.length + data.losers.length;
  if (total < 3) continue;
  const winRate = (data.winners.length / total * 100).toFixed(1);
  const netPnL = [...data.winners, ...data.losers].reduce((s, t) => s + t.netPnL, 0);
  const avgPnL = netPnL / total;
  console.log(
    key.padEnd(30) +
    `${total}`.padEnd(8) +
    `${winRate}%`.padEnd(10) +
    `${data.losers.length}`.padEnd(10) +
    `$${netPnL.toLocaleString()}`.padEnd(14) +
    `$${avgPnL.toFixed(0)}`
  );
}

// ============================================================================
// By Confirmation Type
// ============================================================================
console.log('\n' + '='.repeat(80));
console.log('PERFORMANCE BY CONFIRMATION TYPE');
console.log('='.repeat(80));

const byConfirmation = {};
for (const trade of results.trades) {
  const confType = trade.signal?.metadata?.confirmationType || trade.metadata?.confirmationType || 'unknown';
  if (!byConfirmation[confType]) byConfirmation[confType] = { winners: [], losers: [] };
  if (trade.netPnL > 0) byConfirmation[confType].winners.push(trade);
  else byConfirmation[confType].losers.push(trade);
}

console.log('\nConfirmation'.padEnd(25) + 'Total'.padEnd(8) + 'Win%'.padEnd(10) + 'Losers'.padEnd(10) + 'Net PnL'.padEnd(14) + 'Avg PnL');
console.log('-'.repeat(80));
for (const [type, data] of Object.entries(byConfirmation).sort((a, b) => {
  const aWinRate = a[1].winners.length / (a[1].winners.length + a[1].losers.length);
  const bWinRate = b[1].winners.length / (b[1].winners.length + b[1].losers.length);
  return aWinRate - bWinRate;
})) {
  const total = data.winners.length + data.losers.length;
  const winRate = (data.winners.length / total * 100).toFixed(1);
  const netPnL = [...data.winners, ...data.losers].reduce((s, t) => s + t.netPnL, 0);
  const avgPnL = netPnL / total;
  console.log(
    type.padEnd(25) +
    `${total}`.padEnd(8) +
    `${winRate}%`.padEnd(10) +
    `${data.losers.length}`.padEnd(10) +
    `$${netPnL.toLocaleString()}`.padEnd(14) +
    `$${avgPnL.toFixed(0)}`
  );
}

// ============================================================================
// By Risk/Reward Ratio at Entry
// ============================================================================
console.log('\n' + '='.repeat(80));
console.log('PERFORMANCE BY RISK/REWARD RATIO AT ENTRY');
console.log('='.repeat(80));

const byRR = {};
for (const trade of results.trades) {
  const rr = trade.signal?.metadata?.riskRewardRatio || trade.metadata?.riskRewardRatio || 0;
  let bucket;
  if (rr < 1.0) bucket = 'RR < 1.0';
  else if (rr < 1.5) bucket = 'RR 1.0-1.5';
  else if (rr < 2.0) bucket = 'RR 1.5-2.0';
  else if (rr < 3.0) bucket = 'RR 2.0-3.0';
  else bucket = 'RR 3.0+';

  if (!byRR[bucket]) byRR[bucket] = { winners: [], losers: [] };
  if (trade.netPnL > 0) byRR[bucket].winners.push(trade);
  else byRR[bucket].losers.push(trade);
}

console.log('\nR:R Bucket'.padEnd(15) + 'Total'.padEnd(8) + 'Win%'.padEnd(10) + 'Losers'.padEnd(10) + 'Net PnL'.padEnd(14) + 'Avg PnL');
console.log('-'.repeat(70));
for (const [bucket, data] of Object.entries(byRR)) {
  const total = data.winners.length + data.losers.length;
  if (total === 0) continue;
  const winRate = (data.winners.length / total * 100).toFixed(1);
  const netPnL = [...data.winners, ...data.losers].reduce((s, t) => s + t.netPnL, 0);
  const avgPnL = netPnL / total;
  console.log(
    bucket.padEnd(15) +
    `${total}`.padEnd(8) +
    `${winRate}%`.padEnd(10) +
    `${data.losers.length}`.padEnd(10) +
    `$${netPnL.toLocaleString()}`.padEnd(14) +
    `$${avgPnL.toFixed(0)}`
  );
}

// ============================================================================
// By Hour of Day
// ============================================================================
console.log('\n' + '='.repeat(80));
console.log('PERFORMANCE BY HOUR OF DAY (UTC)');
console.log('='.repeat(80));

const byHour = {};
for (const trade of results.trades) {
  const hour = new Date(trade.entryTime || trade.timestamp).getUTCHours();
  if (!byHour[hour]) byHour[hour] = { winners: [], losers: [] };
  if (trade.netPnL > 0) byHour[hour].winners.push(trade);
  else byHour[hour].losers.push(trade);
}

console.log('\nHour (UTC)'.padEnd(12) + 'Total'.padEnd(8) + 'Win%'.padEnd(10) + 'Losers'.padEnd(10) + 'Net PnL'.padEnd(14) + 'Session');
console.log('-'.repeat(70));
for (let h = 0; h < 24; h++) {
  const data = byHour[h];
  if (!data) continue;
  const total = data.winners.length + data.losers.length;
  if (total === 0) continue;
  const winRate = (data.winners.length / total * 100).toFixed(1);
  const netPnL = [...data.winners, ...data.losers].reduce((s, t) => s + t.netPnL, 0);
  const session = h >= 14 && h < 21 ? 'RTH' : h >= 21 || h < 4 ? 'Overnight' : 'Pre-market';
  console.log(
    `${h.toString().padStart(2, '0')}:00`.padEnd(12) +
    `${total}`.padEnd(8) +
    `${winRate}%`.padEnd(10) +
    `${data.losers.length}`.padEnd(10) +
    `$${netPnL.toLocaleString()}`.padEnd(14) +
    session
  );
}

// ============================================================================
// Worst Performing Combinations
// ============================================================================
console.log('\n' + '='.repeat(80));
console.log('WORST PERFORMING COMBINATIONS (Candidates for Filtering)');
console.log('='.repeat(80));

const byCombo = {};
for (const trade of results.trades) {
  const side = trade.side?.toUpperCase() || 'UNK';
  const levelType = trade.signal?.metadata?.entryLevel?.type || trade.metadata?.entryLevel?.type || 'unk';
  const regime = trade.signal?.metadata?.regime || trade.metadata?.regime || 'unk';
  const key = `${side} @ ${levelType} in ${regime}`;

  if (!byCombo[key]) byCombo[key] = { winners: [], losers: [], trades: [] };
  byCombo[key].trades.push(trade);
  if (trade.netPnL > 0) byCombo[key].winners.push(trade);
  else byCombo[key].losers.push(trade);
}

console.log('\nCombination'.padEnd(50) + 'Total'.padEnd(8) + 'Win%'.padEnd(10) + 'Net PnL'.padEnd(14) + 'Avg Loss');
console.log('-'.repeat(95));

const worstCombos = Object.entries(byCombo)
  .filter(([_, data]) => data.trades.length >= 5)
  .map(([key, data]) => {
    const total = data.trades.length;
    const winRate = data.winners.length / total;
    const netPnL = data.trades.reduce((s, t) => s + t.netPnL, 0);
    const avgLoss = data.losers.length > 0
      ? data.losers.reduce((s, t) => s + t.netPnL, 0) / data.losers.length
      : 0;
    return { key, total, winRate, netPnL, avgLoss, losers: data.losers.length };
  })
  .sort((a, b) => a.netPnL - b.netPnL)
  .slice(0, 15);

for (const combo of worstCombos) {
  console.log(
    combo.key.padEnd(50) +
    `${combo.total}`.padEnd(8) +
    `${(combo.winRate * 100).toFixed(1)}%`.padEnd(10) +
    `$${combo.netPnL.toLocaleString()}`.padEnd(14) +
    `$${combo.avgLoss.toFixed(0)}`
  );
}

// ============================================================================
// Summary Recommendations
// ============================================================================
console.log('\n' + '='.repeat(80));
console.log('FILTER RECOMMENDATIONS');
console.log('='.repeat(80));

const filterCandidates = Object.entries(byCombo)
  .filter(([_, data]) => {
    const total = data.trades.length;
    if (total < 5) return false;
    const winRate = data.winners.length / total;
    const netPnL = data.trades.reduce((s, t) => s + t.netPnL, 0);
    return netPnL < 0 && winRate < 0.35;
  })
  .map(([key, data]) => {
    const total = data.trades.length;
    const winRate = data.winners.length / total;
    const netPnL = data.trades.reduce((s, t) => s + t.netPnL, 0);
    return { key, total, winRate, netPnL };
  })
  .sort((a, b) => a.netPnL - b.netPnL);

console.log('\nPotential filters (negative P&L, <35% win rate, 5+ trades):');
for (const candidate of filterCandidates) {
  console.log(`  - ${candidate.key}: ${candidate.total} trades, ${(candidate.winRate * 100).toFixed(1)}% win, $${candidate.netPnL.toLocaleString()}`);
}

if (filterCandidates.length === 0) {
  console.log('  No clear filter candidates found with current criteria.');
}
