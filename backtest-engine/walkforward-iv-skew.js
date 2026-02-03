#!/usr/bin/env node
/**
 * Walk-Forward Validation: IV Skew GEX Strategy
 *
 * Tests strategy robustness by:
 * 1. Rolling 2-month training / 1-month testing windows
 * 2. Quarterly analysis
 * 3. Out-of-sample vs in-sample comparison
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  // Load the full year results
  const results = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'results/iv-skew-full-year-backtest.json'),
    'utf-8'
  ));

  const trades = results.trades;

  console.log('=== Walk-Forward Validation: IV Skew GEX Strategy ===\n');
  console.log(`Total trades: ${trades.length}\n`);

  // ============= Quarterly Analysis =============
  console.log('=== QUARTERLY PERFORMANCE ===\n');

  const quarters = {
    'Q1 2025': { start: '2025-01', end: '2025-03' },
    'Q2 2025': { start: '2025-04', end: '2025-06' },
    'Q3 2025': { start: '2025-07', end: '2025-09' },
    'Q4 2025': { start: '2025-10', end: '2025-12' },
  };

  console.log('Quarter  | Trades | Win%  | Total P&L | Avg P&L | PF');
  console.log('-'.repeat(60));

  for (const [qtr, range] of Object.entries(quarters)) {
    const qtrTrades = trades.filter(t => {
      const month = t.entryTime.slice(0, 7);
      return month >= range.start && month <= range.end;
    });

    if (qtrTrades.length === 0) continue;

    const wins = qtrTrades.filter(t => t.pnl > 0).length;
    const winRate = wins / qtrTrades.length * 100;
    const totalPnL = qtrTrades.reduce((s, t) => s + t.pnl, 0);
    const avgPnL = totalPnL / qtrTrades.length;

    const grossProfit = qtrTrades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(qtrTrades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
    const pf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit;

    console.log(`${qtr.padEnd(8)} | ${qtrTrades.length.toString().padStart(6)} | ${winRate.toFixed(1).padStart(4)}% | ${totalPnL.toFixed(0).padStart(9)} | ${avgPnL.toFixed(2).padStart(7)} | ${pf.toFixed(2).padStart(4)}`);
  }

  // ============= Rolling Window Analysis =============
  console.log('\n=== ROLLING 2-MONTH WINDOW ANALYSIS ===\n');

  const months = [...new Set(trades.map(t => t.entryTime.slice(0, 7)))].sort();

  console.log('Training Period | Test Month | Train PF | Test PF | Consistent?');
  console.log('-'.repeat(70));

  for (let i = 2; i < months.length; i++) {
    const trainMonths = [months[i - 2], months[i - 1]];
    const testMonth = months[i];

    const trainTrades = trades.filter(t => trainMonths.includes(t.entryTime.slice(0, 7)));
    const testTrades = trades.filter(t => t.entryTime.slice(0, 7) === testMonth);

    if (trainTrades.length < 10 || testTrades.length < 5) continue;

    const calcPF = (arr) => {
      const profit = arr.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
      const loss = Math.abs(arr.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
      return loss > 0 ? profit / loss : profit;
    };

    const trainPF = calcPF(trainTrades);
    const testPF = calcPF(testTrades);
    const consistent = testPF > 1 ? 'YES' : 'NO';

    console.log(`${trainMonths.join(', ').padEnd(15)} | ${testMonth.padEnd(10)} | ${trainPF.toFixed(2).padStart(8)} | ${testPF.toFixed(2).padStart(7)} | ${consistent.padStart(11)}`);
  }

  // ============= First Half vs Second Half =============
  console.log('\n=== FIRST HALF vs SECOND HALF ===\n');

  const h1Trades = trades.filter(t => t.entryTime.slice(5, 7) <= '06');
  const h2Trades = trades.filter(t => t.entryTime.slice(5, 7) > '06');

  const analyzeHalf = (arr, name) => {
    const wins = arr.filter(t => t.pnl > 0).length;
    const totalPnL = arr.reduce((s, t) => s + t.pnl, 0);
    const grossProfit = arr.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(arr.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
    const pf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit;

    console.log(`${name}: ${arr.length} trades | ${(wins/arr.length*100).toFixed(1)}% win | ${totalPnL.toFixed(0)} pts | PF ${pf.toFixed(2)}`);
  };

  analyzeHalf(h1Trades, 'H1 (Jan-Jun)');
  analyzeHalf(h2Trades, 'H2 (Jul-Dec)');

  // ============= LONG vs SHORT Consistency =============
  console.log('\n=== LONG vs SHORT BY QUARTER ===\n');

  console.log('Quarter  | LONG Trades | LONG Win% | SHORT Trades | SHORT Win%');
  console.log('-'.repeat(70));

  for (const [qtr, range] of Object.entries(quarters)) {
    const qtrTrades = trades.filter(t => {
      const month = t.entryTime.slice(0, 7);
      return month >= range.start && month <= range.end;
    });

    const longTrades = qtrTrades.filter(t => t.side === 'LONG');
    const shortTrades = qtrTrades.filter(t => t.side === 'SHORT');

    const longWinRate = longTrades.length > 0 ?
      longTrades.filter(t => t.pnl > 0).length / longTrades.length * 100 : 0;
    const shortWinRate = shortTrades.length > 0 ?
      shortTrades.filter(t => t.pnl > 0).length / shortTrades.length * 100 : 0;

    console.log(`${qtr.padEnd(8)} | ${longTrades.length.toString().padStart(11)} | ${longWinRate.toFixed(1).padStart(9)}% | ${shortTrades.length.toString().padStart(12)} | ${shortWinRate.toFixed(1).padStart(10)}%`);
  }

  // ============= Drawdown Analysis =============
  console.log('\n=== DRAWDOWN ANALYSIS ===\n');

  let cumPnL = 0, peak = 0;
  let currentDD = 0, ddStart = null;
  const drawdowns = [];

  for (const t of trades) {
    cumPnL += t.pnl;

    if (cumPnL > peak) {
      if (currentDD > 50) {
        drawdowns.push({
          start: ddStart,
          end: t.entryTime,
          depth: currentDD,
          recovery: cumPnL
        });
      }
      peak = cumPnL;
      currentDD = 0;
      ddStart = null;
    } else {
      const dd = peak - cumPnL;
      if (dd > currentDD) {
        currentDD = dd;
        if (!ddStart) ddStart = t.entryTime;
      }
    }
  }

  console.log('Significant Drawdowns (> 50 pts):\n');
  console.log('Start Date  | Depth    | Recovered?');
  console.log('-'.repeat(45));

  for (const dd of drawdowns.slice(0, 10)) {
    console.log(`${dd.start.slice(0, 10)} | ${dd.depth.toFixed(0).padStart(6)} pts | Yes`);
  }

  if (currentDD > 50) {
    console.log(`${ddStart?.slice(0, 10) || 'N/A'} | ${currentDD.toFixed(0).padStart(6)} pts | In progress`);
  }

  // ============= Monte Carlo Simulation =============
  console.log('\n=== MONTE CARLO SIMULATION (1000 runs) ===\n');

  const returns = trades.map(t => t.pnl);
  const numSims = 1000;
  const finalEquities = [];

  for (let sim = 0; sim < numSims; sim++) {
    // Shuffle returns
    const shuffled = [...returns].sort(() => Math.random() - 0.5);
    const finalEq = shuffled.reduce((s, r) => s + r, 0);
    finalEquities.push(finalEq);
  }

  finalEquities.sort((a, b) => a - b);

  const p5 = finalEquities[Math.floor(numSims * 0.05)];
  const p25 = finalEquities[Math.floor(numSims * 0.25)];
  const p50 = finalEquities[Math.floor(numSims * 0.50)];
  const p75 = finalEquities[Math.floor(numSims * 0.75)];
  const p95 = finalEquities[Math.floor(numSims * 0.95)];

  console.log('Final Equity Distribution (shuffled trade order):');
  console.log(`  5th percentile:  ${p5.toFixed(0)} pts`);
  console.log(`  25th percentile: ${p25.toFixed(0)} pts`);
  console.log(`  Median:          ${p50.toFixed(0)} pts`);
  console.log(`  75th percentile: ${p75.toFixed(0)} pts`);
  console.log(`  95th percentile: ${p95.toFixed(0)} pts`);
  console.log(`  Actual result:   ${results.summary.totalPnL.toFixed(0)} pts`);

  // ============= Statistical Tests =============
  console.log('\n=== STATISTICAL ROBUSTNESS ===\n');

  // Win rate confidence interval
  const n = trades.length;
  const p = results.summary.winRate / 100;
  const se = Math.sqrt(p * (1 - p) / n);
  const ci95 = [p - 1.96 * se, p + 1.96 * se].map(x => (x * 100).toFixed(1));

  console.log(`Win Rate: ${results.summary.winRate.toFixed(1)}%`);
  console.log(`95% CI:   [${ci95[0]}%, ${ci95[1]}%]`);

  // Is it significantly better than 50%?
  const zScore = (p - 0.5) / se;
  console.log(`Z-Score vs 50%: ${zScore.toFixed(2)} (${zScore > 1.96 ? 'Significant' : 'Not significant'})`);

  // Average trade significance
  const avgPnL = results.summary.totalPnL / n;
  const stdDev = Math.sqrt(returns.reduce((s, r) => s + Math.pow(r - avgPnL, 2), 0) / n);
  const tStat = avgPnL / (stdDev / Math.sqrt(n));
  console.log(`\nAvg P&L: ${avgPnL.toFixed(2)} pts`);
  console.log(`T-Stat:  ${tStat.toFixed(2)} (${Math.abs(tStat) > 1.96 ? 'Significant' : 'Not significant'})`);

  console.log('\n=== Walk-Forward Validation Complete ===\n');
}

main().catch(console.error);
