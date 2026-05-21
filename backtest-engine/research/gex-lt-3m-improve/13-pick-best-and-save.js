/**
 * Phase 13 — pick the best engine candidates and save as gold-standard JSONs.
 *
 * Usage: node 13-pick-best-and-save.js [--save]
 *   --save: copy the engine output JSONs to data/gold-standard/gex-lt-3m-crossover-v3-*.json.
 *           Without --save, just prints the summary table.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SAVE = process.argv.includes('--save');

const RUNS = {
  // Map preset name → destination filename (in data/gold-standard/)
  'v3':            'gex-lt-3m-crossover-v3.json',
  'v3-max':        'gex-lt-3m-crossover-v3-max.json',
  'v3-balanced':   'gex-lt-3m-crossover-v3-balanced.json',
  'v3-low-dd':     'gex-lt-3m-crossover-v3-low-dd.json',
};

const SRC_DIR = path.join(__dirname, 'output');
const DST_DIR = path.resolve(__dirname, '../../data/gold-standard');

if (SAVE) {
  fs.mkdirSync(DST_DIR, { recursive: true });
  console.log(`Saving v3 gold-standard JSONs to ${DST_DIR}\n`);
}

for (const [preset, dst] of Object.entries(RUNS)) {
  const src = path.join(SRC_DIR, `engine-${preset}.json`);
  if (!fs.existsSync(src)) {
    console.log(`  ${preset.padEnd(15)} MISSING — engine run incomplete`);
    continue;
  }
  const d = JSON.parse(fs.readFileSync(src, 'utf-8'));
  const p = d.performance.summary;
  const b = d.performance.basic;
  console.log(`  ${preset.padEnd(15)} ${String(p.totalTrades).padStart(4)} trades  $${p.totalPnL.toFixed(0).padStart(6)}  WR ${p.winRate.toFixed(0)}%  PF ${b.profitFactor.toFixed(2)}  Sharpe ${p.sharpeRatio.toFixed(2)}  MaxDD ${p.maxDrawdown.toFixed(2)}%`);

  if (SAVE) {
    const dstPath = path.join(DST_DIR, dst);
    fs.copyFileSync(src, dstPath);
    console.log(`     → ${dstPath}`);
  }
}

if (!SAVE) {
  console.log('\n(--save not passed — dry run. Re-run with --save to copy.)');
}
