/**
 * Phase 1 — Precompute per-1s flow features for the regime/change-point strategy.
 *
 * Goal: turn raw 1s OHLCV (no buy/sell split, no order book) into the inferred-flow
 * feature stream a regime detector needs. Everything here is CAUSAL — each bar's
 * features use only that bar and prior bars within the SAME primary contract.
 *
 * Pipeline (mirrors research/gex-touch-confirm/06):
 *   1. Load 1m OHLCV → build primary-contract-by-hour map (highest-volume contract/hr).
 *   2. Stream the 7.6GB 1s file line-by-line, keep only rows whose symbol is the
 *      primary contract for that hour (drops the inactive month + calendar spreads).
 *   3. Maintain causal rolling state; reset it on a contract change (rollover) so no
 *      feature ever spans a roll spread.
 *   4. Emit one feature row per primary-contract 1s bar.
 *
 * Features per bar:
 *   close, volume
 *   ret_1s/3s/5s/10s/30s/60s  — point change over horizon (causal, backward-looking)
 *   rv_30s                    — realized vol = std of 1s point-returns over last 30 bars
 *   range, range_exp          — bar range, and range / avg(range,60s)
 *   vol_vel                   — volume / avg(volume,60s)
 *   signed_vol                — BVC-estimated buy minus sell volume for this bar
 *   delta_10s/30s/60s/180s    — rolling sum of signed_vol (cumulative-delta proxy)
 *   ofi_60s                   — |Σ signed_vol| / Σ volume over 60s (directional pressure 0..1)
 *   vpin_60s                  — Σ|signed_vol| / Σ volume over 60s (flow toxicity 0..1)
 *   run_len                   — signed count of consecutive same-direction 1s closes
 *   body_range                — |close-open| / range  (1 = pure trend bar, ~0 = wick/absorption)
 *
 * BVC (Bulk Volume Classification, Easley/Lopez de Prado/O'Hara):
 *   buyFrac = Φ( ΔP / σ_ΔP ),  signed_vol = volume * (2*buyFrac - 1)
 *   where ΔP is this bar's close-to-close change and σ_ΔP is the rolling std of ΔP.
 *   This estimates aggressor direction from price displacement when no tape exists.
 *
 * Usage:
 *   node research/regime-flow/01-precompute-flow-features.js \
 *     --start 2026-03-01 --end 2026-03-31 \
 *     --out data/features/nq_flow_1s_2026-03.csv
 *
 * Start with ONE month to iterate; widen to the gold-standard window once validated.
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import csv from 'csv-parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');
const DATA_DIR = path.join(ROOT, 'data');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  return process.argv[i + 1];
}
const START = arg('start', '2026-03-01');
const END = arg('end', '2026-03-31');
const PRODUCT = arg('product', 'NQ').toUpperCase();
const OUT = arg('out', `data/features/nq_flow_1s_${START}_${END}.csv`);
const SIGMA_WIN = +arg('sigma-win', 300);   // bars for σ_ΔP (BVC volatility scale)

const outPath = path.isAbsolute(OUT) ? OUT : path.join(ROOT, OUT);
fs.mkdirSync(path.dirname(outPath), { recursive: true });

console.log(`\n=== Precompute 1s flow features ===`);
console.log(`Range:   ${START} → ${END}`);
console.log(`Product: ${PRODUCT}`);
console.log(`Out:     ${outPath}\n`);

// --- standard normal CDF (Abramowitz-Stegun erf approximation) ---
function normCdf(z) {
  // Φ(z) = 0.5 * (1 + erf(z/√2))
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  let p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

// --- 1. primary-contract-by-hour map from 1m OHLCV ---
async function loadOneMin(startStr, endStr) {
  const filePath = path.join(DATA_DIR, 'ohlcv', PRODUCT.toLowerCase(), `${PRODUCT}_ohlcv_1m.csv`);
  const start = new Date(startStr).getTime();
  const end = new Date(endStr).getTime() + 24 * 3600000;
  const rows = [];
  await new Promise((resolve, reject) => {
    fs.createReadStream(filePath).pipe(csv())
      .on('data', (row) => {
        if (row.symbol && row.symbol.includes('-')) return; // calendar spread
        const ts = new Date(row.ts_event).getTime();
        if (isNaN(ts) || ts < start || ts > end) return;
        rows.push({ timestamp: ts, volume: +row.volume || 0, symbol: row.symbol });
      })
      .on('end', resolve).on('error', reject);
  });
  return rows;
}
function buildPrimaryByHour(rows) {
  const hourVol = new Map();
  for (const c of rows) {
    const h = Math.floor(c.timestamp / 3600000);
    if (!hourVol.has(h)) hourVol.set(h, new Map());
    const m = hourVol.get(h);
    m.set(c.symbol, (m.get(c.symbol) || 0) + c.volume);
  }
  const primary = new Map();
  for (const [h, m] of hourVol.entries()) {
    let bestSym = '', bestVol = -1;
    for (const [s, v] of m.entries()) if (v > bestVol) { bestVol = v; bestSym = s; }
    primary.set(h, bestSym);
  }
  return primary;
}

console.log(`Loading 1m OHLCV for primary-contract map ...`);
const oneMin = await loadOneMin(START, END);
const primaryByHour = buildPrimaryByHour(oneMin);
console.log(`  ${oneMin.length.toLocaleString()} 1m rows → ${primaryByHour.size.toLocaleString()} hours mapped\n`);

// --- 2. causal rolling state (ring buffers + running sums), reset on contract change ---
const CAP = 1024; // > all windows
function newState() {
  return {
    sym: null,
    n: 0,                       // bars seen in current contract
    closes: new Float64Array(CAP),
    rets: new Float64Array(CAP),
    vols: new Float64Array(CAP),
    sgn: new Float64Array(CAP),
    prevClose: NaN,
    runLen: 0,
    // running sums for delta windows
    sumSgn: { 10: 0, 30: 0, 60: 0, 180: 0 },
    sumVol60: 0,
    sumAbsSgn60: 0,
    sumRange60: 0,
    ranges: new Float64Array(CAP),
    // σ_ΔP window
    dpSum: 0, dpSum2: 0, dpN: 0,
    // rv window (std of last 30 rets)
    retSum30: 0, retSum2_30: 0,
  };
}
let st = newState();

function resetForContract(sym) {
  st = newState();
  st.sym = sym;
}

// helper: value that leaves window of size k when pushing index n (0-based)
function at(arr, idx) { return arr[idx % CAP]; }

const out = fs.createWriteStream(outPath);
out.write([
  'ts', 'symbol', 'close', 'volume',
  'ret_1s', 'ret_3s', 'ret_5s', 'ret_10s', 'ret_30s', 'ret_60s',
  'rv_30s', 'range', 'range_exp', 'vol_vel',
  'signed_vol', 'delta_10s', 'delta_30s', 'delta_60s', 'delta_180s',
  'ofi_60s', 'vpin_60s', 'run_len', 'body_range',
].join(',') + '\n');

let written = 0, scanned = 0;

function processBar(ts, o, h, l, c, v, sym) {
  if (sym !== st.sym) resetForContract(sym);
  const n = st.n;

  // --- BVC signed volume ---
  const dp = Number.isNaN(st.prevClose) ? 0 : (c - st.prevClose);
  // σ_ΔP over rolling window
  const sigma = st.dpN >= 30 ? Math.sqrt(Math.max(1e-9, st.dpSum2 / st.dpN - (st.dpSum / st.dpN) ** 2)) : NaN;
  let signedVol = 0;
  if (Number.isFinite(sigma) && sigma > 1e-6) {
    const buyFrac = normCdf(dp / sigma);
    signedVol = v * (2 * buyFrac - 1);
  }

  // --- ring-buffer writes ---
  const slot = n % CAP;
  st.closes[slot] = c;
  st.rets[slot] = dp;
  st.vols[slot] = v;
  st.sgn[slot] = signedVol;
  const range = h - l;
  st.ranges[slot] = range;

  // --- running sums (add new) ---
  for (const k of [10, 30, 60, 180]) st.sumSgn[k] += signedVol;
  st.sumVol60 += v;
  st.sumAbsSgn60 += Math.abs(signedVol);
  st.sumRange60 += range;
  st.retSum30 += dp; st.retSum2_30 += dp * dp;
  // σ_ΔP window
  st.dpSum += dp; st.dpSum2 += dp * dp; st.dpN += 1;

  // --- subtract values leaving each window ---
  for (const k of [10, 30, 60, 180]) {
    if (n - k >= 0) st.sumSgn[k] -= at(st.sgn, n - k);
  }
  if (n - 60 >= 0) { st.sumVol60 -= at(st.vols, n - 60); st.sumAbsSgn60 -= Math.abs(at(st.sgn, n - 60)); st.sumRange60 -= at(st.ranges, n - 60); }
  if (n - 30 >= 0) { const r = at(st.rets, n - 30); st.retSum30 -= r; st.retSum2_30 -= r * r; }
  if (st.dpN > SIGMA_WIN && n - SIGMA_WIN >= 0) { const r = at(st.rets, n - SIGMA_WIN); st.dpSum -= r; st.dpSum2 -= r * r; st.dpN -= 1; }

  // --- run length (signed consecutive same-direction closes) ---
  if (dp > 0) st.runLen = st.runLen > 0 ? st.runLen + 1 : 1;
  else if (dp < 0) st.runLen = st.runLen < 0 ? st.runLen - 1 : -1;
  // dp==0 keeps prior runLen

  // --- emit only once enough history exists for the longest core window (60s) ---
  if (n >= 60) {
    const ret = (k) => c - at(st.closes, n - k);
    const cnt30 = Math.min(n + 1, 30);
    const rv30 = Math.sqrt(Math.max(0, st.retSum2_30 / cnt30 - (st.retSum30 / cnt30) ** 2));
    const avgRange60 = st.sumRange60 / 60;
    const avgVol60 = st.sumVol60 / 60;
    const ofi = st.sumVol60 > 0 ? st.sumSgn[60] / st.sumVol60 : 0;        // signed, -1..1
    const vpin = st.sumVol60 > 0 ? st.sumAbsSgn60 / st.sumVol60 : 0;       // 0..1
    const bodyRange = range > 1e-9 ? Math.abs(c - o) / range : 0;

    out.write([
      ts, sym, c.toFixed(2), v,
      ret(1).toFixed(3), ret(3).toFixed(3), ret(5).toFixed(3), ret(10).toFixed(3), ret(30).toFixed(3), ret(60).toFixed(3),
      rv30.toFixed(4), range.toFixed(2), (avgRange60 > 1e-9 ? range / avgRange60 : 0).toFixed(3),
      (avgVol60 > 1e-9 ? v / avgVol60 : 0).toFixed(3),
      signedVol.toFixed(2), st.sumSgn[10].toFixed(2), st.sumSgn[30].toFixed(2), st.sumSgn[60].toFixed(2), st.sumSgn[180].toFixed(2),
      ofi.toFixed(4), vpin.toFixed(4), st.runLen, bodyRange.toFixed(3),
    ].join(',') + '\n');
    written++;
  }

  st.prevClose = c;
  st.n = n + 1;
}

// --- 3. stream the 1s file ---
const oneSecPath = path.join(DATA_DIR, 'ohlcv', PRODUCT.toLowerCase(), `${PRODUCT}_ohlcv_1s.csv`);
const startTs = new Date(START).getTime();
const endTs = new Date(END).getTime() + 24 * 3600000;
const startDate = START.slice(0, 10);
const endDate = END.slice(0, 10);

console.log(`Streaming 1s file ...`);
const rl = readline.createInterface({ input: fs.createReadStream(oneSecPath), crlfDelay: Infinity });
let headerSeen = false;
const t0 = process.hrtime.bigint();

for await (const line of rl) {
  if (!headerSeen) { headerSeen = true; continue; }
  // fast date lex-gate on the ISO timestamp prefix before any parsing
  const dprefix = line.slice(0, 10);
  if (dprefix < startDate) continue;
  if (dprefix > endDate) break; // file is sorted by ts_event

  const f = line.split(',');
  const sym = f[9];
  if (!sym || sym.includes('-')) continue; // calendar spread
  const ts = new Date(f[0]).getTime();
  if (ts < startTs || ts > endTs) continue;

  const hour = Math.floor(ts / 3600000);
  if (primaryByHour.get(hour) !== sym) continue; // not the active contract this hour

  scanned++;
  processBar(f[0], +f[4], +f[5], +f[6], +f[7], +f[8], sym);

  if (scanned % 2_000_000 === 0) {
    const secs = Number(process.hrtime.bigint() - t0) / 1e9;
    console.log(`  scanned ${scanned.toLocaleString()} primary bars, wrote ${written.toLocaleString()} (${secs.toFixed(0)}s)`);
  }
}
out.end();

const secs = Number(process.hrtime.bigint() - t0) / 1e9;
console.log(`\nDone. Primary 1s bars: ${scanned.toLocaleString()}, feature rows written: ${written.toLocaleString()} in ${secs.toFixed(0)}s`);
console.log(`Output: ${outPath}\n`);
