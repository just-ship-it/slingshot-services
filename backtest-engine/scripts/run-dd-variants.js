#!/usr/bin/env node
/**
 * Drawdown-reduction variants for iv-skew-gex on cbbo gold-standard params.
 *
 * Runs each variant by spawning the standard CLI. Concurrency 2.
 * Writes per-variant result JSON to data/dd-variants/<id>.json.
 * Prints a comparison table at the end.
 *
 * Add new variants by appending to VARIANTS — keep `id` short and unique.
 *
 * Usage: node scripts/run-dd-variants.js [--only A,C,E]
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RESULTS_DIR = path.join(ROOT, 'data', 'dd-variants');
fs.mkdirSync(RESULTS_DIR, { recursive: true });

const COMMON = [
  '--ticker', 'NQ',
  '--strategy', 'iv-skew-gex',
  '--timeframe', '1m',
  '--raw-contracts',
  '--start', '2025-01-13',
  '--end', '2026-04-23',
  '--iv-resolution', '1m',
  '--gex-dir', 'data/gex/nq-cbbo',
  '--quiet',
];

const VARIANTS = [
  {
    id: 'baseline',
    label: 'Gold standard (reference)',
    extra: [
      '--target-points', '120',
      '--stop-loss-points', '80',
      '--max-hold-bars', '60',
      '--time-based-trailing',
      '--tb-rule-1', '15,50,breakeven',
      '--tb-rule-2', '40,50,trail:10',
    ],
  },
  {
    id: 'A_iv-filter',
    label: 'IV filter: maxIV=0.30, maxIVVol=0.02',
    extra: [
      '--target-points', '120',
      '--stop-loss-points', '80',
      '--max-hold-bars', '60',
      '--time-based-trailing',
      '--tb-rule-1', '15,50,breakeven',
      '--tb-rule-2', '40,50,trail:10',
      '--max-iv', '0.30',
      '--max-iv-volatility', '0.02',
    ],
  },
  {
    id: 'B_top3-levels',
    label: 'Top-3 levels only (S1-S3,R1-R3 + walls + GammaFlip)',
    extra: [
      '--target-points', '120',
      '--stop-loss-points', '80',
      '--max-hold-bars', '60',
      '--time-based-trailing',
      '--tb-rule-1', '15,50,breakeven',
      '--tb-rule-2', '40,50,trail:10',
      '--trade-support-levels', 'S1,S2,S3,PutWall,GammaFlip',
      '--trade-resistance-levels', 'R1,R2,R3,CallWall,GammaFlip',
    ],
  },
  {
    id: 'C_tight-sl60',
    label: 'Tighter SL: 60pt (R:R 2.0)',
    extra: [
      '--target-points', '120',
      '--stop-loss-points', '60',
      '--max-hold-bars', '60',
      '--time-based-trailing',
      '--tb-rule-1', '15,50,breakeven',
      '--tb-rule-2', '40,50,trail:10',
    ],
  },
  {
    id: 'D_early-breakeven',
    label: 'Earlier breakeven: TB1=10bars/30MFE',
    extra: [
      '--target-points', '120',
      '--stop-loss-points', '80',
      '--max-hold-bars', '60',
      '--time-based-trailing',
      '--tb-rule-1', '10,30,breakeven',
      '--tb-rule-2', '40,50,trail:10',
    ],
  },
  {
    id: 'E_iv+top3',
    label: 'IV filter + top-3 levels',
    extra: [
      '--target-points', '120',
      '--stop-loss-points', '80',
      '--max-hold-bars', '60',
      '--time-based-trailing',
      '--tb-rule-1', '15,50,breakeven',
      '--tb-rule-2', '40,50,trail:10',
      '--max-iv', '0.30',
      '--max-iv-volatility', '0.02',
      '--trade-support-levels', 'S1,S2,S3,PutWall,GammaFlip',
      '--trade-resistance-levels', 'R1,R2,R3,CallWall,GammaFlip',
    ],
  },
  {
    id: 'F_pure-trail50-15',
    label: 'No TB. Pure trailing: trigger=50, offset=15',
    extra: [
      '--target-points', '120',
      '--stop-loss-points', '80',
      '--max-hold-bars', '60',
      '--use-trailing-stop',
      '--trailing-trigger', '50',
      '--trailing-offset', '15',
    ],
  },
  {
    id: 'G_slower-tb',
    label: 'Slower TB: 30,80,BE | 50,80,trail:15',
    extra: [
      '--target-points', '120',
      '--stop-loss-points', '80',
      '--max-hold-bars', '60',
      '--time-based-trailing',
      '--tb-rule-1', '30,80,breakeven',
      '--tb-rule-2', '50,80,trail:15',
    ],
  },
  {
    id: 'H_maxhold-90',
    label: 'Longer hold: 90 bars + default TB',
    extra: [
      '--target-points', '120',
      '--stop-loss-points', '80',
      '--max-hold-bars', '90',
      '--time-based-trailing',
      '--tb-rule-1', '15,50,breakeven',
      '--tb-rule-2', '40,50,trail:10',
    ],
  },
  {
    id: 'I_maxhold-30',
    label: 'Shorter hold: 30 bars + default TB',
    extra: [
      '--target-points', '120',
      '--stop-loss-points', '80',
      '--max-hold-bars', '30',
      '--time-based-trailing',
      '--tb-rule-1', '15,50,breakeven',
      '--tb-rule-2', '40,50,trail:10',
    ],
  },
  {
    id: 'J_price-be-60',
    label: 'No TB. Price BE only: trigger=60, offset=5',
    extra: [
      '--target-points', '120',
      '--stop-loss-points', '80',
      '--max-hold-bars', '60',
      '--breakeven-stop',
      '--breakeven-trigger', '60',
      '--breakeven-offset', '5',
    ],
  },
];

const args = process.argv.slice(2);
let onlyIds = null;
const onlyFlag = args.indexOf('--only');
if (onlyFlag !== -1 && args[onlyFlag + 1]) {
  onlyIds = new Set(args[onlyFlag + 1].split(',').map((s) => s.trim()));
}

function runVariant(v) {
  const outPath = path.join(RESULTS_DIR, `${v.id}.json`);
  if (fs.existsSync(outPath)) {
    return Promise.resolve({ v, code: 0, elapsedSec: 0, skipped: true });
  }
  const cmd = ['index.js', ...COMMON, ...v.extra, '--output-json', outPath];
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn('node', cmd, { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      resolve({ v, code, elapsedSec: ((Date.now() - t0) / 1000).toFixed(0), stderr });
    });
  });
}

function summarize(v) {
  const p = path.join(RESULTS_DIR, `${v.id}.json`);
  if (!fs.existsSync(p)) return null;
  const r = JSON.parse(fs.readFileSync(p, 'utf8'));
  const perf = r.performance || {};
  const b = perf.basic || {};
  const ri = perf.risk || {};
  const dd = perf.drawdown || {};
  const sim = r.simulation || {};
  return {
    id: v.id,
    label: v.label,
    signals: sim.totalSignals ?? 0,
    trades: b.totalTrades ?? 0,
    winRate: b.winRate ?? 0,
    pf: b.profitFactor ?? 0,
    sharpe: ri.sharpeRatio ?? 0,
    maxDD: dd.maxDrawdown ?? 0,
    pnl: b.totalPnL ?? 0,
  };
}

function fmtRow(s, baseline) {
  const cols = [
    s.id.padEnd(20),
    String(s.signals).padStart(5),
    String(s.trades).padStart(6),
    s.winRate.toFixed(1).padStart(5),
    s.pf.toFixed(2).padStart(5),
    s.sharpe.toFixed(2).padStart(6),
    s.maxDD.toFixed(2).padStart(6) + '%',
    `$${s.pnl.toFixed(0)}`.padStart(10),
  ];
  if (baseline && s.id !== 'baseline') {
    const pnlPct = ((s.pnl - baseline.pnl) / baseline.pnl * 100);
    const ddDelta = (s.maxDD - baseline.maxDD);
    const wrDelta = (s.winRate - baseline.winRate);
    cols.push(
      `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`.padStart(7),
      `${ddDelta >= 0 ? '+' : ''}${ddDelta.toFixed(2)}pp`.padStart(8),
      `${wrDelta >= 0 ? '+' : ''}${wrDelta.toFixed(1)}pp`.padStart(8),
    );
  }
  return cols.join('  ');
}

async function main() {
  const todo = VARIANTS.filter((v) => !onlyIds || onlyIds.has(v.id));
  console.log(`Running ${todo.length} variant(s) at concurrency 2...\n`);

  const t0 = Date.now();
  let nextIdx = 0, completed = 0;
  const concurrency = 2;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (true) {
        const i = nextIdx++;
        if (i >= todo.length) return;
        const v = todo[i];
        const res = await runVariant(v);
        completed++;
        const status = res.skipped ? 'SKIP (cached)' : (res.code === 0 ? 'OK' : `FAIL(${res.code})`);
        const elapsed = ((Date.now() - t0) / 60000).toFixed(1);
        console.log(`[${completed}/${todo.length}] ${v.id.padEnd(20)} ${status.padEnd(14)} ${res.elapsedSec}s  (elapsed ${elapsed}m)`);
        if (res.code !== 0 && !res.skipped) {
          console.log(`    stderr tail: ${res.stderr.slice(-300)}`);
        }
      }
    })
  );

  console.log(`\nAll variants done in ${((Date.now() - t0) / 60000).toFixed(1)}m.\n`);

  // Comparison table
  const summaries = VARIANTS.map(summarize).filter(Boolean);
  const baseline = summaries.find((s) => s.id === 'baseline');

  console.log('═'.repeat(120));
  console.log('  Variant comparison vs gold-standard baseline');
  console.log('═'.repeat(120));
  const header = [
    'id'.padEnd(20),
    'sigs'.padStart(5),
    'trades'.padStart(6),
    'WR%'.padStart(5),
    'PF'.padStart(5),
    'Sharpe'.padStart(6),
    'MaxDD'.padStart(7),
    'PnL'.padStart(10),
    'Δ PnL'.padStart(7),
    'Δ MaxDD'.padStart(8),
    'Δ WR'.padStart(8),
  ].join('  ');
  console.log(header);
  console.log('-'.repeat(120));
  for (const s of summaries) {
    const v = VARIANTS.find((x) => x.id === s.id);
    console.log(fmtRow(s, baseline));
    console.log(`                       ${v.label}`);
  }

  // Pick winner: lowest MaxDD subject to PnL >= baseline.pnl * (2/3) and PF >= 2.5
  if (baseline) {
    const minPnl = baseline.pnl * (2 / 3);
    const candidates = summaries.filter((s) => s.id !== 'baseline' && s.pnl >= minPnl && s.pf >= 2.5);
    const winner = candidates.sort((a, b) => a.maxDD - b.maxDD)[0];
    console.log('');
    if (winner) {
      console.log(`📉 Lowest MaxDD that passes the 2/3-PnL & PF≥2.5 floor: ${winner.id}`);
      console.log(`   ${winner.label}`);
      console.log(`   MaxDD ${winner.maxDD.toFixed(2)}% | PF ${winner.pf.toFixed(2)} | Sharpe ${winner.sharpe.toFixed(2)} | PnL $${winner.pnl.toFixed(0)} (${((winner.pnl / baseline.pnl - 1) * 100).toFixed(1)}% vs baseline)`);
    } else {
      console.log(`No variant passed the floor (PnL ≥ \$${minPnl.toFixed(0)} & PF ≥ 2.5). Showing all.`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
