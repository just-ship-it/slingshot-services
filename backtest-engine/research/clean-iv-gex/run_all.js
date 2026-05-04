/**
 * Runner — executes every predictor sequentially against the same shared loader.
 *
 *   node run_all.js
 *
 * Each predictor script is self-contained and writes to the shared master CSV
 * via _lib.appendMasterCsv.  This runner truncates the master CSV first, then
 * spawns each predictor as a subprocess (so each gets its own module cache and
 * a clean `await main()`).
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { resetMasterCsv, OUTPUT_CSV } from './_lib.js';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PREDICTORS = [
  'p01_total_gex_zscore.js',
  'p02_wall_asymmetry.js',
  'p03_gamma_flip_dynamics.js',
  'p04_iv_term_structure.js',
  'p05_iv_crush.js',
  'p06_gamma_flip_crossover.js',
  'p07_lt_gex_confluence.js',
  'p08_tod_regime.js',
];

function run(file) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [path.join(__dirname, file)], { stdio: 'inherit' });
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${file} exited ${code}`)));
  });
}

async function main() {
  console.log('=== clean-IV / clean-GEX correlation hunt ===');
  console.log(`master CSV: ${OUTPUT_CSV}`);
  resetMasterCsv();

  const t0 = Date.now();
  for (const f of PREDICTORS) {
    console.log(`\n──── ${f} ────`);
    await run(f);
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n=== done in ${elapsed}s ===`);

  // Print summary
  const rows = fs.readFileSync(OUTPUT_CSV, 'utf8').trim().split('\n').slice(1);
  const promoted = rows.filter(r => r.includes(',true,'));
  console.log(`\nTotal predictor rows: ${rows.length}`);
  console.log(`Promoted rows:        ${promoted.length}`);
  for (const r of promoted) {
    const cols = r.split(',');
    console.log(`  + ${cols[0]} → ${cols[2]}  (n=${cols[3]}, r=${cols[4]}, effect=${cols[8]}, hit_diff=${cols[9]}/${cols[10]})`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
