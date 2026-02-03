#!/usr/bin/env node
/**
 * Test breakeven/profit protection trailing stop configurations
 * Goal: Once up X points, never give it all back
 */
import { spawn } from 'child_process';
import fs from 'fs/promises';

// Breakeven-style configs: trigger = offset means stop at breakeven when triggered
// trigger > offset means lock in (trigger - offset) points of profit
const CONFIGS = [
  // Pure breakeven levels
  { trigger: 30, offset: 30, desc: 'BE at 30pts' },
  { trigger: 40, offset: 40, desc: 'BE at 40pts' },
  { trigger: 50, offset: 50, desc: 'BE at 50pts' },
  { trigger: 75, offset: 75, desc: 'BE at 75pts' },
  { trigger: 100, offset: 100, desc: 'BE at 100pts' },
  
  // Lock in some profit
  { trigger: 50, offset: 40, desc: 'Lock 10pts at 50' },
  { trigger: 50, offset: 30, desc: 'Lock 20pts at 50' },
  { trigger: 75, offset: 50, desc: 'Lock 25pts at 75' },
  { trigger: 75, offset: 60, desc: 'Lock 15pts at 75' },
  { trigger: 100, offset: 75, desc: 'Lock 25pts at 100' },
  { trigger: 100, offset: 80, desc: 'Lock 20pts at 100' },
  { trigger: 100, offset: 50, desc: 'Lock 50pts at 100' },
];

const OUTPUT_DIR = 'results/2025-strategy-comparison/pullback-breakeven-grid';

async function runBacktest(config) {
  const outputFile = `${OUTPUT_DIR}/T${config.trigger}_O${config.offset}.json`;
  
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
    '--trailing-trigger', config.trigger.toString(),
    '--trailing-offset', config.offset.toString(),
    '--output', outputFile,
    '--quiet'
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn('node', args, { cwd: process.cwd() });
    proc.on('close', (code) => {
      if (code === 0) resolve({ ...config, outputFile });
      else reject(new Error(`Failed ${config.desc}`));
    });
  });
}

async function main() {
  console.log('🛡️  Breakeven/Profit Protection Grid Search');
  console.log('═'.repeat(70));
  console.log(`Testing ${CONFIGS.length} profit protection configurations\n`);
  
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  
  // Run in batches
  const BATCH_SIZE = 4;
  const results = [];
  
  for (let i = 0; i < CONFIGS.length; i += BATCH_SIZE) {
    const batch = CONFIGS.slice(i, i + BATCH_SIZE);
    console.log(`Batch ${Math.floor(i/BATCH_SIZE) + 1}: ${batch.map(c => c.desc).join(', ')}`);
    const batchResults = await Promise.all(batch.map(c => runBacktest(c).catch(e => ({ error: e.message, ...c }))));
    results.push(...batchResults);
  }
  
  console.log('\n📊 Results:\n');
  
  const summaries = [];
  for (const r of results) {
    if (r.error) continue;
    try {
      const data = JSON.parse(await fs.readFile(r.outputFile, 'utf8'));
      const perf = data.performance?.summary || {};
      const basic = data.performance?.basic || {};
      
      // Count trades by exit type
      const trades = data.trades || [];
      const trailingExits = trades.filter(t => t.exitReason === 'TRAILING_STOP').length;
      const stopLossExits = trades.filter(t => t.exitReason === 'STOP_LOSS').length;
      const takeProfitExits = trades.filter(t => t.exitReason === 'TAKE_PROFIT').length;
      
      summaries.push({
        desc: r.desc,
        trigger: r.trigger,
        offset: r.offset,
        pnl: perf.totalPnL || 0,
        return: perf.totalReturn || 0,
        maxDD: perf.maxDrawdown || 0,
        winRate: perf.winRate || 0,
        profitFactor: basic.profitFactor || 0,
        trailingExits,
        stopLossExits,
        takeProfitExits
      });
    } catch (err) {}
  }
  
  summaries.sort((a, b) => b.pnl - a.pnl);
  
  console.log('| Config                | Trigger | Offset |    P&L    | Return | MaxDD | Trail | SL  | TP  |');
  console.log('|-----------------------|---------|--------|-----------|--------|-------|-------|-----|-----|');
  
  for (const s of summaries) {
    console.log(`| ${s.desc.padEnd(21)} | ${s.trigger.toString().padStart(7)} | ${s.offset.toString().padStart(6)} | $${s.pnl.toLocaleString().padStart(8)} | ${s.return.toFixed(1).padStart(5)}% | ${s.maxDD.toFixed(1).padStart(4)}% | ${s.trailingExits.toString().padStart(5)} | ${s.stopLossExits.toString().padStart(3)} | ${s.takeProfitExits.toString().padStart(3)} |`);
  }
  
  console.log('\n📋 Baseline (no trailing): $23,350 | 23.4% return | 3.4% maxDD | 0 trail | 15 SL | 12 TP');
  
  await fs.writeFile(`${OUTPUT_DIR}/breakeven-summary.json`, JSON.stringify(summaries, null, 2));
}

main().catch(console.error);
