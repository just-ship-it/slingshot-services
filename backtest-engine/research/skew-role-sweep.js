/**
 * Skew Role Sweep — runs 4 variants sequentially, saves after each.
 * Usage: node research/skew-role-sweep.js [variantIndex]
 *   (no arg = run all remaining; index 0..3 = run that one)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { BacktestEngine } from '../src/backtest-engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const OUT = '/tmp/skew-role-sweep.json';

const baseConfig = {
  ticker: 'NQ', strategy: 'iv-skew-gex', timeframe: '1m', noContinuous: true,
  startDate: new Date('2025-01-13'), endDate: new Date('2026-01-23'),
  dataDir: DATA_DIR, ivResolution: '1m', quiet: true,
};
const baseParams = {
  stopLossPoints: 80, takeProfitPoints: 120, maxHoldBars: 60,
  timeBasedTrailing: true,
  timeBasedConfig: { rules: [
    { afterBars: 15, ifMFE: 50, action: 'breakeven' },
    { afterBars: 40, ifMFE: 50, trailDistance: 10 },
  ]},
  dataDir: DATA_DIR,
};

const VARIANTS = [
  { key: 'gold_standard',  label: 'Gold Standard (-0.01/+0.01)', negT: -0.01, posT:  0.01 },
  { key: 'reversed',       label: 'Reversed (+0.01/-0.01)',       negT:  0.01, posT: -0.01 },
  { key: 'longs_only',     label: 'Longs Only (-0.01/+99)',       negT: -0.01, posT: 99    },
  { key: 'shorts_only',    label: 'Shorts Only (-99/+0.01)',      negT: -99,   posT:  0.01 },
];

// Already completed in earlier session (before crash):
const SEED = {
  skew_disabled: {
    label: 'Skew Disabled (0.99/-0.99)', negT: 0.99, posT: -0.99,
    trades: 920, longs: 675, shorts: 245,
    wr: 44.5, pf: 2.09, pnl: 301352, longPnL: 196950, shortPnL: 104402,
    note: 'recovered from pre-crash session transcript',
  },
};

function summarize(trades) {
  const s = trades.filter(t => t.side === 'sell' || t.side === 'short');
  const l = trades.filter(t => t.side === 'buy'  || t.side === 'long');
  const w = trades.filter(t => t.netPnL > 0);
  const lo = trades.filter(t => t.netPnL <= 0);
  const wg = w.reduce((a,x)=>a+x.netPnL,0);
  const lg = Math.abs(lo.reduce((a,x)=>a+x.netPnL,0));
  const pf = lg > 0 ? wg/lg : 0;
  const pnl = trades.reduce((a,x)=>a+x.netPnL,0);
  const shortWR = s.length ? (s.filter(x=>x.netPnL>0).length / s.length * 100) : 0;
  const longWR  = l.length ? (l.filter(x=>x.netPnL>0).length / l.length * 100) : 0;
  return {
    trades: trades.length, longs: l.length, shorts: s.length,
    wr: +(w.length/trades.length*100).toFixed(1),
    pf: +pf.toFixed(2), pnl: +pnl.toFixed(0),
    longPnL: +l.reduce((a,x)=>a+x.netPnL,0).toFixed(0),
    shortPnL: +s.reduce((a,x)=>a+x.netPnL,0).toFixed(0),
    longWR: +longWR.toFixed(1), shortWR: +shortWR.toFixed(1),
  };
}

function loadResults() {
  if (fs.existsSync(OUT)) return JSON.parse(fs.readFileSync(OUT, 'utf8'));
  return { completed: { ...SEED }, pending: VARIANTS.map(v => v.key) };
}

function saveResults(state) {
  fs.writeFileSync(OUT, JSON.stringify(state, null, 2));
}

async function runVariant(v) {
  console.log(`\n━━━ Running: ${v.label} ━━━`);
  const t0 = Date.now();
  const engine = new BacktestEngine({
    ...baseConfig,
    strategyParams: { ...baseParams, negSkewThreshold: v.negT, posSkewThreshold: v.posT },
  });
  const r = await engine.run();
  const summary = summarize(r.trades);
  summary.label = v.label;
  summary.negSkewThreshold = v.negT;
  summary.posSkewThreshold = v.posT;
  summary.elapsedSec = Math.round((Date.now() - t0) / 1000);
  return summary;
}

async function main() {
  const arg = process.argv[2];
  const state = loadResults();
  let variantsToRun = VARIANTS;
  if (arg !== undefined && arg !== 'all') {
    const idx = parseInt(arg, 10);
    variantsToRun = [VARIANTS[idx]];
  } else {
    variantsToRun = VARIANTS.filter(v => !state.completed[v.key]);
  }
  console.log(`Queued variants: ${variantsToRun.map(v=>v.key).join(', ') || '(none — all done)'}`);
  console.log(`Already completed: ${Object.keys(state.completed).join(', ')}`);

  for (const v of variantsToRun) {
    try {
      const summary = await runVariant(v);
      state.completed[v.key] = summary;
      state.pending = VARIANTS.filter(x => !state.completed[x.key]).map(x => x.key);
      saveResults(state);
      console.log(`✅ ${v.key} saved.`);
      console.log(`   Trades: ${summary.trades} (L:${summary.longs}/S:${summary.shorts}) | WR: ${summary.wr}% | PF: ${summary.pf} | PnL: $${summary.pnl}`);
      console.log(`   Long WR: ${summary.longWR}% ($${summary.longPnL}) | Short WR: ${summary.shortWR}% ($${summary.shortPnL})`);
      console.log(`   Elapsed: ${summary.elapsedSec}s`);
    } catch (e) {
      console.error(`❌ ${v.key} FAILED: ${e.message}`);
      state.completed[v.key] = { error: e.message, stack: e.stack };
      saveResults(state);
    }
  }

  console.log('\n═══ FINAL TABLE ═══');
  console.log('Variant'.padEnd(28) + '| Trades | L   | S   |  WR%  |  PF  |  Total$  |  Long$  |  Short$ | LWR%  | SWR%');
  console.log('-'.repeat(110));
  const order = ['gold_standard','reversed','skew_disabled','longs_only','shorts_only'];
  for (const k of order) {
    const r = state.completed[k];
    if (!r) { console.log(k.padEnd(28) + '| (pending)'); continue; }
    if (r.error) { console.log(k.padEnd(28) + '| ERROR: ' + r.error); continue; }
    console.log(
      k.padEnd(28) + '| ' +
      String(r.trades).padStart(5) + ' | ' +
      String(r.longs ?? '-').padStart(3) + ' | ' +
      String(r.shorts ?? '-').padStart(3) + ' | ' +
      String(r.wr).padStart(5) + ' | ' +
      String(r.pf).padStart(4) + ' | $' +
      String(r.pnl).padStart(7) + ' | $' +
      String(r.longPnL ?? '-').padStart(6) + ' | $' +
      String(r.shortPnL ?? '-').padStart(6) + ' | ' +
      String(r.longWR ?? '-').padStart(4) + ' | ' +
      String(r.shortWR ?? '-').padStart(4)
    );
  }
  console.log(`\nResults persisted to ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
