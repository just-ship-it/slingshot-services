/**
 * OFI signal validation: does Order Flow Imbalance predict NQ forward returns?
 *
 * Joins trade-ofi-1m + book-imbalance-1m + NQ_ohlcv_1m and reports
 * correlations between each OF metric and forward 1/5/15/30min returns.
 *
 * Also computes conditional return distributions in OFI deciles.
 */
import fs from 'fs';
import readline from 'readline';
import path from 'path';

const ROOT = '/home/drew/projects/slingshot-services/backtest-engine';
const OFI_PATH = `${ROOT}/data/orderflow/nq/trade-ofi-1m.csv`;
const BI_PATH = `${ROOT}/data/orderflow/nq/book-imbalance-1m.csv`;
const NQ_1M_PATH = `${ROOT}/data/ohlcv/nq/NQ_ohlcv_1m.csv`;
const ROLLOVER_PATH = `${ROOT}/data/ohlcv/nq/NQ_rollover_log.csv`;

// Load NQ 1m closes per minute (primary contract per hour)
async function loadPrimaryNQ() {
  console.log('Loading NQ 1m...');
  const t0 = Date.now();
  const rl = readline.createInterface({ input: fs.createReadStream(NQ_1M_PATH), crlfDelay: Infinity });
  // First pass: build hour→bestSymbol map by volume
  const hourVol = new Map();
  const rows = [];
  let header = null;
  for await (const line of rl) {
    if (!header) { header = line.split(','); continue; }
    const parts = line.split(',');
    // ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume,symbol
    const symbol = parts[9];
    if (!symbol || symbol.includes('-')) continue;
    const ts = parts[0];
    const close = +parts[7];
    const volume = +parts[8] || 0;
    if (isNaN(close)) continue;
    const tsMs = Date.parse(ts);
    if (isNaN(tsMs)) continue;
    const hour = Math.floor(tsMs / 3600000);
    if (!hourVol.has(hour)) hourVol.set(hour, new Map());
    const m = hourVol.get(hour);
    m.set(symbol, (m.get(symbol) || 0) + volume);
    rows.push({ ts: tsMs, close, volume, symbol });
  }
  const primary = new Map();
  for (const [h, m] of hourVol.entries()) {
    let best = '', bestV = -1;
    for (const [s, v] of m.entries()) if (v > bestV) { bestV = v; best = s; }
    primary.set(h, best);
  }
  const filtered = rows.filter(r => r.symbol === primary.get(Math.floor(r.ts / 3600000)));
  filtered.sort((a, b) => a.ts - b.ts);
  console.log(`  loaded ${rows.length.toLocaleString()} rows, kept ${filtered.length.toLocaleString()} primary  (${((Date.now()-t0)/1000).toFixed(0)}s)`);
  return filtered;
}

async function loadCSV(p, parser) {
  const rl = readline.createInterface({ input: fs.createReadStream(p), crlfDelay: Infinity });
  const rows = [];
  let header = null;
  for await (const line of rl) {
    if (!header) { header = line.split(','); continue; }
    const parts = line.split(',');
    const r = parser(parts);
    if (r) rows.push(r);
  }
  return rows;
}

const ofi = await loadCSV(OFI_PATH, p => {
  const ts = Date.parse(p[0]);
  if (isNaN(ts)) return null;
  return {
    ts,
    buyVolume: +p[1], sellVolume: +p[2], netVolume: +p[3], totalVolume: +p[4],
    buyTrades: +p[5], sellTrades: +p[6], totalTrades: +p[7],
    volumeImbalance: +p[8], tradeImbalance: +p[9], buyRatio: +p[10],
  };
});
console.log(`Loaded ${ofi.length.toLocaleString()} OFI 1m rows`);

const bi = await loadCSV(BI_PATH, p => {
  const ts = Date.parse(p[0]);
  if (isNaN(ts)) return null;
  return {
    ts, updates: +p[1],
    totalBidSize: +p[2], totalAskSize: +p[3],
    totalBidCount: +p[4], totalAskCount: +p[5],
    sizeImbalance: +p[6], countImbalance: +p[7],
    avgSizeImbalance: +p[8], avgCountImbalance: +p[9],
    bidAskRatio: +p[10],
  };
});
console.log(`Loaded ${bi.length.toLocaleString()} book-imbalance 1m rows`);

const nq = await loadPrimaryNQ();

// Index by minute timestamp
const tsToClose = new Map();
for (const r of nq) tsToClose.set(r.ts, r.close);
console.log(`Indexed ${tsToClose.size.toLocaleString()} NQ minute closes`);

// Build joined rows: for each OFI ts, look up NQ close, plus forward closes at +1, +5, +15, +30 min
const HORIZONS = [1, 3, 5, 10, 15, 30];

const ofiByTs = new Map(ofi.map(r => [r.ts, r]));
const biByTs = new Map(bi.map(r => [r.ts, r]));

