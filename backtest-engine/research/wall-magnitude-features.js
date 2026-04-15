/**
 * Wall Magnitude & Gamma Imbalance Features
 *
 * Tests whether the *size* of the GEX wall the strategy traded against
 * predicts outcome. Also tests gamma imbalance (above vs below spot)
 * and whether the specific level was the primary wall or a weak backup.
 *
 * Requires regenerated GEX snapshots with call_wall_gex, put_wall_gex,
 * resistance_gex[], support_gex[], gamma_above_spot, gamma_below_spot,
 * gamma_imbalance fields (see scripts/generate-intraday-gex.py).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GexLoader } from '../src/data-loaders/gex-loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

const BACKTEST_JSON = process.argv.includes('--json')
  ? process.argv[process.argv.indexOf('--json') + 1]
  : '/tmp/ivskew-results.json';
const START_DATE = new Date('2025-01-13');
const END_DATE = new Date('2026-01-23');

// ─── Feature extraction ──────────────────────────────────────────────
function extractFeatures(trade, gexLoader) {
  const ts = trade.entryTime;
  const snap = gexLoader.getGexLevels(new Date(ts));
  const f = {};
  if (!snap) return f;

  // Raw magnitudes (scaled to $B for readability in logs; keep raw for stats)
  f.call_wall_gex = snap.call_wall_gex;
  f.put_wall_gex = snap.put_wall_gex;
  f.gamma_above_spot = snap.gamma_above_spot;
  f.gamma_below_spot = snap.gamma_below_spot;
  f.gamma_imbalance = snap.gamma_imbalance;

  // Absolute wall magnitude (side-agnostic "how big is the primary wall trade is up against")
  const side = (trade.side === 'sell' || trade.side === 'short') ? 'short' : 'long';
  // Shorts trade at resistance (call wall side). Longs trade at support (put wall side).
  if (side === 'short' && snap.call_wall_gex != null) {
    f.primary_wall_gex = snap.call_wall_gex;
  } else if (side === 'long' && snap.put_wall_gex != null) {
    f.primary_wall_gex = Math.abs(snap.put_wall_gex); // put wall is negative
  }

  // Trade-level gamma: find which level in resistance[]/support[] matches the signal's levelPrice
  const signal = trade.signal || {};
  const levelPrice = signal.levelPrice;
  const levelCategory = signal.levelCategory; // 'resistance' | 'support'
  if (levelPrice != null) {
    const levelArr = levelCategory === 'resistance' ? snap.resistance : snap.support;
    const gexArr = levelCategory === 'resistance' ? snap.resistance_gex : snap.support_gex;
    if (Array.isArray(levelArr) && Array.isArray(gexArr)) {
      // Find closest level by price
      let bestIdx = -1, bestDist = Infinity;
      for (let i = 0; i < levelArr.length; i++) {
        const d = Math.abs(levelArr[i] - levelPrice);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
      if (bestIdx >= 0 && bestDist < 50) { // must match within 50pts
        f.trade_level_gex = Math.abs(gexArr[bestIdx]);
        f.trade_level_rank = bestIdx; // 0 = primary wall, 4 = weakest top-5
        // Ratio: how dominant is this level vs primary?
        const primaryAbs = Math.abs(gexArr[0]);
        f.trade_level_dominance = primaryAbs > 0 ? f.trade_level_gex / primaryAbs : null;
      }
    }
  }

  // Gamma imbalance interpreted from trade perspective
  // For shorts: we want gamma_above_spot > gamma_below_spot (sticky resistance). imbalance positive = good for short.
  // For longs: we want gamma_below_spot > gamma_above_spot. imbalance negative = good for long.
  if (f.gamma_imbalance != null) {
    f.imbalance_favorable = side === 'short' ? f.gamma_imbalance : -f.gamma_imbalance;
  }

  // Relative wall magnitude (vs other walls)
  if (Array.isArray(snap.resistance_gex) && snap.resistance_gex.length >= 2) {
    const top = Math.abs(snap.resistance_gex[0]);
    const avgRest = snap.resistance_gex.slice(1).reduce((s,v)=>s+Math.abs(v),0) / (snap.resistance_gex.length - 1);
    f.call_wall_concentration = avgRest > 0 ? top / avgRest : null;
  }
  if (Array.isArray(snap.support_gex) && snap.support_gex.length >= 2) {
    const top = Math.abs(snap.support_gex[0]);
    const avgRest = snap.support_gex.slice(1).reduce((s,v)=>s+Math.abs(v),0) / (snap.support_gex.length - 1);
    f.put_wall_concentration = avgRest > 0 ? top / avgRest : null;
  }

  return f;
}

// ─── Statistics ──────────────────────────────────────────────────────
const mean = a => a.length ? a.reduce((s,v)=>s+v,0)/a.length : 0;
const median = a => { const s=[...a].sort((x,y)=>x-y); return s[Math.floor(s.length/2)] || 0; };
const stdev = a => { const m=mean(a); return Math.sqrt(a.reduce((s,v)=>s+(v-m)**2,0)/a.length); };
function cohensD(g1, g2) {
  const s1=stdev(g1), s2=stdev(g2), p=Math.sqrt((s1*s1+s2*s2)/2);
  return p === 0 ? 0 : (mean(g1)-mean(g2))/p;
}

function analyzeFilter(label, trades, filterFn) {
  const removed = trades.filter(filterFn);
  const kept = trades.filter(t => !filterFn(t));
  if (removed.length === 0) return null;
  const netRemoved = removed.reduce((s,t)=>s+t.netPnL,0);
  const kw = kept.filter(t=>t.netPnL>0), kl = kept.filter(t=>t.netPnL<=0);
  const kwg = kw.reduce((s,t)=>s+t.netPnL,0), klg = Math.abs(kl.reduce((s,t)=>s+t.netPnL,0));
  return {
    label, removed: removed.length, total: trades.length,
    winsRemoved: removed.filter(t=>t.netPnL>0).length,
    lossesRemoved: removed.filter(t=>t.netPnL<=0).length,
    winPnLSacrificed: removed.filter(t=>t.netPnL>0).reduce((s,t)=>s+t.netPnL,0),
    lossPnLAvoided: removed.filter(t=>t.netPnL<=0).reduce((s,t)=>s+t.netPnL,0),
    netPnLImpact: -netRemoved,
    newWR: kept.length ? (kw.length/kept.length*100) : 0,
    newPF: klg > 0 ? kwg/klg : Infinity,
    keptN: kept.length,
  };
}

function bucketAnalysis(trades, featName, buckets) {
  console.log(`\n── Bucket analysis: ${featName} ───────────────────────`);
  console.log(`${'Range'.padEnd(20)} | ${'N'.padStart(4)} | ${'WR%'.padStart(6)} | ${'PF'.padStart(6)} | ${'AvgPnL'.padStart(8)} | ${'TotalPnL'.padStart(10)}`);
  console.log('-'.repeat(72));
  for (let i = 0; i < buckets.length - 1; i++) {
    const lo = buckets[i], hi = buckets[i+1];
    const b = trades.filter(t => t._f[featName] != null && t._f[featName] >= lo && t._f[featName] < hi);
    if (b.length < 3) continue;
    const w = b.filter(t => t.netPnL > 0);
    const l = b.filter(t => t.netPnL <= 0);
    const wg = w.reduce((s,t)=>s+t.netPnL,0);
    const lg = Math.abs(l.reduce((s,t)=>s+t.netPnL,0));
    const pf = lg > 0 ? wg/lg : Infinity;
    const tot = b.reduce((s,t)=>s+t.netPnL,0);
    const avg = tot / b.length;
    const fmt = v => Math.abs(v) >= 1e9 ? (v/1e9).toFixed(2)+'B' : Math.abs(v) >= 1e6 ? (v/1e6).toFixed(0)+'M' : v.toFixed(2);
    const label = `${fmt(lo)}–${fmt(hi)}`;
    console.log(`${label.padEnd(20)} | ${String(b.length).padStart(4)} | ${(w.length/b.length*100).toFixed(1).padStart(5)}% | ${pf.toFixed(2).padStart(6)} | $${avg.toFixed(0).padStart(6)} | $${tot.toFixed(0).padStart(8)}`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║  WALL MAGNITUDE & GAMMA IMBALANCE FEATURES                ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  const results = JSON.parse(fs.readFileSync(BACKTEST_JSON, 'utf8'));
  const allTrades = results.trades;
  const shorts = allTrades.filter(t => t.side === 'sell' || t.side === 'short');
  const longs  = allTrades.filter(t => t.side === 'buy'  || t.side === 'long');
  console.log(`Trades loaded: ${allTrades.length} (shorts: ${shorts.length}, longs: ${longs.length})\n`);

  const gexLoader = new GexLoader(path.join(DATA_DIR, 'gex'), 'nq');
  await gexLoader.loadDateRange(START_DATE, END_DATE);
  console.log(`GEX snapshots: ${gexLoader.sortedTimestamps.length}\n`);

  const tagShorts = shorts.map(t => ({ ...t, _f: extractFeatures(t, gexLoader) }));
  const tagLongs  = longs.map(t => ({ ...t, _f: extractFeatures(t, gexLoader) }));

  function printForSide(label, tagged) {
    console.log(`\n═══════════════════════════════════════════════════════════`);
    console.log(`  ${label.toUpperCase()}`);
    console.log(`═══════════════════════════════════════════════════════════`);

    const features = [
      'primary_wall_gex', 'trade_level_gex', 'trade_level_rank', 'trade_level_dominance',
      'gamma_above_spot', 'gamma_below_spot', 'gamma_imbalance', 'imbalance_favorable',
      'call_wall_concentration', 'put_wall_concentration',
    ];
    console.log('\n── DATA COVERAGE ───────────────────');
    for (const f of features) {
      const c = tagged.filter(t => t._f[f] != null).length;
      console.log(`  ${f.padEnd(26)} ${c}/${tagged.length} (${(c/tagged.length*100).toFixed(0)}%)`);
    }

    const wins = tagged.filter(t => t.netPnL > 0);
    const losers = tagged.filter(t => t.netPnL <= 0);
    const wg = wins.reduce((s,t)=>s+t.netPnL,0);
    const lg = Math.abs(losers.reduce((s,t)=>s+t.netPnL,0));
    console.log(`\n── BASELINE ───────────────────────`);
    console.log(`  ${tagged.length} trades | WR ${(wins.length/tagged.length*100).toFixed(1)}% | PnL $${tagged.reduce((s,t)=>s+t.netPnL,0).toFixed(0)} | PF ${(wg/lg).toFixed(2)}`);

    // Effect sizes
    console.log('\n── FEATURE EFFECT SIZE (winners vs losers) ─────────');
    console.log(`${'Feature'.padEnd(26)} | ${'WinMean'.padStart(12)} | ${'LossMean'.padStart(12)} | ${'d'.padStart(7)} | Effect`);
    console.log('-'.repeat(80));
    const rows = [];
    for (const f of features) {
      const wv = wins.map(t => t._f[f]).filter(v => v != null);
      const lv = losers.map(t => t._f[f]).filter(v => v != null);
      if (wv.length < 5 || lv.length < 5) continue;
      const d = cohensD(wv, lv);
      rows.push({ f, wm: mean(wv), lm: mean(lv), d, abs: Math.abs(d) });
    }
    rows.sort((a,b) => b.abs - a.abs);
    const fmt = v => Math.abs(v) >= 1e9 ? (v/1e9).toFixed(2)+'B' : Math.abs(v) >= 1e6 ? (v/1e6).toFixed(0)+'M' : v.toFixed(4);
    for (const r of rows) {
      let eff = 'negligible';
      if (r.abs >= 0.8) eff = 'LARGE'; else if (r.abs >= 0.5) eff = 'MEDIUM'; else if (r.abs >= 0.2) eff = 'small';
      console.log(`${r.f.padEnd(26)} | ${fmt(r.wm).padStart(12)} | ${fmt(r.lm).padStart(12)} | ${r.d.toFixed(3).padStart(7)} | ${eff}`);
    }

    // Bucket analyses for key features
    bucketAnalysis(tagged, 'primary_wall_gex', [0, 100e6, 250e6, 500e6, 1e9, 2e9, 10e9]);
    bucketAnalysis(tagged, 'trade_level_gex', [0, 50e6, 100e6, 250e6, 500e6, 1e9, 10e9]);
    bucketAnalysis(tagged, 'gamma_imbalance', [-1, -0.5, -0.2, 0, 0.2, 0.5, 1]);
    bucketAnalysis(tagged, 'imbalance_favorable', [-1, -0.5, -0.2, 0, 0.2, 0.5, 1]);
    bucketAnalysis(tagged, 'trade_level_rank', [0, 1, 2, 3, 4, 5]);
    bucketAnalysis(tagged, 'trade_level_dominance', [0, 0.25, 0.5, 0.75, 1.0, 1.5]);

    // Filter proposals
    console.log('\n── CANDIDATE FILTERS ───────────────────');
    const filters = [
      [`Suppress when trade_level_gex < 100M (weak wall)`, t => t._f.trade_level_gex != null && t._f.trade_level_gex < 100e6],
      [`Suppress when trade_level_gex < 250M`, t => t._f.trade_level_gex != null && t._f.trade_level_gex < 250e6],
      [`Suppress when trade_level_rank >= 3 (bottom-2 of top-5)`, t => t._f.trade_level_rank != null && t._f.trade_level_rank >= 3],
      [`Suppress when trade_level_dominance < 0.25 (much weaker than primary)`, t => t._f.trade_level_dominance != null && t._f.trade_level_dominance < 0.25],
      [`Suppress when primary_wall_gex < 250M`, t => t._f.primary_wall_gex != null && t._f.primary_wall_gex < 250e6],
      [`Suppress when imbalance_favorable < -0.3 (gamma against trade)`, t => t._f.imbalance_favorable != null && t._f.imbalance_favorable < -0.3],
      [`Suppress when imbalance_favorable < 0 (gamma against trade)`, t => t._f.imbalance_favorable != null && t._f.imbalance_favorable < 0],
    ];
    const fr = [];
    for (const [label, fn] of filters) {
      const r = analyzeFilter(label, tagged, fn);
      if (r) fr.push(r);
    }
    fr.sort((a,b) => b.netPnLImpact - a.netPnLImpact);
    for (const r of fr) {
      const mark = r.netPnLImpact > 0 ? '✓ HELPS' : '✗ HURTS';
      console.log(`\n  ${r.label}`);
      console.log(`    Removed: ${r.removed}/${r.total} (${(r.removed/r.total*100).toFixed(0)}%) | W/L removed: ${r.winsRemoved}/${r.lossesRemoved}`);
      console.log(`    Net: $${r.netPnLImpact.toFixed(0)} ${mark} | New WR: ${r.newWR.toFixed(1)}% | New PF: ${r.newPF.toFixed(2)}`);
    }
  }

  printForSide('Shorts', tagShorts);
  printForSide('Longs', tagLongs);
}

main().catch(e => { console.error(e); process.exit(1); });
