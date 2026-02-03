#!/usr/bin/env node
/**
 * Compare backtest results: Original vs Baseline vs GF Early Exit
 */

import fs from 'fs';

const original = JSON.parse(fs.readFileSync('results/iv-skew-gex-2025.json', 'utf8'));
const baseline = JSON.parse(fs.readFileSync('results/iv-skew-gex-2025-baseline.json', 'utf8'));
const withGF = JSON.parse(fs.readFileSync('results/iv-skew-gex-2025-with-gf-exit.json', 'utf8'));

console.log('═'.repeat(80));
console.log('IV-SKEW-GEX 2025 BACKTEST COMPARISON');
console.log('═'.repeat(80));

const getVal = (d, path) => path.split('.').reduce((o, k) => o?.[k], d);

// Get metrics
const get = (d) => ({
  trades: getVal(d, 'performance.totalTrades') || getVal(d, 'performance.basic.totalTrades'),
  wins: getVal(d, 'performance.winningTrades') || getVal(d, 'performance.basic.winningTrades'),
  losses: getVal(d, 'performance.losingTrades') || getVal(d, 'performance.basic.losingTrades'),
  winRate: getVal(d, 'performance.winRate') || getVal(d, 'performance.basic.winRate'),
  pnl: getVal(d, 'performance.totalPnL') || getVal(d, 'performance.summary.totalPnL'),
  maxDD: getVal(d, 'performance.maxDrawdown') || getVal(d, 'performance.drawdown.maxDrawdown'),
  avgWin: getVal(d, 'performance.averageWin') || getVal(d, 'performance.basic.averageWin'),
  avgLoss: getVal(d, 'performance.averageLoss') || getVal(d, 'performance.basic.averageLoss'),
  pf: getVal(d, 'performance.profitFactor') || getVal(d, 'performance.basic.profitFactor')
});

const orig = get(original);
const base = get(baseline);
const gf = get(withGF);

console.log('\n                          Original     Baseline   GF Early Exit');
console.log('-'.repeat(68));
console.log(`Total Trades:              ${orig.trades.toString().padStart(8)}  ${base.trades.toString().padStart(10)}    ${gf.trades.toString().padStart(10)}`);
console.log(`Winners:                   ${orig.wins.toString().padStart(8)}  ${base.wins.toString().padStart(10)}    ${gf.wins.toString().padStart(10)}`);
console.log(`Losers:                    ${orig.losses.toString().padStart(8)}  ${base.losses.toString().padStart(10)}    ${gf.losses.toString().padStart(10)}`);
console.log(`Win Rate:                  ${(orig.winRate + '%').padStart(8)}  ${(base.winRate + '%').padStart(10)}    ${(gf.winRate + '%').padStart(10)}`);
console.log('-'.repeat(68));
console.log(`Total P&L:                 $${orig.pnl.toLocaleString().padStart(7)}  $${base.pnl.toLocaleString().padStart(9)}    $${gf.pnl.toLocaleString().padStart(9)}`);
console.log(`Max Drawdown:              $${orig.maxDD.toFixed(0).padStart(7)}  $${base.maxDD.toFixed(0).padStart(9)}    $${gf.maxDD.toFixed(0).padStart(9)}`);
console.log(`Profit Factor:             ${orig.pf.toFixed(2).padStart(8)}  ${base.pf.toFixed(2).padStart(10)}    ${gf.pf.toFixed(2).padStart(10)}`);

// Count exit reasons
console.log('\n' + '═'.repeat(80));
console.log('EXIT REASON BREAKDOWN (GF Early Exit vs Baseline)');
console.log('═'.repeat(80));

const countReasons = (trades) => {
  const reasons = {};
  trades.forEach(t => { reasons[t.exitReason] = (reasons[t.exitReason] || 0) + 1; });
  return reasons;
};

const baseReasons = countReasons(baseline.trades);
const gfReasons = countReasons(withGF.trades);

console.log('\n                          Baseline    GF Early Exit    Change');
console.log('-'.repeat(68));
const allReasons = new Set([...Object.keys(baseReasons), ...Object.keys(gfReasons)]);
allReasons.forEach(r => {
  const baseCount = baseReasons[r] || 0;
  const gfCount = gfReasons[r] || 0;
  const diff = gfCount - baseCount;
  const diffStr = diff === 0 ? '' : (diff > 0 ? '+' + diff : diff);
  console.log(`${r.padEnd(25)} ${baseCount.toString().padStart(8)}    ${gfCount.toString().padStart(10)}    ${diffStr.toString().padStart(8)}`);
});

// Analyze GF exit trades
const gfExitTrades = withGF.trades.filter(t => t.exitReason === 'gf_adverse_exit');
if (gfExitTrades.length > 0) {
  console.log('\n' + '═'.repeat(80));
  console.log('GF ADVERSE EXIT TRADES DETAIL');
  console.log('═'.repeat(80));
  gfExitTrades.forEach(t => {
    const date = new Date(t.entryTime).toISOString().split('T')[0];
    console.log(`\n  ${date} ${t.side.toUpperCase().padEnd(5)} @ ${t.signal?.levelType || 'N/A'}`);
    console.log(`    Entry: ${t.actualEntry?.toFixed(2)} | Exit: ${t.actualExit?.toFixed(2)} | P&L: $${t.netPnL?.toFixed(0)}`);
    console.log(`    Consecutive Adverse GF: ${t.gfConsecutiveAdverse || 'N/A'} | Total Adverse Sum: ${t.gfTotalAdverseSum?.toFixed(1) || 'N/A'}`);
  });
}

// Show what would have happened without GF exit
console.log('\n' + '═'.repeat(80));
console.log('TRADES THAT GOT GF EARLY EXIT - WHAT WOULD HAVE HAPPENED?');
console.log('═'.repeat(80));

// Find matching trades in baseline by entry time
gfExitTrades.forEach(gfTrade => {
  const baseTrade = baseline.trades.find(t =>
    Math.abs(new Date(t.entryTime).getTime() - new Date(gfTrade.entryTime).getTime()) < 60000
  );

  if (baseTrade) {
    console.log(`\nTrade on ${new Date(gfTrade.entryTime).toISOString().split('T')[0]}:`);
    console.log(`  Baseline: ${baseTrade.exitReason} → P&L: $${baseTrade.netPnL.toFixed(0)}`);
    console.log(`  GF Exit:  gf_adverse_exit → P&L: $${gfTrade.netPnL.toFixed(0)}`);
    const saved = gfTrade.netPnL - baseTrade.netPnL;
    console.log(`  Difference: $${saved.toFixed(0)} (${saved > 0 ? 'BETTER' : 'WORSE'})`);
  }
});

// Final summary
console.log('\n' + '═'.repeat(80));
console.log('SUMMARY');
console.log('═'.repeat(80));
const pnlDiff = gf.pnl - base.pnl;
console.log(`P&L Change with GF Early Exit: ${pnlDiff >= 0 ? '+' : ''}$${pnlDiff.toFixed(0)}`);
console.log(`GF exits triggered: ${gfExitTrades.length}`);

if (base.trades === orig.trades && Math.abs(base.pnl - orig.pnl) < 1) {
  console.log('✅ Baseline matches original - no regressions');
}