const joined = [];
for (const r of nq) {
  const o = ofiByTs.get(r.ts);
  const b = biByTs.get(r.ts);
  if (!o || !b) continue;
  const fwd = {};
  for (const h of HORIZONS) {
    const ft = r.ts + h * 60_000;
    const fc = tsToClose.get(ft);
    if (fc != null) fwd[h] = fc - r.close;
  }
  joined.push({ ts: r.ts, close: r.close, ...o, ...b, fwd });
}
console.log(`Joined rows: ${joined.length.toLocaleString()}`);

// Correlations
function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return NaN;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
}

const METRICS = ['netVolume', 'volumeImbalance', 'tradeImbalance', 'buyRatio',
                 'sizeImbalance', 'countImbalance', 'avgSizeImbalance', 'avgCountImbalance', 'bidAskRatio'];

console.log(`\nCorrelation: metric vs forward return at horizon h (min)`);
console.log(`metric              h=1     h=3     h=5     h=10    h=15    h=30`);
for (const m of METRICS) {
  const xs = joined.map(r => r[m]).filter(v => Number.isFinite(v));
  const out = [];
  for (const h of HORIZONS) {
    const pairs = joined.filter(r => Number.isFinite(r[m]) && Number.isFinite(r.fwd[h]));
    const xx = pairs.map(r => r[m]);
    const yy = pairs.map(r => r.fwd[h]);
    out.push(pearson(xx, yy));
  }
  console.log(`${m.padEnd(20)} ${out.map(v => (v >= 0 ? ' ' : '') + v.toFixed(3)).join('  ')}`);
}

// Conditional means: deciles of OFI vs forward return
console.log(`\nConditional 5-min forward return by netVolume decile:`);
const sorted = joined.filter(r => Number.isFinite(r.netVolume) && Number.isFinite(r.fwd[5]))
  .slice().sort((a, b) => a.netVolume - b.netVolume);
const N = sorted.length;
console.log(`(n=${N.toLocaleString()})`);
console.log(`decile  netVol_range                            mean_fwd_5m  median  P(>0)  P(>10pt)  P(<-10pt)`);
for (let d = 0; d < 10; d++) {
  const lo = Math.floor(N * d / 10);
  const hi = Math.floor(N * (d + 1) / 10);
  const bucket = sorted.slice(lo, hi);
  const rets = bucket.map(r => r.fwd[5]);
  const mean = rets.reduce((s, v) => s + v, 0) / rets.length;
  rets.sort((a, b) => a - b);
  const median = rets[Math.floor(rets.length / 2)];
  const pPos = rets.filter(r => r > 0).length / rets.length;
  const pBig = rets.filter(r => r > 10).length / rets.length;
  const pNegBig = rets.filter(r => r < -10).length / rets.length;
  console.log(`  d${d}   [${bucket[0].netVolume.toString().padStart(6)} .. ${bucket[bucket.length-1].netVolume.toString().padStart(6)}]   ${mean.toFixed(2).padStart(8)}  ${median.toFixed(2).padStart(6)}  ${(pPos*100).toFixed(1)}%   ${(pBig*100).toFixed(1)}%      ${(pNegBig*100).toFixed(1)}%`);
}

// Same for sizeImbalance (book)
console.log(`\nConditional 5-min forward return by sizeImbalance decile (book):`);
const sorted2 = joined.filter(r => Number.isFinite(r.sizeImbalance) && Number.isFinite(r.fwd[5]))
  .slice().sort((a, b) => a.sizeImbalance - b.sizeImbalance);
const N2 = sorted2.length;
console.log(`(n=${N2.toLocaleString()})`);
console.log(`decile  sizeImb_range                  mean_fwd_5m  median  P(>0)  P(>10pt)  P(<-10pt)`);
for (let d = 0; d < 10; d++) {
  const lo = Math.floor(N2 * d / 10);
  const hi = Math.floor(N2 * (d + 1) / 10);
  const bucket = sorted2.slice(lo, hi);
  const rets = bucket.map(r => r.fwd[5]);
  const mean = rets.reduce((s, v) => s + v, 0) / rets.length;
  rets.sort((a, b) => a - b);
  const median = rets[Math.floor(rets.length / 2)];
  const pPos = rets.filter(r => r > 0).length / rets.length;
  const pBig = rets.filter(r => r > 10).length / rets.length;
  const pNegBig = rets.filter(r => r < -10).length / rets.length;
  console.log(`  d${d}   [${bucket[0].sizeImbalance.toFixed(2).padStart(6)} .. ${bucket[bucket.length-1].sizeImbalance.toFixed(2).padStart(6)}]   ${mean.toFixed(2).padStart(8)}  ${median.toFixed(2).padStart(6)}  ${(pPos*100).toFixed(1)}%   ${(pBig*100).toFixed(1)}%      ${(pNegBig*100).toFixed(1)}%`);
}

// Save joined dataset
const outPath = `${ROOT}/research/output/ofi-nq-joined.json`;
fs.writeFileSync(outPath, JSON.stringify({
  meta: { n: joined.length, horizons: HORIZONS, range: { first: joined[0].ts, last: joined[joined.length-1].ts } },
  joined,
}));
console.log(`\nWritten: ${outPath}  (${(fs.statSync(outPath).size / 1e6).toFixed(0)}MB)`);
