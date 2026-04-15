/**
 * Level Quality Features — approach dynamics, not static snapshots.
 *
 * Tests whether "how price arrives at the level" predicts whether
 * the level holds (strategy wins) or breaks (strategy loses).
 *
 * Features:
 *   1. Approach velocity (N-bar ROC/ATR into entry)
 *   2. Total GEX magnitude + intraday GEX drift
 *   3. Call/put wall drift (dealer repositioning)
 *   4. Volume trajectory into entry
 *   5. ORB break state at entry time
 *
 * Runs against /tmp/ivskew-results.json — no backtest required.
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

// ─── OHLCV Loader (raw contracts, primary filter per hour) ───────────
function loadOHLCV() {
  const file = path.join(DATA_DIR, 'ohlcv', 'nq', 'NQ_ohlcv_1m.csv');
  console.log(`Loading OHLCV from ${file}...`);
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  const header = lines[0].split(',');
  const iTs = header.findIndex(h => h.includes('ts_event') || h.includes('timestamp'));
  const iO = header.findIndex(h => h.toLowerCase() === 'open');
  const iH = header.findIndex(h => h.toLowerCase() === 'high');
  const iL = header.findIndex(h => h.toLowerCase() === 'low');
  const iC = header.findIndex(h => h.toLowerCase() === 'close');
  const iV = header.findIndex(h => h.toLowerCase() === 'volume');
  const iSym = header.findIndex(h => h.toLowerCase() === 'symbol');

  const raw = [];
  const startMs = START_DATE.getTime();
  const endMs = END_DATE.getTime();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]; if (!line) continue;
    const cols = line.split(',');
    const sym = cols[iSym];
    if (!sym || sym.includes('-')) continue; // skip calendar spreads
    const tsRaw = cols[iTs];
    const ts = /^\d+$/.test(tsRaw) ? parseInt(tsRaw) : new Date(tsRaw).getTime();
    if (!Number.isFinite(ts) || ts < startMs || ts > endMs) continue;
    raw.push({
      ts, symbol: sym,
      open: +cols[iO], high: +cols[iH], low: +cols[iL], close: +cols[iC],
      volume: +cols[iV] || 0,
    });
  }
  raw.sort((a,b) => a.ts - b.ts);

  // Primary-contract filter per hour (pick highest-volume symbol in each hour bucket)
  const hourBuckets = new Map();
  for (const c of raw) {
    const hr = Math.floor(c.ts / 3600000);
    if (!hourBuckets.has(hr)) hourBuckets.set(hr, new Map());
    const vm = hourBuckets.get(hr);
    vm.set(c.symbol, (vm.get(c.symbol) || 0) + c.volume);
  }
  const primaryByHour = new Map();
  for (const [hr, vm] of hourBuckets) {
    let best = null, bestV = -1;
    for (const [sym, v] of vm) if (v > bestV) { bestV = v; best = sym; }
    primaryByHour.set(hr, best);
  }

  const filtered = raw.filter(c => primaryByHour.get(Math.floor(c.ts / 3600000)) === c.symbol);

  // Build minute-keyed index (floor to minute)
  const byMinute = new Map();
  for (const c of filtered) byMinute.set(Math.floor(c.ts / 60000), c);

  console.log(`  OHLCV: ${filtered.length} primary candles indexed`);
  return { sorted: filtered, byMinute };
}

// ─── Feature extractors ──────────────────────────────────────────────

// #1 & #4: look back N minutes of candles before entry
function getPriorCandles(ohlcv, ts, nBars) {
  const out = [];
  const startMin = Math.floor(ts / 60000) - nBars;
  for (let m = startMin; m < startMin + nBars; m++) {
    const c = ohlcv.byMinute.get(m);
    if (c) out.push(c);
  }
  return out;
}

function velocityFeatures(ohlcv, trade) {
  const ts = trade.entryTime;
  const entryPx = trade.actualEntry || trade.entryPrice;
  if (!entryPx) return {};
  const out = {};
  for (const n of [5, 10, 20]) {
    const prior = getPriorCandles(ohlcv, ts, n);
    if (prior.length < Math.floor(n * 0.7)) continue;
    const first = prior[0], last = prior[prior.length - 1];
    out[`roc_${n}`] = last.close - first.close; // raw pts moved
    // ATR approximation (avg true range)
    let tr = 0;
    for (let i = 1; i < prior.length; i++) {
      const p = prior[i], pp = prior[i-1];
      const r = Math.max(p.high - p.low, Math.abs(p.high - pp.close), Math.abs(p.low - pp.close));
      tr += r;
    }
    out[`atr_${n}`] = tr / Math.max(1, prior.length - 1);
    // signed directional travel toward entry
    if (trade.side === 'buy' || trade.side === 'long') {
      // long: we want to have bounced UP into entry (i.e., prior moved DOWN to support)
      out[`approach_dir_${n}`] = entryPx - first.close; // positive = price rose into entry
    } else {
      out[`approach_dir_${n}`] = first.close - entryPx; // positive = price fell into entry (for shorts at resistance, we want to have risen)
    }
  }
  return out;
}

function volumeFeatures(ohlcv, trade) {
  const ts = trade.entryTime;
  const out = {};
  const recent = getPriorCandles(ohlcv, ts, 10);
  const session = getPriorCandles(ohlcv, ts, 60);
  if (recent.length >= 7 && session.length >= 40) {
    const recentAvg = recent.reduce((s,c)=>s+c.volume,0) / recent.length;
    const sessionAvg = session.reduce((s,c)=>s+c.volume,0) / session.length;
    out.vol_10m_ratio = sessionAvg > 0 ? recentAvg / sessionAvg : null;
    // volume slope: are the last 10 bars rising or falling?
    const half = Math.floor(recent.length / 2);
    const firstHalf = recent.slice(0, half).reduce((s,c)=>s+c.volume,0) / half;
    const secondHalf = recent.slice(half).reduce((s,c)=>s+c.volume,0) / (recent.length - half);
    out.vol_slope_10m = firstHalf > 0 ? (secondHalf - firstHalf) / firstHalf : null;
  }
  return out;
}

// #5 ORB: compute RTH 30-min opening range (09:30-10:00 ET) from OHLCV for the trade's day.
// ET = UTC-4 (EDT) or UTC-5 (EST). Approximation: compute both offsets and pick the one that aligns.
// Simplest: use UTC 13:30-14:00 (EDT) then fall back to 14:30-15:00 (EST) when appropriate.
function orbFeatures(ohlcv, trade) {
  const ts = trade.entryTime;
  const d = new Date(ts);
  const dayKey = d.toISOString().slice(0,10);
  // Use UTC 13:30-14:00 as proxy (EDT); 5 months of EST will be off by 1hr, acceptable approximation.
  const orbStart = new Date(`${dayKey}T13:30:00Z`).getTime();
  const orbEnd = new Date(`${dayKey}T14:00:00Z`).getTime();
  let orbHigh = -Infinity, orbLow = Infinity, bars = 0;
  for (let t = orbStart; t < orbEnd; t += 60000) {
    const c = ohlcv.byMinute.get(Math.floor(t / 60000));
    if (c) { orbHigh = Math.max(orbHigh, c.high); orbLow = Math.min(orbLow, c.low); bars++; }
  }
  if (bars < 10) return {};
  const entryPx = trade.actualEntry || trade.entryPrice;
  const out = {
    orb_high: orbHigh, orb_low: orbLow,
    orb_range: orbHigh - orbLow,
    above_orb_high: entryPx > orbHigh ? 1 : 0,
    below_orb_low: entryPx < orbLow ? 1 : 0,
    inside_orb: (entryPx >= orbLow && entryPx <= orbHigh) ? 1 : 0,
    // Distance beyond ORB as % of ORB range
    orb_breakout_mag:
      entryPx > orbHigh ? (entryPx - orbHigh) / Math.max(1, orbHigh - orbLow) :
      entryPx < orbLow  ? (orbLow - entryPx) / Math.max(1, orbHigh - orbLow) : 0,
  };
  // Only relevant if trade is AFTER opening range
  out.orb_complete = ts > orbEnd ? 1 : 0;
  return out;
}

// GEX drift: compare wall positions & total_gex now vs N hours ago
function gexDriftFeatures(gexLoader, trade) {
  const ts = trade.entryTime;
  const now = gexLoader.getGexLevels(new Date(ts));
  const prior = gexLoader.getGexLevels(new Date(ts - 2 * 3600000)); // 2 hours prior
  const out = {};
  if (!now) return out;
  out.total_gex_entry = now.total_gex;
  if (prior) {
    if (now.call_wall != null && prior.call_wall != null) {
      out.call_wall_drift_2h = now.call_wall - prior.call_wall; // positive = rising (dealer bullish)
    }
    if (now.put_wall != null && prior.put_wall != null) {
      out.put_wall_drift_2h = now.put_wall - prior.put_wall;
    }
    if (now.total_gex != null && prior.total_gex != null) {
      out.gex_change_2h = now.total_gex - prior.total_gex;
      out.gex_change_2h_pct = prior.total_gex !== 0
        ? (now.total_gex - prior.total_gex) / Math.abs(prior.total_gex) * 100 : null;
    }
  }
  return out;
}

// ─── Statistics ──────────────────────────────────────────────────────
function mean(a) { return a.length ? a.reduce((s,v)=>s+v,0)/a.length : 0; }
function stdev(a) { const m=mean(a); return Math.sqrt(a.reduce((s,v)=>s+(v-m)**2,0)/a.length); }
function cohensD(g1, g2) {
  const s1 = stdev(g1), s2 = stdev(g2);
  const pooled = Math.sqrt((s1*s1 + s2*s2)/2);
  return pooled === 0 ? 0 : (mean(g1) - mean(g2)) / pooled;
}

function analyzeFilter(label, trades, filterFn) {
  const removed = trades.filter(filterFn);
  const kept = trades.filter(t => !filterFn(t));
  if (removed.length === 0) return null;
  const netRemoved = removed.reduce((s,t)=>s+t.netPnL,0);
  const keptWins = kept.filter(t=>t.netPnL>0);
  const keptLosses = kept.filter(t=>t.netPnL<=0);
  const kwg = keptWins.reduce((s,t)=>s+t.netPnL,0);
  const klg = Math.abs(keptLosses.reduce((s,t)=>s+t.netPnL,0));
  return {
    label, removed: removed.length, total: trades.length,
    winsRemoved: removed.filter(t=>t.netPnL>0).length,
    lossesRemoved: removed.filter(t=>t.netPnL<=0).length,
    winPnLSacrificed: removed.filter(t=>t.netPnL>0).reduce((s,t)=>s+t.netPnL,0),
    lossPnLAvoided: removed.filter(t=>t.netPnL<=0).reduce((s,t)=>s+t.netPnL,0),
    netPnLImpact: -netRemoved,
    newWR: kept.length ? (keptWins.length/kept.length*100) : 0,
    newPF: klg > 0 ? kwg/klg : Infinity,
    keptN: kept.length,
  };
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║  LEVEL QUALITY FEATURES — approach dynamics analysis     ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  const results = JSON.parse(fs.readFileSync(BACKTEST_JSON, 'utf8'));
  const allTrades = results.trades;
  const shorts = allTrades.filter(t => t.side === 'sell' || t.side === 'short');
  console.log(`Trades loaded: ${allTrades.length} (shorts: ${shorts.length})\n`);

  const ohlcv = loadOHLCV();

  const gexLoader = new GexLoader(path.join(DATA_DIR, 'gex'), 'nq');
  await gexLoader.loadDateRange(START_DATE, END_DATE);
  console.log(`  GEX: ${gexLoader.sortedTimestamps.length} snapshots\n`);

  console.log('Extracting features...');
  const tagged = shorts.map(t => {
    const f = {
      ...velocityFeatures(ohlcv, t),
      ...volumeFeatures(ohlcv, t),
      ...orbFeatures(ohlcv, t),
      ...gexDriftFeatures(gexLoader, t),
    };
    return { ...t, _f: f };
  });

  // Data coverage
  const featureNames = [
    'roc_5','roc_10','roc_20','atr_5','atr_10','atr_20',
    'approach_dir_5','approach_dir_10','approach_dir_20',
    'vol_10m_ratio','vol_slope_10m',
    'orb_range','above_orb_high','below_orb_low','inside_orb','orb_breakout_mag',
    'total_gex_entry','call_wall_drift_2h','put_wall_drift_2h','gex_change_2h','gex_change_2h_pct',
  ];
  console.log('\n── DATA COVERAGE ────────────────────────────────────');
  for (const f of featureNames) {
    const c = tagged.filter(t => t._f[f] != null).length;
    console.log(`  ${f.padEnd(24)} ${c}/${tagged.length} (${(c/tagged.length*100).toFixed(0)}%)`);
  }

  // Baseline
  const wins = tagged.filter(t => t.netPnL > 0);
  const losers = tagged.filter(t => t.netPnL <= 0);
  const basePnL = tagged.reduce((s,t)=>s+t.netPnL,0);
  const winPnL = wins.reduce((s,t)=>s+t.netPnL,0);
  const lossPnL = Math.abs(losers.reduce((s,t)=>s+t.netPnL,0));
  console.log(`\n── BASELINE (shorts) ────────────────────────────────`);
  console.log(`  ${tagged.length} trades | WR ${(wins.length/tagged.length*100).toFixed(1)}% | PnL $${basePnL.toFixed(0)} | PF ${(winPnL/lossPnL).toFixed(2)}`);

  // Cohen's d by feature
  console.log(`\n══ FEATURE EFFECT SIZE (winners vs losers) ══════════`);
  console.log(`${'Feature'.padEnd(24)} | ${'WinMean'.padStart(10)} | ${'LossMean'.padStart(10)} | ${'d'.padStart(7)} | Effect`);
  console.log('-'.repeat(70));
  const rows = [];
  for (const f of featureNames) {
    const wv = wins.map(t=>t._f[f]).filter(v=>v!=null);
    const lv = losers.map(t=>t._f[f]).filter(v=>v!=null);
    if (wv.length < 5 || lv.length < 5) continue;
    const d = cohensD(wv, lv);
    const abs = Math.abs(d);
    let eff = 'negligible';
    if (abs >= 0.8) eff = 'LARGE'; else if (abs >= 0.5) eff = 'MEDIUM'; else if (abs >= 0.2) eff = 'small';
    rows.push({ f, wm: mean(wv), lm: mean(lv), d, abs, eff });
  }
  rows.sort((a,b) => b.abs - a.abs);
  const fmt = v => Math.abs(v) > 1e6 ? (v/1e9).toFixed(2)+'B' : Math.abs(v) > 100 ? v.toFixed(0) : v.toFixed(4);
  for (const r of rows) {
    console.log(`${r.f.padEnd(24)} | ${fmt(r.wm).padStart(10)} | ${fmt(r.lm).padStart(10)} | ${r.d.toFixed(3).padStart(7)} | ${r.eff}`);
  }

  // Candidate filters
  console.log(`\n══ CANDIDATE FILTERS ═══════════════════════════════════`);
  const filters = [
    // Velocity
    ['Suppress short when ROC20 > +40 (strong up-move into entry)', t => t._f.roc_20 != null && t._f.roc_20 > 40],
    ['Suppress short when ROC20 > +60', t => t._f.roc_20 != null && t._f.roc_20 > 60],
    ['Suppress short when ROC10 > +25', t => t._f.roc_10 != null && t._f.roc_10 > 25],
    ['Suppress short when ATR5 > 8 (fast/spiky approach)', t => t._f.atr_5 != null && t._f.atr_5 > 8],
    // ORB
    ['Suppress short when above ORB high (trend day)', t => t._f.above_orb_high === 1 && t._f.orb_complete === 1],
    ['Suppress short when above ORB high AND ROC20 > +40', t => t._f.above_orb_high === 1 && t._f.roc_20 > 40],
    ['Suppress short when breakout_mag > 2x ORB range', t => t._f.orb_breakout_mag != null && t._f.orb_breakout_mag > 2],
    // Volume
    ['Suppress short when vol_10m_ratio > 1.5 (heavy)', t => t._f.vol_10m_ratio != null && t._f.vol_10m_ratio > 1.5],
    ['Suppress short when vol_slope_10m > +0.5 (accelerating)', t => t._f.vol_slope_10m != null && t._f.vol_slope_10m > 0.5],
    // GEX drift
    ['Suppress short when call_wall rising >20pts', t => t._f.call_wall_drift_2h != null && t._f.call_wall_drift_2h > 20],
    ['Suppress short when call_wall rising >50pts', t => t._f.call_wall_drift_2h != null && t._f.call_wall_drift_2h > 50],
    ['Suppress short when gex_change_2h > 0 (gamma increasing)', t => t._f.gex_change_2h != null && t._f.gex_change_2h > 0],
    ['Suppress short when total_gex_entry < -500M (deep neg gamma)', t => t._f.total_gex_entry != null && t._f.total_gex_entry < -500e6],
    // Composite
    ['Suppress short: above ORB + call wall rising', t => t._f.above_orb_high === 1 && t._f.call_wall_drift_2h > 0],
    ['Suppress short: above ORB + vol accelerating', t => t._f.above_orb_high === 1 && t._f.vol_slope_10m > 0.2],
    ['Suppress short: ROC20 > 40 + vol accelerating', t => t._f.roc_20 > 40 && t._f.vol_slope_10m > 0.2],
  ];
  const fr = [];
  for (const [label, fn] of filters) {
    const r = analyzeFilter(label, tagged, fn);
    if (r) fr.push(r);
  }
  fr.sort((a,b) => b.netPnLImpact - a.netPnLImpact);
  for (const r of fr) {
    console.log(`\n  ${r.label}`);
    console.log(`    Removed: ${r.removed}/${r.total} (${(r.removed/r.total*100).toFixed(0)}%)  | Wins sacrificed: ${r.winsRemoved} ($${r.winPnLSacrificed.toFixed(0)})  | Losses avoided: ${r.lossesRemoved} ($${r.lossPnLAvoided.toFixed(0)})`);
    console.log(`    Net impact: $${r.netPnLImpact.toFixed(0)} ${r.netPnLImpact > 0 ? '✓ HELPS' : '✗ HURTS'}  |  New WR: ${r.newWR.toFixed(1)}%  |  New PF: ${r.newPF.toFixed(2)}`);
  }

  console.log(`\n══ TOP FILTERS (net P&L improvement) ══════════════════`);
  const pos = fr.filter(r => r.netPnLImpact > 0);
  if (pos.length === 0) {
    console.log('  No filter helps. Level-approach features are not predictive on this trade set.');
  } else {
    for (const r of pos.slice(0, 8)) {
      console.log(`  +$${r.netPnLImpact.toFixed(0).padStart(7)}  ${r.label}`);
      console.log(`            (removes ${r.removed}, WR ${r.newWR.toFixed(1)}%, PF ${r.newPF.toFixed(2)})`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
