/**
 * Sub-analysis: shorts at rank 1, 3, or 4 call walls
 *
 * From wall-magnitude analysis:
 *   rank 0: 42 trades, 83% WR, PF 10.66 — GOLD
 *   rank 1: 31 trades, 45% WR, PF 2.84 — BAD
 *   rank 2: 35 trades, 77% WR, PF 8.35 — great
 *   rank 3: 31 trades, 45% WR, PF 2.06 — BAD
 *   rank 4: 44 trades, 54% WR, PF 2.33 — mediocre
 *
 * Goal: find features that separate winners from losers WITHIN the
 * rank-1/3/4 bucket (106 trades at ~49% WR) to tighten short-side scoring.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GexLoader } from '../src/data-loaders/gex-loader.js';
import { IVLoader } from '../src/data-loaders/iv-loader.js';
import { ShortDTEIVLoader } from '../src/data-loaders/short-dte-iv-loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const BACKTEST_JSON = '/tmp/ivskew-results.json';
const START_DATE = new Date('2025-01-13');
const END_DATE = new Date('2026-01-23');

// ─── OHLCV loader (primary contract per hour) ─────────────────────
function loadOHLCV() {
  const file = path.join(DATA_DIR, 'ohlcv', 'nq', 'NQ_ohlcv_1m.csv');
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
  const startMs = START_DATE.getTime(), endMs = END_DATE.getTime();
  const raw = [];
  for (let i = 1; i < lines.length; i++) {
    const ln = lines[i]; if (!ln) continue;
    const cols = ln.split(',');
    const sym = cols[iSym]; if (!sym || sym.includes('-')) continue;
    const tsRaw = cols[iTs];
    const ts = /^\d+$/.test(tsRaw) ? parseInt(tsRaw) : new Date(tsRaw).getTime();
    if (!Number.isFinite(ts) || ts < startMs || ts > endMs) continue;
    raw.push({ ts, symbol: sym, open:+cols[iO], high:+cols[iH], low:+cols[iL], close:+cols[iC], volume:+cols[iV]||0 });
  }
  raw.sort((a,b)=>a.ts-b.ts);
  const hourBuckets = new Map();
  for (const c of raw) {
    const hr = Math.floor(c.ts/3600000);
    if (!hourBuckets.has(hr)) hourBuckets.set(hr, new Map());
    const vm = hourBuckets.get(hr);
    vm.set(c.symbol, (vm.get(c.symbol)||0)+c.volume);
  }
  const primary = new Map();
  for (const [hr, vm] of hourBuckets) {
    let best=null, bv=-1;
    for (const [s,v] of vm) if (v>bv){bv=v;best=s;}
    primary.set(hr, best);
  }
  const byMin = new Map();
  for (const c of raw) if (primary.get(Math.floor(c.ts/3600000)) === c.symbol) byMin.set(Math.floor(c.ts/60000), c);
  return byMin;
}
function priorBars(byMin, ts, n) {
  const out = [];
  const start = Math.floor(ts/60000) - n;
  for (let m=start; m<start+n; m++) { const c=byMin.get(m); if (c) out.push(c); }
  return out;
}

// ─── Feature extraction ────────────────────────────────────────────
function extract(trade, gexLoader, ivLoader, sdivLoader, ohlcv) {
  const ts = trade.entryTime;
  const f = {};
  const snap = gexLoader.getGexLevels(new Date(ts));
  const price = trade.actualEntry || trade.entryPrice;

  if (snap) {
    f.call_wall_gex = snap.call_wall_gex;
    f.put_wall_gex = snap.put_wall_gex != null ? Math.abs(snap.put_wall_gex) : null;
    f.gamma_above_spot = snap.gamma_above_spot;
    f.gamma_below_spot = snap.gamma_below_spot;
    f.gamma_imbalance = snap.gamma_imbalance;
    f.total_gex = snap.total_gex;
    if (snap.call_wall != null && price) f.call_wall_distance = snap.call_wall - price;
    if (snap.put_wall != null && price) f.put_wall_distance = price - snap.put_wall;
    if (snap.gamma_flip != null && price) f.gamma_flip_distance = price - snap.gamma_flip;
    if (snap.call_wall != null && snap.put_wall != null && price) {
      f.wall_spread = snap.call_wall - snap.put_wall;
      f.price_in_wall_range = (price - snap.put_wall) / (snap.call_wall - snap.put_wall);
    }
    // Call-wall concentration
    if (Array.isArray(snap.resistance_gex) && snap.resistance_gex.length >= 2) {
      const top = Math.abs(snap.resistance_gex[0]);
      const rest = snap.resistance_gex.slice(1).reduce((s,v)=>s+Math.abs(v),0) / (snap.resistance_gex.length-1);
      f.call_wall_concentration = rest > 0 ? top/rest : null;
    }
    // Trade-level (resistance side for shorts)
    const sig = trade.signal || {};
    if (sig.levelPrice != null && sig.levelCategory === 'resistance') {
      let bi=-1, bd=Infinity;
      for (let i=0; i<snap.resistance.length; i++) {
        const d = Math.abs(snap.resistance[i] - sig.levelPrice);
        if (d < bd) { bd=d; bi=i; }
      }
      if (bi >= 0 && bd < 50) {
        f.trade_level_gex = Math.abs(snap.resistance_gex[bi]);
        f.trade_level_rank = bi;
        const top = Math.abs(snap.resistance_gex[0]);
        f.trade_level_dominance = top > 0 ? f.trade_level_gex / top : null;
        // How much bigger is rank-0 than rank-k?
        f.rank_gap_to_primary = top - f.trade_level_gex;
      }
    }
  }

  const iv = ivLoader.getIVAtTime(ts);
  if (iv) { f.iv_value = iv.iv; f.iv_skew = iv.skew; f.call_iv = iv.callIV; f.put_iv = iv.putIV; }

  const sdiv = sdivLoader.getIVAtTime(ts);
  if (sdiv) {
    f.dte0_avg_iv = sdiv.dte0_avg_iv;
    f.dte0_skew = sdiv.dte0_skew;
    f.term_slope = sdiv.term_slope;
  }
  const win = sdivLoader.getIVWindow(ts, 3);
  if (win.length >= 2) {
    const a = win[0], b = win[win.length-1];
    if (a.dte0_avg_iv != null && b.dte0_avg_iv != null) f.dte0_iv_change = b.dte0_avg_iv - a.dte0_avg_iv;
  }

  // Price action
  for (const n of [5, 10, 20]) {
    const p = priorBars(ohlcv, ts, n);
    if (p.length < Math.floor(n*0.7)) continue;
    f[`roc_${n}`] = p[p.length-1].close - p[0].close;
    let tr = 0;
    for (let i=1; i<p.length; i++) {
      const c=p[i], pp=p[i-1];
      tr += Math.max(c.high-c.low, Math.abs(c.high-pp.close), Math.abs(c.low-pp.close));
    }
    f[`atr_${n}`] = tr / Math.max(1, p.length-1);
  }
  const recent = priorBars(ohlcv, ts, 10);
  const session = priorBars(ohlcv, ts, 60);
  if (recent.length >= 7 && session.length >= 40) {
    const ra = recent.reduce((s,c)=>s+c.volume,0)/recent.length;
    const sa = session.reduce((s,c)=>s+c.volume,0)/session.length;
    f.vol_10m_ratio = sa > 0 ? ra/sa : null;
  }

  const d = new Date(ts);
  f.utc_hour = d.getUTCHours();
  f.day_of_week = d.getUTCDay();

  return f;
}

// ─── Stats ────────────────────────────────────────────────────────
const mean = a => a.length ? a.reduce((s,v)=>s+v,0)/a.length : 0;
const stdev = a => { const m=mean(a); return Math.sqrt(a.reduce((s,v)=>s+(v-m)**2,0)/a.length); };
function cohensD(g1, g2) {
  const s1=stdev(g1), s2=stdev(g2), p=Math.sqrt((s1*s1+s2*s2)/2);
  return p === 0 ? 0 : (mean(g1)-mean(g2))/p;
}

function bucketAnalysis(trades, feat, buckets, label) {
  console.log(`\n── ${label || feat} ──`);
  console.log(`${'Range'.padEnd(18)} | ${'N'.padStart(4)} | ${'WR%'.padStart(5)} | ${'PF'.padStart(5)} | ${'Total$'.padStart(9)}`);
  console.log('-'.repeat(56));
  for (let i=0; i<buckets.length-1; i++) {
    const lo=buckets[i], hi=buckets[i+1];
    const b = trades.filter(t => t._f[feat] != null && t._f[feat] >= lo && t._f[feat] < hi);
    if (b.length < 4) continue;
    const w=b.filter(t=>t.netPnL>0), l=b.filter(t=>t.netPnL<=0);
    const wg=w.reduce((s,t)=>s+t.netPnL,0), lg=Math.abs(l.reduce((s,t)=>s+t.netPnL,0));
    const pf = lg>0?wg/lg:Infinity;
    const tot = b.reduce((s,t)=>s+t.netPnL,0);
    const fmt = v => Math.abs(v)>=1e9?(v/1e9).toFixed(2)+'B':Math.abs(v)>=1e6?(v/1e6).toFixed(0)+'M':v.toFixed(2);
    console.log(`${(fmt(lo)+'→'+fmt(hi)).padEnd(18)} | ${String(b.length).padStart(4)} | ${(w.length/b.length*100).toFixed(1).padStart(4)}% | ${pf.toFixed(2).padStart(5)} | $${tot.toFixed(0).padStart(8)}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────
async function main() {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║  Short drill: rank 1/3/4 call walls (~49% WR bucket)       ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  const results = JSON.parse(fs.readFileSync(BACKTEST_JSON, 'utf8'));
  const shorts = results.trades.filter(t => t.side === 'sell' || t.side === 'short');

  console.log('Loading data...');
  const gexLoader = new GexLoader(path.join(DATA_DIR, 'gex'), 'nq');
  await gexLoader.loadDateRange(START_DATE, END_DATE);
  const ivLoader = new IVLoader(DATA_DIR, { resolution: '1m' });
  await ivLoader.load(START_DATE, END_DATE);
  const sdivLoader = new ShortDTEIVLoader(DATA_DIR);
  await sdivLoader.load(START_DATE, END_DATE);
  const ohlcv = loadOHLCV();
  console.log('Done.\n');

  const tagged = shorts.map(t => ({ ...t, _f: extract(t, gexLoader, ivLoader, sdivLoader, ohlcv) }));
  const bucket = tagged.filter(t =>
    t._f.trade_level_rank != null &&
    (t._f.trade_level_rank === 1 || t._f.trade_level_rank === 3 || t._f.trade_level_rank === 4)
  );
  console.log(`Shorts total: ${tagged.length}`);
  console.log(`Target bucket (rank 1/3/4 walls): ${bucket.length}`);

  const wins = bucket.filter(t => t.netPnL > 0);
  const losers = bucket.filter(t => t.netPnL <= 0);
  const wg = wins.reduce((s,t)=>s+t.netPnL,0);
  const lg = Math.abs(losers.reduce((s,t)=>s+t.netPnL,0));
  console.log(`Bucket: ${bucket.length} trades | WR ${(wins.length/bucket.length*100).toFixed(1)}% | PF ${(wg/lg).toFixed(2)} | PnL $${(wg-lg).toFixed(0)}\n`);

  const features = [
    'call_wall_gex','put_wall_gex','call_wall_concentration',
    'trade_level_gex','trade_level_dominance','rank_gap_to_primary',
    'gamma_imbalance','gamma_above_spot','gamma_below_spot','total_gex',
    'call_wall_distance','put_wall_distance','gamma_flip_distance','wall_spread','price_in_wall_range',
    'iv_value','iv_skew','call_iv','put_iv',
    'dte0_avg_iv','dte0_skew','term_slope','dte0_iv_change',
    'roc_5','roc_10','roc_20','atr_5','atr_10','atr_20',
    'vol_10m_ratio','utc_hour','day_of_week',
  ];
  console.log('── EFFECT SIZE (winners vs losers within bucket) ──');
  console.log(`${'Feature'.padEnd(26)} | ${'WinMean'.padStart(12)} | ${'LossMean'.padStart(12)} | ${'d'.padStart(6)} | Effect`);
  console.log('-'.repeat(80));
  const rows = [];
  for (const f of features) {
    const wv = wins.map(t=>t._f[f]).filter(v=>v!=null);
    const lv = losers.map(t=>t._f[f]).filter(v=>v!=null);
    if (wv.length < 5 || lv.length < 5) continue;
    const d = cohensD(wv, lv);
    rows.push({ f, wm: mean(wv), lm: mean(lv), d, abs: Math.abs(d) });
  }
  rows.sort((a,b) => b.abs - a.abs);
  const fmt = v => Math.abs(v)>=1e9?(v/1e9).toFixed(2)+'B':Math.abs(v)>=1e6?(v/1e6).toFixed(0)+'M':v.toFixed(4);
  for (const r of rows) {
    let eff='negligible';
    if (r.abs >= 0.8) eff='LARGE'; else if (r.abs >= 0.5) eff='MEDIUM'; else if (r.abs >= 0.2) eff='small';
    console.log(`${r.f.padEnd(26)} | ${fmt(r.wm).padStart(12)} | ${fmt(r.lm).padStart(12)} | ${r.d.toFixed(3).padStart(6)} | ${eff}`);
  }

  const topFeats = rows.slice(0, 10).map(r => r.f);
  console.log(`\n══ TOP 10 FEATURE BUCKETS ══════════════════`);
  const genericBuckets = {
    call_wall_gex: [0, 100e6, 250e6, 500e6, 1e9, 2e9, 10e9],
    put_wall_gex: [0, 100e6, 250e6, 500e6, 1e9, 2e9, 10e9],
    call_wall_concentration: [0, 1, 1.5, 2, 3, 5, 20],
    trade_level_gex: [0, 50e6, 100e6, 250e6, 500e6, 1e9, 10e9],
    trade_level_dominance: [0, 0.1, 0.25, 0.5, 0.75, 1],
    rank_gap_to_primary: [0, 100e6, 250e6, 500e6, 1e9, 5e9],
    gamma_imbalance: [-1, -0.5, -0.2, 0, 0.2, 0.5, 1],
    gamma_above_spot: [0, 500e6, 1e9, 2e9, 3e9, 5e9, 10e9],
    gamma_below_spot: [0, 500e6, 1e9, 2e9, 3e9, 5e9, 10e9],
    total_gex: [-10e9, -1e9, -500e6, 0, 500e6, 1e9, 5e9, 10e9],
    call_wall_distance: [0, 50, 100, 200, 400, 800, 5000],
    put_wall_distance: [0, 50, 100, 200, 400, 800, 5000],
    gamma_flip_distance: [-5000, -500, -200, 0, 200, 500, 5000],
    wall_spread: [0, 200, 500, 1000, 2000, 5000],
    price_in_wall_range: [0, 0.2, 0.4, 0.6, 0.8, 1.0, 2.0],
    iv_value: [0.1, 0.15, 0.18, 0.22, 0.25, 0.3, 0.5],
    iv_skew: [-0.1, -0.02, -0.01, 0, 0.01, 0.02, 0.1],
    dte0_avg_iv: [0.1, 0.2, 0.25, 0.3, 0.35, 0.5],
    dte0_skew: [-0.05, -0.01, 0, 0.01, 0.05],
    term_slope: [-0.2, -0.05, 0, 0.05, 0.2],
    dte0_iv_change: [-0.05, -0.01, -0.003, 0, 0.003, 0.01, 0.05],
    roc_5:  [-50, -10, -3, 0, 3, 10, 50],
    roc_10: [-80, -20, -5, 0, 5, 20, 80],
    roc_20: [-120, -30, -10, 0, 10, 30, 120],
    atr_5: [0, 4, 7, 10, 15, 30],
    atr_10: [0, 4, 7, 10, 15, 30],
    atr_20: [0, 4, 7, 10, 15, 30],
    vol_10m_ratio: [0, 0.5, 1, 1.5, 2, 5],
    utc_hour: [0,4,8,12,14,16,18,20,24],
    day_of_week: [0,1,2,3,4,5,6,7],
  };
  for (const f of topFeats) if (genericBuckets[f]) bucketAnalysis(bucket, f, genericBuckets[f]);
}

main().catch(e => { console.error(e); process.exit(1); });
