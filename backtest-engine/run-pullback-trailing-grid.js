#!/usr/bin/env node
/**
 * Grid search for optimal trailing stop parameters on pullback strategy
 */
import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';

const TRIGGERS = [15, 25, 40, 60, 80, 100];
const OFFSETS = [5, 10, 15, 25, 40, 60];

const OUTPUT_DIR = 'results/2025-strategy-comparison/pullback-trailing-grid';

async function runBacktest(trigger, offset) {
  const outputFile = `${OUTPUT_DIR}/T${trigger}_O${offset}.json`;
  
  const args = [
    'index.js',
    '--ticker', 'NQ',
    '--start', '2025-01-02',
    '--end', '2025-12-25',
    '--strategy', 'gex-ldpm-confluence-pullback',
    '--timeframe', '15m',
    '--use-session-filter',
    '--blocked-level-types', 'resistance_2,resistance_3',
    '--blocked-regimes', 'strong_negative',
    '--sell-start-hour-utc', '13',
    '--use-trailing-stop',
    '--trailing-trigger', trigger.toString(),
    '--trailing-offset', offset.toString(),
    '--output', outputFile,
    '--quiet'
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn('node', args, { cwd: process.cwd() });
    let stdout = '';
    let stderr = '';
    
    proc.stdout.on('data', (data) => stdout += data);
    proc.stderr.on('data', (data) => stderr += data);
    
    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ trigger, offset, outputFile });
      } else {
        reject(new Error(`Failed T${trigger}_O${offset}: ${stderr}`));
      }
    });
  });
}

async function main() {
  console.log('🔍 Pullback Strategy Trailing Stop Grid Search');
  console.log('═'.repeat(60));
  console.log(`Testing ${TRIGGERS.length} triggers × ${OFFSETS.length} offsets = ${TRIGGERS.length * OFFSETS.length} combinations\n`);
  
  // Create output directory
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  
  // Build all combinations
  const combinations = [];
  for (const trigger of TRIGGERS) {
    for (const offset of OFFSETS) {
      combinations.push({ trigger, offset });
    }
  }
  
  // Run in batches of 6 for parallel execution
  const BATCH_SIZE = 6;
  const results = [];
  
  for (let i = 0; i < combinations.length; i += BATCH_SIZE) {
    const batch = combinations.slice(i, i + BATCH_SIZE);
    console.log(`Running batch ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(combinations.length/BATCH_SIZE)}: ${batch.map(c => `T${c.trigger}/O${c.offset}`).join(', ')}`);
    
    const batchResults = await Promise.all(
      batch.map(c => runBacktest(c.trigger, c.offset).catch(err => ({ error: err.message, ...c })))
    );
    results.push(...batchResults);
  }
  
  // Load and analyze results
  console.log('\n📊 Loading results...\n');
  
  const summaries = [];
  for (const r of results) {
    if (r.error) {
      console.log(`❌ T${r.trigger}/O${r.offset}: ${r.error}`);
      continue;
    }
    
    try {
      const data = JSON.parse(await fs.readFile(r.outputFile, 'utf8'));
      const perf = data.performance?.summary || {};
      const basic = data.performance?.basic || {};
      
      summaries.push({
        trigger: r.trigger,
        offset: r.offset,
        pnl: perf.totalPnL || 0,
        return: perf.totalReturn || 0,
        trades: perf.totalTrades || 0,
        winRate: perf.winRate || 0,
        maxDD: perf.maxDrawdown || 0,
        sharpe: perf.sharpeRatio || 0,
        profitFactor: basic.profitFactor || 0
      });
    } catch (err) {
      console.log(`❌ Failed to parse T${r.trigger}/O${r.offset}: ${err.message}`);
    }
  }
  
  // Sort by P&L
  summaries.sort((a, b) => b.pnl - a.pnl);
  
  // Print results table
  console.log('═'.repeat(100));
  console.log('RESULTS (sorted by P&L)');
  console.log('═'.repeat(100));
  console.log('| Trigger | Offset |    P&L    | Return | Trades | Win% | MaxDD | Sharpe | PF   |');
  console.log('|---------|--------|-----------|--------|--------|------|-------|--------|------|');
  
  for (const s of summaries) {
    console.log(`| ${s.trigger.toString().padStart(7)} | ${s.offset.toString().padStart(6)} | $${s.pnl.toLocaleString().padStart(8)} | ${s.return.toFixed(1).padStart(5)}% | ${s.trades.toString().padStart(6)} | ${s.winRate.toFixed(1).padStart(4)}% | ${s.maxDD.toFixed(1).padStart(5)}% | ${(s.sharpe || 0).toFixed(2).padStart(6)} | ${(s.profitFactor || 0).toFixed(2).padStart(4)} |`);
  }
  
  console.log('═'.repeat(100));
  
  // Save summary
  const summaryFile = `${OUTPUT_DIR}/grid-summary.json`;
  await fs.writeFile(summaryFile, JSON.stringify(summaries, null, 2));
  console.log(`\n📁 Summary saved to ${summaryFile}`);
  
  // Best result
  if (summaries.length > 0) {
    const best = summaries[0];
    console.log(`\n🏆 BEST: Trigger=${best.trigger}, Offset=${best.offset} → $${best.pnl.toLocaleString()} (${best.return.toFixed(1)}% return, ${best.maxDD.toFixed(1)}% max DD)`);
  }
}

main().catch(console.error);
