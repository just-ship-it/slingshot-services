#!/usr/bin/env node
/**
 * T11 — filter sweep: take signals from T11-vwap.json, re-load NQ candles,
 * and run grid search on FILTERED subsets to compare to unfiltered.
 *
 * NOTE: this script reproduces simulation logic from T11-vwap.js but operates
 * on already-discovered signals (faster).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import csv from 'csv-parser';

import { CSVLoader } from '../../src/data/csv-loader.js';
import { toET, fromET } from '../utils/data-loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const NQ_OHLCV_PATH = path.join(REPO_ROOT, 'data', 'ohlcv', 'nq', 'NQ_ohlcv_1m.csv');
const T11_JSON = path.join(__dirname, 'output', 'T11-vwap.json');
const OUTPUT = path.join(__dirname, 'output', 'T11-filter-grid.json');

const START_DATE = '2025-01-13';
const END_DATE   = '2026-04-23';
const OOS_START  = '2026-02-23';

function round(x, d = 2) {
  if (x == null || isNaN(x)) return null;
  const m = Math.pow(10, d);
  return Math.round(x * m) / m;
}

async function loadCandles() {
  const start = new Date(START_DATE + 'T00:00:00Z').getTime() - 24*3600000;
  const end = new Date(END_DATE + 'T23:59:59Z').getTime();
  const candles = [];
  await new Promise((resolve, reject) => {
    fs.createReadStream(NQ_OHLCV_PATH)
      .pipe(csv())
      .on('data', (row) => {
        if (row.symbol && row.symbol.includes('-')) return;
        const ts = new Date(row.ts_event).getTime();
        if (isNaN(ts) || ts < start || ts > end) return;
        const o = parseFloat(row.open);
        const h = parseFloat(row.high);
        const l = parseFloat(row.low);
        const c = parseFloat(row.close);
        if (isNaN(o) || isNaN(c)) return;
        candles.push({ timestamp: ts, open: o, high: h, low: l, close: c, volume: parseFloat(row.volume) || 0, symbol: row.symbol });
      })
      .on('end', resolve)
      .on('error', reject);
  });
  const loader = new CSVLoader();
  const filtered = loader.filterPrimaryContract(candles);
  filtered.sort((a,b) => a.timestamp - b.timestamp);
  return filtered;
}

function simulate(candles, signal, stopPts, targetPts, timeStopMin) {
  const dir = signal.type.endsWith('long') ? 'long' : 'short';
  const stopPrice = dir === 'long' ? signal.entryPrice - stopPts : signal.entryPrice + stopPts;
  const tgtPrice  = dir === 'long' ? signal.entryPrice + targetPts : signal.entryPrice - targetPts;
  const endTs = signal.entryTs + timeStopMin * 60000;
  let lastClose = signal.entryPrice;
  for (const c of candles) {
    if (c.timestamp <= signal.entryTs) continue;
    if (c.timestamp > endTs) break;
    lastClose = c.close;
    if (dir === 'long') {
      if (c.low <= stopPrice) return { exit: 'stop', pnlPts: -stopPts };
      if (c.high >= tgtPrice) return { exit: 'target', pnlPts: targetPts };
    } else {
      if (c.high >= stopPrice) return { exit: 'stop', pnlPts: -stopPts };
      if (c.low <= tgtPrice) return { exit: 'target', pnlPts: targetPts };
    }
  }
  const pnl = dir === 'long' ? lastClose - signal.entryPrice : signal.entryPrice - lastClose;
  return { exit: 'time', pnlPts: round(pnl, 2) };
}

function metrics(trades, label, cfg) {
  if (!trades.length) return null;
  const wins = trades.filter(t => t.pnlPts > 0);
  const losses = trades.filter(t => t.pnlPts <= 0);
  const totalPnL = trades.reduce((a,t)=>a+t.pnlPts,0);
  const grossWin = wins.reduce((a,t)=>a+t.pnlPts,0);
  const grossLoss = -losses.reduce((a,t)=>a+t.pnlPts,0);
  const pf = grossLoss > 0 ? grossWin/grossLoss : null;
  const mean = totalPnL/trades.length;
  const variance = trades.reduce((a,t)=>a + Math.pow(t.pnlPts-mean,2),0)/trades.length;
  const std = Math.sqrt(variance);
  const sharpe = std > 0 ? (mean/std)*Math.sqrt(252) : null;
  let cum=0, peak=0, maxDD=0;
  for (const t of trades) { cum += t.pnlPts; if (cum>peak) peak=cum; const dd=peak-cum; if (dd>maxDD) maxDD=dd; }
  return {
    label, ...cfg,
    n: trades.length,
    wr: round(wins.length/trades.length, 4),
    totalPnLPts: round(totalPnL, 2),
    avgPnLPts: round(mean, 2),
    pf: pf == null ? null : round(pf, 2),
    sharpe: sharpe == null ? null : round(sharpe, 2),
    maxDDPts: round(maxDD, 2),
    stopExits: trades.filter(t=>t.exit==='stop').length,
    targetExits: trades.filter(t=>t.exit==='target').length,
    timeExits: trades.filter(t=>t.exit==='time').length,
  };
}

async function main() {
  console.log('Loading T11 signal output...');
  const j = JSON.parse(fs.readFileSync(T11_JSON, 'utf-8'));
  const candles = await loadCandles();

  const stops = [25, 40, 60];
  const targets = [30, 50, 75, 100];
  const timeStops = [60, 90];

  const filters = {
    'reclaim_long_only': s => s.type === 'reclaim_long',
    'reclaim_long_slope_not_rising': s => s.type === 'reclaim_long' && s.slopeBucket !== 'rising',
    'reclaim_long_slope_flat': s => s.type === 'reclaim_long' && s.slopeBucket === 'flat',
    'reclaim_long_regime_pos_or_neut_or_strong_neg': s => s.type === 'reclaim_long' && ['positive','neutral','strong_negative'].includes(s.regime),
    'reclaim_long_combined': s => s.type === 'reclaim_long' && s.slopeBucket !== 'rising' && s.regime !== 'negative',
    'reclaim_short_slope_rising': s => s.type === 'reclaim_short' && s.slopeBucket === 'rising',
    'rejection_all': s => true,
    'rejection_regime_neg': s => s.regime === 'negative' || s.regime === 'strong_negative',
    'rejection_long_gap_down_strong': s => s.type === 'rejection_long' && s.gapBucket === 'gap_down_strong',
    'rejection_long_regime_neg': s => s.type === 'rejection_long' && s.regime === 'negative',
  };

  function runFilter(filterName, sourceList) {
    const filter = filters[filterName];
    const all = sourceList.filter(filter);
    const isSet = all.filter(s => s.date < OOS_START);
    const oosSet = all.filter(s => s.date >= OOS_START);

    const fullGrid = [];
    const isGrid = [];
    for (const stop of stops) for (const tgt of targets) for (const ts of timeStops) {
      const tradesFull = all.map(s => simulate(candles, s, stop, tgt, ts));
      const tradesIS = isSet.map(s => simulate(candles, s, stop, tgt, ts));
      const m = metrics(tradesFull, filterName, { stopPts: stop, targetPts: tgt, timeStopMin: ts });
      const mIS = metrics(tradesIS, filterName + '_IS', { stopPts: stop, targetPts: tgt, timeStopMin: ts });
      if (m) fullGrid.push(m);
      if (mIS) isGrid.push(mIS);
    }
    // top 3 IS by Sharpe → eval OOS
    const top = [...isGrid].sort((a,b) => (b.sharpe||0) - (a.sharpe||0)).slice(0, 3);
    const topOOS = top.map(cfg => {
      const trades = oosSet.map(s => simulate(candles, s, cfg.stopPts, cfg.targetPts, cfg.timeStopMin));
      const m = metrics(trades, filterName + '_OOS', { stopPts: cfg.stopPts, targetPts: cfg.targetPts, timeStopMin: cfg.timeStopMin });
      return { is: cfg, oos: m };
    });
    const topByPF = [...isGrid].sort((a,b) => (b.pf||0) - (a.pf||0)).slice(0, 3);
    const topPFOOS = topByPF.map(cfg => {
      const trades = oosSet.map(s => simulate(candles, s, cfg.stopPts, cfg.targetPts, cfg.timeStopMin));
      const m = metrics(trades, filterName + '_OOS', { stopPts: cfg.stopPts, targetPts: cfg.targetPts, timeStopMin: cfg.timeStopMin });
      return { is: cfg, oos: m };
    });
    return {
      n_total: all.length,
      n_is: isSet.length,
      n_oos: oosSet.length,
      fullGridTopBySharpe: [...fullGrid].sort((a,b) => (b.sharpe||0) - (a.sharpe||0)).slice(0, 5),
      fullGridTopByPF: [...fullGrid].sort((a,b) => (b.pf||0) - (a.pf||0)).slice(0, 5),
      topISBySharpeOOS: topOOS,
      topISByPFOOS: topPFOOS,
    };
  }

  const out = {};
  for (const fname of Object.keys(filters)) {
    const source = fname.startsWith('rejection') ? j.signals.rejection : j.signals.reclaim;
    console.log(`Running ${fname}...`);
    out[fname] = runFilter(fname, source);
    const top = out[fname].fullGridTopBySharpe[0];
    if (top) console.log(`  best: SL=${top.stopPts}/TP=${top.targetPts}/T=${top.timeStopMin}  n=${top.n} WR=${top.wr} PF=${top.pf} Sh=${top.sharpe} PnL=${top.totalPnLPts} DD=${top.maxDDPts}`);
  }

  fs.writeFileSync(OUTPUT, JSON.stringify(out, null, 2));
  console.log(`Wrote ${OUTPUT}`);
  // Print best result per filter for headline
  console.log('\n===== HEADLINE: top by Sharpe per filter =====');
  for (const [fname, res] of Object.entries(out)) {
    const top = res.fullGridTopBySharpe[0];
    if (!top) { console.log(`${fname}: no results (n_total=${res.n_total})`); continue; }
    console.log(`${fname.padEnd(50)} n=${top.n}  WR=${top.wr}  PF=${top.pf}  Sh=${top.sharpe}  PnL=${top.totalPnLPts}pts  DD=${top.maxDDPts}pts  SL=${top.stopPts}/TP=${top.targetPts}/T=${top.timeStopMin}`);
  }
  console.log('\n===== OOS validation top-IS-Sharpe =====');
  for (const [fname, res] of Object.entries(out)) {
    for (const c of res.topISBySharpeOOS) {
      const o = c.oos;
      console.log(`${fname.padEnd(40)} IS Sh=${c.is.sharpe} PF=${c.is.pf}  | OOS n=${o?.n||0} WR=${o?.wr} PF=${o?.pf} PnL=${o?.totalPnLPts}`);
    }
  }
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
