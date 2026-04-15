/**
 * Quality filter sweep — tests wall-magnitude/imbalance filters
 * baked into iv-skew-gex strategy. Runs sequentially, saves after each.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { BacktestEngine } from '../src/backtest-engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = '/tmp/quality-filter-sweep.json';

const baseConfig = {
  ticker: 'NQ', strategy: 'iv-skew-gex', timeframe: '1m', noContinuous: true,
  startDate: new Date('2025-01-13'), endDate: new Date('2026-01-23'),
  dataDir: path.join(__dirname, '..', 'data'),
  ivResolution: '1m', quiet: true,
};
const baseParams = {
  stopLossPoints: 80, takeProfitPoints: 120, maxHoldBars: 60,
  timeBasedTrailing: true,
  timeBasedConfig: { rules: [
    { afterBars: 15, ifMFE: 50, action: 'breakeven' },
    { afterBars: 40, ifMFE: 50, trailDistance: 10 },
  ]},
  dataDir: path.join(__dirname, '..', 'data'),
};

const VARIANTS = [
  { key: 'gold_control',    label: 'Gold (control, no new filters)', p: {} },
  { key: 'short_walldist',  label: 'SHORT: maxCallWallDistance=300',
    p: { shortMaxCallWallDistance: 300 } },
  { key: 'short_totalgex',  label: 'SHORT: minTotalGex=-1e9',
    p: { shortMinTotalGex: -1e9 } },
  { key: 'short_levelgex',  label: 'SHORT: minTradeLevelGex=150M (rank≥1)',
    p: { shortMinTradeLevelGex: 150e6 } },
  { key: 'short_combo',     label: 'SHORT combo: walldist+totalgex+levelgex',
    p: { shortMaxCallWallDistance: 300, shortMinTotalGex: -1e9, shortMinTradeLevelGex: 150e6 } },
  { key: 'long_imbalance',  label: 'LONG: minGammaImbalance=-0.5 + minPutWallGex=500M',
    p: { longMinGammaImbalance: -0.5, longMinPutWallGex: 500e6 } },
  { key: 'long_imbalance_nowall', label: 'LONG: minGammaImbalance=-0.5 alone',
    p: { longMinGammaImbalance: -0.5 } },
  { key: 'combo_all',       label: 'ALL: short combo + long combo',
    p: { shortMaxCallWallDistance: 300, shortMinTotalGex: -1e9, shortMinTradeLevelGex: 150e6,
         longMinGammaImbalance: -0.5, longMinPutWallGex: 500e6 } },
];

function equityMetrics(trades) {
  const sorted = [...trades].sort((a,b) => (a.entryTime||0) - (b.entryTime||0));
  let equity = 0, peak = 0, maxDD = 0, maxDDPct = 0;
  const daily = new Map();
  for (const t of sorted) {
    equity += t.netPnL;
    peak = Math.max(peak, equity);
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
    if (peak > 0 && dd/peak > maxDDPct) maxDDPct = dd/peak;
    const d = new Date(t.entryTime).toISOString().slice(0,10);
    daily.set(d, (daily.get(d)||0) + t.netPnL);
  }
  const vals = Array.from(daily.values());
  const mean = vals.reduce((s,v)=>s+v,0)/Math.max(1,vals.length);
  const variance = vals.reduce((s,v)=>s+(v-mean)**2,0)/Math.max(1,vals.length);
  const std = Math.sqrt(variance);
  const sharpe = std > 0 ? (mean/std) * Math.sqrt(252) : 0;
  const wins = sorted.filter(t => t.netPnL > 0);
  const losses = sorted.filter(t => t.netPnL <= 0);
  const longs = sorted.filter(t => t.side === 'buy' || t.side === 'long');
  const shorts = sorted.filter(t => t.side === 'sell' || t.side === 'short');
  const wg = wins.reduce((s,t)=>s+t.netPnL,0);
  const lg = Math.abs(losses.reduce((s,t)=>s+t.netPnL,0));
  return {
    trades: sorted.length,
    longs: longs.length, shorts: shorts.length,
    wr: sorted.length ? +(wins.length/sorted.length*100).toFixed(1) : 0,
    longWR: longs.length ? +(longs.filter(t=>t.netPnL>0).length/longs.length*100).toFixed(1) : 0,
    shortWR: shorts.length ? +(shorts.filter(t=>t.netPnL>0).length/shorts.length*100).toFixed(1) : 0,
    pf: +(lg>0?wg/lg:0).toFixed(2),
    pnl: +equity.toFixed(0),
    longPnL: +longs.reduce((s,t)=>s+t.netPnL,0).toFixed(0),
    shortPnL: +shorts.reduce((s,t)=>s+t.netPnL,0).toFixed(0),
    maxDD: +maxDD.toFixed(0),
    maxDDPct: +(maxDDPct*100).toFixed(1),
    sharpe: +sharpe.toFixed(2),
  };
}

function load() {
  if (fs.existsSync(OUT)) return JSON.parse(fs.readFileSync(OUT, 'utf8'));
  return { completed: {}, pending: VARIANTS.map(v => v.key) };
}
function save(s) { fs.writeFileSync(OUT, JSON.stringify(s, null, 2)); }

async function main() {
  const state = load();
  const todo = VARIANTS.filter(v => !state.completed[v.key]);
  console.log(`Completed: ${Object.keys(state.completed).join(', ') || '(none)'}`);
  console.log(`To run: ${todo.map(v=>v.key).join(', ')}\n`);

  for (const v of todo) {
    console.log(`\n━━━ ${v.label} ━━━`);
    const t0 = Date.now();
    try {
      const engine = new BacktestEngine({
        ...baseConfig,
        strategyParams: { ...baseParams, ...v.p },
      });
      const r = await engine.run();
      const m = equityMetrics(r.trades);
      m.label = v.label;
      m.params = v.p;
      m.elapsedSec = Math.round((Date.now()-t0)/1000);
      state.completed[v.key] = m;
      state.pending = VARIANTS.filter(x => !state.completed[x.key]).map(x => x.key);
      save(state);
      console.log(`✅ ${v.key}: ${m.trades} (L${m.longs}/S${m.shorts}) | WR ${m.wr}% | PF ${m.pf} | $${m.pnl} | DD ${m.maxDDPct}% | Sharpe ${m.sharpe}`);
    } catch (e) {
      console.error(`❌ ${v.key} FAILED: ${e.message}`);
      state.completed[v.key] = { error: e.message };
      save(state);
    }
  }

  // Final table
  console.log('\n═══ FINAL COMPARISON ═══');
  const cols = ['Variant','Trades','L/S','WR%','LWR','SWR','PF','PnL','DD%','Sharpe'];
  console.log(cols.map(c => c.padEnd(9)).join('| '));
  console.log('-'.repeat(100));
  for (const v of VARIANTS) {
    const m = state.completed[v.key];
    if (!m || m.error) { console.log(v.key.padEnd(9) + '| ERROR'); continue; }
    const row = [
      v.key.substring(0,16).padEnd(16),
      String(m.trades).padStart(6),
      `${m.longs}/${m.shorts}`.padStart(7),
      String(m.wr).padStart(5),
      String(m.longWR).padStart(5),
      String(m.shortWR).padStart(5),
      String(m.pf).padStart(5),
      ('$'+m.pnl).padStart(8),
      String(m.maxDDPct).padStart(5),
      String(m.sharpe).padStart(6),
    ];
    console.log(row.join(' | '));
  }
  console.log(`\nResults saved to ${OUT}`);
}
main().catch(e => { console.error(e); process.exit(1); });
